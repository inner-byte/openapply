/**
 * Slice 4 hardening: production-grade extraction pipeline.
 * Invariants:
 * - Deterministic local tools run before any model call.
 * - Scanned PDF pages and images fall back to vision OCR, then tesseract.
 * - Unreadable pages are reported, never silently empty.
 * - Malformed input never throws out of extractDocument.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync } from "fflate";
import {
  type ExtractMethod,
  extractDocument,
  extractionTools,
} from "../apps/server/src/extract.ts";

/* ---------- minimal PDF builder (correct xref offsets) ---------- */

function buildPdf(bodies: Buffer[]): Buffer {
  const header = Buffer.from("%PDF-1.4\n");
  const parts: Buffer[] = [header];
  const offsets: number[] = [0];
  let pos = header.length;
  bodies.forEach((body, i) => {
    offsets[i + 1] = pos;
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    parts.push(obj);
    pos += obj.length;
  });
  const xrefPos = pos;
  let xref = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= bodies.length; i++)
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  const trailer =
    `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\n` + `startxref\n${xrefPos}\n%%EOF`;
  return Buffer.concat([...parts, Buffer.from(xref + trailer)]);
}

function streamObj(content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
    content,
    Buffer.from("\nendstream"),
  ]);
}

function textPdf(line: string): Buffer {
  const content = Buffer.from(`BT /F1 12 Tf 10 180 Td (${line}) Tj ET`, "latin1");
  return buildPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] " +
        "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    ),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    streamObj(content),
  ]);
}

/** A PDF page that draws a 2x2 RGB image and contains no text. */
function scannedPdf(): Buffer {
  const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  const draw = Buffer.from("q\n100 0 0 100 0 0 cm\n/Im1 Do\nQ", "latin1");
  return buildPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] " +
        "/Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
    ),
    Buffer.concat([
      Buffer.from(
        "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 " +
          "/ColorSpace /DeviceRGB /BitsPerComponent 8 " +
          `/Length ${pixels.length} >>\nstream\n`,
      ),
      pixels,
      Buffer.from("\nendstream"),
    ]),
    streamObj(draw),
  ]);
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function docxBytes(paragraph: string): Uint8Array {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body><w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p></w:body></w:document>`;
  return zipSync({
    "[Content_Types].xml": new TextEncoder().encode("<Types/>"),
    "word/document.xml": new TextEncoder().encode(xml),
  });
}

/* ---------- tests ---------- */

test("extractionTools reports local binary availability", async () => {
  const tools = await extractionTools();
  for (const name of ["pdftotext", "pdfinfo", "pdfimages", "pdftoppm", "tesseract"])
    assert.equal(typeof tools[name], "boolean", name);
});

test("text PDF extracts native text without any model call", async () => {
  let ocrCalls = 0;
  const result = await extractDocument(textPdf("Contact ahmad@example.com"), "application/pdf", {
    visionOcr: async () => {
      ocrCalls++;
      return "SHOULD NOT BE CALLED";
    },
  });
  assert.match(result.text, /ahmad@example\.com/);
  assert.equal(ocrCalls, 0, "native text must not trigger OCR");
  assert.ok(!result.report.ocr);
  assert.ok(result.report.warnings.length === 0, JSON.stringify(result.report.warnings));
  const methods = new Set(result.report.methods);
  assert.ok(methods.has("pdftotext") || methods.has("pdfjs"), [...methods].join(","));
});

test("scanned PDF page falls back to vision OCR", async () => {
  const result = await extractDocument(scannedPdf(), "application/pdf", {
    visionOcr: async () => "CERTIFICATE OF COMPLETION",
  });
  assert.match(result.text, /CERTIFICATE OF COMPLETION/);
  assert.equal(result.report.ocr, true);
  const page = result.report.pages.find((p) => p.page === 1);
  assert.ok(page, "expected a page-1 report");
  assert.equal(page.method as ExtractMethod, "vision-ocr");
  assert.equal(page.readable, true);
});

test("scanned PDF without OCR is reported unreadable, never silently empty", async () => {
  const result = await extractDocument(scannedPdf(), "application/pdf");
  assert.equal(result.text, "");
  const page = result.report.pages.find((p) => p.page === 1);
  assert.ok(page, "expected a page-1 report");
  assert.equal(page.readable, false);
  assert.ok(result.report.warnings.length > 0, "expected an unreadable-page warning");
  assert.ok(
    result.report.warnings.some((w) => /OCR|vision/i.test(w)),
    JSON.stringify(result.report.warnings),
  );
});

test("vision OCR failure degrades to a warning instead of throwing", async () => {
  const result = await extractDocument(scannedPdf(), "application/pdf", {
    visionOcr: async () => {
      throw new Error("model exploded");
    },
  });
  assert.equal(result.text, "");
  assert.ok(result.report.warnings.length > 0);
});

test("image evidence is OCRed through the vision function", async () => {
  const result = await extractDocument(PNG_1X1, "image/png", {
    visionOcr: async () => "Signature: Ahmad",
  });
  assert.match(result.text, /Signature: Ahmad/);
  assert.equal(result.report.ocr, true);
});

test("docx extracts paragraph text", async () => {
  const result = await extractDocument(
    docxBytes("Hello ahmad@example.com"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.match(result.text, /ahmad@example\.com/);
  assert.ok(result.report.methods.includes("docx-xml"));
});

test("malformed PDF never throws; it reports a warning", async () => {
  const result = await extractDocument(
    new TextEncoder().encode("%PDF-1.4 this is not a real pdf"),
    "application/pdf",
  );
  assert.equal(result.text, "");
  assert.ok(result.report.warnings.length > 0);
});

test("zip is stored, not inspected", async () => {
  const result = await extractDocument(new Uint8Array([1, 2, 3]), "application/zip");
  assert.equal(result.text, "");
  assert.ok(result.report.warnings.some((w) => /zip/i.test(w)));
});
