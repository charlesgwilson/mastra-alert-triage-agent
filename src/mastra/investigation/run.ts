import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { seed, type Ledger } from './seed.ts'
import { runInvestigation } from './loop.ts'
import { structure } from './structure.ts'
import { citationGate } from './gate.ts'
import { disconnectMcp } from './backends.ts'
import { renderCard } from './card.ts'
import type { Triage } from './schema.ts'
import { gatherEvidence } from '../triage.ts'

const SAMPLES = process.env.SAMPLES_DIR || path.resolve(process.cwd(), 'samples')
const SERVICE = process.env.SERVICE || 'demo-webapp'

// --- negative controls: prove the hardened gate rejects both failure modes ---
function runControls(ledger: Ledger, base: Triage) {
  const results: { name: string; rejected: boolean; issues: string[] }[] = []

  // Control A — FABRICATION: cite a file the agent never read.
  const fab: Triage = {
    ...base,
    disposition: 'actionable',
    citations: [{ kind: 'source', ref: 'billing.js:99' }],
  }
  const gFab = citationGate(ledger, fab)
  results.push({ name: 'fabricated source (billing.js:99)', rejected: !gFab.passed, issues: [...gFab.existenceIssues, ...gFab.semanticIssues] })

  // Control B — REAL-BUT-IRRELEVANT: cite a source that WAS read but is not the failing
  // frame. We inject a real, readable, irrelevant source into the ledger first so the
  // citation passes existence and can only be caught by the semantic-support check.
  const ledgerB: Ledger = {
    ...ledger,
    sources: [...ledger.sources, { path: 'server.js', line: 30, snippet: "> 30:   res.json({ ok: true })" }],
  }
  const irrelevant: Triage = {
    ...base,
    disposition: 'actionable',
    citations: [{ kind: 'source', ref: 'server.js:30' }],
  }
  const gIrr = citationGate(ledgerB, irrelevant)
  results.push({ name: 'real-but-irrelevant source (server.js:30)', rejected: !gIrr.passed, issues: [...gIrr.existenceIssues, ...gIrr.semanticIssues] })

  return results
}

// --- head-to-head: what did each arm actually gather on the same incident? ---
async function headToHead(ledger: Ledger) {
  const fixed = await gatherEvidence(SERVICE) // the baseline's fixed bundle
  return {
    baseline_fixed_bundle: {
      metric: fixed.metric.value,
      traceId: fixed.traceId,
      source: fixed.source ? `${fixed.source.path}:${fixed.source.line}` : null,
      logs: fixed.logs.length,
      baseline_comparison: false, // the fixed bundle never fetches a baseline
      neighboring_traces: 0, // nor neighbours
    },
    agent_driven: {
      tool_calls: ledger.toolCalls.map((c) => `${c.tool}(${c.args})`),
      metric_points: ledger.metrics.length,
      baseline_comparison: ledger.metrics.some((m) => m.window !== 'now'),
      neighboring_traces: ledger.traces.length,
      logs: ledger.logs.length,
      source_reads: ledger.sources.length,
    },
  }
}

async function main() {
  mkdirSync(SAMPLES, { recursive: true })
  console.log('== seed ==')
  const s = await seed(SERVICE)
  console.log(JSON.stringify(s, null, 2))
  if (s.metric.value == null || !s.trigger.traceId) {
    console.error('seed incomplete (no live incident?). Drive load and retry.')
    await disconnectMcp()
    process.exit(2)
  }

  const inv = await runInvestigation(s)
  console.log(`\n== investigate (model=${inv.model}) ==`)
  console.log(inv.text)
  console.log('\nstep log:', JSON.stringify(inv.stepLog))

  console.log('\n== structure ==')
  const triage = await structure(inv.text)
  console.log(JSON.stringify(triage, null, 2))

  console.log('\n== gate ==')
  const gate = citationGate(inv.ledger, triage)
  console.log(JSON.stringify(gate, null, 2))

  const card = renderCard(inv.ledger, triage, gate)
  console.log('\n== card ==\n' + card)

  console.log('\n== negative controls ==')
  const controls = runControls(inv.ledger, triage)
  for (const c of controls) console.log(`${c.rejected ? 'REJECTED ✓' : 'PASSED ✗'} — ${c.name}${c.rejected ? '' : ' [GATE MISS]'}`)

  console.log('\n== head-to-head ==')
  const h2h = await headToHead(inv.ledger)
  console.log(JSON.stringify(h2h, null, 2))

  writeFileSync(path.join(SAMPLES, 'agent-run.json'), JSON.stringify({ seed: s, investigation: inv.text, stepLog: inv.stepLog, ledger: inv.ledger, triage, gate, controls, headToHead: h2h, model: inv.model }, null, 2))
  writeFileSync(path.join(SAMPLES, 'agent-card.md'), card)
  console.log(`\nwrote ${path.join(SAMPLES, 'agent-run.json')} and agent-card.md`)

  await disconnectMcp()
  process.exit(0)
}

main().catch(async (e) => { console.error('run failed:', e); await disconnectMcp(); process.exit(1) })
