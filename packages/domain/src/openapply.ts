import { z } from "zod";

/**
 * OpenApply domain model, per docs/DOMAIN.md.
 *
 * These are the product's domain rows (jobs, applications, artifacts, events).
 * They are intentionally separate from the chassis file/workspace types in
 * index.ts: a domain Artifact is an evidence or pack artifact with a sha256
 * and a storage path, not an OpenMuse PDF workspace file.
 */

export const jobSourceSchema = z.enum([
  "greenhouse",
  "lever",
  "ashby",
  "linkedin",
  "indeed",
  "government",
  "company_board",
  "rss",
  "web_read",
  "manual",
]);
export type JobSource = z.infer<typeof jobSourceSchema>;

export interface JobPosting {
  id: string;
  source: JobSource;
  /** Stable per-source id (Greenhouse job id, Lever posting id). Used for dedup. */
  external_id?: string;
  source_url: string;
  apply_url?: string;
  company_name: string;
  title: string;
  location_text: string;
  remote_type?: string;
  posted_at?: string;
  raw_text: string;
  requirements: string[];
  qualifications: string[];
  salary_text?: string;
  content_hash: string;
  first_seen_at: string;
  last_seen_at: string;
  is_active: boolean;
}

export const jobPostingInputSchema = z.object({
  source: jobSourceSchema,
  external_id: z.string().trim().min(1).max(200).optional(),
  source_url: z.url().trim().min(1).max(2000),
  apply_url: z.url().trim().max(2000).optional(),
  company_name: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  location_text: z.string().trim().max(200).default(""),
  remote_type: z.string().trim().max(50).optional(),
  posted_at: z.string().trim().max(64).optional(),
  raw_text: z.string().max(200000).default(""),
  requirements: z.array(z.string().max(2000)).max(200).default([]),
  qualifications: z.array(z.string().max(2000)).max(200).default([]),
  salary_text: z.string().trim().max(200).optional(),
  content_hash: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/, "content_hash must be a sha256 hex digest")
    .optional(),
  is_active: z.boolean().default(true),
});
export type JobPostingInput = z.infer<typeof jobPostingInputSchema>;

export const artifactKindSchema = z.enum([
  "source_upload",
  "linkedin_export",
  "extracted_profile",
  "master_resume",
  "certificate",
  "transcript",
  "license",
  "award",
  "portfolio",
  "publication",
  "recommendation",
  "statement_sample",
  "job_snapshot",
  "company_brief",
  "resume_draft",
  "cover_draft",
  "statement_draft",
  "hr_review",
  "resume_final_candidate",
  "cover_final_candidate",
  "statement_final_candidate",
  "resume_approved",
  "cover_approved",
  "statement_approved",
  "pack_manifest",
  "form_snapshot",
  "receipt",
]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  parent_id?: string;
  application_id?: string;
  mime: string;
  sha256: string;
  byte_size: number;
  storage_path: string;
  agent_role?: string;
  model_id?: string;
  created_at: string;
}

export const applicationStateSchema = z.enum([
  // "discovered" is reserved: applications are created directly at "ranked".
  // Kept in the enum for forward compatibility; nothing assigns it today.
  "discovered",
  "ranked",
  "shortlisted",
  "pack_drafting",
  "pack_review",
  "pack_approved",
  "session_needed",
  "prefilled",
  "submit_ready",
  "submitted",
  "awaiting_reply",
  "interviewing",
  "ghosted",
  "closed_won",
  "closed_lost",
  "withdrawn",
]);
export type ApplicationState = z.infer<typeof applicationStateSchema>;

export interface Application {
  id: string;
  job_id: string;
  state: ApplicationState;
  /** When the current state was entered (ISO). Powers days-in-state, stall
   *  detection, and the dashboard timeline. Set on every transition. */
  state_entered_at?: string;
  pack_id?: string;
  browser_profile_key?: string;
  last_form_snapshot_artifact_id?: string;
  submitted_at?: string;
  close_reason?: string;
}

export interface AgentRun {
  id: string;
  role: string;
  status: string;
  job_id?: string;
  application_id?: string;
  input_artifact_ids: string[];
  output_artifact_ids: string[];
  model_logical_name?: string;
  model_id?: string;
  usage_json?: Record<string, unknown>;
  error_class?: string;
  error_message?: string;
  started_at: string;
  ended_at?: string;
}

