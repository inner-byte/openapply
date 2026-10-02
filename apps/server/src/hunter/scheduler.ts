/**
 * Scheduled ATS scans (Slice 5).
 *
 * Ticks every 15 minutes; each owner scans at most once per
 * `scan_interval_hours` (preferences, 6–24h). State lives in the
 * `hunter_state` record so restarts and late returns behave.
 */
import type { JobPosting, StoredPreferences } from "../../../../packages/domain/src/openapply.ts";
import { domainKinds } from "../../../../packages/domain/src/openapply.ts";
import type { Store } from "../db.ts";
import type { DomainService } from "../domain.ts";
import { backgroundFailure } from "../log.ts";
import {
  fetchGreenhouseBoard,
  fetchLeverBoard,
  parseBoardRef,
  validateHunterPacket,
} from "./ats.ts";

export interface HunterScanResult {
  owner: string;
  boards: number;
  fetched: number;
  created: number;
  errors: string[];
  scanned_at: string;
}

interface HunterState {
  id: string;
  last_scan_at?: string;
  last_result?: Omit<HunterScanResult, "owner">;
}

const TICK_MS = 15 * 60 * 1000;

export class HunterScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly db: Store,
    private readonly domain: DomainService,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runDueScans().catch((error) => backgroundFailure("hunter tick", error));
    }, TICK_MS);
    // Boot: run whatever is already due (e.g. first run, or a missed interval).
    void this.runDueScans().catch((error) => backgroundFailure("hunter boot scan", error));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Scan every owner whose interval has elapsed. */
  async runDueScans(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.db.scan<StoredPreferences>(domainKinds.preferences);
      for (const { owner, value } of rows) {
        const prefs = { ...(await this.domain.getPreferences(owner)), ...value };
        const intervalMs = (prefs.scan_interval_hours || 12) * 3600_000;
        const state = await this.db.get<HunterState>(owner, "hunter_state", "default");
        const last = state?.last_scan_at ? Date.parse(state.last_scan_at) : 0;
        if (Date.now() - last >= intervalMs) {
          await this.scanOwner(owner).catch((error) =>
            backgroundFailure(`hunter scan for ${owner}`, error),
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Run one owner's boards now, regardless of the due check. */
  async scanOwner(owner: string): Promise<HunterScanResult> {
    const prefs = await this.domain.getPreferences(owner);
    const result: HunterScanResult = {
      owner,
      boards: 0,
      fetched: 0,
      created: 0,
      errors: [],
      scanned_at: new Date().toISOString(),
    };
    for (const refString of prefs.ats_boards ?? []) {
      result.boards += 1;
      try {
        const ref = parseBoardRef(refString);
        const jobs =
          ref.provider === "greenhouse"
            ? await fetchGreenhouseBoard(ref)
            : await fetchLeverBoard(ref);
        // Re-validate the packet boundary: no browser_profile_key, ever.
        const fresh: JobPosting[] = [];
        for (const job of validateHunterPacket({ jobs })) {
          const { posting, created } = await this.domain.insertJobPosting(owner, job);
          result.fetched += 1;
          if (created) {
            result.created += 1;
            fresh.push(posting);
          }
        }
        // Scheduler → Hunter → upsert → Ranker → Event → Notifier.
        await this.domain.rankDiscoveredJobs(owner, fresh);
      } catch (error) {
        result.errors.push(
          `${refString}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const { owner: _owner, ...rest } = result;
    await this.db.put<HunterState>(owner, "hunter_state", {
      id: "default",
      last_scan_at: result.scanned_at,
      last_result: rest,
    });
    await this.domain.recordEvent(owner, "hunter.scan_completed", {
      boards: result.boards,
      fetched: result.fetched,
      created: result.created,
      errors: result.errors.length,
    });
    return result;
  }

  async getState(owner: string): Promise<HunterState | null> {
    return this.db.get<HunterState>(owner, "hunter_state", "default");
  }
}
