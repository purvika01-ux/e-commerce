import { z } from 'zod';

/**
 * Strict schema for what the AI may return. Lengths are generous here; COPY_POLICY in the
 * validator applies the configured limits. rationale and confidence are stored for display only.
 */
export const ProposalSchema = z
  .object({
    decision: z.enum(['offer', 'no_offer']),
    offerId: z.string().max(64).nullable(),
    headline: z.string().max(200).nullable(),
    body: z.string().max(1000).nullable(),
    rationale: z.string().min(1).max(600),
    confidence: z.number().min(0).max(1).nullable(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.decision === 'offer') {
      if (!p.offerId) ctx.addIssue({ code: 'custom', path: ['offerId'], message: 'offerId is required when decision is "offer"' });
      if (!p.headline || !p.headline.trim()) ctx.addIssue({ code: 'custom', path: ['headline'], message: 'headline is required' });
      if (!p.body || !p.body.trim()) ctx.addIssue({ code: 'custom', path: ['body'], message: 'body is required' });
    }
  });

export type Proposal = z.infer<typeof ProposalSchema>;

/** Schema sent to the model as the structured output format (no refinements; we re-check above). */
export const ProposalOutputSchema = z.object({
  decision: z.enum(['offer', 'no_offer']),
  offerId: z.string().nullable(),
  headline: z.string().nullable(),
  body: z.string().nullable(),
  rationale: z.string(),
  confidence: z.number().nullable(),
});
