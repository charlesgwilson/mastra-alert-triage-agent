import { MCPClient } from '@mastra/mcp'

// Read surface for the agent-driven investigation.
//   - Prometheus (baseline) + Loki (logs)  -> the Grafana MCP, via MCPClient (read-only SA).
//   - Tempo (traces)                       -> direct HTTP: mcp-grafana v0.17.0 exposes NO
//                                             Tempo trace-query tool (46 tools, none for Tempo).
// The read-only Grafana service account is the real boundary; the disabled-tool subset is
// defence in depth. readOnlyHint is advisory, not enforcement.

const GRAFANA_URL = process.env.GRAFANA_URL || 'http://localhost:13000'
const TEMPO = process.env.TEMPO_URL || 'http://localhost:13200'
const MCP_GRAFANA_BIN = process.env.MCP_GRAFANA_BIN || 'mcp-grafana' // resolved on PATH
const PROM_DS_UID = process.env.PROM_DS_UID || 'prometheus'
const LOKI_DS_UID = process.env.LOKI_DS_UID || 'loki'

// Cap each log line so one pathological (e.g. megabyte-long) line can't bloat the ledger,
// the model prompt, or the card. Long enough to keep the error string and its context.
const LOG_LINE_MAX_LEN = 240

// Escape a value before it is interpolated into a LogQL/TraceQL double-quoted string
// literal. Escapes the backslash FIRST, then the quote, so a value cannot break out of
// the literal (or inject a label matcher). Every attacker-influenced value that reaches
// a query string must pass through here.
export function escapeLabelValue(v: string): string {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

// Parse a metric string value to a finite number, or null — the single "no reading"
// sentinel. Prometheus emits "NaN"/"+Inf"/"-Inf" as strings; Number() would turn those
// into NaN/Infinity, which must collapse to null so callers have one absence value.
export function finiteOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

let mcp: MCPClient | null = null
// The tool map from MCPClient.listTools() is a genuinely untyped SDK surface (each tool's
// execute() args/return vary per tool), so `any` here is the SDK's, not a shape we control.
let mcpTools: Record<string, any> | null = null

async function loadGrafanaTools(): Promise<Record<string, any>> {
  if (mcpTools) return mcpTools
  mcp = new MCPClient({
    id: 'grafana-mcp',
    servers: {
      grafana: {
        command: MCP_GRAFANA_BIN,
        args: [
          '-t', 'stdio',
          '-disable-admin', '-disable-alerting', '-disable-incident',
          '-disable-oncall', '-disable-provisioning', '-disable-annotations',
        ],
        env: {
          GRAFANA_URL,
          GRAFANA_SERVICE_ACCOUNT_TOKEN: process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN || '',
        },
      },
    },
  })
  mcpTools = await mcp.listTools()
  return mcpTools
}

export async function disconnectMcp(): Promise<void> {
  await mcp?.disconnect().catch(() => {})
  mcp = null
  mcpTools = null
}

// mcp-grafana returns MCP content: { content: [{ type:'text', text: <json string> }] }.
// Returns `unknown` on purpose so each caller narrows the JSON to the shape it expects.
function mcpJson(result: unknown): unknown {
  const text = (result as { content?: { text?: unknown }[] } | null)?.content?.[0]?.text
  if (typeof text !== 'string') return null
  try { return JSON.parse(text) } catch { return null }
}

const ERROR_RATIO_EXPR =
  'sum(rate(http_requests_total{status="5xx"}[1m])) / clamp_min(sum(rate(http_requests_total[1m])),0.001)'

// Named metrics the agent may ask for by name; keeps PromQL out of the model's hands
// (the tool is intent-shaped, not a raw query surface).
export const METRICS: Record<string, string> = {
  error_ratio_5xx: ERROR_RATIO_EXPR,
  request_rate: 'sum(rate(http_requests_total[1m]))',
  error_rate_5xx: 'sum(rate(http_requests_total{status="5xx"}[1m]))',
}

// Instant PromQL through the Grafana MCP at a given evaluation time ('now' or 'now-1h').
export async function promInstant(expr: string, at = 'now'): Promise<number | null> {
  const grafanaTools = await loadGrafanaTools()
  const raw = await grafanaTools['grafana_query_prometheus'].execute({
    datasourceUid: PROM_DS_UID, expr, queryType: 'instant', endTime: at,
  })
  const parsed = mcpJson(raw) as { data?: { value?: unknown[] }[] } | null
  return finiteOrNull(parsed?.data?.[0]?.value?.[1])
}

// LogQL through the Grafana MCP over a relative window (e.g. '1h').
export async function lokiLogs(logql: string, window = '1h', limit = 10): Promise<string[]> {
  const grafanaTools = await loadGrafanaTools()
  const raw = await grafanaTools['grafana_query_loki_logs'].execute({
    datasourceUid: LOKI_DS_UID, logql, startRfc3339: `now-${window}`, endRfc3339: 'now',
    limit, direction: 'backward',
  })
  const parsed = mcpJson(raw) as { data?: { line?: unknown }[] } | null
  const rows: string[] = []
  for (const entry of parsed?.data ?? []) {
    if (typeof entry?.line === 'string') rows.push(entry.line.slice(0, LOG_LINE_MAX_LEN))
  }
  return rows
}

// ---- Tempo (direct HTTP; the MCP has no Tempo tool) ----

// Tempo's HTTP JSON is external, dynamically-shaped data — returns `unknown` so each caller
// narrows the part it needs (or, for tempoException, reads it out of the serialized blob).
async function tempoGet(url: string, ms = 12000): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } })
    return await res.json()
  } catch { return null } finally { clearTimeout(timer) }
}

