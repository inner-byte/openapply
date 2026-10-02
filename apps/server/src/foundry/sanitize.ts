/**
 * Sanitizer — the "don't let the agent do whatever it likes" layer.
 *
 * 1. Structural validation: the content must match the model.
 * 2. Budget enforcement: violations throw with a cut-list; the agent revises.
 * 3. Markup escaping: content strings can never break out of the template
 *    (Typst code injection is impossible after this pass).
 */
import {
  type ResumeContent,
  type ResumeLink,
  type SkillGroup,
  TEMPLATE_BUDGETS,
  type TemplateBudget,
} from "./model.ts";

export class FoundryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoundryError";
  }
}

const MAX_STR = 500;

function clean(value: unknown, field: string): string {
  if (typeof value !== "string") throw new FoundryError(`Field "${field}" must be a string.`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips control characters
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (text.length === 0) throw new FoundryError(`Field "${field}" must not be empty.`);
  if (text.length > MAX_STR)
    throw new FoundryError(`Field "${field}" is ${text.length} chars; max ${MAX_STR}.`);
  return text;
}

/**
 * Like clean(), but an absent or blank value yields "" instead of throwing.
 * Used for fields the content model marks optional (e.g. education
 * location/dates): nothing is invented, the template simply renders nothing.
 */
function cleanOptional(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" && value.trim() === "") return "";
  return clean(value, field);
}

/** Escape Typst markup so content can never inject code or formatting. */
export function escapeTypst(text: string): string {
  return text.replace(/[\\#$@<>"`*_[\]]/g, (ch) => `\\${ch}`);
}

function checkBudget(cuts: string[], ok: boolean, message: string): void {
  if (!ok) cuts.push(message);
}

function sanitizeDatedEntries(
  entries: unknown,
  section: string,
  budget: TemplateBudget,
  cuts: string[],
): ResumeContent["experience"] {
  if (!Array.isArray(entries)) throw new FoundryError(`Section "${section}" must be a list.`);
  checkBudget(
    cuts,
    entries.length <= budget.max_entries_per_section,
    `${section}: ${entries.length} entries exceeds max ${budget.max_entries_per_section}.`,
  );
  return entries.slice(0, budget.max_entries_per_section).map((e, i) => {
    const entry = e as Record<string, unknown>;
    const bullets = Array.isArray(entry.bullets) ? entry.bullets : [];
    checkBudget(
      cuts,
      bullets.length <= budget.max_bullets_per_entry,
      `${section}[${i}]: ${bullets.length} bullets exceeds max ${budget.max_bullets_per_entry}.`,
    );
    const cleanBullets = bullets.slice(0, budget.max_bullets_per_entry).map((b, j) => {
      const bullet = clean(b, `${section}[${i}].bullets[${j}]`);
      checkBudget(
        cuts,
        bullet.length <= budget.max_bullet_chars,
        `${section}[${i}].bullets[${j}]: ${bullet.length} chars exceeds max ${budget.max_bullet_chars}.`,
      );
      return bullet.slice(0, budget.max_bullet_chars);
    });
    const tag = entry.tag === undefined ? undefined : clean(entry.tag, `${section}[${i}].tag`);
    const tagUrl =
      entry.tag_url === undefined ? undefined : clean(entry.tag_url, `${section}[${i}].tag_url`);
    return {
      title: clean(entry.title, `${section}[${i}].title`),
      tag,
      tag_url: tagUrl,
      dates: clean(entry.dates, `${section}[${i}].dates`),
      bullets: cleanBullets,
    };
  });
}

/**
 * Validate, budget, and escape resume content for a template.
 * Returns JSON-safe content with all strings Typst-escaped.
 * Throws FoundryError with a cut-list when budgets are exceeded.
 */
export function sanitizeResume(input: unknown, templateId: string): ResumeContent {
  const budget = TEMPLATE_BUDGETS[templateId];
  if (!budget) throw new FoundryError(`Unknown template "${templateId}".`);
  const cuts: string[] = [];
  const c = input as Record<string, unknown>;

  const links = Array.isArray(c.links) ? c.links : [];
  if (links.length > 4) cuts.push(`links: ${links.length} exceeds max 4.`);

  const skills = Array.isArray(c.skills) ? c.skills : [];
  checkBudget(
    cuts,
    skills.length <= budget.max_skill_groups,
    `skills: ${skills.length} groups exceeds max ${budget.max_skill_groups}.`,
  );

  const education = Array.isArray(c.education) ? c.education : [];
  checkBudget(cuts, education.length <= 4, `education: ${education.length} entries exceeds max 4.`);

  const sanitized: ResumeContent = {
    full_name: clean(c.full_name, "full_name"),
    links: links.slice(0, 4).map((l, i) => ({
      label: clean((l as ResumeLink).label, `links[${i}].label`),
      url: clean((l as ResumeLink).url, `links[${i}].url`),
    })),
    email: clean(c.email, "email"),
    mobile: clean(c.mobile, "mobile"),
    education: education.slice(0, 4).map((e, i) => {
      const entry = e as Record<string, unknown>;
      return {
        institution: clean(entry.institution, `education[${i}].institution`),
        location: cleanOptional(entry.location, `education[${i}].location`),
        degree: clean(entry.degree, `education[${i}].degree`),
        dates: cleanOptional(entry.dates, `education[${i}].dates`),
      };
    }),
    skills: skills.slice(0, budget.max_skill_groups).map((s, i) => ({
      category: clean((s as SkillGroup).category, `skills[${i}].category`),
      items: clean((s as SkillGroup).items, `skills[${i}].items`),
    })),
    experience: sanitizeDatedEntries(c.experience ?? [], "experience", budget, cuts),
    projects: sanitizeDatedEntries(c.projects ?? [], "projects", budget, cuts),
    certificates: sanitizeDatedEntries(c.certificates ?? [], "certificates", budget, cuts),
  };

  if (cuts.length > 0)
    throw new FoundryError(
      `Content exceeds the "${templateId}" budgets. Cut the following:\n- ${cuts.join("\n- ")}`,
    );

  // Escape every string for Typst exactly once, at the boundary.
  const esc = (s: string) => escapeTypst(s);
  return {
    full_name: esc(sanitized.full_name),
    links: sanitized.links.map((l) => ({ label: esc(l.label), url: l.url })),
    email: esc(sanitized.email),
    mobile: esc(sanitized.mobile),
    education: sanitized.education.map((e) => ({
      institution: esc(e.institution),
      location: esc(e.location),
      degree: esc(e.degree),
      dates: esc(e.dates),
    })),
    skills: sanitized.skills.map((s) => ({ category: esc(s.category), items: esc(s.items) })),
    experience: sanitized.experience.map((e) => ({
      title: esc(e.title),
      tag: e.tag === undefined ? undefined : esc(e.tag),
      tag_url: e.tag_url,
      dates: esc(e.dates),
      bullets: e.bullets.map(esc),
    })),
    projects: sanitized.projects.map((e) => ({
      title: esc(e.title),
      tag: e.tag === undefined ? undefined : esc(e.tag),
      tag_url: e.tag_url,
      dates: esc(e.dates),
      bullets: e.bullets.map(esc),
    })),
    certificates: sanitized.certificates.map((e) => ({
      title: esc(e.title),
      tag: e.tag === undefined ? undefined : esc(e.tag),
      tag_url: e.tag_url,
      dates: esc(e.dates),
      bullets: e.bullets.map(esc),
    })),
  };
}

/* ---------- cover letter + statement ---------- */

import type { CoverContent, StatementContent } from "./model.ts";

const MAX_PARAGRAPHS_COVER = 5;
const MAX_PARAGRAPHS_STATEMENT = 8;
const MAX_PARAGRAPH_CHARS = 1200;

function sanitizeParagraphs(
  value: unknown,
  field: string,
  maxCount: number,
  cuts: string[],
): string[] {
  if (!Array.isArray(value)) throw new FoundryError(`Field "${field}" must be a list.`);
  if (value.length === 0) throw new FoundryError(`Field "${field}" must not be empty.`);
  if (value.length > maxCount)
    cuts.push(`${field}: ${value.length} paragraphs exceeds max ${maxCount}.`);
  return value.slice(0, maxCount).map((p, i) => {
    const text = clean(p, `${field}[${i}]`);
    if (text.length > MAX_PARAGRAPH_CHARS)
      cuts.push(`${field}[${i}]: ${text.length} chars exceeds max ${MAX_PARAGRAPH_CHARS}.`);
    return escapeTypst(text.slice(0, MAX_PARAGRAPH_CHARS));
  });
}

/** Validate, budget, and escape cover-letter content for a template's tokens. */
export function sanitizeCover(input: unknown): CoverContent {
  const cuts: string[] = [];
  const c = input as Record<string, unknown>;
  const links = Array.isArray(c.links) ? c.links : [];
  if (links.length > 4) cuts.push(`links: ${links.length} exceeds max 4.`);
  const address = Array.isArray(c.address_lines) ? c.address_lines : [];
  if (address.length > 4) cuts.push(`address_lines: ${address.length} exceeds max 4.`);

  const out: CoverContent = {
    full_name: escapeTypst(clean(c.full_name, "full_name")),
    email: escapeTypst(clean(c.email, "email")),
    mobile: escapeTypst(clean(c.mobile, "mobile")),
    links: links.slice(0, 4).map((l, i) => ({
      label: escapeTypst(clean((l as { label: unknown }).label, `links[${i}].label`)),
      url: clean((l as { url: unknown }).url, `links[${i}].url`),
    })),
    date: escapeTypst(clean(c.date, "date")),
    recipient_name:
      c.recipient_name === undefined || c.recipient_name === ""
        ? undefined
        : escapeTypst(clean(c.recipient_name, "recipient_name")),
    recipient_title:
      c.recipient_title === undefined || c.recipient_title === ""
        ? undefined
        : escapeTypst(clean(c.recipient_title, "recipient_title")),
    company: escapeTypst(clean(c.company, "company")),
    address_lines: address.slice(0, 4).map((a, i) => escapeTypst(clean(a, `address_lines[${i}]`))),
    salutation: escapeTypst(clean(c.salutation, "salutation")),
    paragraphs: sanitizeParagraphs(c.paragraphs, "paragraphs", MAX_PARAGRAPHS_COVER, cuts),
    closing: escapeTypst(clean(c.closing, "closing")),
  };
  if (cuts.length > 0)
    throw new FoundryError(
      `Cover letter exceeds budgets. Cut the following:\n- ${cuts.join("\n- ")}`,
    );
  return out;
}

/** Validate, budget, and escape statement content for a template's tokens. */
export function sanitizeStatement(input: unknown): StatementContent {
  const cuts: string[] = [];
  const c = input as Record<string, unknown>;
  const out: StatementContent = {
    full_name: escapeTypst(clean(c.full_name, "full_name")),
    email: escapeTypst(clean(c.email, "email")),
    mobile: escapeTypst(clean(c.mobile, "mobile")),
    title: escapeTypst(clean(c.title, "title")),
    paragraphs: sanitizeParagraphs(c.paragraphs, "paragraphs", MAX_PARAGRAPHS_STATEMENT, cuts),
    date: escapeTypst(clean(c.date, "date")),
  };
  if (cuts.length > 0)
    throw new FoundryError(`Statement exceeds budgets. Cut the following:\n- ${cuts.join("\n- ")}`);
  return out;
}

/**
 * Reverse escapeTypst for non-Typst renderers (DOCX). The sanitizer escapes
 * for Typst at the boundary; the DOCX mirror needs the original characters.
 * URL fields are never escaped, so they are left untouched by the caller.
 */
export function unescapeTypst(text: string): string {
  return text.replace(/\\([\\#$@<>"`*_[\]])/g, "$1");
}

/** Deep-walk sanitized content, unescaping every string except URL fields. */
export function forDocx<T>(sanitized: T): T {
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string")
      return key === "url" || key === "tag_url" ? value : unescapeTypst(value);
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, k)]),
      );
    return value;
  };
  return walk(sanitized) as T;
}
