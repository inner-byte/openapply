/**
 * Applications dashboard (debate slice).
 *
 * The panel's decisions, rendered:
 * - KPI row: Active, Awaiting reply, Interviews, Applied vs Walked-away.
 *   No response-rate headline, no volume-as-success.
 * - Sections ordered by action: Needs you → Waiting on them → Interviews →
 *   Fresh finds → Closed.
 * - Cards: title, company, location, bucket pill, legitimacy dot + one
 *   mechanically-sourced evidence line, days-in-state, stall flags.
 *   No match score, no approve button. One action: open the detail.
 * - Detail: full timeline (inferred vs confirmed separated), job details,
 *   legitimacy checks, delivery receipt, deep-links to pack/job.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Button, Card, Chip, colors, dateLabel, ErrorNotice, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

type Bucket = "needs_you" | "waiting_on_them" | "interviews" | "closed" | "fresh";

interface TransitionEntry {
  from: string | null;
  to: string;
  at: string;
  actor: string;
  inferred: boolean;
  reply_kind?: "human" | "auto";
  note?: string;
}

interface DashboardCardData {
  application: {
    id: string;
    job_id: string;
    state: string;
    pack_id?: string;
    submitted_at?: string;
    close_reason?: string;
  };
  job: { id: string; title: string; company_name: string; location_text: string } | null;
  evidence_line: string | null;
  bucket: Bucket;
  days_in_state: number;
  stall: { stalled: boolean; label?: string };
  legitimacy: { level: "verified" | "likely" | "unknown"; checks: string[] };
  transitions: TransitionEntry[];
  last_human_reply_at: string | null;
  last_auto_ack_at: string | null;
  worth_it: { verdict: "worth_it" | "marginal" | "skip"; reason: string };
  cost: { approvals: number; transitions: number; label: string };
}

interface EmployerStats {
  employer: string;
  applications: number;
  human_replies: number;
  ghosted: number;
  label: string;
}

interface Dashboard {
  kpis: {
    active: number;
    awaiting_reply: number;
    interviews: number;
    applied: number;
    walked_away: number;
    fresh: number;
  };
  cards: DashboardCardData[];
  employers: EmployerStats[];
}

const BUCKET_LABEL: Record<Bucket, string> = {
  needs_you: "Needs you",
  waiting_on_them: "Waiting on them",
  interviews: "Interviewing",
  fresh: "Fresh finds",
  closed: "Closed",
};

const SECTION_ORDER: Bucket[] = ["needs_you", "waiting_on_them", "interviews", "fresh", "closed"];

function bucketTint(bucket: Bucket): string {
  switch (bucket) {
    case "needs_you":
      return colors.orange;
    case "waiting_on_them":
      return colors.sky;
    case "interviews":
      return colors.green;
    case "fresh":
      return colors.canvas;
    case "closed":
      return "#E4E6E7";
  }
}

function legitimacyDot(level: DashboardCardData["legitimacy"]["level"]): string {
  return level === "verified" ? colors.green : level === "likely" ? colors.orange : colors.muted;
}

function worthItTint(verdict: DashboardCardData["worth_it"]["verdict"]): string {
  return verdict === "worth_it"
    ? colors.green
    : verdict === "marginal"
      ? colors.orange
      : colors.danger;
}

function worthItLabel(verdict: DashboardCardData["worth_it"]["verdict"]): string {
  return verdict === "worth_it" ? "Worth it" : verdict === "marginal" ? "Marginal" : "Skip";
}

function stateLabel(state: string): string {
  return state
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function daysLabel(days: number): string {
  return days === 0 ? "today" : days === 1 ? "1d" : `${days}d`;
}

function ApplicationCard({ card, onOpen }: { card: DashboardCardData; onOpen: () => void }) {
  const app = card.application;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open application: ${card.job?.title ?? "Unknown role"}`}
      onPress={onOpen}
      style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}
    >
      <Card style={{ gap: 6, marginBottom: 10 }}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Text style={[s.heading, { flex: 1 }]} numberOfLines={1}>
            {card.job?.title ?? "Unknown role"}
          </Text>
          <Chip tint={bucketTint(card.bucket)}>{BUCKET_LABEL[card.bucket]}</Chip>
        </View>
        <Text style={s.small} numberOfLines={1}>
          {card.job?.company_name ?? "—"}
          {card.job?.location_text ? ` · ${card.job.location_text}` : ""}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View
            accessible
            accessibilityLabel={`Legitimacy: ${card.legitimacy.level}`}
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: legitimacyDot(card.legitimacy.level),
            }}
          />
          <Text style={[s.small, { flex: 1 }]} numberOfLines={2}>
            {card.evidence_line ?? "No fit signal yet"}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text style={[s.small, { color: colors.muted }]}>
            {stateLabel(app.state)} · {daysLabel(card.days_in_state)} in state
          </Text>
          <Chip tint={worthItTint(card.worth_it.verdict)}>
            {worthItLabel(card.worth_it.verdict)}
          </Chip>
          {card.last_human_reply_at ? (
            <Chip tint={colors.green}>
              Replied {card.last_human_reply_at ? dateLabel(card.last_human_reply_at) : ""}
            </Chip>
          ) : card.last_auto_ack_at ? (
            <Text style={[s.small, { color: colors.muted }]}>Auto-ack received</Text>
          ) : null}
        </View>
        <Text style={[s.small, { color: colors.muted }]} numberOfLines={2}>
          {card.worth_it.reason} · {card.cost.label}
        </Text>
        {card.stall.stalled && card.stall.label ? (
          <Text style={[s.small, { color: colors.danger, fontWeight: "600" }]}>
            {card.stall.label}
          </Text>
        ) : null}
      </Card>
    </Pressable>
  );
}

function ApplicationDetail({ card, onClose }: { card: DashboardCardData; onClose: () => void }) {
  const { open } = useWorkspace();
  const app = card.application;
  const title = card.job ? `${card.job.title} — ${card.job.company_name}` : "Application";
  return (
    <Sheet
      title={title}
      subtitle={`${stateLabel(app.state)} · ${daysLabel(card.days_in_state)} in state`}
      onClose={onClose}
      wide
    >
      <ScrollView style={{ gap: 12 }}>
        {/* Legitimacy: marker with its stated checks — never a black box. */}
        <Card style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: legitimacyDot(card.legitimacy.level),
              }}
            />
            <Text style={[s.heading, { textTransform: "capitalize" }]}>
              {card.legitimacy.level}
            </Text>
          </View>
          {card.legitimacy.checks.length > 0 ? (
            card.legitimacy.checks.map((check) => (
              <Text key={check} style={s.small}>
                · {check}
              </Text>
            ))
          ) : (
            <Text style={s.small}>No legitimacy signals yet.</Text>
          )}
        </Card>

        {/* Delivery receipt: the mechanical fact of submission. */}
        {app.submitted_at ? (
          <Card>
            <Text style={s.small}>
              Submitted {app.submitted_at ? dateLabel(app.submitted_at) : "—"} — receipt on file.
            </Text>
          </Card>
        ) : null}

        {/* Timeline: append-only, inferred vs confirmed separated. */}
        <Text style={[s.heading, { marginTop: 4 }]}>Timeline</Text>
        {card.transitions.length === 0 ? (
          <Text style={s.small}>No recorded transitions yet.</Text>
        ) : (
          card.transitions.map((t) => (
            <View
              key={`${t.at}-${t.to}-${t.actor}`}
              style={{
                flexDirection: "row",
                gap: 8,
                paddingVertical: 6,
                opacity: t.inferred ? 0.65 : 1,
              }}
            >
              <Text style={[s.small, { color: colors.muted, width: 76 }]}>{dateLabel(t.at)}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.small}>
                  {t.from ? `${stateLabel(t.from)} → ` : ""}
                  <Text style={{ fontWeight: "600" }}>{stateLabel(t.to)}</Text>
                </Text>
                <Text style={[s.small, { color: colors.muted }]}>
                  {t.actor === "user"
                    ? "You"
                    : t.actor === "tracker"
                      ? `Via Gmail (inferred)${t.reply_kind === "auto" ? " · auto-ack" : t.reply_kind === "human" ? " · human reply" : ""}`
                      : "OpenApply"}
                  {t.note ? ` — ${t.note}` : ""}
                </Text>
              </View>
            </View>
          ))
        )}

        {/* Deep-links only. Approval lives where the documents are. */}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          {app.pack_id ? (
            <Button
              small
              onPress={() => {
                onClose();
                open({ type: "pack", packId: app.pack_id as string });
              }}
            >
              Open pack
            </Button>
          ) : null}
          {card.job ? (
            <Button
              small
              onPress={() => {
                const jobId = card.job?.id;
                if (!jobId) return;
                onClose();
                open({ type: "job", jobId });
              }}
            >
              Open job
            </Button>
          ) : null}
        </View>
      </ScrollView>
    </Sheet>
  );
}

