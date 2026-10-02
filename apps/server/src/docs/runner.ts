/**
 * Document runner: executes one agent role per run from a versioned prompt.
 *
 * Laws (docs/AGENTS.md):
 *  - One role per run, one instructions_ref per packet. The runner loads
 *    exactly one prompt file; it never concatenates the prompts directory.
 *  - Job descriptions are untrusted data, passed to the model as data.
 *  - Model keys never enter prompts — the gateway owns transport.
 *  - Missing evidence produces a question, not an invention (the prompts
 *    enforce this; the runner enforces JSON validity + certificate grounding).
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompleteInput, CompleteResult } from "../gateway.ts";
import type { EvidenceRef } from "./grounding.ts";
import { DocumentError } from "./grounding.ts";

export interface RunnerPacket {
  run_id: string;
  role: string;
  schema_version: 1;
  policy: {
    can_use_browser: false;
    can_write_profile: false;
    max_output_tokens: number;
  };
  artifact_ids: string[];
  instructions_ref: string;
}

export type CompleteFn = (owner: string, input: CompleteInput) => Promise<CompleteResult>;

export interface DocumentRunInput {
  owner: string;
  /** Versioned prompt ref, e.g. "resume.ats_optimize.v2". */
  instructions_ref: string;
  target_job: {
    id: string;
    title: string;
    company: string;
    /** Untrusted: the raw posting text. */
    description: string;
    location?: string;
  };
  /** Confirmed profile facts only. */
  profile: unknown;
  master_resume_text?: string;
  /** Confirmed evidence-locker items. */
  evidence: EvidenceRef[];
  /** Extra role-specific inputs (voice samples, prior drafts...). */
  extra?: Record<string, unknown>;
  /** Model transport; injected so tests can stub it. */
  complete: CompleteFn;
}

/** instructions_ref -> exactly one prompt file. Builders only; t3/t4/t8 are
 *  interactive tools and are not runnable by the application pipeline. */
const PROMPT_FILES: Record<string, string> = {
  "resume.ats_optimize.v2": "resume/t1_ats_optimized.md",
  "resume.from_scratch.v2": "resume/t2_from_scratch.md",
  "resume.role_specific.v2": "resume/t5_role_specific.md",
  "resume.career_switch.v2": "resume/t6_career_switch.md",
  "resume.fresher.v2": "resume/t7_fresher.md",
  "resume.linkedin_align.v2": "resume/t9_linkedin_alignment.md",
  "resume.score_booster.v2": "resume/t10_score_booster.md",
  "cover.draft.v2": "cover_specialist.md",
  "statement.draft.v2": "statement_specialist.md",
  "hr.review.v2": "hr_authenticity_reviewer.md",
};

const BUILDER_REFS = new Set(Object.keys(PROMPT_FILES));

export function isBuilderRef(ref: string): boolean {
  return BUILDER_REFS.has(ref);
}

function promptsDir(): string {
  if (process.env.DOCS_PROMPTS_DIR) return process.env.DOCS_PROMPTS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  // apps/server/src/docs -> apps/server/src/prompts
  return join(here, "..", "prompts");
}

/**
 * Load exactly one prompt file for an instructions_ref. Throws when the ref
 * is unknown — the runner never falls back to concatenating prompt files.
 */
export async function loadPrompt(instructions_ref: string): Promise<{
  instructions_ref: string;
  role: string;
  tier: "cheap" | "strong";
  system: string;
}> {
  const file = PROMPT_FILES[instructions_ref];
  if (!file)
    throw new DocumentError("SCHEMA_INVALID", `Unknown instructions_ref: ${instructions_ref}`);
  const system = await readFile(join(promptsDir(), file), "utf8");
  const role = system.match(/^role:\s*(\S+)/m)?.[1] ?? "unknown";
  const tier = system.match(/^tier:\s*(cheap|strong)/m)?.[1] === "cheap" ? "cheap" : "strong";
  return { instructions_ref, role, tier, system };
}

export function buildRunnerPacket(
  instructions_ref: string,
  role: string,
  artifact_ids: string[],
): RunnerPacket {
  return {
    run_id: randomUUID(),
    role,
    schema_version: 1,
    policy: {
      can_use_browser: false,
      can_write_profile: false,
      max_output_tokens: 4000,
    },
    artifact_ids,
    instructions_ref,
  };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(trimmed.slice(start, end + 1));
}

/**
 * Run one document role. Returns the parsed model JSON. The caller validates
 * it against the role's zod schema and runs grounding checks.
 */
export async function runDocumentRole(input: DocumentRunInput): Promise<{
  packet: RunnerPacket;
  output: unknown;
  model_id: string;
}> {
  const prompt = await loadPrompt(input.instructions_ref);
  const packet = buildRunnerPacket(
    prompt.instructions_ref,
    prompt.role,
    input.evidence.map((e) => e.evidence_id),
  );

  const userPayload = {
    runner_packet: packet,
    target_job: {
      id: input.target_job.id,
      title: input.target_job.title,
      company: input.target_job.company,
      location: input.target_job.location ?? "",
      // Explicitly marked: hostile input, read as data only.
      description_untrusted: input.target_job.description,
    },
    profile_confirmed: input.profile,
    master_resume_text: input.master_resume_text ?? "",
    evidence_locker_confirmed: input.evidence,
    ...(input.extra ?? {}),
  };

  const result = await input.complete(input.owner, {
    purpose: `document:${prompt.role}`,
    // Slice 14: lets the gateway honor a per-role model override for this role.
    instructions_ref: prompt.instructions_ref,
    system: prompt.system,
    messages: [
      {
        role: "user",
        content: `Run the instructions in your system prompt for exactly one job.\n\n${JSON.stringify(userPayload)}`,
      },
    ],
    tier: prompt.tier,
  });

  let output: unknown;
  try {
    output = result.json ?? extractJson(result.text);
  } catch {
    throw new DocumentError("SCHEMA_INVALID", `${prompt.role} did not return valid JSON`);
  }
  return { packet, output, model_id: result.model_id };
}
