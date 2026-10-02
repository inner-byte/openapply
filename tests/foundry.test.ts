/**
 * Document Foundry (Phase 1): content model, sanitizer, Typst templates.
 * Invariants:
 * - The agent writes JSON only; content strings can never inject Typst code.
 * - Budget overflow throws a cut-list instead of silently crowding the page.
 * - Previews are rendered FROM the generated PDF bytes (pdftoppm).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { renderResume } from "../apps/server/src/foundry/render.ts";
import { escapeTypst, FoundryError, sanitizeResume } from "../apps/server/src/foundry/sanitize.ts";

const fixtureUrl = new URL("../apps/server/src/foundry/fixtures/demo-resume.json", import.meta.url);

async function demoContent(): Promise<unknown> {
  return JSON.parse(await readFile(fixtureUrl, "utf-8"));
}

test("foundry: Typst markup in content is escaped, never executed", () => {
  assert.equal(escapeTypst("#set page(margin: 0pt)"), "\\#set page(margin: 0pt)");
  const out = sanitizeResume(
    {
      full_name: "Ahmad #Example",
      links: [],
      email: "a@example.com",
      mobile: "+1",
      education: [],
      skills: [],
      experience: [],
      projects: [],
      certificates: [],
    },
    "template-one",
  );
  assert.equal(out.full_name, "Ahmad \\#Example");
});

test("foundry: budget overflow throws a cut-list instead of crowding", async () => {
  const content = (await demoContent()) as Record<string, unknown>;
  const bloated = {
    ...content,
    experience: [
      {
        title: "Role",
        dates: "2024",
        bullets: Array.from({ length: 9 }, (_, i) => `Bullet ${i}`),
      },
    ],
  };
  assert.throws(
    () => sanitizeResume(bloated, "template-one"),
    (err: unknown) => {
      assert.ok(err instanceof FoundryError);
      assert.match(err.message, /exceeds the "template-one" budgets/);
      assert.match(err.message, /9 bullets exceeds max 6/);
      return true;
    },
  );
});

test("foundry: unknown template is rejected", async () => {
  const content = await demoContent();
  await assert.rejects(() => renderResume("nope", content), /Unknown template/);
});

test("foundry: template-one renders PDF + page previews from the same bytes", {
  timeout: 120_000,
}, async () => {
  const result = await renderResume("template-one", await demoContent());
  assert.ok(result.pdf.subarray(0, 5).toString() === "%PDF-", "expected a real PDF");
  assert.ok(result.pageCount >= 1, "expected at least one page preview");
  assert.equal(result.pages.length, result.pageCount);
  for (const page of result.pages)
    assert.ok(page.length > 1000, "page preview should be a real PNG");
});

test(
  "foundry: cover letter renders with template tokens (one + six)",
  async () => {
    const { renderCover } = await import("../apps/server/src/foundry/render.ts");
    const { readFile } = await import("node:fs/promises");
    const content = JSON.parse(
      await readFile(
        new URL("../apps/server/src/foundry/fixtures/demo-cover.json", import.meta.url),
        "utf-8",
      ),
    );
    for (const templateId of ["template-one", "template-six"]) {
      const result = await renderCover(templateId, content);
      assert.equal(result.pdf.subarray(0, 5).toString(), "%PDF-");
      assert.ok(result.pageCount >= 1);
      assert.equal(result.pages.length, result.pageCount);
    }
  }
);

test(
  "foundry: statement renders with template tokens",
  async () => {
    const { renderStatement } = await import("../apps/server/src/foundry/render.ts");
    const { readFile } = await import("node:fs/promises");
    const content = JSON.parse(
      await readFile(
        new URL("../apps/server/src/foundry/fixtures/demo-statement.json", import.meta.url),
        "utf-8",
      ),
    );
    const result = await renderStatement("template-four", content);
    assert.equal(result.pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(result.pageCount >= 1);
  }
);

test("foundry: cover letter paragraph overflow throws a cut-list", async () => {
  const { sanitizeCover } = await import("../apps/server/src/foundry/sanitize.ts");
  const { readFile } = await import("node:fs/promises");
  const content = JSON.parse(
    await readFile(
      new URL("../apps/server/src/foundry/fixtures/demo-cover.json", import.meta.url),
      "utf-8",
    ),
  );
  const bloated = { ...content, paragraphs: Array.from({ length: 8 }, () => "Para.") };
  assert.throws(
    () => sanitizeCover(bloated),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /8 paragraphs exceeds max 5/);
      return true;
    },
  );
});

test(
  "foundry: DOCX mirror renders all 7 templates without Typst escapes",
  async () => {
    const { renderDocx } = await import("../apps/server/src/foundry/docx.ts");
    const { TEMPLATES } = await import("../apps/server/src/foundry/model.ts");
    const { readFile } = await import("node:fs/promises");
    const { execFile } = await import("node:child_process");
    const resume = JSON.parse(
      await readFile(
        new URL("../apps/server/src/foundry/fixtures/demo-resume.json", import.meta.url),
        "utf-8",
      ),
    );
    for (const t of TEMPLATES) {
      const buf = await renderDocx("resume", t.id, resume);
      assert.equal(buf.subarray(0, 2).toString(), "PK", `${t.id}: expected a zip (docx)`);
      const { unzipSync, strFromU8 } = await import("fflate");
      const docXml = strFromU8(unzipSync(new Uint8Array(buf))["word/document.xml"]);
      assert.ok(docXml.includes("Ahmad Example"), `${t.id}: name must appear`);
      assert.ok(
        docXml.includes("ahmad@example.com"),
        `${t.id}: email must not carry Typst escapes`,
      );
      assert.ok(!docXml.includes("ahmad\\@"), `${t.id}: no Typst escapes in docx`);
    }
  }
);

test(
  "foundry: DOCX cover + statement generate",
  async () => {
    const { renderDocx } = await import("../apps/server/src/foundry/docx.ts");
    const { readFile } = await import("node:fs/promises");
    const base = new URL("../apps/server/src/foundry/fixtures/", import.meta.url);
    const cover = JSON.parse(await readFile(new URL("demo-cover.json", base), "utf-8"));
    const statement = JSON.parse(await readFile(new URL("demo-statement.json", base), "utf-8"));
    for (const [kind, content] of [
      ["cover", cover],
      ["statement", statement],
    ] as const) {
      const buf = await renderDocx(kind, "template-one", content);
      assert.equal(buf.subarray(0, 2).toString(), "PK", `${kind}: expected a zip (docx)`);
    }
  }
);

test(
  "foundry: DOCX round-trips through LibreOffice to PDF",
  async () => {
    const { renderDocx } = await import("../apps/server/src/foundry/docx.ts");
    const { mkdtemp, readFile, readdir, writeFile } = await import("node:fs/promises");
    const { execFile } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const resume = JSON.parse(
      await readFile(
        new URL("../apps/server/src/foundry/fixtures/demo-resume.json", import.meta.url),
        "utf-8",
      ),
    );
    const buf = await renderDocx("resume", "template-one", resume);
    const dir = await mkdtemp(join(tmpdir(), "oa-foundry-lo-"));
    await writeFile(join(dir, "resume.docx"), buf);
    await new Promise<void>((resolve, reject) => {
      execFile(
        "soffice",
        ["--headless", "--convert-to", "pdf", "--outdir", dir, join(dir, "resume.docx")],
        { timeout: 110_000 },
        (err, _out, stderr) =>
          err ? reject(new Error(`soffice failed: ${String(stderr).slice(0, 300)}`)) : resolve(),
      );
    });
    const files = await readdir(dir);
    assert.ok(files.includes("resume.pdf"), "LibreOffice must produce a PDF from the docx");
    const pdf = await readFile(join(dir, "resume.pdf"));
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  }
);

test("foundry: empty education location/dates sanitize to empty, nothing invented", () => {
  const sanitized = sanitizeResume(
    {
      full_name: "Test Candidate",
      email: "t@example.com",
      mobile: "+1 555 0100",
      links: [],
      education: [
        { institution: "Test University", location: "", degree: "B.Sc", dates: "" },
        { institution: "Other College", degree: "M.Sc" },
      ],
      skills: [],
      experience: [],
      projects: [],
      certificates: [],
    },
    "template-one",
  );
  assert.equal(sanitized.education[0]?.location, "");
  assert.equal(sanitized.education[0]?.dates, "");
  assert.equal(sanitized.education[1]?.location, "");
  // Required fields still enforced.
  assert.throws(
    () =>
      sanitizeResume(
        {
          full_name: "Test Candidate",
          email: "t@example.com",
          mobile: "+1 555 0100",
          links: [],
          education: [{ institution: "", location: "", degree: "B.Sc", dates: "" }],
          skills: [],
          experience: [],
          projects: [],
          certificates: [],
        },
        "template-one",
      ),
    (e: unknown) => e instanceof FoundryError,
  );
});
