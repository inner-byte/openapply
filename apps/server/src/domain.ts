import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActivityEntry } from "../../../packages/domain/src/index.ts";
import {
  type Application,
  type Artifact,
  type CustomProvider,
  customProviderSchema,
  type DomainEvent,
  defaultPreferences,
  domainKinds,
  type JobPosting,
  type JobPostingInput,
  jobPostingInputSchema,
  modelProviderIdSchema,
  preferencesInputSchema,
  type StoredPreferences,
} from "../../../packages/domain/src/openapply.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import { notifyOwner } from "./notifier.ts";
import { type JobScore, RANK_THRESHOLD, scoreJob } from "./ranker.ts";

/** Accepted inbox uploads, per docs/FILES.md. */
const inboxMime: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  zip: "application/zip",
};
const inboxMaxBytes = 10 * 1024 * 1024;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Dedup key for a posting: caller-supplied content_hash, or a hash of the canonical fields. */
export function jobContentHash(
  input: Pick<
    JobPostingInput,
    "source" | "source_url" | "company_name" | "title" | "location_text" | "raw_text"
  >,
): string {
  return sha256Hex(
    Buffer.from(
      [
        input.source,
        input.source_url,
        input.company_name,
        input.title,
        input.location_text,
        input.raw_text,
      ].join("\n"),
      "utf8",
    ),
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

function safeFileName(name: string): string {
  return (
    Array.from(name.split(/[\\/]/).at(-1) ?? "upload")
      .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
      .join("")
      .slice(0, 180) || "upload"
  );
}

function eventSummary(
  type: string,
  payload: Record<string, unknown>,
): { title: string; detail: string } {
  switch (type) {
    case "job.discovered":
      return {
        title: "Job discovered",
        detail: `${String(payload.company_name ?? "")} — ${String(payload.title ?? "")}`.trim(),
      };
    case "artifact.uploaded":
      return { title: "File uploaded", detail: String(payload.name ?? payload.artifact_id ?? "") };
    default:
      return { title: type, detail: "" };
  }
}

export class DomainService {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
  ) {}

  /** Persist a domain event and mirror it into the Activity feed. */
  async recordEvent(
    owner: string,
    type: string,
    payload: Record<string, unknown>,
    notify = false,
  ): Promise<DomainEvent> {
    const event: DomainEvent = {
      id: randomUUID(),
      type,
      payload,
      notify,
      created_at: new Date().toISOString(),
      delivered_channels: [],
    };
    await this.db.put(owner, domainKinds.events, event);
    const summary = eventSummary(type, payload);
    const entry: ActivityEntry = {
      id: randomUUID(),
      title: summary.title,
      detail: summary.detail,
      date: event.created_at,
      status: "domain",
    };
    await this.db.put(owner, "activity", entry);
    return event;
  }

  /**
   * Insert a job posting. Dedup by (source, external_id) when the source
   * supplies a stable id, falling back to content_hash. Re-seen postings get
   * their mutable fields refreshed and last_seen_at bumped; only genuinely
   * new postings emit job.discovered.
   */
  async insertJobPosting(
    owner: string,
    input: unknown,
  ): Promise<{ posting: JobPosting; created: boolean }> {
    const parsed = jobPostingInputSchema.parse(input);
    const content_hash = parsed.content_hash ?? jobContentHash(parsed);
    const now = new Date().toISOString();
    const existing =
      (parsed.external_id
        ? await this.db.findByTwo<JobPosting>(
            owner,
            domainKinds.jobPostings,
            "source",
            parsed.source,
            "external_id",
            parsed.external_id,
          )
        : null) ??
      (await this.db.find<JobPosting>(
        owner,
        domainKinds.jobPostings,
        "content_hash",
        content_hash,
      ));
    if (existing) {
      const refreshed: JobPosting = {
        ...existing,
        external_id: parsed.external_id ?? existing.external_id,
        source_url: parsed.source_url,
        apply_url: parsed.apply_url ?? existing.apply_url,
        company_name: parsed.company_name,
        title: parsed.title,
        location_text: parsed.location_text,
        remote_type: parsed.remote_type ?? existing.remote_type,
        posted_at: parsed.posted_at ?? existing.posted_at,
        raw_text: parsed.raw_text,
        requirements: parsed.requirements,
        qualifications: parsed.qualifications,
        salary_text: parsed.salary_text ?? existing.salary_text,
        content_hash,
        last_seen_at: now,
        is_active: parsed.is_active,
      };
      await this.db.put(owner, domainKinds.jobPostings, refreshed);
      return { posting: refreshed, created: false };
    }
    const posting: JobPosting = {
      id: randomUUID(),
      source: parsed.source,
      external_id: parsed.external_id,
      source_url: parsed.source_url,
      apply_url: parsed.apply_url,
      company_name: parsed.company_name,
      title: parsed.title,
      location_text: parsed.location_text,
      remote_type: parsed.remote_type,
      posted_at: parsed.posted_at,
      raw_text: parsed.raw_text,
      requirements: parsed.requirements,
      qualifications: parsed.qualifications,
      salary_text: parsed.salary_text,
      content_hash,
      first_seen_at: now,
      last_seen_at: now,
      is_active: parsed.is_active,
    };
    try {
      await this.db.put(owner, domainKinds.jobPostings, posting);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await this.db.find<JobPosting>(
          owner,
          domainKinds.jobPostings,
          "content_hash",
          content_hash,
        );
        if (raced) return { posting: raced, created: false };
      }
      throw error;
    }
    await this.recordEvent(owner, "job.discovered", {
      job_id: posting.id,
      company_name: posting.company_name,
      title: posting.title,
      source: posting.source,
    });
    return { posting, created: true };
  }

  async listJobPostings(owner: string): Promise<JobPosting[]> {
    return this.db.list<JobPosting>(owner, domainKinds.jobPostings);
  }

  async getJobPosting(owner: string, id: string): Promise<JobPosting> {
    const posting = await this.db.get<JobPosting>(owner, domainKinds.jobPostings, id);
    if (!posting) throw new AppError("Job posting not found", 404);
    return posting;
  }

  /** Persist a ranker score for a job. */
  async saveJobScore(owner: string, score: JobScore): Promise<void> {
    await this.db.put(owner, "job_scores", {
      id: score.job_id,
      ...score,
      scored_at: new Date().toISOString(),
    });
  }

  async getJobScore(
    owner: string,
    jobId: string,
  ): Promise<(JobScore & { scored_at: string }) | null> {
    return this.db.get<JobScore & { scored_at: string }>(owner, "job_scores", jobId);
  }

  async listJobScores(owner: string): Promise<Array<JobScore & { scored_at: string }>> {
    return this.db.list<JobScore & { scored_at: string }>(owner, "job_scores");
  }

  /**
   * Score freshly discovered jobs against preferences (Slice 6).
   * Jobs at or above RANK_THRESHOLD get a `ranked` application and a
   * notification (in-app, plus Telegram when the owner connected a bot).
   */
  async rankDiscoveredJobs(owner: string, postings: JobPosting[]): Promise<void> {
    if (postings.length === 0) return;
    const prefs = await this.getPreferences(owner);
    for (const posting of postings) {
      const scored = scoreJob(posting, prefs);
      await this.saveJobScore(owner, scored);
      await this.recordEvent(owner, "job.ranked", { job_id: posting.id, score: scored.score });
      if (scored.score < RANK_THRESHOLD) continue;
      const existing = await this.db.find<Application>(
        owner,
        domainKinds.applications,
        "job_id",
        posting.id,
      );
      if (!existing) {
        // New rows enter the state machine with a timestamp, so days-in-state
        // and the dashboard timeline are honest from birth.
        const now = new Date().toISOString();
        const application: Application = {
          id: randomUUID(),
          job_id: posting.id,
          state: "ranked",
          state_entered_at: now,
        };
        await this.db.put<Application>(owner, domainKinds.applications, application);
        await this.recordEvent(owner, "application.ranked", {
          job_id: posting.id,
          score: scored.score,
        });
        await this.recordEvent(owner, "application.state_changed", {
          application_id: application.id,
          job_id: posting.id,
          previous_state: null,
          new_state: "ranked",
          actor: "system",
          inferred: false,
        });
      }
      const top = scored.reasons.slice(0, 2).join("; ");
      const { delivered_channels } = await notifyOwner(this.db, this.config, owner, {
        title: `New match: ${posting.title} at ${posting.company_name}`,
        body: `Score ${scored.score}/100${top ? ` — ${top}` : ""}. Open the Jobs tab to review.`,
      });
      await this.recordEvent(owner, "job.notify_sent", {
        job_id: posting.id,
        delivered_channels,
      });
    }
  }

  /** Store a raw inbox upload and register it as a source_upload artifact. */
  async inboxUpload(
    owner: string,
    name: string,
    bytes: Uint8Array,
    source = "Uploaded by you",
  ): Promise<Artifact> {
    if (bytes.length === 0) throw new AppError("File is empty", 422);
    if (bytes.length > inboxMaxBytes) throw new AppError("Files must be 10 MB or smaller", 413);
    const fileName = safeFileName(name);
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    const mime = inboxMime[ext];
    if (!mime)
      throw new AppError(
        `File type .${ext || "?"} is not accepted. Use pdf, docx, txt, md, png, jpg, jpeg, webp, or zip.`,
        422,
      );
    const id = randomUUID();
    const directory = join(this.config.dataDir, "inbox");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, `${id}.${ext}`), bytes, { mode: 0o600, flag: "wx" });
    const artifact: Artifact = {
      id,
      kind: "source_upload",
      mime,
      sha256: sha256Hex(bytes),
      byte_size: bytes.length,
      storage_path: `inbox/${id}.${ext}`,
      agent_role: "user",
      created_at: new Date().toISOString(),
    };
    await this.db.put(owner, domainKinds.artifacts, artifact);
    await this.recordEvent(owner, "artifact.uploaded", {
      artifact_id: id,
      name: fileName,
      mime,
      source,
    });
    return artifact;
  }

  async listArtifacts(owner: string): Promise<Artifact[]> {
    return this.db.list<Artifact>(owner, domainKinds.artifacts);
  }

  async listEvents(owner: string): Promise<DomainEvent[]> {
    return this.db.list<DomainEvent>(owner, domainKinds.events);
  }

  /** Preferences per docs/DOMAIN.md and docs/MODELS.md. Unknown owners get defaults. */
  async getPreferences(owner: string): Promise<StoredPreferences> {
    const stored = await this.db.get<Partial<StoredPreferences>>(
      owner,
      domainKinds.preferences,
      "default",
    );
    return { ...defaultPreferences, ...stored };
  }

  async updatePreferences(owner: string, input: unknown): Promise<StoredPreferences> {
    const parsed = preferencesInputSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        `Invalid preferences: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        422,
      );
    const current = await this.getPreferences(owner);
    const merged: StoredPreferences = { ...current, ...stripUndefined(parsed.data) };
    return this.persistPreferences(owner, merged);
  }

  /** Internal write path for the custom-provider endpoints. The public PUT
   *  input schema excludes `custom_providers`, so these records can only be
   *  created through POST /api/models/custom/connect (which also stores the
   *  API key in the encrypted vault). Provider references are still
   *  owner-validated here. */
  private async persistPreferences(
    owner: string,
    prefs: StoredPreferences,
  ): Promise<StoredPreferences> {
    // Slice 15: tiers and role overrides may only name a built-in provider or
    // one of this owner's custom providers. Unknown ids are a 400, not a
    // silent misroute.
    this.assertKnownProviders(prefs);
    // Versioned single source of truth: every write bumps the version.
    const versioned = { ...prefs, version: (prefs.version ?? 0) + 1 };
    await this.db.put(owner, domainKinds.preferences, { ...versioned, id: "default" });
    return versioned;
  }

  /** Built-in provider ids plus this owner's custom provider ids. */
  knownProviderIds(prefs: StoredPreferences): string[] {
    return [...modelProviderIdSchema.options, ...(prefs.custom_providers ?? []).map((p) => p.id)];
  }

  private assertKnownProviders(prefs: StoredPreferences): void {
    const known = new Set(this.knownProviderIds(prefs));
    const refs: Array<[string, string | undefined]> = [
      ["cheap_provider", prefs.cheap_provider],
      ["strong_provider", prefs.strong_provider],
    ];
    for (const [instructionsRef, override] of Object.entries(prefs.role_models ?? {}))
      refs.push([`role_models["${instructionsRef}"].provider`, override.provider]);
    for (const [where, id] of refs)
      if (id && !known.has(id))
        throw new AppError(
          `Unknown model provider "${id}" in ${where}. Connect it in Models first.`,
          400,
        );
  }

  /** Where a custom provider is referenced, for the delete guard (409). */
  customProviderReferences(prefs: StoredPreferences, id: string): string[] {
    const refs: string[] = [];
    if (prefs.cheap_provider === id) refs.push("the cheap tier");
    if (prefs.strong_provider === id) refs.push("the strong tier");
    for (const [instructionsRef, override] of Object.entries(prefs.role_models ?? {}))
      if (override.provider === id) refs.push(`the role override for "${instructionsRef}"`);
    return refs;
  }

  /** Append a user-defined custom provider record (Slice 15). The API key is
   * stored separately in the encrypted vault by ModelAccounts. */
  async addCustomProvider(owner: string, record: CustomProvider): Promise<StoredPreferences> {
    const parsed = customProviderSchema.safeParse(record);
    if (!parsed.success)
      throw new AppError(`Invalid custom provider: ${parsed.error.issues[0]?.message}`, 422);
    const prefs = await this.getPreferences(owner);
    if ((prefs.custom_providers ?? []).some((p) => p.id === parsed.data.id))
      throw new AppError(`A custom provider with id "${parsed.data.id}" already exists.`, 409);
    return this.persistPreferences(owner, {
      ...prefs,
      custom_providers: [...(prefs.custom_providers ?? []), parsed.data],
    });
  }

  async removeCustomProvider(owner: string, id: string): Promise<StoredPreferences> {
    const prefs = await this.getPreferences(owner);
    return this.persistPreferences(owner, {
      ...prefs,
      custom_providers: (prefs.custom_providers ?? []).filter((p) => p.id !== id),
    });
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, entry] of Object.entries(value))
    if (entry !== undefined) out[key as keyof T] = entry as T[keyof T];
  return out;
}
