import type { Triage } from './schema.ts'
import type { Ledger } from './seed.ts'

// The hardened citation gate. It is DETERMINISTIC and runs END-OF-LOOP only —
// never an in-loop tool the agent can Goodhart. Two levels:
//
//   1. Existence  — every cited ref must appear in what the tools ACTUALLY returned
//                   (the ledger), not in the model's say-so. Catches FABRICATION.
//   2. Semantic support — the cited span must actually contain the asserted symptom, not
//                   merely exist. Catches the REAL-BUT-UNFAITHFUL citation: a source/log/
//                   metric that is real and was gathered, but does not support the claim.
//
// The asserted symptom is anchored on the seed's triggering exception (message + failing
// file:line) and the metric breach, both of which are ground truth from the seed.

export interface GateResult {
  passed: boolean
  existenceIssues: string[]
  semanticIssues: string[]
}

// Fuzzy-match citations against gathered evidence on their first N chars, so a citation that
// paraphrases or truncates a log line / error message still matches the real thing. Long
// enough to stay specific, short enough to survive minor model rewording.
const SYMPTOM_PREFIX_LEN = 24

function norm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

// The failing frame the triggering exception blames, as { file, line } (or nulls if unknown).
function failingFrame(ledger: Ledger): { file: string | null; line: number | null } {
  const exc = ledger.seed.trigger.exception
  return {
    file: exc?.file ? exc.file.split('/').pop() ?? null : null, // e.g. "orders.js"
    line: exc?.line ?? null,
  }
}

// Does a (normalized) citation ref name the failing frame — the source the tools actually
// read whose basename AND line are exactly the frame the triggering exception blames?
// Shared by the per-citation semantic check and the final actionable-grounding check so the
// "is this the failing frame" rule lives in one place.
//
// We identify the failing-frame source DIRECTLY (the read source whose basename matches
// failingFile and whose .line === failingLine) rather than a loose path-OR-line find: a bare
// line-number substring (e.g. "23") could otherwise match the wrong source when two read
// files share a line number, then fail the file check and wrongly reject a valid citation.
function citesFailingFrame(ledger: Ledger, ref: string): boolean {
  const { file: failingFile, line: failingLine } = failingFrame(ledger)
  if (!failingFile || failingLine == null) return false
  // The tools must have actually read that exact frame (basename + line)...
  const read = ledger.sources.some(
    (s) => norm(s.path).includes(norm(failingFile)) && s.line === failingLine,
  )
  if (!read) return false
  // ...and the citation must name it by both file and line.
  return ref.includes(norm(failingFile)) && ref.includes(String(failingLine))
}

export function citationGate(ledger: Ledger, triage: Triage): GateResult {
  const existenceIssues: string[] = []
  const semanticIssues: string[] = []

  const { file: failingFile, line: failingLine } = failingFrame(ledger)
  const exc = ledger.seed.trigger.exception
  const symptomMsg = exc?.message ? norm(exc.message) : null // e.g. "cannot read properties of undefined (reading 'price')"
  const metricBreached =
    ledger.seed.metric.value != null && ledger.seed.metric.value > ledger.seed.metric.threshold

  for (const citation of triage.citations) {
    const ref = norm(citation.ref)

    if (citation.kind === 'source') {
      // Existence: the ref must name a source the tools actually read, by PATH — not by a
      // bare line-number substring, which could false-match a source that shares the line.
      const source = ledger.sources.find((s) => ref.includes(norm(s.path)))
      if (!source) {
        existenceIssues.push(`source "${citation.ref}" was never read by a tool (fabricated or unread)`)
        continue
      }
      // Semantic: the cited source must be the frame the exception points at — a real but
      // IRRELEVANT source (e.g. the /health handler) is rejected here.
      if (!citesFailingFrame(ledger, ref)) {
        semanticIssues.push(
          `source "${citation.ref}" was read but is not the failing frame ` +
            `(exception points at ${failingFile}:${failingLine})`,
        )
      }
    } else if (citation.kind === 'log') {
      const hit = ledger.logs.find(
        (line) => norm(line).includes(ref) || ref.includes(norm(line).slice(0, SYMPTOM_PREFIX_LEN)),
      )
      if (!hit) {
        existenceIssues.push(`log "${citation.ref}" not in any fetched log lines`)
        continue
      }
      // Semantic: the cited log must carry the asserted symptom (the exception message),
      // not just be some real log line the service emitted.
      if (symptomMsg && !norm(hit).includes(symptomMsg.slice(0, SYMPTOM_PREFIX_LEN))) {
        semanticIssues.push(`log "${citation.ref}" was fetched but does not contain the asserted error symptom`)
      }
    } else if (citation.kind === 'metric') {
      const known = ['error_ratio_5xx', ...ledger.metrics.map((m) => m.name), ledger.seed.metric.name]
      if (!known.some((name) => ref.includes(norm(name)))) {
        existenceIssues.push(`metric "${citation.ref}" is not a metric that was queried`)
        continue
      }
      // Semantic: an actionable call citing the metric must have an actual breach in-window.
      if (triage.disposition === 'actionable' && !metricBreached) {
        semanticIssues.push(
          `metric "${citation.ref}" cited for an actionable call, but it is not above threshold ` +
            `(${ledger.seed.metric.value} <= ${ledger.seed.metric.threshold})`,
        )
      }
    } else if (citation.kind === 'trace') {
      const shortId = ref.replace(/[^a-f0-9]/g, '').slice(0, 8)
      const known = [ledger.seed.trigger.traceId, ...ledger.traces.map((trace) => trace.traceId)].filter(Boolean) as string[]
      if (!shortId || !known.some((id) => id.toLowerCase().includes(shortId))) {
        existenceIssues.push(`trace "${citation.ref}" does not match the seed trace or any fetched trace`)
      }
    }
  }

  // An actionable disposition must be grounded in the code: it needs a source citation that
  // survived both checks (existence + semantic).
  if (triage.disposition === 'actionable') {
    const groundedSource = triage.citations.some(
      (citation) => citation.kind === 'source' && citesFailingFrame(ledger, norm(citation.ref)),
    )
    if (!groundedSource) semanticIssues.push('actionable disposition without a semantically-supported source citation')
  }

  return {
    passed: existenceIssues.length === 0 && semanticIssues.length === 0,
    existenceIssues,
    semanticIssues,
  }
}
