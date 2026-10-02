/**
 * Slice 12 invariants: hardening — role isolation.
 * - A document run's model input carries no tools: the resume specialist
 *   cannot call Gmail tools (docs/TESTING.md). The gateway interface has
 *   no tools field at all, so this is structural, not promissory.
 * - Runs have fresh context: a second run's messages contain none of the
 *   first run's output. No shared chat history between roles.
 * - One role per run: the packet carries exactly one role and one
 *   instructions_ref; unknown refs fail instead of concatenating files.
 * - Every prompt file in apps/server/src/prompts parses with role, tier, and
 *   instructions_ref frontmatter, and every registered ref resolves.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildRunnerPacket, loadPrompt, runDocumentRole } from "../apps/server/src/docs/runner.ts";
import type { CompleteInput, CompleteResult } from "../apps/server/src/gateway.ts";

const here = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(here, "..", "apps", "server", "src", "prompts");

function modelReply(output: unknown): CompleteResult {
  return {
    text: JSON.stringify(output),
    json: output,
    usage: { input_tokens: 10, output_tokens: 10 },
    model_id: "fake",
  };
}

function runInput(overrides: Record<string, unknown> = {}) {
  return {
    owner: "owner-isolation",
    instructions_ref: "resume.ats_optimize.v2",
    target_job: {
      id: "job-1",
      title: "Accountant",
      company: "Acme",
      location: "Lagos",
      description: "Do the accounts.",
    },
    profile: { full_name: "Test User" },
    evidence: [],
    complete: async (_o: string, _i: CompleteInput): Promise<CompleteResult> =>
      modelReply({ ok: true }),
    ...overrides,
  };
}

test("document runs carry no tools: resume specialist cannot call Gmail tools", async () => {
  const seen: CompleteInput[] = [];
  await runDocumentRole(
    runInput({
      complete: async (_o: string, input: CompleteInput) => {
        seen.push(input);
        return modelReply({ ok: true });
      },
    }) as never,
  );
  assert.equal(seen.length, 1);
  // The gateway interface has no tools field: roles are structurally
  // tool-less. A Gmail tool cannot even be expressed.
  assert.ok(!("tools" in seen[0]));
  const keys = Object.keys(seen[0]).sort();
  assert.ok(keys.includes("messages") && keys.includes("system") && keys.includes("tier"));
  assert.ok(!keys.some((k) => k.toLowerCase().includes("tool")));
});

test("runs have fresh context: no shared history between runs", async () => {
  const seen: CompleteInput[] = [];
  const complete = async (_o: string, input: CompleteInput) => {
    seen.push(input);
    return modelReply({ marker: `output-for-${seen.length}` });
  };
  await runDocumentRole(runInput({ complete }) as never);
  await runDocumentRole(
    runInput({
      complete,
      target_job: {
        id: "job-2",
        title: "Auditor",
        company: "Beta",
        location: "",
        description: "Audit things.",
      },
    }) as never,
  );
  assert.equal(seen.length, 2);
  const secondMessages = JSON.stringify(seen[1].messages);
  // The first run's output never leaks into the second run's context.
  assert.ok(!secondMessages.includes("output-for-1"));
  assert.ok(secondMessages.includes("job-2"));
  assert.ok(!secondMessages.includes("job-1"));
});

test("one role per run: packet carries exactly one role and one instructions_ref", () => {
  const packet = buildRunnerPacket("tracker.v1", "tracker", []);
  assert.equal(packet.role, "tracker");
  assert.equal(packet.instructions_ref, "tracker.v1");
  assert.ok(!("roles" in packet));
  assert.ok(!("instructions_refs" in packet));
});

test("unknown instructions_ref fails; the runner never concatenates prompt files", async () => {
  await assert.rejects(() => loadPrompt("nope.does_not_exist.v9"), /Unknown instructions_ref/);
});

test("every prompt file has role, tier, and instructions_ref frontmatter", async () => {
  const files: string[] = [];
  const top = await readdir(promptsDir);
  for (const name of top) {
    if (name === "README.md") continue;
    if (name.endsWith(".md")) files.push(name);
    else {
      for (const sub of await readdir(join(promptsDir, name)))
        if (sub.endsWith(".md")) files.push(`${name}/${sub}`);
    }
  }
  assert.ok(files.length >= 20, `expected at least 20 prompt files, got ${files.length}`);
  const refs = new Set<string>();
  for (const file of files) {
    const text = await readFile(join(promptsDir, file), "utf8");
    const ref = text.match(/^instructions_ref:\s*(\S+)/m)?.[1];
    const role = text.match(/^role:\s*(\S+)/m)?.[1];
    const tier = text.match(/^tier:\s*(cheap|strong)/m)?.[1];
    assert.ok(ref, `${file}: missing instructions_ref`);
    assert.ok(role, `${file}: missing role`);
    assert.ok(tier, `${file}: missing tier`);
    assert.ok(!refs.has(ref), `${file}: duplicate instructions_ref ${ref}`);
    refs.add(ref);
  }
});

test("every registered instructions_ref resolves to its prompt file", async () => {
  const known = [
    "resume.ats_optimize.v2",
    "resume.from_scratch.v2",
    "resume.role_specific.v2",
    "resume.career_switch.v2",
    "resume.fresher.v2",
    "resume.linkedin_align.v2",
    "resume.score_booster.v2",
    "cover.draft.v2",
    "statement.draft.v2",
    "hr.review.v2",
  ];
  for (const ref of known) {
    const prompt = await loadPrompt(ref);
    assert.equal(prompt.instructions_ref, ref);
    assert.ok(prompt.system.length > 100);
  }
});
