import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserManager, validateProfileKey } from "../src/browser.ts";
import { WorkerError } from "../src/errors.ts";

async function withManager<T>(
  fn: (browser: Awaited<ReturnType<typeof createBrowserManager>>, dataDir: string) => Promise<T>,
) {
  const dataDir = await mkdtemp(join(tmpdir(), "openapply-browser-extensions-"));
  const browser = await createBrowserManager({
    dataDir,
    upstreamProxy: process.env.WORKER_UPSTREAM_PROXY,
  });
  try {
    return await fn(browser, dataDir);
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("validateProfileKey accepts origin-scoped keys like apply:example.com", () => {
  assert.equal(validateProfileKey("apply:example.com"), "apply:example.com");
  for (const bad of [
    "../escape",
    "a/b",
    "apply:https://example.com",
    "x".repeat(121),
    "",
    "has space",
    "semi;colon",
  ]) {
    assert.throws(() => validateProfileKey(bad), WorkerError, `key ${bad} should be rejected`);
  }
});

test("named profile sessions share a profile dir per origin", {
  timeout: 90_000,
}, async () => {
  await withManager(async (browser, dataDir) => {
    const id = randomUUID();
    const created = await browser.create(id, "https://example.com/", {
      profileKey: "apply:example.com",
      sessionClass: "apply",
    });
    assert.equal(created.profileKey, "apply:example.com");
    assert.equal(created.idleMinutes, 120);
    const profileDir = join(dataDir, "profiles", "apply:example.com");
    assert.equal((await stat(profileDir)).isDirectory(), true);
    await browser.closeSession(id);
    // Storage state (cookies) lives with the named profile, not the session.
    await stat(join(profileDir, "storage.json"));
  });
});

test("explicit idle_minutes wins over the session class default", {
  timeout: 90_000,
}, async () => {
  await withManager(async (browser) => {
    const id = randomUUID();
    const created = await browser.create(id, "https://example.com/", {
      sessionClass: "hunt",
      idleMinutes: 45,
    });
    assert.equal(created.idleMinutes, 45);
    const hunted = await browser.create(randomUUID(), "https://example.com/", {
      sessionClass: "hunt",
    });
    assert.equal(hunted.idleMinutes, 60);
    const plain = await browser.create(randomUUID(), "https://example.com/");
    assert.equal(plain.idleMinutes, 30);
  });
});

test("file-chooser rejects paths outside the pack directory", {
  timeout: 90_000,
}, async () => {
  await withManager(async (browser, dataDir) => {
    const packDir = join(dataDir, "..", "files");
    await mkdir(packDir, { recursive: true });
    const id = randomUUID();
    await browser.create(id, "https://example.com/");
    for (const bad of ["../secret.pdf", "/etc/passwd", "resume.exe", ""]) {
      await assert.rejects(browser.fileChooser(id, [bad]), { code: "INVALID_PATH" });
    }
    // A pack file exists but the page has no file input.
    await writeFile(join(packDir, "resume.pdf"), "%PDF-1.4 fake");
    await assert.rejects(browser.fileChooser(id, ["resume.pdf"]), {
      code: "FILE_INPUT_NOT_FOUND",
    });
  });
});

test("file-chooser attaches a pack file to a real file input", {
  timeout: 120_000,
}, async () => {
  await withManager(async (browser, dataDir) => {
    const packDir = join(dataDir, "..", "files");
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, "resume.pdf"), "%PDF-1.4 fake");
    const id = randomUUID();
    // NOTE: httpbin.org/forms/post has no file input; the blueimp demo does.
    await browser.create(id, "https://blueimp.github.io/jQuery-File-Upload/");
    const result = await browser.fileChooser(id, ["resume.pdf"]);
    assert.equal(result.status, "active");
  });
});

test("concurrent sessions on one named profile get PROFILE_IN_USE", {
  timeout: 120_000,
}, async () => {
  await withManager(async (browser) => {
    const first = randomUUID();
    await browser.create(first, "https://example.com/", {
      profileKey: "apply:example.com",
      sessionClass: "apply",
    });
    await assert.rejects(
      browser.create(randomUUID(), "https://example.com/", {
        profileKey: "apply:example.com",
        sessionClass: "apply",
      }),
      { code: "PROFILE_IN_USE" },
    );
    await browser.closeSession(first);
    // The profile is reusable once the first session closes.
    const second = await browser.create(randomUUID(), "https://example.com/", {
      profileKey: "apply:example.com",
      sessionClass: "apply",
    });
    assert.equal(second.profileKey, "apply:example.com");
    await browser.closeSession(second.id);
  });
});

test("submit clicks an implicit <button> inside a form", {
  timeout: 120_000,
}, async () => {
  await withManager(async (browser) => {
    const id = randomUUID();
    // httpbin's form uses <button>Submit order</button> with no type attribute,
    // which per HTML defaults to type=submit inside a form.
    await browser.create(id, "https://httpbin.org/forms/post");
    const result = await browser.submit(id);
    assert.match(result.url, /httpbin\.org\/post/);
  });
});

test("submit reports a missing submit control instead of clicking blindly", {
  timeout: 90_000,
}, async () => {
  await withManager(async (browser) => {
    const id = randomUUID();
    await browser.create(id, "https://example.com/");
    await assert.rejects(browser.submit(id), { code: "SUBMIT_NOT_FOUND" });
  });
});

test("input fill rejects invalid payloads without touching the page", {
  timeout: 90_000,
}, async () => {
  await withManager(async (browser) => {
    const id = randomUUID();
    await browser.create(id, "https://example.com/");
    await assert.rejects(browser.input(id, { action: "fill", value: "x" }), {
      code: "INVALID_INPUT",
    });
    await assert.rejects(
      browser.input(id, { action: "fill", field: "Name", value: "x".repeat(10_001) }),
      {
        code: "INVALID_INPUT",
      },
    );
  });
});
