/**
 * Application pipeline (Slices 7-8): shortlisted application -> document
 * runs (resume, cover, statement when required) -> HR review ->
 * packer -> pack_review.
 *
 * The detector-evasion wording pass was removed (ADR-021): the HR review
 * output goes straight to the packer.
 *
 * One job per run: every role call is scoped to a single application/job.
 * Drafts cite the evidence locker; certificate grounding is enforced before
 * anything reaches the packer. HR blockers stop the pipeline with findings
 * for the user instead of an invented fix.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Application,
  Artifact,
  ArtifactKind,
} from "../../../../packages/domain/src/openapply.ts";
import { domainKinds } from "../../../../packages/domain/src/openapply.ts";
import {
  isTemplateId,
  planSections,
  readPreferencesForPipeline,
  recordTemplateSelection,
  type SectionPlanItem,
  selectTemplate,
  validateAdaptation,
} from "../adaptive-cv.ts";
import type { Store } from "../db.ts";
import { buildPack, type PackManifest } from "../foundry/packer.ts";
import type { ProfileStore } from "../profile.ts";
import {
  checkClaimEvidenceIds,
  checkProseCertificates,
  checkResumeCertificates,
  DocumentError,
  type EvidenceRef,
} from "./grounding.ts";
import { runHrReview } from "./hr-review.ts";
import { type CompleteFn, isBuilderRef, runDocumentRole } from "./runner.ts";
import type { HrReviewOutput } from "./schemas.ts";
import {
  type CoverRunOutput,
  coverRunOutputSchema,
  type ResumeRunOutput,
  resumeRunOutputSchema,
  type StatementRunOutput,
  statementRunOutputSchema,
} from "./schemas.ts";

export interface PipelineDeps {
  db: Store;
  dataDir: string;
  recordEvent(owner: string, type: string, payload: Record<string, unknown>): Promise<unknown>;
  profileStore: ProfileStore;
}

export interface BuildPackOptions {
  application_id: string;
  template_id: string;
  /** Builder prompt ref for the resume run. Default: resume.ats_optimize.v2. */
  resume_ref?: string;
  statement_required?: boolean;
  complete: CompleteFn;
  /**
   * Dispatch hook provided by the orchestrator: every specialist runs
   * through it as its own tracked subagent run (one role per run).
   * Defaults to identity when the pipeline is called without one.
   */
  runRole?: <T>(
    spec: { role: string; instructions_ref: string },
    fn: () => Promise<T>,
  ) => Promise<T>;
}

export type BuildPackResult =
  | { status: "pack_review"; manifest: PackManifest; application: Application }
  | {
      status: "hr_blocked";
      findings: HrReviewOutput["findings"];
      application: Application;
    };

interface JobRecord {
  id: string;
  title: string;
  company?: string;
  company_name?: string;
  location?: string;
  location_text?: string;
  raw_text?: string;
  description?: string;
  source?: string;
  requirements?: string[];
  qualifications?: string[];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function storeDraft(
  deps: PipelineDeps,
  owner: string,
  application_id: string,
  kind: "resume_draft" | "cover_draft" | "statement_draft",
  content: unknown,
): Promise<Artifact> {
  const id = randomUUID();
  const bytes = Buffer.from(JSON.stringify(content, null, 2));
  const dir = join(deps.dataDir, "drafts");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, `${id}.json`), bytes, { mode: 0o600 });
  const artifact: Artifact = {
    id,
    kind: kind as ArtifactKind,
    application_id,
    mime: "application/json",
    sha256: sha256Hex(bytes),
    byte_size: bytes.length,
    storage_path: `drafts/${id}.json`,
    agent_role:
      kind === "resume_draft"
        ? "resume_specialist"
        : kind === "cover_draft"
          ? "cover_specialist"
          : "statement_specialist",
    created_at: new Date().toISOString(),
  };
  await deps.db.put(owner, domainKinds.artifacts, artifact);
  return artifact;
}

async function loadJobText(job: JobRecord): Promise<string> {
  return job.raw_text ?? job.description ?? "";
}

/**
 * Stale-claim horizon: a pack_drafting claim older than this is treated as a
 * crashed run and may be taken over. Live holders refresh nothing — the
 * claim is held for the whole build, which normally finishes in minutes.
 */
const STALE_CLAIM_MS = 30 * 60 * 1000;