export const approvalTargetSchema = z.enum([
  "resume",
  "cover",
  "statement",
  "pack",
  "submit",
  "outbound_email",
]);
export type ApprovalTarget = z.infer<typeof approvalTargetSchema>;

export const approvalStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export interface Approval {
  id: string;
  application_id: string;
  target: ApprovalTarget;
  status: ApprovalStatus;
  decided_at?: string;
  note?: string;
}

export interface CompanyBrief {
  job_id: string;
  summary: string;
  evidence_urls: string[];
  generated_at: string;
  agent_run_id?: string;
}

export interface EvidenceItem {
  artifact_id: string;
  kind:
    | "certificate"
    | "transcript"
    | "license"
    | "award"
    | "portfolio"
    | "publication"
    | "recommendation"
    | "statement_sample";
  title: string;
  issuer?: string;
  issued_on?: string;
  expires_on?: string;
  credential_id?: string;
  url?: string;
  summary?: string;
  skill_tags: string[];
}

export interface UserProfile {
  id: string;
  display_name: string;
  headline?: string;
  work_authorization_text?: string;
  locations_allowed: string[];
  languages: string[];
  education: unknown[];
  experience: unknown[];
  skills: string[];
  projects: unknown[];
  certifications: unknown[];
  links: string[];
  master_resume_artifact_id?: string;
  evidence_artifact_ids: string[];
  voice_samples: string[];
  statement_samples: string[];
  forgotten_fact_ids: string[];
  updated_at: string;
}

export interface Preference {
  scan_interval_hours: number;
  countries: string[];
  role_levels: string[];
  titles_include: string[];
  titles_exclude: string[];
  keywords: string[];
  exclude_companies: string[];
  work_modes: string[];
  salary_floor?: number;
  salary_currency?: string;
  sources_enabled: string[];
  max_strong_model_packs_per_cycle: number;
  max_cheap_model_calls_per_cycle: number;
  notify_channels: string[];
  timezone?: string;
}

/** Qualification level, asked with dignity during onboarding. Binds to draft
 *  gates so a manual-work user never receives white-collar drafts. */
export const qualificationLevelSchema = z.enum([
  "none_manual",
  "vocational",
  "graduate",
  "postgraduate",
  "experienced_professional",
]);
export type QualificationLevel = z.infer<typeof qualificationLevelSchema>;

export const preferenceSchema = z.object({
  /** Schema version. Bumped on every write; Profile/Preferences are the
   *  versioned single source of truth everything writes through. */
  version: z.number().int().min(1).default(1),
  scan_interval_hours: z.number().int().min(6).max(24),
  countries: z.array(z.string()).default([]),
  role_levels: z.array(z.string()).default([]),
  qualification_level: qualificationLevelSchema.optional(),
  titles_include: z.array(z.string()).default([]),
  titles_exclude: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  exclude_companies: z.array(z.string()).default([]),
  work_modes: z.array(z.string()).default([]),
  salary_floor: z.number().optional(),
  salary_currency: z.string().max(8).optional(),
  sources_enabled: z.array(z.string()).default([]),
  ats_boards: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  max_strong_model_packs_per_cycle: z.number().int().min(1).default(5),
  max_cheap_model_calls_per_cycle: z.number().int().min(1).default(200),
  notify_channels: z.array(z.string()).default([]),
  timezone: z.string().max(64).optional(),
  /** Selected avatar mark id (see apps/mobile/src/avatars.tsx). */
  avatar: z.string().max(40).default("open-ring"),
  onboarding_completed: z.boolean().default(false),
  onboarding_completed_at: z.string().optional(),
  /** Days of employer silence before an application is marked ghosted. */
  ghosted_after_days: z.number().int().min(7).max(90).default(21),
});

/** Model providers that can be connected, per ADR-016. The legacy single
 * "custom" slot is kept for backwards compatibility; new user-defined
 * providers live in `custom_providers` (Slice 15) and are referenced by id. */
export const modelProviderIdSchema = z.enum([
  "openai",
  "anthropic",
  "xai",
  "google",
  "openai-compatible",
  "custom",
  "chatgpt",
  "grok",
]);
export type ModelProviderId = z.infer<typeof modelProviderIdSchema>;

/** Server-minted ids for user-defined custom providers look like
 *  `custom_<slug>_<rand>` (e.g. `custom_nebius-token-factory_a1b2`). The
 *  second underscore separates the random suffix, so `_` is allowed in the
 *  body. Exported so the server can recognise custom ids without regex drift. */
