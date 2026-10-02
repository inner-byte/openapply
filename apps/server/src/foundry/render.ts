/**
 * Foundry renderer: sanitized JSON + locked Typst template -> PDF + page previews.
 *
 * The agent never writes .typ. Templates live in `templates/` and change
 * only by us. Previews are rendered FROM the generated PDF bytes
 * (pdftoppm) — the same bytes the user downloads.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_TOKENS, TEMPLATE_BUDGETS } from "./model.ts";
import { sanitizeCover, sanitizeResume, sanitizeStatement } from "./sanitize.ts";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(here, "templates");

function typstBin(): string {
  return (
    process.env.TYPST_BIN ??
    join(
      process.env.HOME ?? "~",
      "workspace",
      ".local-bin",
      "typst-x86_64-unknown-linux-musl",
      "typst",
    )
  );
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, _out, stderr) => {
        if (err) reject(new Error(`${cmd} failed: ${String(stderr).slice(0, 500) || err.message}`));
        else resolve();
      },
    );
  });
}

export interface RenderResult {
  pdf: Buffer;
  pages: Buffer[];
  pageCount: number;
  templateId: string;
}

/**
 * Render resume content with a locked template.
 * Returns the PDF bytes plus one PNG per page, rendered from those bytes.
 */
export async function renderResume(templateId: string, content: unknown): Promise<RenderResult> {
  const budget = TEMPLATE_BUDGETS[templateId];
  if (!budget) throw new Error(`Unknown template "${templateId}".`);
  const sanitized = sanitizeResume(content, templateId);
  return compileTyp(`${templateId}.typ`, { "content.json": sanitized }, templateId, "resume");
}

async function compileTyp(
  templateFile: string,
  payloads: Record<string, unknown>,
  templateId: string,
  outName: string,
): Promise<RenderResult> {
  const dir = await mkdtemp(join(tmpdir(), "oa-foundry-"));
  try {
    for (const [name, payload] of Object.entries(payloads))
      await writeFile(join(dir, name), JSON.stringify(payload), "utf-8");
    await copyFile(join(TEMPLATES_DIR, templateFile), join(dir, `${outName}.typ`));
    await run(typstBin(), ["compile", `${outName}.typ`, `${outName}.pdf`], dir);
    const pdf = await readFile(join(dir, `${outName}.pdf`));

    // Page previews FROM the generated PDF.
    await run("pdftoppm", ["-png", "-r", "110", `${outName}.pdf`, "preview"], dir);
    const files = (await readdir(dir)).filter((f) => f.startsWith("preview-")).sort();
    const pages: Buffer[] = [];
    for (const f of files) pages.push(await readFile(join(dir, f)));

    return { pdf, pages, pageCount: pages.length, templateId };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function tokensFor(templateId: string) {
  const tokens = DOC_TOKENS[templateId];
  if (!tokens) throw new Error(`Unknown template "${templateId}".`);
  return tokens;
}

/**
 * Render a cover letter with the tokens of the user's chosen resume template,
 * so the letter always matches the CV visually.
 */
export async function renderCover(templateId: string, content: unknown): Promise<RenderResult> {
  const sanitized = sanitizeCover(content);
  return compileTyp(
    "cover.typ",
    { "content.json": sanitized, "tokens.json": tokensFor(templateId) },
    templateId,
    "cover",
  );
}

/**
 * Render a personal statement with the tokens of the chosen resume template.
 */
export async function renderStatement(templateId: string, content: unknown): Promise<RenderResult> {
  const sanitized = sanitizeStatement(content);
  return compileTyp(
    "statement.typ",
    { "content.json": sanitized, "tokens.json": tokensFor(templateId) },
    templateId,
    "statement",
  );
}