export function ApplicationsScreen() {
  const { api } = useWorkspace();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<DashboardCardData | null>(null);
  const [query, setQuery] = useState("");
  const [legitFilter, setLegitFilter] = useState<"all" | "verified" | "likely" | "unknown">("all");

  const load = useCallback(async () => {
    try {
      const data = await api.request<Dashboard>("/api/applications/dashboard");
      setDashboard(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error)
    return (
      <View style={{ gap: 12, alignItems: "flex-start" }}>
        <ErrorNotice error={error} />
        <Button onPress={load}>Try again</Button>
      </View>
    );
  if (!dashboard)
    return (
      <View style={{ padding: 24, alignItems: "center" }}>
        <ActivityIndicator
          size="large"
          color={colors.blue}
          accessibilityLabel="Loading applications"
        />
      </View>
    );

  const { kpis, employers } = dashboard;
  const q = query.trim().toLowerCase();
  const cards = dashboard.cards.filter((card) => {
    if (legitFilter !== "all" && card.legitimacy.level !== legitFilter) return false;
    if (!q) return true;
    const hay = `${card.job?.title ?? ""} ${card.job?.company_name ?? ""}`.toLowerCase();
    return hay.includes(q);
  });
  const byBucket = new Map<Bucket, DashboardCardData[]>();
  for (const card of cards) {
    const list = byBucket.get(card.bucket) ?? [];
    list.push(card);
    byBucket.set(card.bucket, list);
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 4, paddingBottom: 24 }}>
      {/* KPI row: Active, Awaiting reply, Interviews, Applied vs Walked-away. */}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        {[
          { label: "Active", value: String(kpis.active) },
          { label: "Awaiting reply", value: String(kpis.awaiting_reply) },
          { label: "Interviews", value: String(kpis.interviews) },
          { label: "Applied · Walked away", value: `${kpis.applied} · ${kpis.walked_away}` },
        ].map((kpi) => (
          <Card key={kpi.label} style={{ flex: 1, minWidth: 140, alignItems: "center", gap: 2 }}>
            <Text style={[s.title, { fontSize: 22 }]}>{kpi.value}</Text>
            <Text style={s.small}>{kpi.label}</Text>
          </Card>
        ))}
      </View>

      {SECTION_ORDER.map((bucket) => {
        const list = byBucket.get(bucket) ?? [];
        if (list.length === 0) return null;
        return (
          <View key={bucket} style={{ marginTop: 8 }}>
            <Text style={[s.heading, { marginBottom: 8 }]}>
              {BUCKET_LABEL[bucket]} ({list.length})
            </Text>
            {list.map((card) => (
              <ApplicationCard
                key={card.application.id}
                card={card}
                onOpen={() => setSelected(card)}
              />
            ))}
          </View>
        );
      })}

      {cards.length === 0 ? (
        <Text style={s.small}>
          No applications yet. Ranked jobs become applications automatically.
        </Text>
      ) : null}

      {/* Filters: search + legitimacy. */}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8, alignItems: "center" }}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search company or title"
          placeholderTextColor={colors.muted}
          style={[s.input, { flex: 1 }]}
          accessibilityLabel="Search applications"
        />
      </View>
      <View style={{ flexDirection: "row", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        {(["all", "verified", "likely", "unknown"] as const).map((level) => (
          <Pressable
            key={level}
            accessibilityRole="button"
            accessibilityLabel={`Filter by legitimacy: ${level}`}
            onPress={() => setLegitFilter(level)}
            style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}
          >
            <Chip tint={legitFilter === level ? colors.blue : undefined}>
              {level === "all" ? "All" : level.charAt(0).toUpperCase() + level.slice(1)}
            </Chip>
          </Pressable>
        ))}
      </View>

      {/* Per-employer reply behavior: aggregates, never a gaming leaderboard. */}
      {employers.length > 0 ? (
        <View style={{ marginTop: 12 }}>
          <Text style={[s.heading, { marginBottom: 8 }]}>Employers</Text>
          {employers.map((e) => (
            <Card key={e.employer} style={{ marginBottom: 8, gap: 2 }}>
              <Text style={[s.text, { fontWeight: "600" }]}>{e.employer}</Text>
              <Text style={s.small}>{e.label}</Text>
            </Card>
          ))}
        </View>
      ) : null}
      {selected ? <ApplicationDetail card={selected} onClose={() => setSelected(null)} /> : null}
    </ScrollView>
  );
}
