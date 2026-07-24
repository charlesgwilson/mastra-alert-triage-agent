import { Agent } from '@mastra/core/agent'
import { makeTools } from './tools.ts'
import { newLedger, type Ledger, type Seed } from './seed.ts'

// The agent-driven investigation: seed-then-explore ReAct. The agent decides
// which read-only tools to call and when it has enough; the loop is bounded in code
// (maxSteps hard cap + per-tool circuit breakers inside the tools + same-query stop).

const INVESTIGATOR_MODEL = process.env.INVESTIGATOR_MODEL || 'openrouter/anthropic/claude-sonnet-4.5'
// Guard the parse: a non-numeric MAX_STEPS must fall back, not become NaN.
const parsedMaxSteps = Number(process.env.MAX_STEPS)
const MAX_STEPS = Number.isFinite(parsedMaxSteps) ? parsedMaxSteps : 10

const INSTRUCTIONS = `You are an on-call SRE triaging a firing alert on a webapp. You are READ-ONLY:
you read telemetry and source to form a recommendation; a human decides and acts.

You are given a SEED: the firing metric's current value and its threshold, plus the
triggering error trace's exception (type, message) and the file:line its stack points to.
The seed is a starting point, not the whole picture. Investigate before you conclude.

You have four read-only tools. Use them deliberately; do not guess:
- get_baseline(metric, window): is the signal actually elevated vs one window ago, or normal?
- get_more_logs(window, filter): confirm the error string and how often it recurs.
- get_neighboring_traces(onlyErrors, limit): is this the only failing path, or one of many?
- read_source(file, line): read the code the failing trace points to, to ground a root cause.

Investigate efficiently. A good triage usually: checks the baseline to confirm the signal
is real, reads the source at the exception's file:line to explain the failure, and samples
logs or neighbouring traces to gauge blast radius. Stop when more calls would not change your
recommendation. If a tool returns a "circuit breaker" message, stop calling it and conclude.

Cite ONLY evidence a tool actually returned to you. Never invent a file:line, trace id, log
line, or metric. If evidence is thin or contradictory, prefer LOWER confidence and say why.

End your response with a CONCLUSION block, exactly this shape:

CONCLUSION:
disposition: <actionable|noise>
recommendation: <file_ticket|close_as_noise>
confidence: <low|medium|high>
root_cause: <one or two sentences naming the specific file:line and why that code fails>
citations:
- metric: <metric name you saw, e.g. error_ratio_5xx>
- source: <file:line you read, e.g. orders.js:23>
- log: <a substring of a log line you fetched>
- trace: <a trace id you saw>
(include only the citations you actually have evidence for)`

export interface InvestigationResult {
  text: string
  ledger: Ledger
  model: string
  stepLog: { step: number; tools: string[]; finishReason: string }[]
}

// The per-step payload @mastra/core hands onStepFinish. We type only the fields we read;
// a tool call reports its name at either .toolName or .payload.toolName depending on provider.
interface StepFinish {
  toolCalls?: { toolName?: string; payload?: { toolName?: string } }[]
  finishReason?: string
}

export async function runInvestigation(
  seed: Seed,
  opts: { model?: string; maxSteps?: number } = {},
): Promise<InvestigationResult> {
  const model = opts.model || INVESTIGATOR_MODEL
  const maxSteps = opts.maxSteps ?? MAX_STEPS
  const ledger = newLedger(seed)
  const tools = makeTools(ledger)

  const agent = new Agent({
    id: 'alert-triage-investigator',
    name: 'Alert Triage Investigator',
    instructions: INSTRUCTIONS,
    model,
    tools,
  })

  const seedPrompt = `A Grafana alert is firing for service "${seed.service}".

SEED:
- metric ${seed.metric.name} = ${seed.metric.value} (alert threshold ${seed.metric.threshold})
- triggering trace: ${seed.trigger.traceId ?? 'none'}
- exception: ${seed.trigger.exception?.type ?? 'n/a'}: ${seed.trigger.exception?.message ?? 'n/a'}
- exception points at: ${seed.trigger.exception?.file ?? 'n/a'}:${seed.trigger.exception?.line ?? 'n/a'}

Investigate and produce the CONCLUSION block.`

  const stepLog: InvestigationResult['stepLog'] = []

  const result = await agent.generate(seedPrompt, {
    maxSteps,
    onStepFinish: ({ toolCalls, finishReason }: StepFinish) => {
      stepLog.push({
        step: stepLog.length + 1,
        tools: (toolCalls ?? []).map((call) => call.toolName ?? call.payload?.toolName ?? 'unknown'),
        finishReason: finishReason ?? 'unknown',
      })
    },
  })

  return { text: String(result.text ?? ''), ledger, model, stepLog }
}
