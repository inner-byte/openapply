/**
 * DOCX mirror: the same sanitized content JSON + tokens rendered to .docx
 * via python-docx. Decision-time format: the packer renders PDF (Typst) or
 * DOCX from the same canonical JSON depending on what the portal requires.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_TOKENS, TEMPLATE_BUDGETS } from "./model.ts";
import { forDocx, sanitizeCover, sanitizeResume, sanitizeStatement } from "./sanitize.ts";

const here = dirname(fileURLToPath(import.meta.url));

export type DocxKind = "resume" | "cover" | "statement";

function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} failed: ${String(stderr).slice(0, 500) || err.message}`));
        else resolve(String(stdout));
      },
    );
  });
}

/**
 * Render content to DOCX bytes using the template's style tokens.
 * Throws on unknown template or budget violations (same as the PDF path).
 */
export async function renderDocx(
  kind: DocxKind,
  templateId: string,
  content: unknown,
): Promise<Buffer> {
  const tokens = DOC_TOKENS[templateId];
  if (!tokens) throw new Error(`Unknown template "${templateId}".`);
  let sanitized: unknown;
  if (kind === "resume") {
    if (!TEMPLATE_BUDGETS[templateId]) throw new Error(`Unknown template "${templateId}".`);
    sanitized = forDocx(sanitizeResume(content, templateId));
  } else if (kind === "cover") {
    sanitized = forDocx(sanitizeCover(content));
  } else {
    sanitized = forDocx(sanitizeStatement(content));
  }

  const dir = await mkdtemp(join(tmpdir(), "oa-foundry-docx-"));
  try {
    const contentPath = join(dir, "content.json");
    const tokensPath = join(dir, "tokens.json");
    const outPath = join(dir, "out.docx");
    await writeFile(contentPath, JSON.stringify(sanitized), "utf-8");
    await writeFile(tokensPath, JSON.stringify(tokens), "utf-8");
    await run(
      "python3",
      [
        join(here, "docx_render.py"),
        "--kind",
        kind,
        "--content",
        contentPath,
        "--tokens",
        tokensPath,
        "--out",
        outPath,
      ],
      dir,
    );
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
