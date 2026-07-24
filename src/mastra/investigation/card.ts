import type { Ledger } from './seed.ts'
import type { GateResult } from './gate.ts'
import type { Triage } from './schema.ts'

// The single Slack-card renderer for the agent-driven investigation, shared by
// the webhook receiver (index.ts) and the CLI harness (run.ts). One definition, one format.
export function renderCard(ledger: Ledger, triage: Triage, gate: GateResult): string {
  const cite = triage.citations.map((c) => `\`${c.kind}\`: ${c.ref}`).join(' · ')
  const gateLine = gate.passed
    ? ':white_check_mark: passed (existence + semantic support)'
    : ':x: ' + [...gate.existenceIssues, ...gate.semanticIssues].join('; ')
  return [
    `*Alert triage — ${ledger.seed.service}* ${triage.disposition === 'actionable' ? ':rotating_light:' : ':mostly_sunny:'}`,
    `*Disposition:* ${triage.disposition}  |  *Recommendation:* ${triage.recommendation}  |  *Confidence:* ${triage.confidence}`,
    ``,
    `*Root cause hypothesis:* ${triage.rootCauseHypothesis}`,
    ``,
    `*Investigation:* ${ledger.toolCalls.length} tool calls (${ledger.toolCalls.map((c) => c.tool).join(', ') || 'none'})`,
    `*Evidence gathered:* ${ledger.metrics.length} metric points · ${ledger.logs.length} logs · ${ledger.traces.length} traces · ${ledger.sources.length} source reads`,
    ``,
    `*Citations:* ${cite || '(none)'}`,
    `*Citation gate:* ${gateLine}`,
    `_Read-only recommendation. A human decides._`,
  ].join('\n')
}
