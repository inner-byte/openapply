/**
 * HR authenticity review (Slice 8): grounding critique of the drafted
 * documents. One run, one instructions_ref.
 *
 * - runHrReview: hr.review.v2 checks every claim against confirmed evidence.
 *   Blockers (severity "blocker" or can_approve=false) stop the pipeline:
 *   missing evidence produces a question, not an invention.
 *
 * The detector-evasion wording pass (hr.detector_evasion.v2) was removed
 * (ADR-021). The review output goes straight to the packer.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact, ArtifactKind } from "../../../../packages/domain/src/openapply.ts";
import { domainKinds } from "../../../../packages/domain/src/openapply.ts";
import type { Store } from "../db.ts";
import { DocumentError, type EvidenceRef } from "./grounding.ts";
import { type CompleteFn, runDocumentRole } from "./runner.ts";
import { type HrReviewOutput, hrReviewOutputSchema } from "./schemas.ts";

export interface HrDeps {
  db: Store;
  dataDir: string;
  recordEvent(owner: string, type: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface HrReviewInput {
  application_id: string;
  target_job: {
    id: string;
    title: string;
    company: string;
    description: string;
    location?: string;
  };
  profile: unknown;
  evidence: EvidenceRef[];
  drafts: {
    resume: unknown;
    cover?: unknown;
    statement?: unknown;
  };
  complete: CompleteFn;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function storeHrArtifact(
  deps: HrDeps,
  owner: string,
  application_id: string,
  kind: "hr_review",
  agent_role: "hr_authenticity_reviewer",
  content: unknown,
): Promise<Artifact> {
  const id = randomUUID();
  const bytes = Buffer.from(JSON.stringify(content, null, 2));
  const dir = join(deps.dataDir, "hr");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, `${id}.json`), bytes, { mode: 0o600 });
  const artifact: Artifact = {
    id,
    kind: kind as ArtifactKind,
    application_id,
    mime: "application/json",
    sha256: sha256Hex(bytes),
    byte_size: bytes.length,
    storage_path: `hr/${id}.json`,
    agent_role,
    created_at: new Date().toISOString(),
  };
  await deps.db.put(owner, domainKinds.artifacts, artifact);
  return artifact;
}

/**
 * Run the HR authenticity review. Returns the validated output; the caller
 * decides whether blockers stop the pipeline.
 */
export async function runHrReview(
  deps: HrDeps,
  owner: string,
  input: HrReviewInput,
): Promise<{ output: HrReviewOutput; artifact: Artifact }> {
  const run = await runDocumentRole({
    owner,
    instructions_ref: "hr.review.v2",
    target_job: input.target_job,
    profile: input.profile,
    evidence: input.evidence,
    complete: input.complete,
    extra: {
      resume_draft: input.drafts.resume,
      cover_draft: input.drafts.cover ?? null,
      statement_draft: input.drafts.statement ?? null,
    },
  });
  const output = hrReviewOutputSchema.parse(run.output) as HrReviewOutput;

  // The model must not claim approval while blockers remain.
  const hasBlocker = output.findings.some((f) => f.severity === "blocker");
  if (hasBlocker && output.can_approve) {
    throw new DocumentError(
      "POLICY_DENIED",
      "HR review reported blockers but set can_approve=true; treating as blocked.",
    );
  }
  const approved = output.can_approve && !hasBlocker;

  const artifact = await storeHrArtifact(
    deps,
    owner,
    input.application_id,
    "hr_review",
    "hr_authenticity_reviewer",
    { ...output, hr_approved: approved, run_id: run.packet.run_id },
  );
  await deps.recordEvent(owner, "hr.reviewed", {
    application_id: input.application_id,
    artifact_id: artifact.id,
    hr_approved: approved,
    blockers: output.findings.filter((f) => f.severity === "blocker").length,
  });
  return { output: { ...output, can_approve: approved }, artifact };
}
