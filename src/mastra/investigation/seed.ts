import { fetchTriggeringTrace, type TraceException } from './backends.ts'

// Seed = the deterministic, always-needed starting point: the firing alert's
// metric value + its triggering trace. Nothing else is pre-fetched — the agent decides
// what more it needs. The trigger's exception/file:line is parsed here (it is part of
// "having the trace"), but the source snippet is NOT read: read_source is an
// agent-driven step, so the citation gate can check whether the agent actually read it.

export interface Seed {
  service: string
  metric: { name: string; value: number | null; threshold: number }
  trigger: { traceId: string | null; exception: TraceException | null }
}

// The per-run evidence ledger. Every tool the agent drives appends what it gathered here,
// deterministically. The end-of-loop citation gate checks the model's citations against
// THIS ledger (existence + semantic support) — never against the model's own say-so.
export interface Ledger {
  seed: Seed
  metrics: { name: string; window: string; value: number | null }[]
  logs: string[]
  traces: { traceId: string; isError: boolean }[]
  sources: { path: string; line: number; snippet: string }[]
  toolCalls: { tool: string; args: string }[]
}

export function newLedger(seed: Seed): Ledger {
  return { seed, metrics: [], logs: [], traces: [], sources: [], toolCalls: [] }
}

export async function seed(service: string): Promise<Seed> {
  const { value, traceId, exception } = await fetchTriggeringTrace(service)
  return {
    service,
    metric: { name: 'error_ratio_5xx', value, threshold: 0.1 },
    trigger: { traceId, exception },
  }
}
