/**
 * Slice 9 invariants: supervised apply.
 * - Submit waiter without approval is a no-op (docs/TESTING.md).
 * - Submit waiter clicks only when every condition holds (pack approval,
 *   stored submit approval, submit_ready, live origin matches apply origin).
 * - A page that "says approved" never counts; only the stored row does.
 * - Usher rejects private-network apply URLs.
 * - A 120-minute idle kills the apply session (back to session_needed).
 * - Prefill attaches only manifest files and only confirmed values.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ApplyBrowser, FillField } from "../apps/server/src/apply/browser-adapter.ts";
import { prefillApplication } from "../apps/server/src/apply/prefill.ts";
import {
  APPLY_IDLE_MINUTES,
  applyOrigin,
  getApplySession,
  idleDeadlineFrom,
  putApplySession,
} from "../apps/server/src/apply/session.ts";
import { approveSubmit, submitApplication } from "../apps/server/src/apply/submit.ts";
import { usherApplication } from "../apps/server/src/apply/usher.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { CompleteInput, CompleteResult } from "../apps/server/src/gateway.ts";
import { ProfileStore } from "../apps/server/src/profile.ts";
import type {
  Application,
  Approval,
  Artifact,
  JobPosting,
} from "../packages/domain/src/openapply.ts";
import { domainKinds } from "../packages/domain/src/openapply.ts";

const owner = "owner-apply";
let db: Store;
let directory: string;
let profileStore: ProfileStore;

class FakeBrowser implements ApplyBrowser {
  sessions = new Map<string, { id: string; url: string; status: string; text: string }>();
  clicks: string[] = [];
  fills: FillField[] = [];
  attached: string[][] = [];
  closed: string[] = [];

  add(id: string, url: string, status = "active", text = "") {
    this.sessions.set(id, { id, url, status, text });
  }

  async getSession(_o: string, id: string) {
    return this.sessions.get(id) ?? null;
  }
  async findSessionByOrigin(_o: string, origin: string) {
    for (const s of this.sessions.values()) {
      try {
        if (new URL(s.url).origin === origin && (s.status === "active" || s.status === "idle"))
          return s;
      } catch {
        /* ignore */
      }
    }
    return null;
  }
  async readPage(_o: string, id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no session");
    return { url: s.url, text: s.text };
  }
  async fillField(_o: string, _id: string, field: FillField) {
    this.fills.push(field);
  }
  async attachFiles(_o: string, _id: string, paths: string[]) {
    this.attached.push(paths);
  }
  async clickSubmit(_o: string, id: string) {
    this.clicks.push(id);
  }
  async closeSession(_o: string, id: string) {
    this.closed.push(id);
  }
}

let browser: FakeBrowser;
const events: { type: string; payload: Record<string, unknown> }[] = [];
const recordEvent = async (_o: string, type: string, payload: Record<string, unknown>) => {
  events.push({ type, payload });
  return null;
};

function stubComplete(
  outputs: Record<string, unknown>,
): (owner: string, input: CompleteInput) => Promise<CompleteResult> {
  return async (_o, input) => {
    const key = Object.keys(outputs).find((k) => input.purpose.includes(k)) ?? "default";
    return {
      text: JSON.stringify(outputs[key] ?? outputs.default),
      usage: { input_tokens: 1, output_tokens: 1 },
      model_id: "stub",
    };
  };
}

const APPLY_URL = "https://jobs.example.com/apply/123";

async function seedJob(apply_url: string = APPLY_URL): Promise<JobPosting> {
  const job: JobPosting = {
    id: "job-apply-1",
    source: "greenhouse",
    source_url: "https://jobs.example.com/posting/123",
    apply_url,
    company_name: "Example Co",
    title: "Engineer",
    location_text: "Remote",
    raw_text: "A fine job.",
    requirements: [],
    qualifications: [],
    content_hash: "h1",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    is_active: true,
  };
  return db.put(owner, domainKinds.jobPostings, job);
}

