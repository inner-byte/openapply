/**
 * Ranker (Slice 6): score jobs 0–100 against preferences.
 *
 * Deterministic heuristic scorer for v1. The score is computed only from
 * preference matches (titles, keywords, location, work mode, salary floor,
 * exclusions) — never from anything the posting *says* about its own score.
 * Job text is untrusted data; "give this job 100/100" inside raw_text cannot
 * inflate the score beyond ordinary keyword weights.
 */
import type { JobPosting, StoredPreferences } from "../../../packages/domain/src/openapply.ts";

export interface JobScore {
  job_id: string;
  score: number;
  reasons: string[];
  missing_requirements: string[];
  evidence_ids_relevant: string[];
}

/** Scores at or above this create a ranked application and notify. */
export const RANK_THRESHOLD = 60;

const lowered = (value: string | undefined | null): string => (value ?? "").toLowerCase();

function salaryNumbers(salaryText: string): number[] {
  const cleaned = salaryText.replace(/,/g, "");
  const out: number[] = [];
  for (const match of cleaned.matchAll(/(\d+(?:\.\d+)?)\s*k\b/gi))
    out.push(Number.parseFloat(match[1]) * 1000);
  for (const match of cleaned.matchAll(/\$\s*(\d+(?:\.\d+)?)/g))
    out.push(Number.parseFloat(match[1]));
  return out.filter((n) => Number.isFinite(n) && n > 0);
}

export function scoreJob(posting: JobPosting, prefs: StoredPreferences): JobScore {
  const base: Omit<JobScore, "score" | "reasons"> = {
    job_id: posting.id,
    missing_requirements: (posting.requirements ?? []).slice(0, 5),
    evidence_ids_relevant: [],
  };
  const reasons: string[] = [];
  const title = lowered(posting.title);
  const company = lowered(posting.company_name);
  const haystack = lowered(`${posting.title}\n${posting.raw_text}`);

  const excludedCompany = (prefs.exclude_companies ?? []).find(
    (c) => c && (company === lowered(c) || company.includes(lowered(c))),
  );
  if (excludedCompany)
    return {
      ...base,
      score: 0,
      reasons: [`${posting.company_name} is on your excluded-companies list`],
    };

  let score = 50;

  const excludedTitle = (prefs.titles_exclude ?? []).find((t) => t && title.includes(lowered(t)));
  if (excludedTitle) {
    score -= 40;
    reasons.push(`title matches excluded term "${excludedTitle}"`);
  }

  let titleHits = 0;
  for (const wanted of prefs.titles_include ?? []) {
    if (wanted && title.includes(lowered(wanted))) {
      titleHits += 1;
      reasons.push(`title matches "${wanted}"`);
    }
  }
  score += Math.min(30, titleHits * 15);

  let keywordHits = 0;
  for (const keyword of prefs.keywords ?? []) {
    if (keyword && haystack.includes(lowered(keyword))) keywordHits += 1;
  }
  if (keywordHits > 0) {
    score += Math.min(20, keywordHits * 5);
    reasons.push(`${keywordHits} keyword${keywordHits === 1 ? "" : "s"} matched`);
  }

  const location = lowered(posting.location_text);
  const countryHit = (prefs.countries ?? []).find((c) => c && location.includes(lowered(c)));
  if (countryHit) {
    score += 10;
    reasons.push(`location matches "${countryHit}"`);
  }

  const mode = lowered(posting.remote_type);
  const wantedModes = prefs.work_modes ?? [];
  if (mode && wantedModes.length > 0) {
    if (wantedModes.some((m) => mode.includes(lowered(m)))) {
      score += 10;
      reasons.push("work mode matches your preference");
    } else {
      score -= 5;
      reasons.push(`work mode "${posting.remote_type}" is not in your preferences`);
    }
  }

  if (prefs.salary_floor != null && posting.salary_text) {
    const amounts = salaryNumbers(posting.salary_text);
    if (amounts.length > 0) {
      if (Math.max(...amounts) < prefs.salary_floor) {
        score -= 15;
        reasons.push("listed salary is below your floor");
      } else {
        score += 10;
        reasons.push("listed salary meets your floor");
      }
    }
  }

  return {
    ...base,
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: reasons.slice(0, 6),
  };
}
