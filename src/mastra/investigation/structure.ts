import { Agent } from '@mastra/core/agent'
import { TriageSchema, type Triage } from './schema.ts'

// Separate structuring model: the investigation loop runs as TEXT, and this pass turns the
// narrative into the structured card.
//
// Why two passes instead of one `agent.generate` with `structuredOutput`? Mastra's
// `onStepFinish` — which the loop uses to log steps and drive the circuit-breaker tracking — is
// only available when generating text WITHOUT structured output, so the loop must run as text.
// This pass then structures that text, and a cheap model suffices. A text-parse fallback covers
// any model that still leaves `res.object` empty.
const STRUCTURING_MODEL = process.env.STRUCTURING_MODEL || 'openrouter/openai/gpt-5-mini'

const structurer = new Agent({
  id: 'triage-structurer',
  name: 'Triage Structurer',
  instructions:
    'Convert an SRE investigation write-up into the structured triage card. Copy the ' +
    "investigation's own CONCLUSION verbatim into the schema fields. Do not add citations the " +
    'write-up did not make. Do not change the disposition, recommendation, or confidence.',
  model: STRUCTURING_MODEL,
})

// The loose shape the coercion path reads: raw model output BEFORE Zod validation, so every
// field is optional and untyped. root_cause is the snake_case alias some models emit.
interface LooseTriage {
  disposition?: unknown
  recommendation?: unknown
  rootCauseHypothesis?: unknown
  root_cause?: unknown
  confidence?: unknown
  citations?: unknown
}

const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const
type Confidence = (typeof CONFIDENCE_LEVELS)[number]
function isConfidence(value: unknown): value is Confidence {
  return typeof value === 'string' && (CONFIDENCE_LEVELS as readonly string[]).includes(value)
}

function parseFallback(text: string): LooseTriage {
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      return JSON.parse(match[0]) as LooseTriage
    } catch {
      // Not valid JSON — fall through to the empty default below.
    }
  }
  return {}
}

export async function structure(investigationText: string): Promise<Triage> {
  const res = await structurer.generate(
    `Investigation write-up:\n\n${investigationText}\n\nReturn the structured triage card.`,
    { structuredOutput: { schema: TriageSchema, errorStrategy: 'warn' } },
  )
  const raw: LooseTriage = res.object
    ? (res.object as LooseTriage)
    : parseFallback(String(res.text ?? ''))
  const parsed = TriageSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  // Coerce with safe defaults so the pipeline never crashes on model variance.
  const citations = Array.isArray(raw.citations)
    ? (raw.citations.filter(
        (c: { kind?: unknown; ref?: unknown }) => c?.kind && c?.ref,
      ) as Triage['citations'])
    : []
  return {
    disposition: raw.disposition === 'actionable' ? 'actionable' : 'noise',
    recommendation:
      raw.recommendation === 'file_ticket' || raw.disposition === 'actionable'
        ? 'file_ticket'
        : 'close_as_noise',
    rootCauseHypothesis: String(raw.rootCauseHypothesis ?? raw.root_cause ?? ''),
    confidence: isConfidence(raw.confidence) ? raw.confidence : 'low',
    citations,
  }
}
