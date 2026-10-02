/**
 * Zod schemas for the v2 document-runner outputs. These mirror the Foundry
 * content model (apps/server/src/foundry/model.ts) plus the role-specific
 * metadata each prompt promises.
 */
import { z } from "zod";

/**
 * Smaller models (e.g. gemini-2.5-flash-lite) emit explicit null for unknown
 * optional fields instead of omitting them. Normalize null to undefined before
 * the optional check so one model quirk can't fail validation.
 */
const nullToUndefined = (v: unknown) => (v === null ? undefined : v);
const optString = () => z.preprocess(nullToUndefined, z.string().optional());
const optStringDefault = (def: string) =>
  z.preprocess(nullToUndefined, z.string().optional().default(def));

const datedEntry = z.object({
  title: z.string(),
  tag: optString(),
  tag_url: optString(),
  dates: optStringDefault(""),
  bullets: z.array(z.string()).optional().default([]),
});

export const resumeContentSchema = z.object({
  full_name: z.string().min(1),
  links: z
    .array(z.object({ label: z.string(), url: z.string() }))
    .optional()
    .default([]),
  email: optStringDefault(""),
  mobile: optStringDefault(""),
  education: z
    .array(
      z.object({
        institution: z.string(),
        location: optStringDefault(""),
        degree: z.string(),
        dates: optStringDefault(""),
      }),
    )
    .optional()
    .default([]),
  skills: z
    .array(z.object({ category: z.string(), items: z.string() }))
    .optional()
    .default([]),
  experience: z.array(datedEntry).optional().default([]),
  projects: z.array(datedEntry).optional().default([]),
  certificates: z.array(datedEntry).optional().default([]),
});

export const resumeRunOutputSchema = z.object({
  resume_content: resumeContentSchema,
  keywords_used: z.array(z.string()).optional().default([]),
  missing_evidence: z.array(z.string()).optional().default([]),
  evidence_ids_used: z.array(z.string()).optional().default([]),
  notes_for_hr_reviewer: z.array(z.string()).optional().default([]),
});

const claimSchema = z.object({
  text: z.string(),
  evidence_id: optStringDefault(""),
});

export const coverContentSchema = z.object({
  full_name: z.string().min(1),
  email: optStringDefault(""),
  mobile: optStringDefault(""),
  links: z
    .array(z.object({ label: z.string(), url: z.string() }))
    .optional()
    .default([]),
  date: optStringDefault(""),
  recipient_name: optStringDefault(""),
  recipient_title: optString(),
  company: z.string().min(1),
  address_lines: z.array(z.string()).optional().default([]),
  salutation: optStringDefault(""),
  paragraphs: z.array(z.string()).min(1),
  closing: optStringDefault(""),
});

export const coverRunOutputSchema = z.object({
  cover_content: coverContentSchema,
  claims: z.array(claimSchema).optional().default([]),
  questions_for_user: z.array(z.string()).optional().default([]),
});

export const statementContentSchema = z.object({
  full_name: z.string().min(1),
  email: optStringDefault(""),
  mobile: optStringDefault(""),
  title: optStringDefault(""),
  paragraphs: z.array(z.string()).min(1),
  date: optStringDefault(""),
});

export const statementRunOutputSchema = z.object({
  statement_content: statementContentSchema,
  claims: z.array(claimSchema).optional().default([]),
  questions_for_user: z.array(z.string()).optional().default([]),
});

export type ResumeRunOutput = z.infer<typeof resumeRunOutputSchema>;
export type CoverRunOutput = z.infer<typeof coverRunOutputSchema>;
export type StatementRunOutput = z.infer<typeof statementRunOutputSchema>;

/* ---------- Slice 8: HR review (detector-evasion pass removed, ADR-021) ---------- */

const findingSchema = z.object({
  severity: z.enum(["blocker", "warn", "note"]),
  location: z.string(),
  issue: z.string(),
  fix: z.string(),
});

export const hrReviewOutputSchema = z.object({
  findings: z.array(findingSchema).optional().default([]),
  resume_final_candidate: resumeContentSchema,
  cover_final_candidate: coverContentSchema,
  statement_final_candidate: statementContentSchema.nullable().optional(),
  can_approve: z.boolean(),
});

export type HrReviewOutput = z.infer<typeof hrReviewOutputSchema>;
