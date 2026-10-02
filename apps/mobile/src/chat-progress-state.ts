/**
 * Pure state→label mapping for the slim chat progress indicator.
 *
 * No React Native imports: this module is unit-testable in node. The rules:
 * - Labels are derived from the task's status, title and plan steps — never
 *   narrated, never invented.
 * - Internal role/state names (e.g. "hr.review.v2") never surface; keyword
 *   rules map to fixed plain-words strings.
 * - Step counts come from the task plan ("Step 2 of 5"); undefined when the
 *   plan is too short to count honestly.
 */
import type { AgentTask } from "../../../packages/domain/src/agent";

/** No visible activity for this long while a run is active → gentle notice. */
export const LONG_RUNNING_MS = 90_000;

export type ProgressKind = "working" | "waiting" | "failed" | "done";

export interface ProgressInfo {
  kind: ProgressKind;
  /** Plain-words status. Never an internal role or state name. */
  label: string;
  /** Honest step count, e.g. "Step 2 of 5". Undefined when unknown. */
  stepLabel?: string;
  /** The run/task id. Shown on failures and waiting states. */
  runId?: string;
  /** Plain-language error, first line only. */
  error?: string;
}

/**
 * Internal keyword → plain-words mapping. The haystack is the task title and
 * its plan step titles; the labels are fixed user-facing strings. Nothing
 * internal leaks through.
 */
export const LABEL_RULES: Array<{ test: RegExp; label: string }> = [
  { test: /hunter|job boards?|scan/i, label: "Checking job boards…" },
  { test: /tracker|replies|inbox|gmail/i, label: "Checking for replies…" },
  { test: /review/i, label: "Reviewing your documents…" },
  { test: /resume|cover letter|statement|pack/i, label: "Drafting your pack…" },
  { test: /apply|submit|prefill|usher|browser/i, label: "Preparing your application…" },
];

export function labelFor(task: AgentTask | undefined): string {
  const haystack = [task?.title ?? "", ...(task?.plan ?? []).map((step) => step.title)].join(" ");
  for (const rule of LABEL_RULES) {
    if (rule.test.test(haystack)) return rule.label;
  }
  return "Working on it…";
}

export function stepLabelFor(task: AgentTask | undefined): string | undefined {
  const steps = task?.plan ?? [];
  if (steps.length < 2) return undefined;
  const doneCount = steps.filter((step) => step.status === "succeeded").length;
  const runningIdx = steps.findIndex((step) => step.status === "running");
  const current = runningIdx >= 0 ? runningIdx + 1 : Math.min(doneCount + 1, steps.length);
  return `Step ${current} of ${steps.length}`;
}

export function plainError(task: AgentTask): string {
  const raw = task.error ?? "Something went wrong.";
  return raw.split("\n")[0].trim().slice(0, 200) || "Something went wrong.";
}

export function deriveProgress(task: AgentTask | undefined, loading: boolean): ProgressInfo {
  if (task?.status === "failed") {
    return {
      kind: "failed",
      label: "Something went wrong",
      runId: task.id,
      error: plainError(task),
    };
  }
  if (task && (task.status === "waiting_approval" || task.status === "waiting_input")) {
    return { kind: "waiting", label: "Waiting for your approval", runId: task.id };
  }
  if (!loading) {
    return { kind: "done", label: "Done" };
  }
  return {
    kind: "working",
    label: labelFor(task),
    stepLabel: stepLabelFor(task),
    runId: task?.id,
  };
}
