/**
 * Production-grade document text extraction.
 *
 * Layered pipeline, deterministic tools first, model vision as fallback:
 *
 *   PDF    pdftotext (poppler, per page) -> pdfjs-dist (pure JS fallback)
 *          pages with no native text but embedded images -> OCR
 *   DOCX   unzip + word/document.xml parse (same technique as python-docx)
 *   Images png/jpg/webp -> vision model OCR -> tesseract (if installed)
 *   Text   utf-8 decode
 *   ZIP    stored, contents not inspected
 *
 * OCR order is deliberate: a vision-capable model first (per product
 * direction), a local OCR binary second, and an explicit "unreadable"
 * report rather than a silent empty string. Downstream code must never
 * invent facts from pages marked unreadable.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export const EXCERPT_CHARS = 20_000;
/** A PDF page with fewer native-text chars than this is a scan candidate. */
const SCAN_THRESHOLD_CHARS = 40;
/** Never OCR more than this many pages per document (cost guard). */
const MAX_OCR_PAGES = 10;

export type ExtractMethod =
  | "pdftotext"
  | "pdfjs"
  | "docx-xml"
  | "plain-text"
  | "vision-ocr"
  | "tesseract"
  | "none";

export interface PageReport {
  page: number;
  chars: number;
  method: ExtractMethod;
  /** False when the page yielded no usable text by any available means. */
  readable: boolean;
}

export interface ExtractionReport {
  methods: ExtractMethod[];
  warnings: string[];
  /** True when any text came from OCR/vision rather than the document itself. */
  ocr: boolean;
  chars: number;
  pages: PageReport[];
}

export interface ExtractResult {
  text: string;
  report: ExtractionReport;
}

/** Transcribe visible text from an image. Throws when unavailable. */
export type VisionOcrFn = (image: Uint8Array, mime: string) => Promise<string>;

export interface ExtractOptions {
  visionOcr?: VisionOcrFn;
}

/** Which local extraction binaries are present. Useful for diagnostics. */
export async function extractionTools(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const name of ["pdftotext", "pdfinfo", "pdfimages", "pdftoppm", "tesseract"])
    out[name] = await hasTool(name);
  return out;
}

const toolCache = new Map<string, boolean>();

function probeTool(name: string, flag: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(name, [flag], { timeout: 5000 }, (err) => resolve(!err));
  });
}

function hasTool(name: string): Promise<boolean> {
  const hit = toolCache.get(name);
  if (hit !== undefined) return Promise.resolve(hit);
  // Poppler tools answer to -v; most others to --version.
  return (async () => {
    const ok = (await probeTool(name, "-v")) || (await probeTool(name, "--version"));
    toolCache.set(name, ok);
    return ok;
  })();
}

function runTool(
  cmd: string,
  args: string[],
  stdin?: Uint8Array,
  timeoutMs = 30_000,
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout: stdout as Buffer, stderr: String(stderr) });
      },
    );
    if (stdin) child.stdin?.write(Buffer.from(stdin));
    child.stdin?.end();
  });
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "oa-extract-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cap(text: string): string {
  return text.slice(0, EXCERPT_CHARS);
}

function emptyReport(): ExtractionReport {
  return { methods: [], warnings: [], ocr: false, chars: 0, pages: [] };
}

function finalize(text: string, report: ExtractionReport): ExtractResult {
  const capped = cap(text);
  report.chars = capped.length;
  report.methods = [...new Set(report.pages.map((p) => p.method))];
  if (report.pages.length > 0 && report.pages.every((p) => !p.readable))
    report.warnings.push("No readable text could be extracted from this file.");
  return { text: capped, report };
}

/* ---------------- PDF ---------------- */

