/**
 * Adaptive CV selection + relevance planning (debate slice).
 *
 * Two hard rules from the panel:
 * 1. The system may NEVER mutate a CV to chase a metric. No bandits, no A/B
 *    testing, no silent rewrites. Adaptation is limited to an enumerated
 *    surface (section order, bullets-per-role, evidence prominence); anything
 *    else is refused loudly, never rewritten silently.
 * 2. The "learning" loop is dead. The coaching view below is descriptive
 *    statistics only: it never mutates any CV, and it censors ghosted
 *    applications from every denominator (a ghost is not a "no").
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Application, ApplicationState } from "../../../packages/domain/src/openapply.ts";
import { defaultPreferences, domainKinds } from "../../../packages/domain/src/openapply.ts";
import type { Store } from "./db.ts";
import {
  type ResumeContent,
  TEMPLATE_BUDGETS,
  TEMPLATES,
  type TemplateId,
} from "./foundry/model.ts";
import type { ProfileStore } from "./profile.ts";

/* ------------------------------------------------------------------ */
/* Job features                                                        */
/* ------------------------------------------------------------------ */

export type Seniority = "entry" | "mid" | "senior" | "executive";
export type Channel = "ats" | "email" | "referral";
export type Industry = "tech" | "finance" | "healthcare" | "education" | "general";

export interface JobFeatures {
  seniority: Seniority;
  industry: Industry;
  channel: Channel;
}

/** Minimal job shape the selector needs. Everything else is ignored. */
export interface JobLike {
  id: string;
  title: string;
  source: string;
  requirements?: string[];
  qualifications?: string[];
}

export interface PreferencesLike {
  role_levels?: string[];
}

const SENIORITY_KEYWORDS: Record<Exclude<Seniority, "mid">, string[]> = {
  entry: ["intern", "trainee", "graduate", "junior", "entry-level", "entry level", "apprentice"],
  senior: ["senior", "sr.", "sr ", "lead", "staff", "manager"],
  executive: [
    "director",
    "vp",
    "vice president",
    "head of",
    "chief",
    "cto",
    "cfo",
    "ceo",
    "coo",
    "president",
    "partner",
  ],
};

const INDUSTRY_KEYWORDS: Record<Exclude<Industry, "general">, string[]> = {
  tech: [
    "software",
    "engineer",
    "developer",
    "devops",
    "data",
    "machine learning",
    "frontend",
    "backend",
    "full-stack",
    "fullstack",
    "qa",
    "cyber",
    "cloud",
    "systems",
    "network",
    "mobile",
    "web",
  ],
  finance: [
    "account",
    "finance",
    "audit",
    "bank",
    "tax",
    "payroll",
    "treasury",
    "bookkeep",
    "reconciliation",
    "fintech",
  ],
  healthcare: ["nurse", "medical", "health", "clinic", "pharma", "doctor", "patient", "care"],
  education: ["teach", "lecturer", "professor", "tutor", "school", "academic", "curriculum"],
};

const ATS_SOURCES = new Set([
  "greenhouse",
  "lever",
  "ashby",
  "linkedin",
  "indeed",
  "government",
  "company_board",
]);
const EMAIL_SOURCES = new Set(["manual", "web_read", "rss"]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter(Boolean);
}

function containsKeyword(haystack: string, keyword: string): boolean {
  const h = ` ${haystack.toLowerCase()} `;
  const k = keyword.toLowerCase();
  // Multi-word keywords match as phrases; single words match whole words.
  return k.includes(" ") ? h.includes(` ${k} `) : words(haystack).includes(k);
}

function seniorityFromTitle(title: string): Seniority | null {
  for (const level of ["executive", "senior", "entry"] as const) {
    if (SENIORITY_KEYWORDS[level].some((k) => containsKeyword(title, k))) return level;
  }
  return null;
}

function seniorityFromRoleLevels(roleLevels: string[] | undefined): Seniority | null {
  if (roleLevels?.length !== 1) return null;
  const lvl = roleLevels[0]?.toLowerCase() ?? "";
  if (["entry", "junior", "intern", "graduate", "trainee"].some((k) => lvl.includes(k)))
    return "entry";
  if (["executive", "director", "vp", "chief", "head"].some((k) => lvl.includes(k)))
    return "executive";
  if (["senior", "lead", "staff", "manager"].some((k) => lvl.includes(k))) return "senior";
  return null;
}

