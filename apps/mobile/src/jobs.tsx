import { Briefcase, ExternalLink, MapPin, RefreshCw } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import type { JobPosting } from "../../../packages/domain/src/openapply";
import { Button, Card, Chip, colors, ErrorNotice, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

interface HunterState {
  id: string;
  last_scan_at?: string;
  last_result?: { boards: number; fetched: number; created: number; scanned_at: string };
}

type ScoredJob = JobPosting & { score: number | null };

function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) return null;
  const tint = score >= 80 ? colors.green : score >= 60 ? colors.sky : colors.canvas;
  return <Chip tint={tint}>{score}/100</Chip>;
}

interface ScanResult {
  boards: number;
  fetched: number;
  created: number;
  errors: string[];
}

function postedLabel(posting: JobPosting): string {
  if (posting.posted_at) {
    const date = new Date(posting.posted_at);
    if (!Number.isNaN(date.getTime())) return date.toLocaleDateString();
  }
  return "Recently listed";
}

export function JobsScreen() {
  const { api, open } = useWorkspace();
  const [jobs, setJobs] = useState<ScoredJob[] | null>(null);
  const [state, setState] = useState<HunterState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const [list, hunterState] = await Promise.all([
        api.request<ScoredJob[]>("/api/jobs"),
        api.request<HunterState>("/api/hunter/state"),
      ]);
      setJobs(list);
      setState(hunterState);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function scanNow() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.request<ScanResult>("/api/hunter/scan");
      setNotice(
        result.boards === 0
          ? "No job boards configured. Add boards in Settings to start scanning."
          : `Scanned ${result.boards} board${result.boards === 1 ? "" : "s"}: ${result.fetched} listings, ${result.created} new.`,
      );
      if (result.errors.length) setError(result.errors.join("\n"));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const lastScan = state?.last_scan_at ? new Date(state.last_scan_at).toLocaleString() : null;

  return (
    <View style={{ gap: 12 }}>
      <View style={[s.between, { alignItems: "center" }]}>
        <View style={{ flex: 1 }}>
          <Text style={s.heading}>Jobs</Text>
          <Text style={s.muted}>
            {lastScan ? `Last scan ${lastScan}` : "Public boards only. Scans run on your schedule."}
          </Text>
        </View>
        <Button small primary icon={RefreshCw} busy={busy} onPress={() => void scanNow()}>
          Scan now
        </Button>
      </View>
      <ErrorNotice error={error} />
      {!!notice && <Text style={s.small}>{notice}</Text>}
      {jobs === null && <Text style={s.muted}>Loading jobs…</Text>}
      {jobs !== null && jobs.length === 0 && (
        <Card>
          <Text style={s.text}>No jobs yet</Text>
          <Text style={s.muted}>
            Add the Greenhouse or Lever boards you care about in Settings, then run a scan.{"\n\n"}
            Or open a browser session on LinkedIn, Indeed, or a government jobs portal and use
            “Extract jobs” to pull listings from the page you are looking at.
          </Text>
        </Card>
      )}
      {(jobs ?? []).map((job) => (
        <Card key={job.id}>
          <View style={{ gap: 6 }}>
            <View style={[s.row, { gap: 10, alignItems: "flex-start" }]}>
              <View style={[s.iconBox, { backgroundColor: colors.sky }]}>
                <Briefcase size={18} color={colors.text} />
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={[s.text, { fontWeight: "600" }]}>{job.title}</Text>
                <Text style={s.small}>{job.company_name}</Text>
                {!!job.location_text && (
                  <View style={[s.row, { gap: 4, alignItems: "center" }]}>
                    <MapPin size={13} color={colors.muted} />
                    <Text style={s.muted}>{job.location_text}</Text>
                  </View>
                )}
              </View>
              <View style={{ alignItems: "flex-end", gap: 6 }}>
                <Chip tint={colors.canvas}>{job.source}</Chip>
                <ScoreBadge score={job.score} />
              </View>
            </View>
            <View style={[s.row, { gap: 8, alignItems: "center" }]}>
              <Text style={s.muted}>{postedLabel(job)}</Text>
              <View style={{ flex: 1 }} />
              <Button small onPress={() => open({ type: "job", jobId: job.id })}>
                Details
              </Button>
            </View>
          </View>
        </Card>
      ))}
    </View>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <View style={[s.row, { gap: 10 }]}>
      <Text style={[s.small, { width: 90 }]}>{label}</Text>
      <Text style={[s.text, { flex: 1 }]}>{value}</Text>
    </View>
  );
}

/** Slice 11 — Tracker: manual state marks + user-started Gmail scan. */
const TRACK_STATES = [
  { id: "submitted", label: "Submitted" },
  { id: "awaiting_reply", label: "Awaiting reply" },
  { id: "interviewing", label: "Interviewing" },
  { id: "closed_won", label: "Offer received" },
  { id: "closed_lost", label: "Rejected" },
  { id: "withdrawn", label: "Withdrawn" },
] as const;