async function pdfPageCount(pdfPath: string): Promise<number | null> {
  if (!(await hasTool("pdfinfo"))) return null;
  try {
    const { stdout } = await runTool("pdfinfo", [pdfPath]);
    const m = /Pages:\s+(\d+)/.exec(stdout.toString());
    return m ? Number.parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

/** True when the given page embeds at least one image (scan candidate). */
async function pageHasImages(pdfPath: string, page: number): Promise<boolean> {
  if (!(await hasTool("pdfimages"))) return false;
  try {
    const { stdout } = await runTool("pdfimages", ["-list", pdfPath]);
    const lines = stdout.toString().split("\n").slice(2);
    return lines.some((line) => {
      const first = line.trim().split(/\s+/)[0];
      return first !== "" && Number.parseInt(first, 10) === page;
    });
  } catch {
    return false;
  }
}

async function renderPagePng(pdfPath: string, dir: string, page: number): Promise<Uint8Array> {
  const prefix = join(dir, `page-${page}`);
  await runTool("pdftoppm", [
    "-png",
    "-r",
    "200",
    "-f",
    String(page),
    "-l",
    String(page),
    "-singlefile",
    pdfPath,
    prefix,
  ]);
  return readFile(`${prefix}.png`);
}

async function tesseractOcr(png: Uint8Array): Promise<string> {
  const { stdout } = await runTool(
    "tesseract",
    ["stdin", "stdout", "-l", "eng", "--psm", "6"],
    png,
    60_000,
  );
  return stdout.toString().trim();
}

async function ocrImage(
  png: Uint8Array,
  mime: string,
  visionOcr: VisionOcrFn | undefined,
  report: ExtractionReport,
  pageLabel: string,
): Promise<{ text: string; method: ExtractMethod }> {
  if (visionOcr) {
    try {
      const text = (await visionOcr(png, mime)).trim();
      if (text) {
        report.ocr = true;
        return { text, method: "vision-ocr" };
      }
      report.warnings.push(`${pageLabel}: the vision model found no text in the image.`);
      return { text: "", method: "vision-ocr" };
    } catch {
      report.warnings.push(`${pageLabel}: vision OCR failed, trying local OCR.`);
    }
  }
  if (await hasTool("tesseract")) {
    try {
      const text = await tesseractOcr(png);
      if (text) {
        report.ocr = true;
        return { text, method: "tesseract" };
      }
      return { text: "", method: "tesseract" };
    } catch {
      // Fall through to unreadable.
    }
  }
  report.warnings.push(
    `${pageLabel}: scanned image, no text extracted. ` +
      (visionOcr ? "OCR failed." : "Connect a vision-capable model for OCR."),
  );
  return { text: "", method: "none" };
}

async function extractPdf(bytes: Uint8Array, opts: ExtractOptions): Promise<ExtractResult> {
  const report = emptyReport();
  if (await hasTool("pdftotext")) {
    try {
      return await withTempDir(async (dir) => {
        const pdfPath = join(dir, "doc.pdf");
        await writeFile(pdfPath, bytes, { mode: 0o600 });
        const count = await pdfPageCount(pdfPath);
        if (!count || count < 1 || count > 500) {
          // Page count unknown: whole-document extraction, no per-page detail.
          const { stdout } = await runTool("pdftotext", ["-layout", pdfPath, "-"]);
          const text = stdout.toString();
          report.pages.push({
            page: 0,
            chars: text.trim().length,
            method: "pdftotext",
            readable: text.trim().length > 0,
          });
          return finalize(text, report);
        }
        const parts: string[] = [];
        let ocrPages = 0;
        const canRender = await hasTool("pdftoppm");
        for (let page = 1; page <= count; page++) {
          const { stdout } = await runTool("pdftotext", [
            "-layout",
            "-f",
            String(page),
            "-l",
            String(page),
            pdfPath,
            "-",
          ]);
          const native = stdout.toString();
          if (native.trim().length >= SCAN_THRESHOLD_CHARS) {
            parts.push(native);
            report.pages.push({
              page,
              chars: native.trim().length,
              method: "pdftotext",
              readable: true,
            });
            continue;
          }
          // Near-empty page: scan candidate?
          const scanned = canRender && (await pageHasImages(pdfPath, page));
          if (scanned && ocrPages < MAX_OCR_PAGES) {
            ocrPages++;
            const png = await renderPagePng(pdfPath, dir, page);
            const { text, method } = await ocrImage(
              png,
              "image/png",
              opts.visionOcr,
              report,
              `Page ${page}`,
            );
            parts.push(text);
            report.pages.push({
              page,
              chars: text.trim().length,
              method,
              readable: text.trim().length > 0,
            });
          } else if (native.trim().length > 0) {
            parts.push(native);
            report.pages.push({
              page,
              chars: native.trim().length,
              method: "pdftotext",
              readable: true,
            });
          } else {
            report.pages.push({ page, chars: 0, method: "pdftotext", readable: false });
            if (!scanned)
              report.warnings.push(
                `Page ${page}: no extractable text and no embedded image found.`,
              );
          }
          if (parts.join(" ").length > EXCERPT_CHARS) break;
        }
        return finalize(parts.join("\n"), report);
      });
    } catch {
      // Poppler failed on this file: fall through to pdfjs.
    }
  }
  // Pure-JS fallback: no binaries required.
  try {
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
      parts.push(text);
      report.pages.push({
        page: i,
        chars: text.trim().length,
        method: "pdfjs",
        readable: text.trim().length > 0,
      });
      if (parts.join(" ").length > EXCERPT_CHARS) break;
    }
    const maybeDestroy = doc as unknown as { destroy?: () => Promise<void> };
    await maybeDestroy.destroy?.().catch(() => {});
    return finalize(
      parts
        .join("\n")
        .replace(/[ \t]+/g, " ")
        .trim(),
      report,
    );
  } catch {
    report.warnings.push("This PDF could not be parsed.");
    return finalize("", report);
  }
}

/* ---------------- DOCX / text / images ---------------- */

function extractDocxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  const entry = Object.entries(files).find(([name]) => name === "word/document.xml");
  if (!entry) return "";
  const xml = new TextDecoder().decode(entry[1]);
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<w:tab\b[^>]*\/>/g, " ")
    .replace(/<\/w:tc>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|apos);/g, (m, name: string) => entities[name] ?? m)
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]*\n+/g, "\n")
    .trim();
}