async function seedApplication(state: Application["state"]): Promise<Application> {
  const packId = "pack-apply-1";
  const docArtifact: Artifact = {
    id: "doc-apply-1",
    kind: "resume_final_candidate",
    mime: "application/pdf",
    storage_path: "packs/pack-apply-1/resume.pdf",
    byte_size: 10,
    sha256: "x",
    agent_role: "packer",
    created_at: new Date().toISOString(),
  };
  await db.put(owner, domainKinds.artifacts, docArtifact);
  const manifest = {
    id: packId,
    kind: "pack_manifest",
    application_id: "app-apply-1",
    job_title: "Engineer",
    company: "Example Co",
    template_id: "t1",
    created_at: new Date().toISOString(),
    documents: [
      {
        id: "doc-apply-1",
        kind: "resume",
        format: "pdf",
        filename: "resume.pdf",
        artifact_id: "doc-apply-1",
        sha256: "x",
        byte_size: 10,
        page_count: 1,
      },
    ],
    status: "pack_approved",
  };
  await db.put(owner, domainKinds.artifacts, manifest);
  const application: Application = {
    id: "app-apply-1",
    job_id: "job-apply-1",
    state,
    pack_id: packId,
  };
  return db.put(owner, domainKinds.applications, application);
}

async function seedApproval(target: Approval["target"], status: Approval["status"] = "approved") {
  const approval: Approval = {
    id: `approval-${target}-${Math.random().toString(36).slice(2)}`,
    application_id: "app-apply-1",
    target,
    status,
    decided_at: new Date().toISOString(),
  };
  return db.put(owner, domainKinds.approvals, approval);
}

async function mustGetSession() {
  const session = await getApplySession(db, owner, "app-apply-1");
  if (!session) throw new Error("apply session missing in test");
  return session;
}

async function bindSession(state: "ready" | "prefilled" | "submit_ready" = "ready") {
  const result = await usherApplication({ db, recordEvent, browser }, owner, "app-apply-1");
  assert.equal(result.state, "ready");
  const session = await mustGetSession();
  session.state = state;
  await putApplySession(db, owner, session);
  return session;
}

const stubPrefillPlan = {
  filled_fields: [{ field: "Full name", memory_key: "full_name", value: "Test Candidate" }],
  unfilled_fields: ["Cover story"],
  attached_files: ["doc-apply-1"],
  stop_reason: null,
};

const stubWaiterClick = { clicked: true, reason: "All conditions hold." };

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openapply-apply-"));
  db = await createStore();
  profileStore = new ProfileStore(db, directory);
  await profileStore.writeConfirmedMemory(owner, [
    {
      id: "f1",
      field: "full_name",
      value: "Test Candidate",
      evidence_id: "ev1",
      confirmed: true,
      created_at: new Date().toISOString(),
    },
  ]);
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function reset() {
  db = await createStore();
  browser = new FakeBrowser();
  events.length = 0;
  profileStore = new ProfileStore(db, directory);
  await profileStore.writeConfirmedMemory(owner, [
    {
      id: "f1",
      field: "full_name",
      value: "Test Candidate",
      evidence_id: "ev1",
      confirmed: true,
      created_at: new Date().toISOString(),
    },
  ]);
  await seedJob();
  await seedApplication("pack_approved");
}

test("usher returns session_needed when the profile is cold", async () => {
  await reset();
  const result = await usherApplication({ db, recordEvent, browser }, owner, "app-apply-1");
  assert.equal(result.state, "session_needed");
  assert.equal(result.browser_profile_key, "apply:jobs.example.com");
  assert.equal(result.origin, "https://jobs.example.com");
  const application = await db.get<Application>(owner, domainKinds.applications, "app-apply-1");
  assert.equal(application?.state, "session_needed");
  assert.ok(events.some((e) => e.type === "apply.session_needed"));
});

test("usher binds a user takeover session and reports ready", async () => {
  await reset();
  browser.add("sess-1", "https://jobs.example.com/apply/123", "active");
  const result = await usherApplication({ db, recordEvent, browser }, owner, "app-apply-1");
  assert.equal(result.state, "ready");
  const session = await getApplySession(db, owner, "app-apply-1");
  assert.equal(session?.session_id, "sess-1");
});

