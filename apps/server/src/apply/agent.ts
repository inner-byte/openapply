/**
 * Apply role runner (Slice 9). Mirrors the docs runner's packet discipline —
 * one role per run, one instructions_ref per packet, fresh context — for the
 * apply-flow roles: session_usher, prefill, submit_waiter.
 *
 * Unlike document roles these runs may drive the browser, so the packet
 * policy allows browser use and forbids profile writes, exactly like the
 * docs runner. Prompts live in apps/server/src/prompts/ and are loaded one at
 * a time; unknown refs fail instead of falling back.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../errors.ts";
import type { CompleteInput, CompleteResult } from "../gateway.ts";

export type CompleteFn = (owner: string, input: CompleteInput) => Promise<CompleteResult>;

const APPLY_PROMPT_FILES: Record<string, string> = {
  "session.usher.v1": "session_usher.md",
  "prefill.v1": "prefill.md",
  "submit.wait.v1": "submit_waiter.md",
};

function promptsDir(): string {
  if (process.env.DOCS_PROMPTS_DIR) return process.env.DOCS_PROMPTS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  // apps/server/src/apply -> apps/server/src/prompts
  return join(here, "..", "prompts");
}

export async function loadApplyPrompt(instructions_ref: string): Promise<{
  instructions_ref: string;
  role: string;
  tier: "cheap" | "strong";
  system: string;
}> {
  const file = APPLY_PROMPT_FILES[instructions_ref];
  if (!file) throw new AppError(`Unknown apply instructions_ref: ${instructions_ref}`, 500);
  const system = await readFile(join(promptsDir(), file), "utf8");
  const role = system.match(/^role:\s*(\S+)/m)?.[1] ?? "unknown";
  const tier = system.match(/^tier:\s*(cheap|strong)/m)?.[1] === "cheap" ? "cheap" : "strong";
  return { instructions_ref, role, tier, system };
}

export interface ApplyRunInput {
  owner: string;
  instructions_ref: string;
  payload: Record<string, unknown>;
  complete: CompleteFn;
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
 * Run one apply role. Returns the run packet and the parsed model JSON.
 * The caller validates the output against the role's schema and enforces
 * every safety gate server-side — model output never authorizes a click.
 */
export async function runApplyRole(input: ApplyRunInput): Promise<{
  packet: {
    run_id: string;
    role: string;
    schema_version: number;
    policy: { can_use_browser: boolean; can_write_profile: boolean; max_output_tokens: number };
    artifact_ids: string[];
    instructions_ref: string;
  };
  output: unknown;
  model_id: string;
}> {
  const prompt = await loadApplyPrompt(input.instructions_ref);
  const packet = {
    run_id: randomUUID(),
    role: prompt.role,
    schema_version: 1,
    policy: {
      can_use_browser: true,
      can_write_profile: false,
      max_output_tokens: 2000,
    },
    artifact_ids: [] as string[],
    instructions_ref: prompt.instructions_ref,
  };
  const result = await input.complete(input.owner, {
    purpose: `apply:${prompt.role}`,
    system: prompt.system,
    messages: [
      {
        role: "user",
        content: `Run the instructions in your system prompt for exactly one application.\n\n${JSON.stringify({ apply_packet: packet, ...input.payload })}`,
      },
    ],
    tier: prompt.tier,
  });
  let output: unknown;
  try {
    output = result.json ?? extractJson(result.text);
  } catch {
    throw new AppError(`${prompt.role} did not return valid JSON`, 502);
  }
  return { packet, output, model_id: result.model_id };
}
