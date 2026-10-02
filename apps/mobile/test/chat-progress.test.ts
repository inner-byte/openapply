/**
 * Slim chat progress: state→label mapping is derived, never narrated.
 * - Internal role/state names never surface; keyword rules map to plain words.
 * - Step counts come from the task plan; undefined when there is nothing
 *   honest to count.
 * - waiting_approval / waiting_input → static waiting state.
 * - failed → run id + first-line error.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import { deriveProgress, labelFor, stepLabelFor } from "../src/chat-progress-state.ts";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    title: "Untitled",
    prompt: "do things",
    kind: "agent",
    status: "running",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: 0,
    artifactIds: [],
    ...overrides,
  };
}

function step(title: string, status: "pending" | "running" | "succeeded" | "failed" | "waiting") {
  return { id: `s-${title}`, title, status };
}

test("keyword rules map internal work to plain words", () => {
  assert.equal(labelFor(task({ title: "hunter_ats scan" })), "Checking job boards…");
  assert.equal(labelFor(task({ title: "resume_specialist draft" })), "Drafting your pack…");
  assert.equal(
    labelFor(task({ title: "hr_authenticity_reviewer findings" })),
    "Reviewing your documents…",
  );
  assert.equal(labelFor(task({ title: "submit waiter" })), "Preparing your application…");
  assert.equal(labelFor(task({ title: "tracker.v1 gmail sweep" })), "Checking for replies…");
  assert.equal(labelFor(task({ title: "something unknown" })), "Working on it…");
  assert.equal(labelFor(undefined), "Working on it…");
});

test("plan step titles also feed the mapping", () => {
  const t = task({
    title: "agent run",
    plan: [step("prefill form fields", "running"), step("wait for submit", "pending")],
  });
  assert.equal(labelFor(t), "Preparing your application…");
});

test("step counts are honest or absent", () => {
  const t = task({
    plan: [
      step("one", "succeeded"),
      step("two", "running"),
      step("three", "pending"),
      step("four", "pending"),
    ],
  });
  assert.equal(stepLabelFor(t), "Step 2 of 4");
  assert.equal(stepLabelFor(task({ plan: [step("only", "running")] })), undefined);
  assert.equal(stepLabelFor(task()), undefined);
});

test("waiting states are static and distinct", () => {
  for (const status of ["waiting_approval", "waiting_input"] as const) {
    const info = deriveProgress(task({ status }), true);
    assert.equal(info.kind, "waiting");
    assert.equal(info.label, "Waiting for your approval");
    assert.equal(info.runId, "task-1");
  }
});

test("failures carry the run id and a plain first-line error", () => {
  const info = deriveProgress(
    task({ status: "failed", error: "BUDGET_EXCEEDED: run over budget\nstack trace here" }),
    false,
  );
  assert.equal(info.kind, "failed");
  assert.equal(info.runId, "task-1");
  assert.equal(info.error, "BUDGET_EXCEEDED: run over budget");
});

test("done and working kinds", () => {
  assert.deepEqual(deriveProgress(task({ status: "succeeded" }), false), {
    kind: "done",
    label: "Done",
  });
  const working = deriveProgress(task({ title: "hunter_ats scan" }), true);
  assert.equal(working.kind, "working");
  assert.equal(working.label, "Checking job boards…");
  assert.equal(working.stepLabel, undefined);
});