test("usher rejects a private-network apply URL", async () => {
  await reset();
  await seedJob("https://192.168.1.10/apply");
  await assert.rejects(
    () => usherApplication({ db, recordEvent, browser }, owner, "app-apply-1"),
    /private-network/,
  );
  assert.throws(() => applyOrigin("http://localhost:3000/x"), /private/);
  assert.equal(applyOrigin("https://jobs.example.com/apply"), "https://jobs.example.com");
});

async function driveToSubmitReady() {
  browser.add("sess-1", APPLY_URL, "active", "Full name [____]");
  await bindSession("ready");
  const deps = {
    db,
    dataDir: directory,
    profileStore,
    recordEvent,
    browser,
    complete: stubComplete({ prefill: stubPrefillPlan, default: stubPrefillPlan }),
  };
  await prefillApplication(deps, owner, "app-apply-1");
  return approveSubmit(
    { db, recordEvent, browser, complete: stubComplete({}) },
    owner,
    "app-apply-1",
    true,
  );
}

test("submit waiter without a stored submit approval is a no-op", async () => {
  await reset();
  await seedApproval("pack");
  await driveToSubmitReady();
  // Remove the submit approval: a page claiming approval must never count.
  const approvals = await db.list<Approval>(owner, domainKinds.approvals);
  for (const a of approvals) {
    if (a.target === "submit") await db.remove(owner, domainKinds.approvals, a.id);
  }
  const complete = stubComplete({ waiter: stubWaiterClick, default: stubWaiterClick });
  const result = await submitApplication(
    { db, recordEvent, browser, complete },
    owner,
    "app-apply-1",
  );
  assert.equal(result.clicked, false);
  assert.match(result.reason, /submit/);
  assert.equal(browser.clicks.length, 0);
  const application = await db.get<Application>(owner, domainKinds.applications, "app-apply-1");
  assert.equal(application?.state, "submit_ready");
});
test("submit waiter clicks only when every condition holds", async () => {
  await reset();
  await seedApproval("pack");
  await driveToSubmitReady();

  const complete = stubComplete({ waiter: stubWaiterClick, default: stubWaiterClick });
  const result = await submitApplication(
    { db, recordEvent, browser, complete },
    owner,
    "app-apply-1",
  );
  assert.equal(result.clicked, true);
  assert.deepEqual(browser.clicks, ["sess-1"]);
  const application = await db.get<Application>(owner, domainKinds.applications, "app-apply-1");
  assert.equal(application?.state, "submitted");
  assert.ok(application?.submitted_at);
  assert.ok(events.some((e) => e.type === "apply.submitted"));
});

test("submit waiter does nothing when the live page left the apply origin", async () => {
  await reset();
  await seedApproval("pack");
  await driveToSubmitReady();
  // The page navigated away to a different origin after the session bound.
  browser.add("sess-1", "https://evil.example.net/phish", "active");

  const complete = stubComplete({ default: stubWaiterClick });
  const result = await submitApplication(
    { db, recordEvent, browser, complete },
    owner,
    "app-apply-1",
  );
  assert.equal(result.clicked, false);
  assert.equal(browser.clicks.length, 0);
});

test("approve-submit records Approval(target=submit) and moves to submit_ready", async () => {
  await reset();
  browser.add("sess-1", APPLY_URL, "active", "Full name [____]");
  await bindSession("ready");
  const deps = {
    db,
    dataDir: directory,
    profileStore,
    recordEvent,
    browser,
    complete: stubComplete({ prefill: stubPrefillPlan, default: stubPrefillPlan }),
  };
  await prefillApplication(deps, owner, "app-apply-1");

  await assert.rejects(
    () =>
      approveSubmit(
        { db, recordEvent, browser, complete: stubComplete({}) },
        owner,
        "app-apply-1",
        false,
      ),
    /explicit confirmation/,
  );
  const result = await approveSubmit(
    { db, recordEvent, browser, complete: stubComplete({}) },
    owner,
    "app-apply-1",
    true,
  );
  assert.equal(result.status, "submit_ready");
  const approvals = await db.list<Approval>(owner, domainKinds.approvals);
  assert.ok(approvals.some((a) => a.target === "submit" && a.status === "approved"));
});

