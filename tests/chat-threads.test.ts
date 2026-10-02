import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store, directory: string, token: string;
let app: Awaited<ReturnType<typeof createApp>>["app"];
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openapply-chat-threads-"));
  db = await createStore();
  ({ app } = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  }));
  const session = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

async function createThread(name?: string) {
  const response = await app.request("/api/threads", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(name === undefined ? {} : { name }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).thread;
}

test("main chat is provisioned in the local store before the first run", async () => {
  assert.equal((await app.request("/api/main-thread")).status, 401);
  const first = await (await app.request("/api/main-thread", { headers: headers() })).json();
  const reopened = await (await app.request("/api/main-thread", { headers: headers() })).json();
  assert.equal(first.existing, true);
  assert.equal(reopened.threadId, first.threadId);
  assert.equal(reopened.existing, true);
  // Backed by the app's own thread store, scoped to the authenticated owner.
  const stored = await db.get("local-user", "chat-thread", first.threadId);
  assert.ok(stored);
  assert.equal(await db.get("other-user", "chat-thread", first.threadId), null);
});

test("threads require a session and round-trip through CRUD", async () => {
  assert.equal((await app.request("/api/threads")).status, 401);
  const thread = await createThread("Trip planning");
  assert.equal(thread.name, "Trip planning");
  assert.equal(thread.archived, false);

  const listed = await (await app.request("/api/threads", { headers: headers() })).json();
  assert.ok(listed.threads.some((t: { id: string }) => t.id === thread.id));

  const renamed = await app.request(`/api/threads/${thread.id}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ name: "Weekend plans", archived: true }),
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).thread.name, "Weekend plans");

  const hidden = await (await app.request("/api/threads", { headers: headers() })).json();
  assert.ok(!hidden.threads.some((t: { id: string }) => t.id === thread.id));
  const shown = await (
    await app.request("/api/threads?includeArchived=true", { headers: headers() })
  ).json();
  assert.ok(shown.threads.some((t: { id: string }) => t.id === thread.id));

  const unarchived = await app.request(`/api/threads/${thread.id}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ archived: false }),
  });
  assert.equal(unarchived.status, 200);
  assert.equal((await unarchived.json()).thread.archived, false);

  assert.equal(
    (await app.request(`/api/threads/${thread.id}`, { method: "DELETE", headers: headers() }))
      .status,
    204,
  );
  assert.equal(
    (await app.request(`/api/threads/${thread.id}/messages`, { headers: headers() })).status,
    404,
  );
  assert.equal(
    (
      await app.request(`/api/threads/${thread.id}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ name: "gone" }),
      })
    ).status,
    404,
  );
});

test("a chat turn persists the user message and the assistant reply", async () => {
  const thread = await createThread();
  const empty = await (
    await app.request(`/api/threads/${thread.id}/messages`, { headers: headers() })
  ).json();
  assert.deepEqual(empty.messages, []);

  const response = await app.request("/api/chat/stream", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      threadId: thread.id,
      message: { id: "m1", role: "user", content: "Show my calendar" },
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const sse = await response.text();
  assert.match(sse, /RUN_STARTED/);
  assert.match(sse, /RUN_FINISHED/);

  const { messages } = await (
    await app.request(`/api/threads/${thread.id}/messages`, { headers: headers() })
  ).json();
  assert.deepEqual(
    messages.map((m: { role: string }) => m.role),
    ["user", "assistant"],
  );
  assert.equal(messages[0].content, "Show my calendar");
  assert.match(messages[1].content, /Your local calendar has/);
  // Untitled threads take their name from the first user message.
  const renamed = await db.get<{ name: string }>("local-user", "chat-thread", thread.id);
  assert.equal(renamed?.name, "Show my calendar");
});

test("approving an unknown run is a 410 and pending approvals start empty", async () => {
  const response = await app.request("/api/chat/approve", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ runId: "missing", toolCallId: "missing", approved: true }),
  });
  assert.equal(response.status, 410);
  const pending = await (
    await app.request("/api/chat/pending-approvals?threadId=whatever", { headers: headers() })
  ).json();
  assert.deepEqual(pending.approvals, []);
});

test("thread history never leaks across owners", async () => {
  const thread = await createThread("Private");
  await db.put("other-user", "chat-thread", {
    id: thread.id,
    name: "Forged",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
  });
  const listed = await (await app.request("/api/threads", { headers: headers() })).json();
  assert.ok(listed.threads.some((t: { id: string }) => t.id === thread.id));
  assert.ok(listed.threads.every((t: { id: string; name: string }) => t.name !== "Forged"));
});