function TrackApplicationSection({ jobId }: { jobId: string }) {
  const { api } = useWorkspace();
  const [application, setApplication] = useState<{ id: string; state: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanResult, setScanResult] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const apps =
        await api.request<Array<{ id: string; job_id: string; state: string }>>(
          "/api/applications",
        );
      setApplication(apps.find((a) => a.job_id === jobId) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, jobId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!application) return null;
  const terminal = ["closed_won", "closed_lost", "withdrawn"].includes(application.state);

  const mark = async (state: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{ application: { id: string; state: string } }>(
        `/api/applications/${application.id}/state`,
        { state },
        "POST",
      );
      setApplication({ id: result.application.id, state: result.application.state });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const scanMail = async () => {
    setBusy(true);
    setError("");
    setScanResult("");
    try {
      const result = await api.request<{
        scanned: number;
        transitions: Array<{ new_state: string }>;
        rejected: number;
      }>("/api/tracker/scan-mail", {}, "POST");
      const names = result.transitions.map((t) => t.new_state.replace(/_/g, " ")).join(", ");
      setScanResult(
        `Scanned ${result.scanned} messages` +
          (names ? ` — updated: ${names}` : " — no updates") +
          (result.rejected ? ` (${result.rejected} rejected)` : ""),
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ gap: 8 }}>
      <View style={[s.row, { gap: 8, alignItems: "center" }]}>
        <Text style={s.small}>Application status</Text>
        <Chip tint={colors.sky}>{application.state.replace(/_/g, " ")}</Chip>
      </View>
      {!terminal && (
        <View style={{ gap: 6 }}>
          <Text style={s.muted}>Mark as:</Text>
          <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
            {TRACK_STATES.filter((t) => t.id !== application.state).map((t) => (
              <Button key={t.id} small disabled={busy} onPress={() => mark(t.id)}>
                {t.label}
              </Button>
            ))}
          </View>
        </View>
      )}
      <Button small disabled={busy} onPress={scanMail}>
        {busy ? "Scanning…" : "Scan Gmail for updates"}
      </Button>
      {!!scanResult && <Text style={s.small}>{scanResult}</Text>}
      <ErrorNotice error={error} />
    </Card>
  );
}

/** Job detail: the full listing plus official links. source_url always shown. */
const PACK_TEMPLATES = [
  { id: "template-one", name: "Classic Cream" },
  { id: "template-two", name: "Modern Accent" },
  { id: "template-three", name: "Compact" },
  { id: "template-four", name: "Executive" },
  { id: "template-five", name: "Minimal" },
  { id: "template-six", name: "Corporate Grid" },
  { id: "template-seven", name: "ATS Classic" },
];

function BuildPackSection({ jobId }: { jobId: string }) {
  const { api, open } = useWorkspace();
  const [application, setApplication] = useState<{ id: string; state: string } | null>(null);
  const [templateId, setTemplateId] = useState("template-one");
  const [statement, setStatement] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hrFindings, setHrFindings] = useState<
    Array<{ severity: string; location: string; issue: string; fix: string }>
  >([]);

  useEffect(() => {
    let live = true;
    api
      .request<Array<{ id: string; job_id: string; state: string }>>("/api/applications")
      .then((apps) => {
        if (live) setApplication(apps.find((a) => a.job_id === jobId) ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, jobId]);

  if (!application || !["ranked", "shortlisted"].includes(application.state)) return null;

  const build = () => {
    setBusy(true);
    setError("");
    setHrFindings([]);
    api
      .request<{
        status: string;
        pack_id?: string;
        findings?: Array<{ severity: string; location: string; issue: string; fix: string }>;
      }>(`/api/applications/${application.id}/build-pack`, {
        method: "POST",
        body: JSON.stringify({
          template_id: templateId,
          statement_required: statement,
        }),
      })
      .then((r) => {
        if (r.status === "hr_blocked") {
          // HR review found blockers — show the findings so the user can
          // supply the missing evidence instead of having it invented.
          setHrFindings(r.findings ?? []);
          return;
        }
        if (r.pack_id) open({ type: "pack", packId: r.pack_id });
        else setError("Unexpected response from pack builder.");
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Card style={{ gap: 10 }}>
      <Text style={s.small}>Application pack</Text>
      <Text style={s.muted}>
        Generate a tailored resume
        {statement ? ", cover letter, and statement" : " and cover letter"} from your confirmed
        profile, then review the pack before anything is submitted.
      </Text>
      <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
        {PACK_TEMPLATES.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => setTemplateId(t.id)}
            style={[s.chip, templateId === t.id ? { backgroundColor: colors.sky } : null]}
          >
            <Text style={s.chipText}>{t.name}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable onPress={() => setStatement(!statement)} style={[s.row, { gap: 6 }]}>
        <View style={[s.chip, statement ? { backgroundColor: colors.sky } : null]}>
          <Text style={s.chipText}>{statement ? "✓ Include statement" : "Include statement"}</Text>
        </View>
      </Pressable>
      <ErrorNotice error={error} />
      {hrFindings.length > 0 && (
        <Card style={{ gap: 8, backgroundColor: colors.orange }}>
          <Text style={s.small}>HR review needs your input</Text>
          <Text style={s.muted}>
            The HR reviewer found blockers. Nothing was invented — add the missing evidence and
            rebuild.
          </Text>
          {hrFindings.map((f) => (
            <View key={`${f.severity}:${f.location}:${f.issue}`} style={{ gap: 2 }}>
              <Text style={s.small}>
                {f.severity === "blocker" ? "⛔" : "⚠️"} {f.issue}
              </Text>
              {!!f.fix && <Text style={s.muted}>{f.fix}</Text>}
            </View>
          ))}
        </Card>
      )}
      <Button primary busy={busy} disabled={busy} onPress={build} icon={Briefcase}>
        {busy ? "Generating documents…" : "Build application pack"}
      </Button>
    </Card>
  );
}

export function JobDetailSheet({ jobId }: { jobId: string }) {
  const { api, close } = useWorkspace();
  const [job, setJob] = useState<
    (JobPosting & { score: number | null; score_reasons: string[] }) | null
  >(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api
      .request<JobPosting & { score: number | null; score_reasons: string[] }>(`/api/jobs/${jobId}`)
      .then((j) => live && setJob(j))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [api, jobId]);

  return (
    <Sheet title={job?.title ?? "Job"} subtitle={job?.company_name ?? "Loading…"} onClose={close}>
      <ErrorNotice error={error} />
      {!job && <Text style={s.muted}>Loading…</Text>}
      {job && (
        <View style={{ gap: 14 }}>
          {job.score != null && (
            <Card style={{ gap: 6 }}>
              <View style={[s.row, { gap: 8, alignItems: "center" }]}>
                <Text style={s.small}>Match score</Text>
                <ScoreBadge score={job.score} />
              </View>
              {job.score_reasons.map((reason) => (
                <Text key={reason} style={[s.text, { lineHeight: 22 }]}>
                  • {reason}
                </Text>
              ))}
            </Card>
          )}
          <BuildPackSection jobId={jobId} />
          <TrackApplicationSection jobId={jobId} />
          <Card style={{ gap: 8 }}>
            <MetaRow label="Company" value={job.company_name} />
            <MetaRow label="Location" value={job.location_text} />
            {job.remote_type ? <MetaRow label="Work mode" value={job.remote_type} /> : null}
            <MetaRow label="Source" value={job.source} />
            <MetaRow label="Posted" value={postedLabel(job)} />
            {job.salary_text ? <MetaRow label="Salary" value={job.salary_text} /> : null}
            <MetaRow label="Source URL" value={job.source_url} />
          </Card>

          {!!job.raw_text && (
            <View style={{ gap: 6 }}>
              <Text style={s.small}>Description</Text>
              <Text selectable style={[s.text, { lineHeight: 22 }]}>
                {job.raw_text}
              </Text>
            </View>
          )}
          {job.requirements.length > 0 && (
            <View style={{ gap: 6 }}>
              <Text style={s.small}>Requirements</Text>
              {job.requirements.map((r) => (
                <Text key={r} style={[s.text, { lineHeight: 22 }]}>
                  • {r}
                </Text>
              ))}
            </View>
          )}
          {job.qualifications.length > 0 && (
            <View style={{ gap: 6 }}>
              <Text style={s.small}>Qualifications</Text>
              {job.qualifications.map((q) => (
                <Text key={q} style={[s.text, { lineHeight: 22 }]}>
                  • {q}
                </Text>
              ))}
            </View>
          )}

          <View style={{ gap: 8 }}>
            <Text style={s.small}>Official links</Text>
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              <Button
                small
                icon={ExternalLink}
                onPress={() => void Linking.openURL(job.source_url)}
              >
                View original posting
              </Button>
              {!!job.apply_url && (
                <Button
                  small
                  primary
                  icon={ExternalLink}
                  onPress={() => void Linking.openURL(job.apply_url as string)}
                >
                  Apply on company site
                </Button>
              )}
            </View>
            <Text style={s.muted}>
              These open the employer's own pages. OpenApply never applies on your behalf without
              your explicit approval.
            </Text>
          </View>
        </View>
      )}
    </Sheet>
  );
}