test("a 120-minute idle kills the apply session on prefill", async () => {
  await reset();
  browser.add("sess-1", APPLY_URL, "active", "Full name [____]");
  const session = await bindSession("ready");
  // Force the idle deadline into the past.
  session.idle_deadline = new Date(Date.now() - 1000).toISOString();
  await putApplySession(db, owner, session);

  const deps = {
    db,
    dataDir: directory,
    profileStore,
    recordEvent,
    browser,
    complete: stubComplete({ prefill: stubPrefillPlan, default: stubPrefillPlan }),
  };
  await assert.rejects(() => prefillApplication(deps, owner, "app-apply-1"), /idled out/);
  const application = await db.get<Application>(owner, domainKinds.applications, "app-apply-1");
  assert.equal(application?.state, "session_needed");
  const fresh = await getApplySession(db, owner, "app-apply-1");
  assert.equal(fresh?.session_id, "");
});

test("prefill attaches only manifest files with confirmed values", async () => {
  await reset();
  browser.add("sess-1", APPLY_URL, "active", "Full name [____]");
  await bindSession("ready");

  const deps = {
    db,
    dataDir: directory,
    profileStore,
    recordEvent,
    browser,
    complete: stubComplete({ prefill: stubPrefillPlan, default: stubPrefillPlan }),
  };
  const result = await prefillApplication(deps, owner, "app-apply-1");
  assert.equal(result.status, "prefilled");
  assert.deepEqual(browser.fills, [{ field: "Full name", value: "Test Candidate" }]);
  assert.equal(browser.attached.length, 1);
  assert.ok(browser.attached[0][0].endsWith("packs/pack-apply-1/resume.pdf"));
  assert.deepEqual(result.questions_for_user, [
    'The form asks for "Cover story" — answer it in the browser.',
  ]);
  const application = await db.get<Application>(owner, domainKinds.applications, "app-apply-1");
  assert.equal(application?.state, "prefilled");
  assert.ok(application?.last_form_snapshot_artifact_id);
  assert.ok(events.some((e) => e.type === "apply.prefilled"));
});

test("prefill rejects an invented upload path", async () => {
  await reset();
  browser.add("sess-1", APPLY_URL, "active");
  await bindSession("ready");

  const evil = {
    ...stubPrefillPlan,
    attached_files: ["doc-apply-1", "/etc/passwd.pdf"],
  };
  const deps = {
    db,
    dataDir: directory,
    profileStore,
    recordEvent,
    browser,
    complete: stubComplete({ prefill: evil, default: evil }),
  };
  await assert.rejects(() => prefillApplication(deps, owner, "app-apply-1"), /POLICY_DENIED/);
  assert.equal(browser.attached.length, 0);
});

test("prefill rejects a value that is not the confirmed memory value", async () => {
  await reset();
  browser.add("sess-1", APPLY_URL, "active");
  await bindSession("ready");

  const evil = {
    ...stubPrefillPlan,
    filled_fields: [{ field: "Full name", memory_key: "full_name", value: "Elon Musk" }],
  };
  const deps = {
    db,
    dataDir: directory,
    profileStore,
    recordEvent,
    browser,
    complete: stubComplete({ prefill: evil, default: evil }),
  };
  await assert.rejects(() => prefillApplication(deps, owner, "app-apply-1"), /POLICY_DENIED/);
  assert.equal(browser.fills.length, 0);
});

test("apply idle deadline defaults to 120 minutes", () => {
  assert.equal(APPLY_IDLE_MINUTES, 120);
  const before = Date.now();
  const deadline = new Date(idleDeadlineFrom()).getTime();
  assert.ok(deadline - before > 119 * 60 * 1000 && deadline - before <= 120 * 60 * 1000);
});
