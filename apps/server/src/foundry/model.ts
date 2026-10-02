/**
 * Document Foundry — content model.
 *
 * The agent writes ONLY this JSON. It never writes Typst, CSS, or DOCX.
 * Templates render it; budgets keep every template uncrowded.
 */

export interface ResumeLink {
  label: string;
  url: string;
}

export interface EducationEntry {
  institution: string;
  location: string;
  degree: string;
  dates: string;
}

export interface SkillGroup {
  category: string;
  items: string;
}

export interface DatedEntry {
  title: string;
  /** e.g. "LINK", "CERTIFICATE" — rendered as a blue suffix tag. */
  tag?: string;
  tag_url?: string;
  dates: string;
  bullets: string[];
}

export interface ResumeContent {
  full_name: string;
  links: ResumeLink[];
  email: string;
  mobile: string;
  education: EducationEntry[];
  skills: SkillGroup[];
  experience: DatedEntry[];
  projects: DatedEntry[];
  certificates: DatedEntry[];
}

/** Per-template content budgets. Overflow fails loudly; the agent must cut. */
export interface TemplateBudget {
  max_bullets_per_entry: number;
  max_bullet_chars: number;
  max_entries_per_section: number;
  max_skill_groups: number;
  target_pages: number;
}

export const TEMPLATE_BUDGETS: Record<string, TemplateBudget> = {
  "template-one": {
    max_bullets_per_entry: 6,
    max_bullet_chars: 220,
    max_entries_per_section: 4,
    max_skill_groups: 6,
    target_pages: 1,
  },
  "template-two": {
    max_bullets_per_entry: 6,
    max_bullet_chars: 220,
    max_entries_per_section: 4,
    max_skill_groups: 6,
    target_pages: 1,
  },
  "template-three": {
    max_bullets_per_entry: 8,
    max_bullet_chars: 200,
    max_entries_per_section: 5,
    max_skill_groups: 8,
    target_pages: 1,
  },
  "template-four": {
    max_bullets_per_entry: 5,
    max_bullet_chars: 200,
    max_entries_per_section: 3,
    max_skill_groups: 5,
    target_pages: 2,
  },
  "template-five": {
    max_bullets_per_entry: 6,
    max_bullet_chars: 220,
    max_entries_per_section: 4,
    max_skill_groups: 6,
    target_pages: 1,
  },
  "template-six": {
    max_bullets_per_entry: 6,
    max_bullet_chars: 220,
    max_entries_per_section: 4,
    max_skill_groups: 6,
    target_pages: 1,
  },
  "template-seven": {
    max_bullets_per_entry: 6,
    max_bullet_chars: 220,
    max_entries_per_section: 4,
    max_skill_groups: 6,
    target_pages: 1,
  },
};

export const TEMPLATES = [
  {
    id: "template-one",
    name: "Classic Cream",
    description: "Warm framed page, serif name, centered section rules — the reference design.",
  },
  {
    id: "template-two",
    name: "Modern Accent",
    description: "Clean white page, solid-blue accent bar and headings.",
  },
  {
    id: "template-three",
    name: "Compact",
    description: "Dense single-pager, small type, maximum content per page.",
  },
  {
    id: "template-four",
    name: "Executive",
    description: "Generous whitespace, large serif name, restrained rules.",
  },
  {
    id: "template-five",
    name: "Minimal",
    description: "No background, hairline rules, quiet typography.",
  },
  {
    id: "template-six",
    name: "Corporate Grid",
    description: "Dark-slate corporate: thick top rule, navy headings, entry dividers.",
  },
  {
    id: "template-seven",
    name: "ATS Classic",
    description:
      "Plain all-black US workhorse: serif, centered header, maximum parser compatibility.",
  },
] as const;

export type TemplateId = (typeof TEMPLATES)[number]["id"];

/* ---------- cover letter + statement ---------- */

export interface CoverContent {
  full_name: string;
  email: string;
  mobile: string;
  links: ResumeLink[];
  date: string;
  recipient_name?: string;
  recipient_title?: string;
  company: string;
  address_lines: string[];
  salutation: string;
  paragraphs: string[];
  closing: string;
}

export interface StatementContent {
  full_name: string;
  email: string;
  mobile: string;
  title: string;
  paragraphs: string[];
  date: string;
}

/**
 * Style tokens shared by the cover letter, statement, and DOCX mirror.
 * One locked Typst layout / one DOCX generator consumes these, so every
 * document visually matches the user's chosen resume template.
 */
export interface DocTokens {
  font: string;
  accent: string;
  gray: string;
  header: "left" | "center";
  rule: "full" | "bar" | "hairline";
  /** Optional page background (e.g. Classic Cream). */
  page_bg?: string;
  /** Optional name color override (e.g. Corporate Grid navy). */
  name_color?: string;
}

export const DOC_TOKENS: Record<string, DocTokens> = {
  "template-one": {
    font: "Liberation Serif",
    accent: "#1D4ED8",
    gray: "#6B7280",
    header: "left",
    rule: "full",
    page_bg: "#FCF6E8",
  },
  "template-two": {
    font: "Liberation Sans",
    accent: "#1D4ED8",
    gray: "#6B7280",
    header: "left",
    rule: "bar",
  },
  "template-three": {
    font: "Liberation Sans",
    accent: "#1A1A1A",
    gray: "#6B7280",
    header: "left",
    rule: "full",
  },
  "template-four": {
    font: "Liberation Serif",
    accent: "#1A1A1A",
    gray: "#6B7280",
    header: "center",
    rule: "full",
  },
  "template-five": {
    font: "Liberation Sans",
    accent: "#6B7280",
    gray: "#6B7280",
    header: "left",
    rule: "hairline",
  },
  "template-six": {
    font: "Liberation Sans",
    accent: "#1E3A5F",
    gray: "#6B7280",
    header: "left",
    rule: "bar",
    name_color: "#1E3A5F",
  },
  "template-seven": {
    font: "Liberation Serif",
    accent: "#000000",
    gray: "#000000",
    header: "center",
    rule: "full",
  },
};