/**
 * Atomically claim the application for a pack build. Exactly one caller —
 * the manual route or the orchestrator tick — can move the application into
 * pack_drafting; every other concurrent caller gets a 409. A pack_drafting
 * claim older than STALE_CLAIM_MS is treated as a crashed run and may be
 * taken over (the compare-and-swap on the exact old timestamp keeps that
 * takeover atomic too).
 */
async function claimPackBuild(
  db: PipelineDeps["db"],
  recordEvent: PipelineDeps["recordEvent"],
  owner: string,
  application_id: string,
): Promise<Application> {
  const now = new Date().toISOString();
  // state_entered_at keeps days-in-state and the dashboard timeline honest —
  // the CAS patch is the state change, so the stamp lives in the patch.
  const claimPatch = { state: "pack_drafting", pack_claimed_at: now, state_entered_at: now };
  let application = await db.compareAndSwap<Application>(
    owner,
    domainKinds.applications,
    application_id,
    { state: "ranked" },
    claimPatch,
  );
  let previous_state: string | null = "ranked";
  if (!application) {
    previous_state = "shortlisted";
    application = await db.compareAndSwap<Application>(
      owner,
      domainKinds.applications,
      application_id,
      { state: "shortlisted" },
      claimPatch,
    );
  }
  if (!application) {
    const current = await db.get<Application & { pack_claimed_at?: string }>(
      owner,
      domainKinds.applications,
      application_id,
    );
    const claimedAt =
      current?.pack_claimed_at != null ? Date.parse(current.pack_claimed_at) : Number.NaN;
    if (
      current?.state === "pack_drafting" &&
      !Number.isNaN(claimedAt) &&
      Date.now() - claimedAt > STALE_CLAIM_MS
    ) {
      previous_state = "pack_drafting";
      application = await db.compareAndSwap<Application>(
        owner,
        domainKinds.applications,
        application_id,
        { state: "pack_drafting", pack_claimed_at: current.pack_claimed_at },
        claimPatch,
      );
    }
  }
  if (!application) {
    const current = await db.get<Application>(owner, domainKinds.applications, application_id);
    if (!current) throw new DocumentError("SCHEMA_INVALID", "Application not found", 404);
    throw new DocumentError(
      "POLICY_DENIED",
      `Pack build already in progress (application is ${current.state}).`,
      409,
    );
  }
  await recordEvent(owner, "application.state_changed", {
    application_id: application.id,
    job_id: application.job_id,
    previous_state,
    new_state: "pack_drafting",
    actor: "system",
    inferred: false,
    note: "pack build claimed",
  });
  return application;
}

/**
 * Release a pack-build claim after a failed or blocked build so the
 * application is rebuildable. Success paths set their own terminal state
 * (pack_review via the packer) and never call this.
 */
async function releasePackClaim(
  db: PipelineDeps["db"],
  recordEvent: PipelineDeps["recordEvent"],
  owner: string,
  application: Application,
  toState: "shortlisted",
): Promise<Application> {
  const now = new Date().toISOString();
  const released = await db.compareAndSwap<Application>(
    owner,
    domainKinds.applications,
    application.id,
    { state: "pack_drafting" },
    { state: toState, state_entered_at: now },
  );
  if (released) {
    await recordEvent(owner, "application.state_changed", {
      application_id: application.id,
      job_id: application.job_id,
      previous_state: "pack_drafting",
      new_state: toState,
      actor: "system",
      inferred: false,
      note: "pack build released",
    });
  }
  // Someone else took over a stale claim mid-flight; report what is there.
  return (
    released ??
    (await db.get<Application>(owner, domainKinds.applications, application.id)) ??
    application
  );
}

/**
 * Build the application pack for one shortlisted/ranked application.
 * Exactly one job is in scope for the whole run. The build is claimed
 * atomically (see claimPackBuild): concurrent manual + tick builds for the
 * same application cannot both proceed.
 */
