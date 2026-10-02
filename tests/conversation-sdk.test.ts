import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationQueue } from "../apps/mobile/src/conversation-queue.ts";
import { runConversationTurn } from "../apps/mobile/src/conversation-run.ts";

test("a rejected turn stops the queue and leaves the next message pending", async () => {
  let attempts = 0;
  const queue = new ConversationQueue();
  queue.enqueue({ id: "first", text: "First task" });
  queue.enqueue({ id: "second", text: "Second task" });
  await assert.rejects(
    queue.flush(() =>
      runConversationTurn(async () => {
        attempts++;
        throw new Error("Connection interrupted");
      }),
    ),
    /Connection interrupted/,
  );
  assert.equal(attempts, 1);
  assert.equal(queue.getSnapshot().paused, true);
  assert.deepEqual(
    queue.getSnapshot().pending.map((message) => message.id),
    ["second"],
  );
});

test("a resolved turn runs the queued messages to completion", async () => {
  const sent: string[] = [];
  const queue = new ConversationQueue();
  queue.enqueue({ id: "first", text: "First task" });
  queue.enqueue({ id: "second", text: "Second task" });
  await queue.flush((message) => runConversationTurn(async () => void sent.push(message.id)));
  assert.deepEqual(sent, ["first", "second"]);
  assert.equal(queue.getSnapshot().paused, false);
  assert.equal(queue.getSnapshot().pending.length, 0);
});
