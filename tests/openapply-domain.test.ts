import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { Workspace } from "../packages/domain/src/index.ts";
import type { Artifact, DomainEvent, JobPosting } from "../packages/domain/src/openapply.ts";

let db: Store, app: Awaited<ReturnType<typeof createApp>>["app"], token: string, directory: string;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const postingBody = {
  source: "manual",
  source_url: "https://example.com/jobs/123",
  apply_url: "https://example.com/jobs/123/apply",
  company_name: "Example Corp",
  title: "Support Engineer",
  location_text: "Remote",
  raw_text: "Support Engineer at Example Corp. Remote.",
  requirements: ["2 years of support experience"],
  qualifications: ["Clear writing"],
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openapply-domain-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  ({ app } = await createApp(db, config));
  const response = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  token = (await response.json()).token;
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("manual JobPosting insert works", async () => {
  const response = await app.request("/api/jobs", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(postingBody),
  });
  assert.equal(response.status, 201);
  const { posting, created } = (await response.json()) as {
    posting: JobPosting;
    created: boolean;
  };
  assert.equal(created, true);
  assert.match(posting.id, /^[0-9a-f-]{36}$/);
  assert.equal(posting.source, "manual");
  assert.equal(posting.company_name, "Example Corp");
  assert.match(posting.content_hash, /^[0-9a-f]{64}$/);
  assert.ok(posting.first_seen_at);
  assert.equal(posting.first_seen_at, posting.last_seen_at);
});

test("duplicate JobPosting dedupes on content_hash", async () => {
  const again = await app.request("/api/jobs", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...postingBody, title: "Support Engineer" }),
  });
  assert.equal(again.status, 200);
  const second = (await again.json()) as { posting: JobPosting; created: boolean };
  assert.equal(second.created, false);
  const list = (await (
    await app.request("/api/jobs", { headers: headers() })
  ).json()) as JobPosting[];
  assert.equal(list.length, 1);
  assert.equal(second.posting.id, list[0].id);
});

test("job detail includes source_url", async () => {
  const list = (await (
    await app.request("/api/jobs", { headers: headers() })
  ).json()) as JobPosting[];
  const detail = await app.request(`/api/jobs/${list[0].id}`, { headers: headers() });
  assert.equal(detail.status, 200);
  const posting = (await detail.json()) as JobPosting;
  assert.equal(posting.source_url, "https://example.com/jobs/123");
  assert.equal((await app.request("/api/jobs/nope", { headers: headers() })).status, 404);
});

test("inbox upload creates a source_upload artifact", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.4 fake resume bytes");
  const form = new FormData();
  form.append("file", new File([bytes], "resume.pdf", { type: "application/pdf" }));
  const response = await app.request("/api/inbox", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(response.status, 201);
  const { artifact } = (await response.json()) as { artifact: Artifact };
  assert.equal(artifact.kind, "source_upload");
  assert.equal(artifact.mime, "application/pdf");
  assert.equal(artifact.byte_size, bytes.length);
  assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.match(artifact.storage_path, /^inbox\/[0-9a-f-]{36}\.pdf$/);
  const stored = await stat(join(directory, artifact.storage_path));
  assert.equal(stored.size, bytes.length);
  const inbox = (await (
    await app.request("/api/inbox", { headers: headers() })
  ).json()) as Artifact[];
  assert.ok(inbox.some((a) => a.id === artifact.id));
});

test("inbox rejects executables", async () => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([0x4d, 0x5a])], "run.exe"));
  const response = await app.request("/api/inbox", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(response.status, 422);
});

test("domain events appear in activity", async () => {
  const events = (await (
    await app.request("/api/events", { headers: headers() })
  ).json()) as DomainEvent[];
  assert.ok(events.some((e) => e.type === "job.discovered"));
  assert.ok(events.some((e) => e.type === "artifact.uploaded"));
  const workspace = (await (
    await app.request("/api/workspace", { headers: headers() })
  ).json()) as Workspace;
  const entry = workspace.activity.find((a) => a.title === "Job discovered");
  assert.ok(entry);
  assert.match(entry.detail, /Example Corp/);
});