const customProviderIdPattern = /^custom_[a-z0-9_-]{1,32}$/;
export function isCustomProviderId(id: string): boolean {
  return customProviderIdPattern.test(id);
}

/** A user-defined custom provider (Slice 15). Stored per owner in
 * `ModelSettings.custom_providers`; the API key lives in the encrypted vault
 * under `model:custom:<id>` and never in this record. */
export const customProviderSchema = z.object({
  id: z.string().regex(customProviderIdPattern),
  label: z.string().trim().min(1).max(80),
  base_url: z
    .string()
    .trim()
    .url()
    .refine((url) => url.startsWith("https://"), "base_url must be an https URL"),
  model_id: z.string().trim().min(1).max(120),
  created_at: z.string(),
});
export type CustomProvider = z.infer<typeof customProviderSchema>;

/** Any provider reference a tier or role override may name: a built-in id or
 * a user-defined custom provider id. Kept as a bounded string on purpose —
 * owner-scoped existence is validated in domain.updatePreferences, where
 * unknown ids fail with HTTP 400 instead of failing Zod shape checks first. */
export const modelProviderRefSchema = z.string().trim().min(1).max(64);
export type ModelProviderRef = z.infer<typeof modelProviderRefSchema>;

/** Per-role model override for Slice 14 (Nebius hackathon). Keyed by
 * instructions_ref; the gateway routes that role's calls to the override
 * provider/model instead of the tier mapping. Empty by default: nothing is
 * routed anywhere until the user connects the provider and sets an override. */
export const roleModelOverrideSchema = z.object({
  provider: modelProviderRefSchema,
  model: z.string().trim().min(1).max(120),
});
export type RoleModelOverride = z.infer<typeof roleModelOverrideSchema>;

/** MODELS.md settings: which connected account backs each tier, plus the
 * user's own custom providers (Slice 15). */
export const modelSettingsSchema = z.object({
  cheap_provider: modelProviderRefSchema.optional(),
  cheap_model: z.string().trim().min(1).max(120).optional(),
  strong_provider: modelProviderRefSchema.optional(),
  strong_model: z.string().trim().min(1).max(120).optional(),
  role_models: z.record(z.string(), roleModelOverrideSchema).optional(),
  custom_providers: z.array(customProviderSchema).default([]),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;

/** PUT /api/preferences accepts any subset of preference + model settings.
 * `custom_providers` is deliberately excluded: those records are created
 * only through POST /api/models/custom/connect, which also stores the API
 * key in the encrypted vault. Direct writes cannot smuggle in a provider
 * record with no credential behind it. */
export const preferencesInputSchema = preferenceSchema
  .partial()
  .merge(modelSettingsSchema.omit({ custom_providers: true }));
export type PreferencesInput = z.infer<typeof preferencesInputSchema>;

/** Stored preferences: full preference fields plus model settings. */
export type StoredPreferences = z.output<typeof preferenceSchema> &
  z.output<typeof modelSettingsSchema>;

export const defaultPreferences: StoredPreferences = {
  version: 1,
  scan_interval_hours: 12,
  countries: [],
  role_levels: [],
  titles_include: [],
  titles_exclude: [],
  keywords: [],
  exclude_companies: [],
  work_modes: [],
  sources_enabled: ["greenhouse", "lever"],
  ats_boards: [],
  max_strong_model_packs_per_cycle: 5,
  max_cheap_model_calls_per_cycle: 200,
  notify_channels: [],
  avatar: "open-ring",
  onboarding_completed: false,
  ghosted_after_days: 21,
  cheap_provider: undefined,
  cheap_model: undefined,
  strong_provider: undefined,
  strong_model: undefined,
  role_models: undefined,
  custom_providers: [],
};

/** DOMAIN.md "Event". Named DomainEvent to avoid colliding with the DOM Event type. */
export interface DomainEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  notify: boolean;
  created_at: string;
  delivered_channels: string[];
}

/** Record kinds used in the shared records table for domain rows. */
export const domainKinds = {
  jobPostings: "job_postings",
  artifacts: "domain_artifacts",
  events: "domain_events",
  applications: "applications",
  agentRuns: "agent_runs",
  approvals: "approvals",
  profiles: "profiles",
  evidence: "evidence",
  preferences: "preferences",
  companyBriefs: "company_briefs",
} as const;