function industryFromJob(job: JobLike): Industry {
  const haystack = [job.title, ...(job.requirements ?? []), ...(job.qualifications ?? [])].join(
    " ",
  );
  for (const industry of ["tech", "finance", "healthcare", "education"] as const) {
    if (INDUSTRY_KEYWORDS[industry].some((k) => containsKeyword(haystack, k))) return industry;
  }
  return "general";
}

/**
 * Deterministic job features. `channelOverride` is the only way to reach
 * "referral" — no job source reliably signals a referral, so it is never
 * inferred.
 */
export function extractFeatures(
  job: JobLike,
  preferences?: PreferencesLike,
  channelOverride?: Channel,
): JobFeatures {
  const fromTitle = seniorityFromTitle(job.title);
  const seniority = fromTitle ?? seniorityFromRoleLevels(preferences?.role_levels) ?? "mid";
  const channel: Channel =
    channelOverride ??
    (ATS_SOURCES.has(job.source) ? "ats" : EMAIL_SOURCES.has(job.source) ? "email" : "ats");
  return { seniority, industry: industryFromJob(job), channel };
}

/* ------------------------------------------------------------------ */
/* Template selection: explicit feature table                          */
/* ------------------------------------------------------------------ */

export interface TemplateSelection {
  template_id: TemplateId;
  reason: string;
  features: JobFeatures | null;
}

interface SelectionRow {
  when: Partial<JobFeatures>;
  template_id: TemplateId;
  reason: string;
}

/**
 * The feature table: job attributes x template attributes -> template id.
 * Ordered; the first matching row wins. Every row carries its own one-line
 * human reason, so every selection is explainable.
 */
const SELECTION_TABLE: SelectionRow[] = [
  {
    when: { seniority: "executive" },
    template_id: "template-four",
    reason:
      "Chose the Executive template: this is a senior leadership role with room for a two-page narrative.",
  },
  {
    when: { channel: "ats", seniority: "entry" },
    template_id: "template-three",
    reason:
      "Chose the Compact template: this is an ATS-portal graduate role, so a dense single page keeps it parseable and tight.",
  },
  {
    when: { channel: "ats" },
    template_id: "template-seven",
    reason:
      "Chose the ATS Classic template: this role goes through an ATS portal, so parser compatibility comes first.",
  },
  {
    when: { seniority: "entry" },
    template_id: "template-three",
    reason:
      "Chose the Compact template: this is an entry-level role, so a dense single page keeps the focus tight.",
  },
  {
    when: { seniority: "senior" },
    template_id: "template-three",
    reason:
      "Chose the Compact template: a senior role needs room for depth on a single dense page.",
  },
  {
    when: { industry: "tech" },
    template_id: "template-two",
    reason: "Chose the Modern Accent template: tech hiring favors a clean, modern read.",
  },
  {
    when: { industry: "finance" },
    template_id: "template-six",
    reason: "Chose the Corporate Grid template: finance hiring favors a formal, corporate read.",
  },
  {
    when: { channel: "referral" },
    template_id: "template-five",
    reason:
      "Chose the Minimal template: a referral is read by a human first, so quiet typography beats keyword density.",
  },
  {
    when: { channel: "email" },
    template_id: "template-one",
    reason: "Chose the Classic Cream template: a direct application lands in a human inbox first.",
  },
  {
    when: {},
    template_id: "template-one",
    reason:
      "Chose the Classic Cream template: no strong signal stood out, so the familiar default is safest.",
  },
];

const TEMPLATE_IDS: Set<string> = new Set(TEMPLATES.map((t) => t.id));

/** Type guard for template ids (requested templates are free-form strings). */
export function isTemplateId(id: string): id is TemplateId {
  return TEMPLATE_IDS.has(id);
}

/**
 * Deterministic template selection. `fallback` is the requested template and
 * is returned untouched when the job is unknown (null) — the selector never
 * guesses from nothing.
 */
export function selectTemplate(
  job: JobLike | null,
  preferences: PreferencesLike | undefined,
  fallback: string,
  channelOverride?: Channel,
): TemplateSelection {
  const fallbackId = (TEMPLATE_IDS.has(fallback) ? fallback : TEMPLATES[0].id) as TemplateId;
  if (!job) {
    return {
      template_id: fallbackId,
      reason: "Kept the requested template: the job details were unavailable.",
      features: null,
    };
  }
  const features = extractFeatures(job, preferences, channelOverride);
  const row = SELECTION_TABLE.find((r) =>
    (Object.keys(r.when) as (keyof JobFeatures)[]).every((k) => r.when[k] === features[k]),
  );
  if (!row) throw new Error("adaptive-cv: selection table has no default row");
  return { template_id: row.template_id, reason: row.reason, features };
}