export async function buildApplicationPack(
  deps: PipelineDeps,
  owner: string,
  opts: BuildPackOptions,
): Promise<BuildPackResult> {
  const resumeRef = opts.resume_ref ?? "resume.ats_optimize.v2";
  if (!isBuilderRef(resumeRef))
    throw new DocumentError("SCHEMA_INVALID", `Not a pipeline builder prompt: ${resumeRef}`);

  const application = await claimPackBuild(deps.db, deps.recordEvent, owner, opts.application_id);

  const job = await deps.db.get<JobRecord>(owner, domainKinds.jobPostings, application.job_id);
  if (!job) throw new DocumentError("SCHEMA_INVALID", "Job not found", 404);

  const profile = await deps.profileStore.get(owner);
  // Only confirmed locker items are visible to the document roles.
  const evidence: EvidenceRef[] = profile.evidence
    .filter((e) => e.confirmed)
    .map((e) => ({
      evidence_id: e.id,
      kind: e.kind,
      name: e.file_name,
      text: e.text_excerpt,
    }));

  let masterResumeText = "";
  if (profile.master_resume_id) {
    try {
      const bytes = await readFile(
        join(deps.dataDir, "uploads", `${profile.master_resume_id}.txt`),
      );
      masterResumeText = bytes.toString("utf8").slice(0, 20000);
    } catch {
      masterResumeText = "";
    }
  }

  const company = job.company ?? job.company_name ?? "";
  const jobInput = {
    id: job.id,
    title: job.title,
    company,
    description: await loadJobText(job),
    location: job.location ?? job.location_text,
  };

  // The atomic claim above already moved the application to pack_drafting.
  await deps.recordEvent(owner, "pack.build_started", {
    application_id: application.id,
    job_id: job.id,
  });

  const runRole = opts.runRole ?? (async (_spec, fn) => fn());

  try {
    const runBase = {
      owner,
      profile: profile.memory,
      master_resume_text: masterResumeText,
      evidence,
      complete: opts.complete,
    };

    // --- Resume run (one job, one role) ---
    const resumeRun = await runRole(
      { role: "resume_specialist", instructions_ref: resumeRef },
      () =>
        runDocumentRole({
          ...runBase,
          instructions_ref: resumeRef,
          target_job: jobInput,
        }),
    );
    const resume = resumeRunOutputSchema.parse(resumeRun.output) as ResumeRunOutput;
    checkResumeCertificates(resume.resume_content, evidence);
    const resumeArtifact = await storeDraft(deps, owner, application.id, "resume_draft", resume);
    await deps.recordEvent(owner, "document.resume_drafted", {
      application_id: application.id,
      artifact_id: resumeArtifact.id,
      instructions_ref: resumeRef,
    });

    // --- Cover run (separate role, separate run) ---
    const coverRun = await runRole(
      { role: "cover_specialist", instructions_ref: "cover.draft.v2" },
      () =>
        runDocumentRole({
          ...runBase,
          instructions_ref: "cover.draft.v2",
          target_job: jobInput,
          extra: { resume_draft: resume.resume_content },
        }),
    );
    const cover = coverRunOutputSchema.parse(coverRun.output) as CoverRunOutput;
    checkClaimEvidenceIds(cover.claims, evidence);
    checkProseCertificates(cover.cover_content.paragraphs, evidence);
    // Salutation conventions, not credential claims: default when unknown.
    if (!cover.cover_content.recipient_name?.trim())
      cover.cover_content.recipient_name = "Hiring Manager";
    if (!cover.cover_content.recipient_title?.trim())
      cover.cover_content.recipient_title = undefined;
    if (!cover.cover_content.date?.trim())
      cover.cover_content.date = new Date().toISOString().slice(0, 10);
    if (!cover.cover_content.salutation?.trim())
      cover.cover_content.salutation = "Dear Hiring Manager,";
    const coverArtifact = await storeDraft(deps, owner, application.id, "cover_draft", cover);
    await deps.recordEvent(owner, "document.cover_drafted", {
      application_id: application.id,
      artifact_id: coverArtifact.id,
    });

    // --- Statement run (only when the posting requires one) ---
    let statement: StatementRunOutput | null = null;
    if (opts.statement_required) {
      const statementRun = await runRole(
        { role: "statement_specialist", instructions_ref: "statement.draft.v2" },
        () =>
          runDocumentRole({
            ...runBase,
            instructions_ref: "statement.draft.v2",
            target_job: jobInput,
            extra: {
              resume_draft: resume.resume_content,
              voice_samples: [],
            },
          }),
      );
      statement = statementRunOutputSchema.parse(statementRun.output) as StatementRunOutput;
      checkClaimEvidenceIds(statement.claims, evidence);
      checkProseCertificates(statement.statement_content.paragraphs, evidence);
      const statementArtifact = await storeDraft(
        deps,
        owner,
        application.id,
        "statement_draft",
        statement,
      );
      await deps.recordEvent(owner, "document.statement_drafted", {
        application_id: application.id,
        artifact_id: statementArtifact.id,
      });
    }

    // --- HR review (separate role, separate run) ---
    const hrDeps = { db: deps.db, dataDir: deps.dataDir, recordEvent: deps.recordEvent };
    const hr = await runRole(
      { role: "hr_authenticity_reviewer", instructions_ref: "hr.review.v2" },
      () =>
        runHrReview(hrDeps, owner, {
          application_id: application.id,
          target_job: jobInput,
          profile: profile.memory,
          evidence,
          drafts: {
            resume: resume.resume_content,
            cover: cover.cover_content,
            statement: statement?.statement_content,
          },
          complete: opts.complete,
        }),
    );
    if (!hr.output.can_approve) {
      // Blockers stop the pipeline with findings for the user — never an
      // invented fix. The claim is released so the application is shortlisted
      // and rebuildable once the user adds evidence.
      const released = await releasePackClaim(
        deps.db,
        deps.recordEvent,
        owner,
        application,
        "shortlisted",
      );
      await deps.recordEvent(owner, "pack.hr_blocked", {
        application_id: application.id,
        finding_count: hr.output.findings.length,
      });
      return {
        status: "hr_blocked",
        findings: hr.output.findings,
        application: released,
      };
    }

    // --- Adaptive CV selection (after the HR gate, before the pack render) ---
    // The gate passed; now choose the presentation. The requested template is
    // the fallback when the job is unknown — the selector never guesses.
    const preferences = await readPreferencesForPipeline(deps.db, owner);
    let template_id = opts.template_id;
    let section_plan: SectionPlanItem[] | undefined;
    const jobLike = {
      id: job.id,
      title: job.title,
      source: job.source ?? "",
      requirements: job.requirements,
      qualifications: job.qualifications,
    };
    try {
      const selection = selectTemplate(jobLike, preferences, opts.template_id);
      template_id = selection.template_id;
      await recordTemplateSelection(
        { recordEvent: deps.recordEvent },
        owner,
        application.id,
        job.id,
        selection,
        opts.template_id,
      );
    } catch {
      // Job unknown or unparseable: keep the requested template.
    }
    try {
      // Relevance-only section plan: returned and logged, never applied
      // silently — the user sees it at pack review and can reject it.
      if (!isTemplateId(template_id)) throw new Error("unknown template, no plan");
      const planned = planSections({
        template_id,
        job: jobLike,
        resume: hr.output.resume_final_candidate,
      });
      validateAdaptation(planned.adaptation);
      section_plan = planned.items;
      await deps.recordEvent(owner, "cv.section_plan", {
        application_id: application.id,
        job_id: job.id,
        template_id,
        items: planned.items,
      });
    } catch {
      // No plan: the pack still builds with the selected template.
    }

    // --- Pack (from the reviewed finals) ---
    const manifest = await runRole({ role: "packer", instructions_ref: "packer.v1" }, () =>
      buildPack(
        {
          db: deps.db,
          dataDir: deps.dataDir,
          recordEvent: deps.recordEvent,
        },
        owner,
        {
          application_id: application.id,
          template_id,
          job_title: job.title,
          company,
          resume: hr.output.resume_final_candidate,
          cover: hr.output.cover_final_candidate,
          statement: hr.output.statement_final_candidate ?? undefined,
          section_plan,
        },
      ),
    );
    await deps.recordEvent(owner, "pack.built", {
      application_id: application.id,
      pack_id: manifest.id,
    });

    const updated = await deps.db.get<Application>(owner, domainKinds.applications, application.id);
    if (!updated) throw new DocumentError("SCHEMA_INVALID", "Application vanished mid-run");
    return { status: "pack_review", manifest, application: updated };
  } catch (error) {
    // Release the claim so a failed build never wedges the application in
    // pack_drafting: it returns to shortlisted, rebuildable by hand. The
    // error is rethrown so callers (manual route, orchestrator tick) see
    // the real failure.
    await releasePackClaim(deps.db, deps.recordEvent, owner, application, "shortlisted");
    await deps.recordEvent(owner, "pack.build_failed", {
      application_id: application.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