export interface TraceHit { traceId: string; name?: string; durationMs?: number }

// One row of Tempo's /api/search response (only the fields we surface).
interface TempoSearchRow { traceID: string; rootTraceName?: string; durationMs?: number }

export async function tempoSearch(traceql: string, limit = 5): Promise<TraceHit[]> {
  // Fresh traces take a few seconds to flush to Tempo's search index; retry.
  for (let attempt = 0; attempt < 4; attempt++) {
    const body = await tempoGet(
      `${TEMPO}/api/search?q=${encodeURIComponent(traceql)}&limit=${limit}`,
    )
    const traces = (body as { traces?: unknown })?.traces
    if (Array.isArray(traces) && traces.length) {
      return (traces as TempoSearchRow[]).map((hit) => ({
        traceId: hit.traceID, name: hit.rootTraceName, durationMs: hit.durationMs,
      }))
    }
    // Back off between attempts, but not after the last one — the loop is about to return [].
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2500))
  }
  return []
}

export interface TraceException { type?: string; message?: string; file?: string; line?: number }

function firstAppFrame(stack: string): { file?: string; line?: number } {
  const re = /(\/[^\s"()]*demo-webapp\/(?!node_modules\/)[^\s"():]+\.(?:js|ts)):(\d+):\d+/
  const match = stack.match(re)
  return match ? { file: match[1], line: Number(match[2]) } : {}
}

// Find an OTLP span attribute's string value by key, walking the parsed trace object. Tempo's
// /api/traces/{id} nests exception details in span attributes shaped { key, value: { stringValue } },
// but the container nesting (batches vs resourceSpans, span status vs events, scopeSpans vs
// instrumentationLibrarySpans) varies by Tempo/OTLP version. Recursing the whole object finds the
// attribute wherever it lives — no fixed path to guess — and returns the value JSON.parse already
// unescaped, so there is no manual regex unescaping to get wrong.
export function findAttributeString(node: unknown, key: string): string | undefined {
  if (node === null || typeof node !== 'object') return undefined
  const attr = node as { key?: unknown; value?: { stringValue?: unknown } }
  if (attr.key === key && typeof attr.value?.stringValue === 'string') return attr.value.stringValue
  for (const child of Object.values(node as Record<string, unknown>)) {
    const found = findAttributeString(child, key)
    if (found !== undefined) return found
  }
  return undefined
}

export async function tempoException(traceId: string): Promise<TraceException | null> {
  const trace = await tempoGet(`${TEMPO}/api/traces/${traceId}`)
  if (!trace) return null
  // Fall back to scanning the whole trace text if the stacktrace attribute is not found by key.
  const stacktrace = findAttributeString(trace, 'exception.stacktrace') ?? JSON.stringify(trace)
  const { file, line } = firstAppFrame(stacktrace)
  return {
    type: findAttributeString(trace, 'exception.type'),
    message: findAttributeString(trace, 'exception.message'),
    file,
    line,
  }
}

// Does a trace carry an error status? (used to classify neighbours)
export async function traceIsError(traceId: string): Promise<boolean> {
  const trace = await tempoGet(`${TEMPO}/api/traces/${traceId}`)
  if (!trace) return false
  return findAttributeString(trace, 'exception.stacktrace') !== undefined
}

// TraceQL for "this service's error traces" — the triggering-incident query. Named and shared
// by the seed, the baseline bundle, and the neighbouring-traces tool so the matcher lives once.
export function errorTraceQL(service: string): string {
  return `{ resource.service.name = "${escapeLabelValue(service)}" && status = error }`
}

// The primitive both the agent seed and the baseline fixed-bundle start from: the current
// error ratio plus the most recent error trace's exception (type/message/file:line). Kept as
// one helper so the two intentionally-separate arms share the fetch without merging outputs.
export async function fetchTriggeringTrace(
  service: string,
): Promise<{ value: number | null; traceId: string | null; exception: TraceException | null }> {
  const [value, hits] = await Promise.all([
    promInstant(METRICS.error_ratio_5xx, 'now'),
    tempoSearch(errorTraceQL(service), 1),
  ])
  const traceId = hits[0]?.traceId ?? null
  const exception = traceId ? await tempoException(traceId) : null
  return { value, traceId, exception }
}
