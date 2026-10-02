import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { ProfileStore } from "../apps/server/src/profile.ts";

let db: Store;
let app: Awaited<ReturnType<typeof createApp>>["app"];
let token: string;
let directory: string;
const owner = "local-user";
interface TestFact {
  id: string;
  field: string;
  value: string;
  evidence_id: string;
  confirmed: boolean;
}
interface TestItem {
  id: string;
  kind: string;
  file_name: string;
  mime: string;
  confirmed: boolean;
  extraction?: { methods: string[]; warnings: string[]; ocr: boolean };
}
interface TestProfile {
  master_resume_id: string | null;
  evidence: TestItem[];
  draft: { id: string; facts: TestFact[]; evidence_ids: string[] } | null;
  memory: Record<string, string>;
}
interface TestUpload {
  item: TestItem;
}
const auth = () => ({ Authorization: `Bearer ${token}` });

const RESUME_TEXT = `Ahmad Example
Senior Engineer
ahmad@example.com
+1 555 010 2030
Built distributed systems for a decade.`;

async function upload(name: string, bytes: Uint8Array, kind: string) {
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], name));
  form.append("kind", kind);
  const response = await app.request("/api/profile/upload", {
    method: "POST",
    headers: auth(),
    body: form,
  });
  return { status: response.status, json: (await response.json()) as TestUpload };
}

async function getProfile() {
  const response = await app.request("/api/profile", { headers: auth() });
  assert.equal(response.status, 200);
  return (await response.json()) as TestProfile;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openapply-profile-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8788,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8788",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    encryptionKey: randomBytes(32).toString("base64"),
    googleRedirectUri: "http://localhost:8788/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  ({ app } = await createApp(db, config));
  const response = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  token = ((await response.json()) as { token: string }).token;
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("upload creates a draft and promotes nothing until confirm", async () => {
  const { status, json } = await upload(
    "resume.txt",
    new TextEncoder().encode(RESUME_TEXT),
    "resume",
  );
  assert.equal(status, 201);
  assert.equal(json.item.confirmed, false, "evidence must not be promoted before confirm");
  assert.equal(json.item.kind, "master_resume");

  const profile = await getProfile();
  assert.ok(profile.draft, "a draft must exist after upload");
  assert.deepEqual(profile.memory, {}, "memory must stay empty before confirm");
  const fields = profile.draft.facts.map((f: TestFact) => f.field);
  assert.ok(fields.includes("email"), "intake extracts the email fact");
  assert.ok(
    profile.draft.facts.every((f: TestFact) => f.confirmed === false),
    "draft facts are unconfirmed",
  );
});

test("upload records how the text was extracted", async () => {
  const { status, json } = await upload(
    "resume.txt",
    new TextEncoder().encode(RESUME_TEXT),
    "resume",
  );
  assert.equal(status, 201);
  assert.ok(json.item.extraction, "evidence must carry an extraction report");
  assert.ok(
    json.item.extraction.methods.includes("plain-text"),
    `unexpected methods: ${json.item.extraction.methods.join(",")}`,
  );
  assert.deepEqual(json.item.extraction.warnings, []);
});

test("a second pending resume is not a second master", async () => {
  const { status, json } = await upload(
    "resume-v2.txt",
    new TextEncoder().encode(RESUME_TEXT),
    "resume",
  );
  assert.equal(status, 201);
  assert.equal(json.item.kind, "resume", "only the first pending resume may be the master");
  const profile = await getProfile();
  const masters = profile.evidence.filter((e: { kind: string }) => e.kind === "master_resume");
  assert.equal(masters.length, 1, "exactly one master resume may exist");
});

test("memory_writer without confirm fails", async () => {
  const store = new ProfileStore(db, directory);
  const profile = await store.get(owner);
  assert.ok(profile.draft, "draft from the previous test must still be pending");
  await assert.rejects(
    () => store.writeConfirmedMemory(owner, profile.draft?.facts ?? []),
    /not confirmed/,
    "memory_writer must refuse unconfirmed facts",
  );
  const afterAttempt = await store.get(owner);
  assert.deepEqual(afterAttempt.memory, {}, "memory must stay empty after refusal");
});

test("confirm promotes evidence and writes confirmed memory", async () => {
  const response = await app.request("/api/profile/confirm", {
    method: "POST",
    headers: auth(),
  });
  assert.equal(response.status, 200);
  const profile = await getProfile();
  assert.equal(profile.draft, null, "draft is cleared after confirm");
  assert.ok(
    profile.evidence.every((e: TestItem) => e.confirmed),
    "all evidence is confirmed after confirm",
  );
  assert.equal(profile.master_resume_id, profile.evidence[0].id);
  assert.equal(profile.memory.email, "ahmad@example.com", "memory_writer wrote the fact");
});

test("the master resume is immutable", async () => {
  const before = await getProfile();
  const { status, json } = await upload(
    "resume-v2.txt",
    new TextEncoder().encode("Ahmad Example\nahmad2@example.com"),
    "resume",
  );
  assert.equal(status, 201);
  assert.equal(json.item.kind, "resume", "a second resume never becomes the master");
  const afterUpload = await getProfile();
  assert.equal(afterUpload.master_resume_id, before.master_resume_id);

  const del = await app.request(`/api/profile/evidence/${before.master_resume_id}`, {
    method: "DELETE",
    headers: auth(),
  });
  assert.equal(del.status, 409, "forgetting the master resume is refused");
});

test("MIME is sniffed from bytes, not the extension", async () => {
  const { status, json } = await upload(
    "sneaky.pdf",
    new TextEncoder().encode("just plain text"),
    "certificate",
  );
  assert.equal(status, 201);
  assert.equal(json.item.mime, "text/plain", "bytes win over the .pdf extension");

  const bad = await upload(
    "evil.pdf",
    new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
    "certificate",
  );
  assert.equal(bad.status, 422, "unrecognized bytes are rejected");
});

test("forget removes evidence and its draft facts", async () => {
  const { json } = await upload(
    "cert.txt",
    new TextEncoder().encode("Certificate of Awesomeness, issued 2024"),
    "certificate",
  );
  const id = json.item.id as string;
  const fact = await app.request("/api/profile/facts", {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ field: "award", value: "Awesomeness 2024", evidence_id: id }),
  });
  assert.equal(fact.status, 201);

  const del = await app.request(`/api/profile/evidence/${id}`, {
    method: "DELETE",
    headers: auth(),
  });
  assert.equal(del.status, 200);
  const profile = await getProfile();
  assert.ok(!profile.evidence.some((e: TestItem) => e.id === id), "evidence is gone");
  assert.ok(
    !(profile.draft?.facts ?? []).some((f: TestFact) => f.evidence_id === id),
    "facts drawn from it are gone",
  );
});
