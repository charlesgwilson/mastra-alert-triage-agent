import {
  fetchTriggeringTrace,
  lokiLogs,
  escapeLabelValue,
  type TraceException,
} from './investigation/backends.ts'
import { readSourceSnippet } from './investigation/source.ts'

// The baseline "fixed bundle" arm: a deterministic evidence gatherer (one metric read, one
// error trace, its source frame, a few logs) with no agent deciding what else to pull. run.ts's
// head-to-head compares it against the agent-driven investigation; it reuses the same
// backends/source helpers as the agent path.

export interface Evidence {
  service: string
  metric: { name: string; value: number | null }
  traceId: string | null
  exception: TraceException | null
  source: { path: string; line: number; snippet: string } | null
  logs: string[]
}

// The baseline "fixed bundle": one metric read, one error trace, its source frame, and a
// few error logs — gathered unconditionally, with no agent deciding what else to pull.
export async function gatherEvidence(service: string): Promise<Evidence> {
  const { value, traceId, exception } = await fetchTriggeringTrace(service)
  const source =
    exception?.file && exception.line ? readSourceSnippet(exception.file, exception.line) : null
  const escapedService = escapeLabelValue(service)
  const logs = await lokiLogs(`{service_name="${escapedService}"} |= "failed"`, '1h', 3)
  return { service, metric: { name: 'error_ratio_5xx', value }, traceId, exception, source, logs }
}
