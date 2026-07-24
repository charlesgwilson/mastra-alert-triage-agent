import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { promInstant, lokiLogs, tempoSearch, traceIsError, METRICS, escapeLabelValue, errorTraceQL } from './backends.ts'
import { readSourceSnippet } from './source.ts'
import type { Ledger } from './seed.ts'

// Deterministic loop bounds: the loop is bounded in CODE, not the model's
// judgment. maxSteps is the hard backstop on generate(); these per-tool caps are enforced
// INSIDE each tool, so a model that wants to keep digging is stopped by the tool returning a
// terminal message instead of data. Both constants mean the SAME thing — "max executions" —
// and are guarded the same way (block once that many have already run):
//   PER_TOOL_CAP  = 4 -> a tool runs 4x, the 5th call is blocked.
//   SAME_QUERY_CAP = 2 -> an identical (tool, args) query runs 2x, the 3rd is blocked.
const PER_TOOL_CAP = 4
const SAME_QUERY_CAP = 2

// Decide whether this call may proceed, then record only calls that actually execute — a
// tripped breaker records nothing, so no-op attempts never inflate ledger.toolCalls (or the
// card's "N tool calls" count). We count executions ALREADY on the ledger and block once a
// cap is reached, so the message reports a cap reached, not more runs than actually happened.
function guard(ledger: Ledger, tool: string, args: string): string | null {
  const toolRuns = ledger.toolCalls.filter((c) => c.tool === tool).length
  if (toolRuns >= PER_TOOL_CAP) {
    return `circuit breaker: ${tool} reached its ${PER_TOOL_CAP}-call cap. Stop calling it; conclude with what you have.`
  }
  const sameQueryRuns = ledger.toolCalls.filter((c) => c.tool === tool && c.args === args).length
  if (sameQueryRuns >= SAME_QUERY_CAP) {
    return `circuit breaker: identical ${tool} query reached its ${SAME_QUERY_CAP}-call cap. You already have this result; do not repeat it. Conclude.`
  }
  ledger.toolCalls.push({ tool, args }) // record only a call that actually executes
  return null
}

// Build the four read-only tools for one run, closing over that run's ledger.
export function makeTools(ledger: Ledger) {
  const get_baseline = createTool({
    id: 'get_baseline',
    description:
      'Compare a metric now vs one window ago, to tell an elevated signal from a normal one. ' +
      `metric is one of: ${Object.keys(METRICS).join(', ')}. window is a relative range like "1h" or "30m".`,
    inputSchema: z.object({
      metric: z.string().describe('metric name'),
      window: z.string().default('1h').describe('how far back the baseline point is, e.g. "1h"'),
    }),
    outputSchema: z.object({
      metric: z.string(), now: z.number().nullable(), baseline: z.number().nullable(), note: z.string(),
    }),
    execute: async ({ metric, window }) => {
      const stop = guard(ledger, 'get_baseline', `${metric}|${window}`)
      if (stop) return { metric, now: null, baseline: null, note: stop }
      const expr = METRICS[metric]
      if (!expr) return { metric, now: null, baseline: null, note: `unknown metric; choose one of ${Object.keys(METRICS).join(', ')}` }
      const [now, baseline] = await Promise.all([promInstant(expr, 'now'), promInstant(expr, `now-${window}`)])
      ledger.metrics.push({ name: metric, window: 'now', value: now })
      ledger.metrics.push({ name: metric, window, value: baseline })
      return { metric, now, baseline, note: `now=${now} vs ${window}-ago=${baseline}` }
    },
  })

  const get_more_logs = createTool({
    id: 'get_more_logs',
    description:
      'Fetch recent log lines for the service over a window, optionally filtered by a substring. ' +
      'Use to confirm the error string, its frequency, or to look for a different failure.',
    inputSchema: z.object({
      window: z.string().default('1h').describe('relative window, e.g. "1h"'),
      filter: z.string().default('').describe('substring the log line must contain, e.g. "failed" or "" for all'),
    }),
    outputSchema: z.object({ lines: z.array(z.string()), count: z.number() }),
    execute: async ({ window, filter }) => {
      const stop = guard(ledger, 'get_more_logs', `${window}|${filter}`)
      if (stop) return { lines: [stop], count: 0 }
      const service = escapeLabelValue(ledger.seed.service)
      const logql = filter
        ? `{service_name="${service}"} |= "${escapeLabelValue(filter)}"`
        : `{service_name="${service}"}`
      const lines = await lokiLogs(logql, window, 12)
      ledger.logs.push(...lines)
      return { lines, count: lines.length }
    },
  })

  const get_neighboring_traces = createTool({
    id: 'get_neighboring_traces',
    description:
      'List recent traces for the service (error and non-error) to judge blast radius: is the ' +
      'failure the only path failing, or one of many? Helps tell a real incident from a one-off flap.',
    inputSchema: z.object({
      onlyErrors: z.boolean().default(false).describe('restrict to error traces'),
      limit: z.number().default(5),
    }),
    outputSchema: z.object({
      traces: z.array(z.object({ traceId: z.string(), isError: z.boolean() })), summary: z.string(),
    }),
    execute: async ({ onlyErrors, limit }) => {
      const stop = guard(ledger, 'get_neighboring_traces', `${onlyErrors}|${limit}`)
      if (stop) return { traces: [], summary: stop }
      const q = onlyErrors
        ? errorTraceQL(ledger.seed.service)
        : `{ resource.service.name = "${escapeLabelValue(ledger.seed.service)}" }`
      const hits = await tempoSearch(q, Math.min(limit, 8))
      // An error-filtered query only returns error traces, so skip the per-trace status re-fetch
      // there; only the unfiltered listing has to classify each hit.
      const traces = onlyErrors
        ? hits.map((h) => ({ traceId: h.traceId, isError: true }))
        : await Promise.all(
            hits.map(async (h) => ({ traceId: h.traceId, isError: await traceIsError(h.traceId) })),
          )
      for (const t of traces) if (!ledger.traces.some((x) => x.traceId === t.traceId)) ledger.traces.push(t)
      const errs = traces.filter((t) => t.isError).length
      return { traces, summary: `${traces.length} traces, ${errs} carrying an error` }
    },
  })

  const read_source = createTool({
    id: 'read_source',
    description:
      'Read a snippet of the demo webapp source (read-only). Use the file:line a failing trace ' +
      'points to, to ground a root-cause hypothesis in the actual code. file is relative to the app root.',
    inputSchema: z.object({
      file: z.string().describe('source path, e.g. "orders.js"'),
      line: z.number().describe('1-based line number to center on'),
    }),
    outputSchema: z.object({ path: z.string().nullable(), line: z.number(), snippet: z.string() }),
    execute: async ({ file, line }) => {
      const stop = guard(ledger, 'read_source', `${file}:${line}`)
      if (stop) return { path: null, line, snippet: stop }
      const src = readSourceSnippet(file, line)
      if (!src) return { path: null, line, snippet: `not readable (outside source root or missing): ${file}:${line}` }
      if (!ledger.sources.some((s) => s.path === src.path && s.line === src.line)) ledger.sources.push(src)
      return { path: src.path, line: src.line, snippet: src.snippet }
    },
  })

  return { get_baseline, get_more_logs, get_neighboring_traces, read_source }
}
