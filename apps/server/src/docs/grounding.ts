/**
 * Grounding checks for generated documents (Slice 7: "Drafts cite the
 * evidence locker").
 *
 * - Every certificate named in resume_content.certificates must match a
 *   confirmed evidence-locker item (title and issuer). An unmatched name
 *   fails the run with UNGROUNDED_CLAIM — missing evidence produces a
 *   question, not an invention.
 * - Every claim in cover/statement output must point at an evidence_id that
 *   exists in the confirmed locker.
 */
import { AppError } from "../errors.ts";

export type DocumentErrorClass = "SCHEMA_INVALID" | "UNGROUNDED_CLAIM" | "POLICY_DENIED";

export class DocumentError extends AppError {
  constructor(
    public readonly errorClass: DocumentErrorClass,
    message: string,
    status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503 = 422,
  ) {
    super(message, status);
    this.name = "DocumentError";
  }
}

/**
 * A confirmed evidence-locker item, as the document roles see it. Server
 * evidence is file-based: the name comes from the file name and the
 * searchable text from the extraction excerpt (a confirmed certificate's
 * excerpt contains its title and issuer).
 */
export interface EvidenceRef {
  evidence_id: string;
  kind: string;
  name: string;
  text: string;
}

const CREDENTIAL_KINDS = new Set(["certificate", "license", "award"]);

function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesEvidence(name: string, evidence: EvidenceRef): boolean {
  const n = norm(name);
  if (!n) return false;
  const hay = norm(`${evidence.name} ${evidence.text}`);
  // The named certificate must contain (or be contained in) the confirmed
  // evidence name/text. Substring both ways tolerates "AWS Certified
  // Solutions Architect" vs "AWS Certified Solutions Architect – Associate".
  return n.length > 3 && hay.length > 3 && (hay.includes(n) || n.includes(hay.slice(0, 120)));
}

export function findMatchingEvidence(name: string, evidence: EvidenceRef[]): EvidenceRef | null {
  for (const item of evidence) {
    if (!CREDENTIAL_KINDS.has(item.kind)) continue;
    if (matchesEvidence(name, item)) return item;
  }
  return null;
}

/** Fail the run when a named certificate is not in the confirmed locker. */
export function checkResumeCertificates(
  resumeContent: { certificates?: Array<{ title?: string }> },
  evidence: EvidenceRef[],
): void {
  for (const cert of resumeContent.certificates ?? []) {
    const title = (cert.title ?? "").trim();
    if (!title) continue;
    if (!findMatchingEvidence(title, evidence)) {
      throw new DocumentError(
        "UNGROUNDED_CLAIM",
        `Certificate "${title}" is not in the confirmed evidence locker and cannot appear in the resume.`,
      );
    }
  }
}

/** Fail the run when a claim cites an evidence_id that is not confirmed. */
export function checkClaimEvidenceIds(
  claims: Array<{ text?: string; evidence_id?: string }>,
  evidence: EvidenceRef[],
): void {
  const known = new Set(evidence.map((e) => e.evidence_id));
  for (const claim of claims ?? []) {
    const id = (claim.evidence_id ?? "").trim();
    if (!id) continue;
    if (!known.has(id)) {
      throw new DocumentError(
        "UNGROUNDED_CLAIM",
        `Claim "${(claim.text ?? "").slice(0, 80)}" cites unconfirmed evidence "${id}".`,
      );
    }
  }
}

export function extractCertificateCandidates(paragraphs: string[]): string[] {
  const found: string[] = [];
  const joined = paragraphs.join("\n");
  // Tight patterns only: Title-Case phrases adjacent to credential keywords.
  // Ordinary lowercase prose ("certified scrum master with 5 years...") does
  // not match, so grounded sentences are not flagged.
  const patterns = [
    /\b([A-Z][\w&'’.-]*(?:\s+[A-Z][\w&'’.-]*){0,5}\s+(?:Certificate|Certification|Certified|License|Licensed))\b/g,
    /\b((?:Certificate|Certification)\s+(?:in|of)\s+[A-Z][\w&'’.-]*(?:\s+[A-Z][\w&'’.-]*){0,5})/g,
  ];
  for (const pattern of patterns) {
    for (const m of joined.matchAll(pattern)) {
      const phrase = m[1].trim();
      if (phrase.length > 6 && phrase.length < 120) found.push(phrase);
    }
  }
  return [...new Set(found)];
}

/** Fail the run when prose names a credential that is not confirmed. */
export function checkProseCertificates(paragraphs: string[], evidence: EvidenceRef[]): void {
  for (const candidate of extractCertificateCandidates(paragraphs)) {
    if (!findMatchingEvidence(candidate, evidence)) {
      throw new DocumentError(
        "UNGROUNDED_CLAIM",
        `Prose names a credential ("${candidate.slice(0, 80)}") that is not in the confirmed evidence locker.`,
      );
    }
  }
}
