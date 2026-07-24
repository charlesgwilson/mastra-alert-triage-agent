import { z } from 'zod'

// The structured triage card. The investigation loop runs as TEXT (so Mastra's onStepFinish is
// available — it is not, alongside structured output); a SEPARATE structuring model then turns
// the narrative into this object. See investigation/structure.ts for why the passes are split.
export const TriageSchema = z.object({
  disposition: z.enum(['actionable', 'noise']),
  recommendation: z.enum(['file_ticket', 'close_as_noise']),
  rootCauseHypothesis: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
  citations: z.array(
    z.object({
      kind: z.enum(['metric', 'trace', 'log', 'source']),
      ref: z.string().describe('the concrete value: metric name, trace id, a log substring, or file:line'),
    }),
  ),
})
export type Triage = z.infer<typeof TriageSchema>
