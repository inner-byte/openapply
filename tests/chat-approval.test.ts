import assert from "node:assert/strict";
import { test } from "node:test";
import { convertTanStackStream } from "../apps/server/src/engine/tanstack-agent.ts";

async function collect(stream: AsyncIterable<unknown>) {
  const events: Record<string, unknown>[] = [];
  for await (const chunk of stream) events.push(chunk as Record<string, unknown>);
  return events;
}

test("approval-request custom event keeps the wire shape the chat client reads", async () => {
  const runId = "run-1";
  const toolCallId = "tc-9";
  const fakeTanStackStream = (async function* () {
    yield {
      type: "CUSTOM",
      name: "approval-request",
      value: {
        toolName: "browser_navigate",
        input: { url: "https://example.com/apply" },
        toolCallId,
      },
    };
    yield { type: "RUN_FINISHED", runId };
  })();
  const events = await collect(
    convertTanStackStream(fakeTanStackStream, new AbortController().signal, runId, {}, {}),
  );
  const approval = events.find((e) => (e as { name?: unknown }).name === "approval-request");
  assert.ok(approval, "expected an approval-request event on the wire");
  // The mobile chat client reads runId/toolCallId/toolName/args from the
  // event payload (top level or under `value`); the converter must supply all
  // four or the approval card never appears.
  const value = approval.value as Record<string, unknown>;
  assert.equal(value.runId, runId);
  assert.equal(value.toolCallId, toolCallId);
  assert.equal(value.toolName, "browser_navigate");
  assert.deepEqual(value.args, { url: "https://example.com/apply" });
});