export interface TemplateSelectionDeps {
  recordEvent(owner: string, type: string, payload: Record<string, unknown>): Promise<unknown>;
}

/** Log every selection as `cv.template_selected` — the audit trail. */
export async function recordTemplateSelection(
  deps: TemplateSelectionDeps,
  owner: string,
  application_id: string,
  job_id: string,
  selection: TemplateSelection,
  requested_template_id: string,
): Promise<void> {
  await deps.recordEvent(owner, "cv.template_selected", {
    application_id,
    job_id,
    template_id: selection.template_id,
    reason: selection.reason,
    requested_template_id,
    features: selection.features,
    at: new Date().toISOString(),
  });
}

/* ------------------------------------------------------------------ */
/* Mutation surface: enumerated, refused loudly                         */
/* ------------------------------------------------------------------ */

export const SECTION_NAMES = [
  "experience",
  "projects",
  "education",
  "skills",
  "certificates",
] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

/**
 * The ONLY things adaptation may change. Titles, skill claims, dates,
 * employers, degrees — anything else — are not adaptation and are refused.
 */
export interface ResumeAdaptation {
  /** Full section order (a permutation of all sections). */
  section_order: SectionName[];
  /** Entry titles trimmed to at most this many bullets (template budget). */
  bullets_per_entry: Record<string, number>;
  /** Evidence ids that should lead their sections (prominence). */
  lead_evidence_ids: string[];
}

function isSectionName(value: unknown): value is SectionName {
  return typeof value === "string" && (SECTION_NAMES as readonly string[]).includes(value);
}

/**
 * Strict allowlist validation. Unknown keys, wrong shapes, or anything
 * outside the enumerated surface throws — never silently rewritten, never
 * silently dropped.
 */
export function validateAdaptation(input: unknown): ResumeAdaptation {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error(
      "adaptation refused: expected an object with only section_order, bullets_per_entry, lead_evidence_ids",
    );
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["section_order", "bullets_per_entry", "lead_evidence_ids"].includes(key))
      throw new Error(
        `adaptation refused: "${key}" is outside the allowed mutation surface ` +
          `(section order, bullets-per-role, evidence prominence)`,
      );
  }
  const section_order = record.section_order;
  if (
    !Array.isArray(section_order) ||
    section_order.length !== SECTION_NAMES.length ||
    !section_order.every(isSectionName) ||
    new Set(section_order).size !== SECTION_NAMES.length
  )
    throw new Error(
      "adaptation refused: section_order must be a permutation of all sections " +
        `(${SECTION_NAMES.join(", ")})`,
    );
  const bullets_per_entry = record.bullets_per_entry ?? {};
  if (
    typeof bullets_per_entry !== "object" ||
    bullets_per_entry === null ||
    Array.isArray(bullets_per_entry)
  )
    throw new Error("adaptation refused: bullets_per_entry must be an object");
  for (const [title, count] of Object.entries(bullets_per_entry)) {
    if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 20)
      throw new Error(`adaptation refused: bullets_per_entry["${title}"] must be an integer 1..20`);
  }
  const lead_evidence_ids = record.lead_evidence_ids ?? [];
  if (
    !Array.isArray(lead_evidence_ids) ||
    !lead_evidence_ids.every((id) => typeof id === "string" && id.length > 0)
  )
    throw new Error("adaptation refused: lead_evidence_ids must be an array of non-empty strings");
  return {
    section_order: section_order as SectionName[],
    bullets_per_entry: bullets_per_entry as Record<string, number>,
    lead_evidence_ids,
  };
}

/* ------------------------------------------------------------------ */
/* Relevance-only section planning                                      */
/* ------------------------------------------------------------------ */

export interface SectionPlanItem {
  section: SectionName;
  order: number;
  /** Title of the real entry that leads this section, if any. */
  leads_with: string | null;
  /** One-line explanation. */
  why: string;
}

export interface SectionPlan {
  items: SectionPlanItem[];
  adaptation: ResumeAdaptation;
}

