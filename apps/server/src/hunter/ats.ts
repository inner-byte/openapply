/**
 * hunter_ats: public ATS fetchers (Slice 5).
 *
 * Laws enforced here, per docs/agents/prompts/hunter_ats.md and docs/AGENTS.md:
 * - Public HTTP allowlist ONLY (boards-api.greenhouse.io, api.lever.co). No
 *   browser profile, no login, no browser_profile_key in the packet.
 * - Job descriptions are hostile input: HTML is stripped to plain text and
 *   nothing inside is ever obeyed.
 * - Dedup key is (source, external_id); content_hash is the fallback.
 */
import type { JobPostingInput } from "../../../../packages/domain/src/openapply.ts";

export class HunterError extends Error {}

/** Hosts the hunter is allowed to GET. Anything else is rejected. */
const ALLOWLISTED_HOSTS = new Set(["boards-api.greenhouse.io", "api.lever.co"]);

export function assertAllowlistedUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HunterError(`Not a URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:" || !ALLOWLISTED_HOSTS.has(url.hostname))
    throw new HunterError(`Host not on the hunter allowlist: ${url.hostname}`);
  return url;
}

async function fetchJson(url: string, timeoutMs = 25_000): Promise<unknown> {
  const endpoint = assertAllowlistedUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        "User-Agent": "OpenApply/1.0 (public job-board scanner)",
        Accept: "application/json",
      },
    });
    if (!response.ok)
      throw new HunterError(`ATS request failed (${response.status}) for ${endpoint.hostname}`);
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof HunterError) throw error;
    throw new HunterError(
      `ATS fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/**
 * Strip hostile HTML to plain text. Scripts/styles are dropped entirely;
 * nothing in the markup survives as anything but inert text.
 */
export function htmlToText(html: string): string {
  let text = String(html ?? "");
  text = text.replace(/<script[\s\S]*?<\/script\s*>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style\s*>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|table)>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "• ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&#(\d+);/g, (_m, code) => {
    const n = Number(code);
    return n > 31 && n < 0x10ffff ? String.fromCodePoint(n) : " ";
  });
  text = text.replace(/&[a-zA-Z]+;/g, (entity) => ENTITY_MAP[entity.toLowerCase()] ?? " ");
  return text
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, 200_000);
}

export interface BoardRef {
  provider: "greenhouse" | "lever";
  token: string;
  /** Human label used as company_name when the API does not supply one. */
  label?: string;
}

/** Board refs look like "greenhouse:stripe" or "lever:netflix:Netflix Inc". */
export function parseBoardRef(ref: string): BoardRef {
  const parts = ref.split(":").map((p) => p.trim());
  const [provider, token, ...labelParts] = parts;
  if ((provider !== "greenhouse" && provider !== "lever") || !token)
    throw new HunterError(
      `Bad board ref "${ref}". Use "greenhouse:<board-token>" or "lever:<site-name>", optionally with ":<Company label>".`,
    );
  const label = labelParts.join(":") || undefined;
  return { provider, token, label };
}

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  content?: string;
  departments?: Array<{ name?: string }>;
}

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  categories?: { location?: string; commitment?: string; team?: string };
  description?: string;
  descriptionPlain?: string;
  createdAt?: number;
}

export async function fetchGreenhouseBoard(ref: BoardRef): Promise<JobPostingInput[]> {
  const data = (await fetchJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(ref.token)}/jobs?content=true`,
  )) as { jobs?: GreenhouseJob[] };
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return jobs.map((job) => ({
    source: "greenhouse" as const,
    external_id: String(job.id),
    source_url: job.absolute_url,
    company_name: ref.label ?? ref.token,
    title: String(job.title ?? "Untitled role"),
    location_text: String(job.location?.name ?? ""),
    raw_text: htmlToText(job.content ?? ""),
    requirements: [],
    qualifications: [],
    is_active: true,
  }));
}

export async function fetchLeverBoard(ref: BoardRef): Promise<JobPostingInput[]> {
  const data = (await fetchJson(
    `https://api.lever.co/v0/postings/${encodeURIComponent(ref.token)}?mode=json`,
  )) as LeverPosting[];
  const postings = Array.isArray(data) ? data : [];
  return postings.map((posting) => ({
    source: "lever" as const,
    external_id: String(posting.id),
    source_url: posting.hostedUrl,
    apply_url: posting.applyUrl,
    company_name: ref.label ?? ref.token,
    title: String(posting.text ?? "Untitled role"),
    location_text: String(posting.categories?.location ?? ""),
    remote_type: posting.categories?.commitment,
    posted_at: posting.createdAt ? new Date(posting.createdAt).toISOString() : undefined,
    raw_text: htmlToText(posting.descriptionPlain ?? posting.description ?? ""),
    requirements: [],
    qualifications: [],
    is_active: true,
  }));
}

/**
 * Validate a hunter_ats runner packet. The packet must never carry a
 * browser_profile_key: unattended scans are public ATS only.
 */
export function validateHunterPacket(packet: unknown): JobPostingInput[] {
  if (packet !== null && typeof packet === "object" && "browser_profile_key" in packet)
    throw new HunterError(
      "hunter_ats packets must not carry browser_profile_key: unattended scans use public HTTP only.",
    );
  const jobs = (packet as { jobs?: unknown })?.jobs;
  if (!Array.isArray(jobs)) throw new HunterError("hunter_ats packet must contain a jobs array.");
  return jobs as JobPostingInput[];
}