async function extractImage(
  bytes: Uint8Array,
  mime: string,
  opts: ExtractOptions,
): Promise<ExtractResult> {
  const report = emptyReport();
  const { text, method } = await ocrImage(bytes, mime, opts.visionOcr, report, "Image");
  report.pages.push({
    page: 1,
    chars: text.trim().length,
    method,
    readable: text.trim().length > 0,
  });
  return finalize(text, report);
}

/**
 * Best-effort text for intake, with a full extraction report.
 * Never throws for malformed input: worst case is empty text plus warnings.
 */
export async function extractDocument(
  bytes: Uint8Array,
  mime: string,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  if (mime === "application/pdf") return extractPdf(bytes, opts);
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const report = emptyReport();
    try {
      const text = extractDocxText(bytes);
      report.pages.push({
        page: 1,
        chars: text.trim().length,
        method: "docx-xml",
        readable: text.trim().length > 0,
      });
      if (!text.trim()) report.warnings.push("This Word document contains no extractable text.");
      return finalize(text, report);
    } catch {
      report.warnings.push("This Word document could not be parsed.");
      return finalize("", report);
    }
  }
  if (mime === "image/png" || mime === "image/jpeg" || mime === "image/webp")
    return extractImage(bytes, mime, opts);
  if (mime.startsWith("text/")) {
    const report = emptyReport();
    try {
      const text = new TextDecoder("utf-8").decode(bytes);
      report.pages.push({
        page: 1,
        chars: text.trim().length,
        method: "plain-text",
        readable: true,
      });
      return finalize(text, report);
    } catch {
      report.warnings.push("This text file could not be decoded as UTF-8.");
      return finalize("", report);
    }
  }
  if (mime === "application/zip") {
    const report = emptyReport();
    report.pages.push({ page: 0, chars: 0, method: "none", readable: false });
    report.warnings.push("Zip archives are stored but their contents are not inspected yet.");
    return finalize("", report);
  }
  const report = emptyReport();
  report.warnings.push(`Unsupported file type for text extraction: ${mime}.`);
  return finalize("", report);
}