export interface PlanSectionsInput {
  template_id: TemplateId;
  job: Pick<JobLike, "title" | "requirements" | "qualifications">;
  resume: ResumeContent;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "will",
  "are",
  "was",
  "have",
  "has",
  "our",
  "you",
  "your",
  "their",
  "they",
  "them",
  "its",
  "into",
  "over",
  "under",
  "between",
  "through",
  "during",
  "each",
  "other",
  "more",
  "most",
  "such",
  "only",
  "also",
  "than",
  "then",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "what",
  "about",
  "into",
  "out",
  "off",
  "all",
  "any",
  "both",
  "few",
  "how",
  "her",
  "his",
  "him",
  "she",
  "per",
  "via",
  "within",
  "without",
  "including",
  "using",
  "used",
  "use",
  "role",
  "job",
  "work",
  "team",
  "ability",
  "strong",
  "good",
  "excellent",
  "looking",
  "seeking",
  "join",
  "help",
  "day",
]);

function contentKeywords(text: string): Set<string> {
  return new Set(words(text).filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

function overlap(entryText: string, jobKeywords: Set<string>): number {
  let hits = 0;
  for (const w of contentKeywords(entryText)) if (jobKeywords.has(w)) hits++;
  return hits;
}

/**
 * Deterministic relevance plan: which real experience leads, per section.
 * Pure — it returns the plan (and the machine-readable adaptation) without
 * applying anything. The caller logs it and shows it at pack review, where
 * the user can reject it.
 */
export function planSections(input: PlanSectionsInput): SectionPlan {
  const jobKeywords = contentKeywords(
    [input.job.title, ...(input.job.requirements ?? []), ...(input.job.qualifications ?? [])].join(
      " ",
    ),
  );
  const budget = TEMPLATE_BUDGETS[input.template_id];

  const sections: Array<{
    section: SectionName;
    score: number;
    hits: number;
    topEntry: string | null;
    entries: Array<{ title: string; bullets: string[] }>;
  }> = SECTION_NAMES.map((section) => {
    const raw = input.resume[section] as Array<{ title?: string; bullets?: string[] }> | undefined;
    const entries = Array.isArray(raw)
      ? raw.map((e) => ({ title: e.title ?? "", bullets: e.bullets ?? [] }))
      : [];
    let best = { score: -1, hits: 0, title: null as string | null };
    for (const entry of entries) {
      const text = [entry.title, ...entry.bullets].join(" ");
      const score = overlap(text, jobKeywords);
      if (score > best.score) best = { score, hits: score, title: entry.title || null };
    }
    return {
      section,
      score: best.score,
      hits: best.hits,
      topEntry: best.title,
      entries,
    };
  });

  // Order by relevance; ties keep the canonical section order (deterministic).
  const canonical = new Map(SECTION_NAMES.map((s, i) => [s, i] as const));
  const ordered = [...sections].sort(
    (a, b) =>
      b.score - a.score || (canonical.get(a.section) ?? 0) - (canonical.get(b.section) ?? 0),
  );

  const items: SectionPlanItem[] = ordered.map((s, i) => ({
    section: s.section,
    order: i,
    leads_with: s.topEntry,
    why:
      s.entries.length === 0
        ? `No ${s.section} entries on file — placed last.`
        : i === 0
          ? `Leads with "${s.topEntry ?? s.section}": ${s.hits} job keyword${s.hits === 1 ? "" : "s"} matched, the strongest signal on the page.`
          : `"${s.topEntry ?? s.section}" matched ${s.hits} job keyword${s.hits === 1 ? "" : "s"} — ordered by relevance.`,
  }));

  // Bullets-per-role: trim only what exceeds the selected template's budget.
  const bullets_per_entry: Record<string, number> = {};
  for (const s of sections) {
    for (const entry of s.entries) {
      if (entry.title && entry.bullets.length > budget.max_bullets_per_entry)
        bullets_per_entry[entry.title] = budget.max_bullets_per_entry;
    }
  }

  const adaptation = validateAdaptation({
    section_order: ordered.map((s) => s.section),
    bullets_per_entry,
    lead_evidence_ids: [],
  });
  return { items, adaptation };
}

/* ------------------------------------------------------------------ */
/* Coaching view: descriptive stats only                               */
/* ------------------------------------------------------------------ */

/** States where the employer's behavior is known. Ghosts are censored. */
const KNOWN_OUTCOME_STATES: ReadonlySet<ApplicationState> = new Set([
  "closed_lost",
  "closed_won",
  "interviewing",
]);
/** Known outcomes where the employer engaged (a reply worth counting). */
const REPLY_STATES: ReadonlySet<ApplicationState> = new Set(["interviewing", "closed_won"]);

const MIN_KNOWN_OUTCOMES = 5;

export interface CoachingDetail {
  detail: string;
  evidence_id: string;
  cited_in: number;
  replies: number;
  reply_rate: number;
  n: number;
}

export type CoachingResult =
  | {
      status: "insufficient_data";
      message: string;
      known_outcomes: number;
      read_only: true;
    }
  | {
      status: "ok";
      read_only: true;
      note: string;
      known_outcomes: number;
      details: CoachingDetail[];
    };

export interface CoachingEvidenceItem {
  id: string;
  file_name: string;
  text_excerpt: string;
}

export interface CoachingDeps {
  db: Store;
  dataDir: string;
  /** Minimal surface: coaching only reads confirmed evidence items. */
  profileStore: {
    get(owner: string): Promise<{ evidence: CoachingEvidenceItem[] }>;
  };
}

async function evidenceIdsForApplication(
  deps: CoachingDeps,
  owner: string,
  application_id: string,
): Promise<string[]> {
  const artifacts = await deps.db.list<{ id: string; kind: string; application_id?: string }>(
    owner,
    domainKinds.artifacts,
  );
  const drafts = artifacts.filter(
    (a) => a.kind === "resume_draft" && a.application_id === application_id,
  );
  if (drafts.length === 0) return [];
  const withTime = await Promise.all(
    drafts.map(async (d) => {
      const full = await deps.db.get<{ created_at?: string }>(owner, domainKinds.artifacts, d.id);
      return { id: d.id, at: full?.created_at ?? "" };
    }),
  );
  withTime.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const latest = withTime[0];
  try {
    const raw = await readFile(join(deps.dataDir, "drafts", `${latest.id}.json`), "utf8");
    const parsed = JSON.parse(raw) as { evidence_ids_used?: unknown };
    return Array.isArray(parsed.evidence_ids_used)
      ? parsed.evidence_ids_used.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Descriptive statistics only: for each evidence detail cited in packs, how
 * often applications citing it reached a known outcome, and how often the
 * employer engaged. Ghosted applications are censored from every denominator
 * (a ghost is not a "no"). READ-ONLY — it never mutates any CV.
 */
export async function buildCoaching(deps: CoachingDeps, owner: string): Promise<CoachingResult> {
  const applications = await deps.db.list<Application>(owner, domainKinds.applications);
  const packed = applications.filter((a) => a.pack_id);
  const profile = await deps.profileStore.get(owner);
  const evidenceById = new Map(profile.evidence.map((e) => [e.id, e]));

  const known = packed.filter((a) => KNOWN_OUTCOME_STATES.has(a.state));
  if (known.length < MIN_KNOWN_OUTCOMES) {
    return {
      status: "insufficient_data",
      message: `Not enough completed applications yet — ${MIN_KNOWN_OUTCOMES} needed.`,
      known_outcomes: known.length,
      read_only: true,
    };
  }

  const citedBy = new Map<string, Application[]>();
  for (const app of known) {
    const ids = await evidenceIdsForApplication(deps, owner, app.id);
    for (const id of new Set(ids)) {
      const list = citedBy.get(id) ?? [];
      list.push(app);
      citedBy.set(id, list);
    }
  }

  const details: CoachingDetail[] = [...citedBy.entries()].map(([evidence_id, apps]) => {
    const replies = apps.filter((a) => REPLY_STATES.has(a.state)).length;
    const item = evidenceById.get(evidence_id);
    const detail = item?.text_excerpt?.slice(0, 80) || item?.file_name || evidence_id;
    const n = apps.length;
    return {
      detail,
      evidence_id,
      cited_in: n,
      replies,
      reply_rate: n === 0 ? 0 : Math.round((replies / n) * 100) / 100,
      n,
    };
  });
  details.sort((a, b) => b.cited_in - a.cited_in || b.replies - a.replies);

  return {
    status: "ok",
    read_only: true,
    note: "Descriptive statistics only. This view never mutates any CV.",
    known_outcomes: known.length,
    details,
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function registerAdaptiveCvRoutes(
  app: Hono<{ Variables: { owner: string } }>,
  db: Store,
  dataDir: string,
  profileStore: ProfileStore,
): void {
  app.get("/api/cv/coaching", async (c) => {
    const owner = c.get("owner");
    return c.json(await buildCoaching({ db, dataDir, profileStore }, owner));
  });
}

/** Preferences read for the pipeline (mirrors DomainService.getPreferences). */
export async function readPreferencesForPipeline(
  db: Store,
  owner: string,
): Promise<{ role_levels?: string[] }> {
  const stored = await db.get<Partial<typeof defaultPreferences>>(
    owner,
    domainKinds.preferences,
    "default",
  );
  return { role_levels: stored?.role_levels ?? defaultPreferences.role_levels };
}
