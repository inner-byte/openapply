import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import {
  ArrowDownToLine,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Cpu,
  FileText,
  Globe2,
  Inbox,
  Link2,
  ListChecks,
  Mail,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import type {
  Artifact,
  BrowserSession,
  CalendarEvent,
  EmailDraft,
} from "../../../packages/domain/src";
import { API_URL } from "./api";
import { CvInterviewSheet } from "./cv-interview";
import { localDateTime, zonedInstant } from "./date-time";
import {
  Button,
  Card,
  Chip,
  colors,
  dateLabel,
  Empty,
  ErrorNotice,
  Field,
  IconButton,
  LinkRow,
  Mascot,
  relativeDate,
  resultSummary,
  SectionHeading,
  Sheet,
  s,
  timeLabel,
} from "./ui";
import { useWorkspace } from "./workspace";

function todayDate() {
  return localDateTime(new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone)
    .date;
}
function eventDate(event: CalendarEvent) {
  return event.allDay ? event.start : localDateTime(event.start, event.timeZone).date;
}
export function TodayScreen() {
  const { workspace: w, navigate, open, ask } = useWorkspace();
  const wide = useWindowDimensions().width > 1180;
  const pending = w.actions.filter((a) => a.status === "awaiting_review");
  const unread = w.mail.filter((m) => m.unread);
  const today = todayDate();
  const events = w.events
    .filter((e) => eventDate(e) === today)
    .sort((a, b) => a.start.localeCompare(b.start));
  return (
    <View style={{ gap: 25 }}>
      <View
        style={[
          {
            backgroundColor: "#E8F2F8",
            borderRadius: 24,
            padding: 32,
            minHeight: 228,
            overflow: "hidden",
          },
          s.row,
        ]}
      >
        <View style={{ flex: 1, gap: 15, zIndex: 1 }}>
          <View style={[s.row, { gap: 7 }]}>
            <Sparkles size={13} color={colors.blueDark} />
            <Text style={[s.label, { color: colors.blueDark }]}>A little clarity, every day</Text>
          </View>
          <Text
            style={{
              fontSize: wide ? 39 : 29,
              lineHeight: wide ? 45 : 36,
              letterSpacing: -1.7,
              fontWeight: "500",
              color: colors.text,
            }}
          >
            Your day, with a little{"\n"}more room to breathe.
          </Text>
          <Text style={[s.muted, { maxWidth: 420, color: "#617680" }]}>
            {events.length ? `${events.length} things on your calendar` : "Your calendar has room"}
            {unread.length ? `, ${unread.length} unread emails` : ""}.{"\n"}Let’s make space for
            what matters.
          </Text>
          <Button
            onPress={() => ask("Help me plan my day")}
            icon={Sparkles}
            primary
            style={{ alignSelf: "flex-start", marginTop: 5 }}
          >
            Plan my day
          </Button>
        </View>
        {wide && (
          <View style={{ width: 220, height: 210, alignItems: "center", justifyContent: "center" }}>
            <View
              style={{
                position: "absolute",
                width: 190,
                height: 190,
                borderRadius: 100,
                backgroundColor: "#DAEAF2",
              }}
            />
            <View
              style={{
                position: "absolute",
                width: 145,
                height: 145,
                borderRadius: 80,
                borderWidth: 1,
                borderColor: "#C8DBE6",
              }}
            />
            <Mascot size={94} />
            <View
              style={[
                s.row,
                {
                  position: "absolute",
                  top: 17,
                  left: -19,
                  padding: 11,
                  gap: 7,
                  backgroundColor: "#FFF",
                  borderRadius: 13,
                  transform: [{ rotate: "-7deg" }],
                },
              ]}
            >
              <Check size={14} color="#739174" />
              <Text style={s.small}>A lighter day</Text>
            </View>
            <View
              style={[
                s.row,
                {
                  position: "absolute",
                  bottom: 18,
                  right: -8,
                  padding: 12,
                  gap: 8,
                  backgroundColor: "#FFF",
                  borderRadius: 13,
                  transform: [{ rotate: "5deg" }],
                },
              ]}
            >
              <CalendarDays size={17} color={colors.blueDark} />
              <Text style={s.small}>Everything, together</Text>
            </View>
          </View>
        )}
      </View>
      <View style={{ flexDirection: "row", gap: 13, flexWrap: "wrap" }}>
        {[
          {
            label: "UNREAD EMAILS",
            value: unread.length,
            note: "A fresh look at your inbox",
            icon: Mail,
            section: "mail" as const,
            tint: colors.sky,
          },
          {
            label: "ON THE CALENDAR",
            value: events.length,
            note: "Make room for your priorities",
            icon: CalendarDays,
            section: "calendar" as const,
            tint: colors.green,
          },
          {
            label: "WAITING FOR YOU",
            value: pending.length,
            note: "Your review keeps things moving",
            icon: ShieldCheck,
            section: "activity" as const,
            tint: colors.lavender,
          },
        ].map((item) => (
          <Pressable
            key={item.label}
            accessibilityRole="button"
            onPress={() => navigate(item.section)}
            style={{ flex: 1, minWidth: 180 }}
          >
            <Card style={{ padding: 21, height: 126 }}>
              <View style={s.between}>
                <Text style={[s.label, { fontSize: 9, letterSpacing: 1 }]}>{item.label}</Text>
                <View
                  style={[
                    s.iconBox,
                    { width: 31, height: 31, borderRadius: 10, backgroundColor: item.tint },
                  ]}
                >
                  <item.icon size={15} color={colors.text} />
                </View>
              </View>
              <Text style={{ fontSize: 29, color: colors.text, letterSpacing: -1, marginTop: -2 }}>
                {String(item.value).padStart(2, "0")}
              </Text>
              <Text style={[s.small, { fontSize: 10, marginTop: 3 }]}>{item.note}</Text>
            </Card>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: wide ? "row" : "column", gap: 22 }}>
        <Card style={{ flex: 1 }}>
          <SectionHeading
            title="On your calendar"
            action="Full calendar"
            onPress={() => navigate("calendar")}
          />
          {events.length ? (
            events.slice(0, 3).map((e, i) => <AgendaRow key={e.id} event={e} index={i} />)
          ) : (
            <Empty
              icon={CalendarDays}
              title="Some breathing room"
              detail="No events scheduled today."
            />
          )}
          <Pressable
            onPress={() => open({ type: "event" })}
            style={[
              s.row,
              {
                gap: 8,
                paddingTop: 15,
                marginTop: 9,
                borderTopWidth: 1,
                borderTopColor: colors.line,
              },
            ]}
          >
            <Plus size={15} color={colors.muted} />
            <Text style={s.small}>Make time for something</Text>
          </Pressable>
        </Card>
        <Card style={{ flex: 1 }}>
          <SectionHeading
            title="From your inbox"
            action="Open mail"
            onPress={() => navigate("mail")}
          />
          {w.mail.length ? (
            w.mail.slice(0, 3).map((m, i) => (
              <Pressable
                key={m.id}
                onPress={() => open({ type: "mail", mail: m })}
                style={[
                  s.row,
                  {
                    gap: 12,
                    paddingVertical: 13,
                    borderTopWidth: i ? 1 : 0,
                    borderTopColor: colors.line,
                  },
                ]}
              >
                <Avatar name={m.sender} index={i} />
                <View style={{ flex: 1, gap: 3 }}>
                  <View style={s.between}>
                    <Text style={[s.text, { fontSize: 12, fontWeight: "600" }]}>{m.sender}</Text>
                    <Text style={[s.small, { fontSize: 10 }]}>{timeLabel(m.date)}</Text>
                  </View>
                  <Text numberOfLines={1} style={[s.text, { fontSize: 12, lineHeight: 18 }]}>
                    {m.subject}
                  </Text>
                  <Text numberOfLines={1} style={[s.small, { fontSize: 11 }]}>
                    {m.body.replace(/\n/g, " ")}
                  </Text>
                </View>
                {m.unread && (
                  <View
                    style={{ width: 5, height: 5, borderRadius: 4, backgroundColor: "#78ABD0" }}
                  />
                )}
              </Pressable>
            ))
          ) : (
            <Empty
              icon={Inbox}
              title="Inbox is quiet"
              detail="Connect Google to bring your messages here."
            />
          )}
        </Card>
      </View>
      <View style={{ flexDirection: wide ? "row" : "column", gap: 22 }}>
        <Card style={{ flex: 1, backgroundColor: "#F0F0E7" }}>
          <SectionHeading title="A hand with the little things" />
          <Text style={[s.muted, { marginBottom: 15 }]}>
            Start with a thought. We’ll take it from there.
          </Text>
          {[
            "What needs my attention today?",
            "Help me catch up on my inbox",
            "Show my recent documents",
          ].map((prompt) => (
            <Pressable
              key={prompt}
              onPress={() => ask(prompt)}
              style={[
                s.between,
                { borderTopWidth: 1, borderTopColor: "#E1E2D9", paddingVertical: 13 },
              ]}
            >
              <Text style={[s.text, { fontSize: 12 }]}>{prompt}</Text>
              <ArrowUpRight size={15} color={colors.muted} />
            </Pressable>
          ))}
        </Card>
        <Card style={{ flex: 1 }}>
          <SectionHeading
            title={pending.length ? "Ready for your review" : "Recent activity"}
            action="View all"
            onPress={() => navigate("activity")}
          />
          {pending.length
            ? pending
                .slice(0, 3)
                .map((a) => (
                  <LinkRow
                    key={a.id}
                    title={a.title}
                    detail="Prepared · waiting for your approval"
                    onPress={() => open({ type: "review", action: a })}
                    icon={ShieldCheck}
                    tint={colors.lavender}
                  />
                ))
            : w.activity.slice(0, 3).map((a) => (
                <View key={a.id} style={[s.row, { gap: 13, paddingVertical: 12 }]}>
                  <View
                    style={[s.iconBox, { width: 32, height: 32, backgroundColor: colors.green }]}
                  >
                    <Check size={14} color={colors.text} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.text, { fontSize: 12 }]}>{a.title}</Text>
                    <Text style={s.small}>{relativeDate(a.date)}</Text>
                  </View>
                </View>
              ))}
          {!pending.length && !w.activity.length && (
            <Text style={s.muted}>
              Your workspace is ready. Things you do here will appear in your activity.
            </Text>
          )}
        </Card>
      </View>
    </View>
  );
}
function Avatar({ name, index = 0 }: { name: string; index?: number }) {
  return (
    <View
      style={{
        width: 35,
        height: 35,
        borderRadius: 12,
        backgroundColor: [colors.orange, colors.lavender, colors.green, colors.sky][index % 4],
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Text style={{ color: colors.text, fontSize: 11, fontWeight: "500" }}>
        {name
          .split(" ")
          .map((p) => p[0])
          .slice(0, 2)
          .join("")}
      </Text>
    </View>
  );
}
export function AgendaRow({
  event: e,
  index = 0,
  neighbors,
}: {
  event: CalendarEvent;
  index?: number;
  neighbors?: CalendarEvent[];
}) {
  const { open } = useWorkspace();
  return (
    <Pressable
      onPress={() => open({ type: "event", event: e, neighbors })}
      style={[s.row, { gap: 16, paddingVertical: 14 }]}
    >
      <View style={{ width: 65 }}>
        <Text style={[s.text, { fontSize: 11 }]}>
          {e.allDay ? "All day" : timeLabel(e.start, e.timeZone)}
        </Text>
        {!e.allDay && (
          <Text style={[s.small, { fontSize: 10 }]}>{timeLabel(e.end, e.timeZone)}</Text>
        )}
      </View>
      <View
        style={{
          width: 3,
          height: 42,
          borderRadius: 4,
          backgroundColor: ["#BCDAEB", "#C7D6AB", "#D9CDEA"][index % 3],
        }}
      />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[s.text, { fontSize: 13, fontWeight: "500" }]}>{e.title}</Text>
        <Text numberOfLines={1} style={[s.small, { fontSize: 11 }]}>
          {e.location || (e.attendees.length ? `${e.attendees.length} attendees` : "Time for you")}
        </Text>
      </View>
      <ChevronRight size={14} color={colors.muted} />
    </Pressable>
  );
}
export function MailScreen() {
  const { workspace: w, api, open } = useWorkspace();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const [drafts, setDrafts] = useState<(EmailDraft & { id: string; createdAt: string })[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    void api
      .request<(EmailDraft & { id: string; createdAt: string })[]>("/api/drafts")
      .then(setDrafts)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, w]);
  const items = w.mail.filter(
    (m) =>
      (tab !== "unread" || m.unread) &&
      `${m.sender} ${m.subject} ${m.body}`.toLowerCase().includes(query.toLowerCase()),
  );
  const filteredDrafts = drafts.filter((d) =>
    `${d.to.join(" ")} ${d.subject} ${d.body}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <View style={{ gap: 20 }}>
      <View style={[s.between, { gap: 12, flexWrap: "wrap" }]}>
        <View
          style={[
            s.row,
            {
              gap: 9,
              flex: 1,
              minWidth: 200,
              backgroundColor: "#FFF",
              borderWidth: 1,
              borderColor: colors.line,
              borderRadius: 12,
              paddingHorizontal: 14,
            },
          ]}
        >
          <Search size={16} color={colors.muted} />
          <TextInput
            accessibilityLabel="Search mail"
            placeholder="Search your inbox"
            placeholderTextColor={colors.muted}
            value={query}
            onChangeText={setQuery}
            style={{ flex: 1, paddingVertical: 13, fontSize: 13, color: colors.text }}
          />
        </View>
        <Button onPress={() => open({ type: "email" })} primary icon={Plus}>
          Compose
        </Button>
      </View>
      <ErrorNotice error={error} />
      <Card>
        <View style={[s.row, { gap: 10, marginBottom: 15, flexWrap: "wrap" }]}>
          <Button small primary={tab === "all"} onPress={() => setTab("all")}>
            All messages
          </Button>
          <Button small primary={tab === "unread"} onPress={() => setTab("unread")}>
            Unread · {w.mail.filter((m) => m.unread).length}
          </Button>
          <Button small primary={tab === "drafts"} onPress={() => setTab("drafts")}>
            Drafts · {drafts.length}
          </Button>
        </View>
        {tab === "drafts" ? (
          filteredDrafts.length ? (
            filteredDrafts.map((d) => (
              <LinkRow
                key={d.id}
                icon={Mail}
                title={d.subject}
                detail={`To: ${d.to.join(", ")} · saved ${dateLabel(d.createdAt)}`}
                onPress={() => open({ type: "email", draft: d })}
              />
            ))
          ) : (
            <Empty
              icon={Mail}
              title="A fresh page"
              detail="Messages you save as drafts will be here when you’re ready."
            />
          )
        ) : items.length ? (
          items.map((m, i) => (
            <Pressable
              key={m.id}
              onPress={() => open({ type: "mail", mail: m })}
              style={[
                s.row,
                { gap: 15, paddingVertical: 20, borderTopWidth: 1, borderTopColor: colors.line },
              ]}
            >
              <Avatar name={m.sender} index={i} />
              <View style={{ flex: 1, gap: 5 }}>
                <View style={s.between}>
                  <Text style={[s.text, { fontWeight: m.unread ? "600" : "400" }]}>{m.sender}</Text>
                  <Text style={s.small}>{dateLabel(m.date)}</Text>
                </View>
                <Text style={[s.text, { fontWeight: "500", fontSize: 13 }]}>{m.subject}</Text>
                <Text style={s.muted} numberOfLines={1}>
                  {m.body.replace(/\n/g, " ")}
                </Text>
                {!!m.attachments.length && (
                  <View style={[s.row, { gap: 4, marginTop: 2 }]}>
                    <FileText size={12} color={colors.muted} />
                    <Text style={s.small}>
                      {m.attachments.length} attachment{m.attachments.length > 1 ? "s" : ""}
                    </Text>
                  </View>
                )}
              </View>
              {m.unread && (
                <View
                  style={{ width: 6, height: 6, borderRadius: 4, backgroundColor: "#83B5D3" }}
                />
              )}
            </Pressable>
          ))
        ) : (
          <Empty
            icon={Inbox}
            title={query ? "No matching messages" : "Nothing in your inbox"}
            detail={
              query
                ? "Try a different name or subject."
                : "Connect Google in Connections to read your mail here."
            }
          />
        )}
      </Card>
    </View>
  );
}
interface CalendarChoice {
  id: string;
  name: string;
  timeZone: string;
  accessRole: string;
}
function plusDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function CalendarScreen() {
  const { workspace: w, api, open } = useWorkspace();
  const [date, setDate] = useState(todayDate());
  const [all, setAll] = useState(false);
  const [calendars, setCalendars] = useState<CalendarChoice[]>([]);
  const [calendarId, setCalendarId] = useState("primary");
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const selected = calendars.find((c) => c.id === calendarId);
  const zone = selected?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const writable = !selected || ["owner", "writer"].includes(selected.accessRole);
  const anchor = new Date(`${date}T12:00:00`);
  const dates = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(anchor);
    day.setDate(anchor.getDate() - anchor.getDay() + i);
    return day;
  });
  useEffect(() => {
    let active = true;
    void api
      .request<CalendarChoice[]>("/api/calendars")
      .then((items) => {
        if (!active) return;
        setCalendars(items);
        setCalendarId((current) =>
          items.some((c) => c.id === current) ? current : items[0]?.id || "primary",
        );
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, retry]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void Promise.resolve()
      .then(() => {
        const query = new URLSearchParams({
          calendarId,
          timeMin: zonedInstant(date, "00:00", zone),
          timeMax: zonedInstant(plusDays(date, all ? 30 : 1), "00:00", zone),
        });
        return api.request<CalendarEvent[]>(`/api/calendar/events?${query}`);
      })
      .then((items) => {
        if (active) setEvents(items.sort((a, b) => a.start.localeCompare(b.start)));
      })
      .catch((e) => {
        if (active) {
          setEvents([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, calendarId, date, all, zone, w, retry]);
  function newEvent() {
    open({
      type: "event",
      neighbors: events,
      draft: {
        calendarId,
        title: "",
        start: zonedInstant(date, "09:00", zone),
        end: zonedInstant(date, "10:00", zone),
        allDay: false,
        timeZone: zone,
        location: "",
        description: "",
        attendees: [],
      },
    });
  }
  return (
    <View style={{ gap: 20 }}>
      <View style={[s.between, { gap: 12, flexWrap: "wrap" }]}>
        <View style={[s.row, { gap: 8 }]}>
          <Text style={s.title}>
            {anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </Text>
          <IconButton
            icon={ChevronLeft}
            label="Previous week"
            onPress={() => setDate(plusDays(date, -7))}
          />
          <IconButton
            icon={ChevronRight}
            label="Next week"
            onPress={() => setDate(plusDays(date, 7))}
          />
        </View>
        <Button primary icon={Plus} disabled={!writable} onPress={newEvent}>
          New event
        </Button>
      </View>
      {calendars.length > 0 && (
        <View style={{ gap: 9 }}>
          <Text style={s.label}>Your calendars</Text>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {calendars.map((c) => (
              <Button
                key={c.id}
                small
                primary={c.id === calendarId}
                onPress={() => setCalendarId(c.id)}
              >
                {c.name}
                {["owner", "writer"].includes(c.accessRole) ? "" : " · read only"}
              </Button>
            ))}
          </View>
        </View>
      )}
      <Card style={{ padding: 12 }}>
        <View style={{ flexDirection: "row", gap: 5 }}>
          {dates.map((day) => {
            const key = localDateTime(
              day.toISOString(),
              Intl.DateTimeFormat().resolvedOptions().timeZone,
            ).date;
            return (
              <Pressable
                key={key}
                onPress={() => {
                  setDate(key);
                  setAll(false);
                }}
                style={{
                  flex: 1,
                  alignItems: "center",
                  paddingVertical: 17,
                  gap: 9,
                  borderRadius: 14,
                  backgroundColor: key === date ? colors.sky : "transparent",
                }}
              >
                <Text style={s.small}>{day.toLocaleDateString("en-US", { weekday: "short" })}</Text>
                <Text
                  style={[
                    s.title,
                    { fontSize: 22, color: key === date ? colors.blueDark : colors.text },
                  ]}
                >
                  {day.getDate()}
                </Text>
                <View
                  style={{
                    height: 4,
                    width: 4,
                    borderRadius: 4,
                    backgroundColor: [...events, ...w.events].some(
                      (e) => e.calendarId === calendarId && eventDate(e) === key,
                    )
                      ? "#8DB6CA"
                      : "transparent",
                  }}
                />
              </Pressable>
            );
          })}
        </View>
      </Card>
      <Card>
        <View style={[s.between, { gap: 10, flexWrap: "wrap" }]}>
          <Text style={s.heading}>
            {all
              ? "The next 30 days"
              : dateLabel(`${date}T12:00:00`, { weekday: "long", month: "long", day: "numeric" })}
          </Text>
          <Button small onPress={() => setAll(!all)}>
            {all ? "Selected day" : "Next 30 days"}
          </Button>
        </View>
        <Text style={[s.small, { marginTop: 7, marginBottom: 13 }]}>
          {selected?.name || "Your calendar"} · {zone}. Events show their own time zone.
        </Text>
        <ErrorNotice error={error} />
        {!!error && (
          <Button small onPress={() => setRetry(retry + 1)}>
            Try again
          </Button>
        )}
        {loading ? (
          <View style={[s.row, { gap: 10, paddingVertical: 35, justifyContent: "center" }]}>
            <ActivityIndicator size="small" color={colors.blueDark} />
            <Text style={s.muted}>Checking your calendar…</Text>
          </View>
        ) : events.length ? (
          events.map((e, i) => (
            <View key={e.id}>
              {all && <Text style={[s.label, { marginTop: 16 }]}>{dateLabel(e.start)}</Text>}
              <AgendaRow event={e} index={i} neighbors={events} />
              <Text style={[s.small, { marginLeft: 84, marginBottom: 8 }]}>{e.timeZone}</Text>
            </View>
          ))
        ) : (
          !error && (
            <Empty
              icon={CalendarDays}
              title="A little open space"
              detail={
                all
                  ? "There’s nothing scheduled for the next 30 days."
                  : "There’s nothing on the calendar for this day."
              }
            >
              {writable && (
                <Button icon={Plus} onPress={newEvent}>
                  Add an event
                </Button>
              )}
            </Empty>
          )
        )}
      </Card>
    </View>
  );
}
export function BrowserScreen() {
  const { workspace: w, api, refresh, open } = useWorkspace();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create() {
    setError("");
    setBusy(true);
    try {
      const browser = await api.request<BrowserSession>("/api/browsers", { url });
      await refresh();
      setUrl("");
      open({ type: "browser", browser });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 22 }}>
      <Card style={{ backgroundColor: colors.sky }}>
        <View style={[s.row, { gap: 12, marginBottom: 15 }]}>
          <Globe2 size={22} color={colors.blueDark} />
          <View>
            <Text style={s.heading}>A place for your open tabs</Text>
            <Text style={s.muted}>Browse in a private, persistent workspace session.</Text>
          </View>
        </View>
        <View style={[s.row, { gap: 10 }]}>
          <TextInput
            accessibilityLabel="Website address"
            value={url}
            onChangeText={setUrl}
            onSubmitEditing={() => void create()}
            autoCapitalize="none"
            placeholder="https://example.com"
            placeholderTextColor={colors.muted}
            style={[s.input, { flex: 1 }]}
          />
          <Button
            primary
            icon={Plus}
            busy={busy}
            disabled={!url.trim()}
            onPress={() => void create()}
          >
            Open session
          </Button>
        </View>
        <ErrorNotice error={error} />
      </Card>
      <Card>
        <SectionHeading title="Browser sessions" />
        {w.browsers.length ? (
          w.browsers.map((b) => (
            <Pressable
              key={b.id}
              onPress={() => open({ type: "browser", browser: b })}
              style={{
                borderTopWidth: 1,
                borderTopColor: colors.line,
                paddingVertical: 20,
                gap: 12,
              }}
            >
              <View style={[s.row, { gap: 14 }]}>
                <View style={s.iconBox}>
                  <Globe2 size={20} color={colors.blueDark} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={s.heading}>{b.title || "Browser session"}</Text>
                  <Text style={s.muted} numberOfLines={1}>
                    {b.url}
                  </Text>
                </View>
                <Chip tint={b.status === "active" ? colors.green : colors.canvas}>{b.status}</Chip>
                <ArrowUpRight size={17} color={colors.muted} />
              </View>
              {b.previewUrl && (
                <Image
                  source={{ uri: api.url(b.previewUrl) }}
                  resizeMode="cover"
                  style={{
                    height: 180,
                    width: "100%",
                    borderRadius: 12,
                    backgroundColor: colors.canvas,
                  }}
                />
              )}
            </Pressable>
          ))
        ) : (
          <Empty
            icon={Globe2}
            title="Start with a website"
            detail="Open a session above to keep your browsing together. Live previews appear when the browser worker is configured."
          />
        )}
      </Card>
    </View>
  );
}
export function FilesScreen() {
  const { workspace: w, api, refresh, open } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function upload() {
    setError("");
    setBusy(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const file = result.assets[0];
      let artifact: Artifact;
      if (Platform.OS === "web") {
        const form = new FormData();
        if (!file.file)
          throw new Error("The selected file could not be read. Please choose it again.");
        form.append("file", file.file, file.name);
        artifact = await api.request<Artifact>("/api/files", form);
      } else {
        const result = await FileSystem.uploadAsync(`${API_URL}/api/files`, file.uri, {
          httpMethod: "POST",
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: "file",
          mimeType: "application/pdf",
          headers: { Authorization: `Bearer ${api.token}` },
        });
        const payload = JSON.parse(result.body);
        if (result.status < 200 || result.status >= 300)
          throw new Error(payload.error || "Could not import this PDF.");
        artifact = payload;
      }
      await refresh();
      open({ type: "file", file: artifact });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 20 }}>
      <View style={s.between}>
        <Text style={[s.muted, { flex: 1, marginRight: 15 }]}>
          Documents, with a little room to work.
        </Text>
        <Button primary icon={Upload} busy={busy} onPress={() => void upload()}>
          Import PDF
        </Button>
      </View>
      <ErrorNotice error={error} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 18 }}>
        {w.files.map((f) => (
          <Pressable
            key={f.id}
            onPress={() => open({ type: "file", file: f })}
            style={{ flexGrow: 1, flexBasis: 250, maxWidth: 430 }}
          >
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <View
                style={{
                  height: 175,
                  backgroundColor: "#EDEFEA",
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <View
                  style={{
                    width: 93,
                    height: 121,
                    borderRadius: 5,
                    backgroundColor: "#FFF",
                    padding: 14,
                    transform: [{ rotate: "-4deg" }],
                    borderWidth: 1,
                    borderColor: "#DDE3DD",
                  }}
                >
                  <View style={[s.row, { gap: 5, marginBottom: 15 }]}>
                    <FileText size={13} color={colors.blueDark} />
                    <Text style={{ fontSize: 7, color: colors.blueDark }}>DOCUMENT</Text>
                  </View>
                  {[100, 75, 90, 95, 60].map((width, i) => (
                    <View
                      key={width}
                      style={{
                        height: 3,
                        backgroundColor: i === 0 ? "#A4BED0" : "#E3E7E3",
                        width: `${width}%`,
                        marginBottom: 7,
                        borderRadius: 3,
                      }}
                    />
                  ))}
                </View>
                <View style={{ position: "absolute", bottom: 12, right: 14 }}>
                  <Chip>PDF</Chip>
                </View>
              </View>
              <View style={{ padding: 21, gap: 6 }}>
                <Text numberOfLines={1} style={[s.heading, { fontSize: 14 }]}>
                  {f.name}
                </Text>
                <Text style={s.small}>
                  {f.pageCount} {f.pageCount === 1 ? "page" : "pages"} ·{" "}
                  {Math.max(1, Math.round(f.size / 1024))} KB
                </Text>
                <View style={[s.between, { marginTop: 9 }]}>
                  <Chip>{f.source}</Chip>
                  <Text style={s.small}>{dateLabel(f.createdAt)}</Text>
                </View>
              </View>
            </Card>
          </Pressable>
        ))}
      </View>
      {!w.files.length && (
        <Card>
          <Empty
            icon={FileText}
            title="Your documents live here"
            detail="Import a PDF or open a mail attachment to read, fill supported form fields, and share a copy."
          />
        </Card>
      )}
    </View>
  );
}
export function ActivityScreen() {
  const { workspace: w, open } = useWorkspace();
  const [filter, setFilter] = useState("all");
  const pending = w.actions.filter((a) => a.status === "awaiting_review");
  const actions = w.actions.filter((a) => filter === "all" || a.status === "awaiting_review");
  return (
    <View style={{ gap: 20 }}>
      <View style={[s.row, { gap: 10 }]}>
        <Button small primary={filter === "all"} onPress={() => setFilter("all")}>
          All activity
        </Button>
        <Button small primary={filter === "review"} onPress={() => setFilter("review")}>
          Needs review · {pending.length}
        </Button>
      </View>
      {actions.length > 0 && (
        <Card>
          <SectionHeading title="Your actions" />
          {actions.map((a) => (
            <Pressable
              key={a.id}
              onPress={() => open({ type: "review", action: a })}
              style={[
                s.row,
                { gap: 15, paddingVertical: 17, borderTopWidth: 1, borderTopColor: colors.line },
              ]}
            >
              <View
                style={[
                  s.iconBox,
                  {
                    backgroundColor:
                      a.status === "awaiting_review" ? colors.lavender : colors.green,
                  },
                ]}
              >
                {a.status === "awaiting_review" ? (
                  <ShieldCheck size={18} color={colors.text} />
                ) : (
                  <CheckCheck size={18} color={colors.text} />
                )}
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={s.text}>{a.title}</Text>
                <Text style={s.small}>{relativeDate(a.createdAt)}</Text>
              </View>
              <Chip
                tint={
                  a.status === "failed"
                    ? "#FBEFED"
                    : a.status === "awaiting_review"
                      ? colors.lavender
                      : colors.canvas
                }
              >
                {a.status.replace(/_/g, " ")}
              </Chip>
              <ChevronRight size={16} color={colors.muted} />
            </Pressable>
          ))}
        </Card>
      )}
      {filter === "all" && (
        <Card>
          <SectionHeading title="Workspace timeline" />
          {w.activity.length ? (
            w.activity.map((a, i) => (
              <View
                key={a.id}
                style={[
                  s.row,
                  {
                    alignItems: "flex-start",
                    gap: 17,
                    paddingVertical: 18,
                    borderTopWidth: i ? 1 : 0,
                    borderTopColor: colors.line,
                  },
                ]}
              >
                <View
                  style={[s.iconBox, { height: 34, width: 34, backgroundColor: colors.canvas }]}
                >
                  <Clock3 size={16} color={colors.muted} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={s.text}>{a.title}</Text>
                  <Text style={s.muted}>{resultSummary(a.detail)}</Text>
                  <Text style={s.small}>
                    {dateLabel(a.date)} · {timeLabel(a.date)}
                  </Text>
                </View>
                <Chip>{a.status}</Chip>
              </View>
            ))
          ) : (
            <Empty
              icon={Clock3}
              title="The beginning of something lighter"
              detail="Your actions and their results will be recorded here."
            />
          )}
        </Card>
      )}
      {filter === "review" && !actions.length && (
        <Card>
          <Empty
            icon={ShieldCheck}
            title="You’re all caught up"
            detail="When an email or calendar change needs your approval, it will appear here."
          />
        </Card>
      )}
    </View>
  );
}
export function ConnectionsScreen({ query = "" }: { query?: string }) {
  const { workspace: w, api, refresh, notify, navigate } = useWorkspace();
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function connect(capability: "read" | "write") {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{ url: string | null; connected?: boolean }>(
        "/api/google/connect",
        { capability },
      );
      if (result.url) {
        await Linking.openURL(result.url);
        notify("Finish connecting in your browser, then refresh your workspace.");
      } else {
        await refresh();
        notify("Local Google data is ready.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await api.request("/api/google/disconnect", {});
      await refresh();
      notify("Google disconnected.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const google = w.connections.find((c) => c.id === "google");
  const connected = google?.status === "connected" || google?.status === "sample";
  const rows = [
    {
      id: "profile",
      name: "Profile",
      icon: UserRound,
      color: colors.accent,
      connected: true,
      group: "profile",
    },
    { id: "gmail", name: "Gmail", icon: Mail, color: "#EA5B4D", connected, group: "google" },
    {
      id: "calendar",
      name: "Google Calendar",
      icon: CalendarDays,
      color: "#4285F4",
      connected,
      group: "google",
    },
    {
      id: "browser",
      name: "Browser",
      icon: Globe2,
      color: "#1987CF",
      connected: w.connections.some((c) => c.id === "browser" && c.status === "connected"),
      group: "browser",
    },
    {
      id: "models",
      name: "Models",
      icon: Cpu,
      color: colors.accent,
      connected: w.connections.some((c) => c.id === "models" && c.status === "connected"),
      group: "models",
    },
    {
      id: "openbot",
      name: "OpenBot",
      icon: Sparkles,
      color: "#6866A6",
      connected: false,
      group: "openbot",
    },
  ].filter((row) => `${row.name} ${row.group}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <View style={{ gap: 22 }}>
      {[true, false].map((isConnected) => {
        const group = rows.filter((row) => row.connected === isConnected);
        if (!group.length) return null;
        return (
          <View key={String(isConnected)} style={{ gap: 8 }}>
            <Text style={[s.small, { marginLeft: 12 }]}>
              {isConnected
                ? w.mode === "sample"
                  ? "Your connections"
                  : "Connected"
                : "Available integrations"}
            </Text>
            <View style={{ paddingHorizontal: 16, borderRadius: 23, backgroundColor: "#F3F4F5" }}>
              {group.map((row, index) => (
                <Pressable
                  key={row.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Manage ${row.name}`}
                  onPress={() =>
                    row.group === "browser" ? navigate("browser") : setSelected(row.group)
                  }
                  style={[
                    s.row,
                    {
                      gap: 14,
                      minHeight: 61,
                      borderBottomWidth: index < group.length - 1 ? 1 : 0,
                      borderBottomColor: "#E5E7E9",
                    },
                  ]}
                >
                  <View
                    style={{
                      width: 29,
                      height: 29,
                      borderRadius: 7,
                      backgroundColor: "#FFF",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <row.icon size={23} color={row.color} />
                  </View>
                  <Text style={[s.text, { flex: 1 }]}>{row.name}</Text>
                  {row.connected && row.group === "google" && w.mode === "sample" && (
                    <Text style={s.small}>Local data</Text>
                  )}
                  {row.connected ? (
                    <ChevronRight size={18} color="#A4A7AA" />
                  ) : (
                    <Text
                      style={{
                        fontSize: 13,
                        color: row.group === "google" ? colors.blueDark : colors.muted,
                      }}
                    >
                      {row.group === "google" ? "Connect" : "Setup"}
                    </Text>
                  )}
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
      {!rows.length && <Text style={s.muted}>No matching connectors.</Text>}
      {selected && (
        <Sheet
          title={
            selected === "google"
              ? "Google connections"
              : selected === "models"
                ? "Models"
                : selected === "profile"
                  ? "Profile"
                  : "OpenBot"
          }
          subtitle={
            selected === "google"
              ? google?.account
              : selected === "models"
                ? "One gateway for every model account"
                : selected === "profile"
                  ? "Your evidence locker"
                  : "Browser sessions for your agent"
          }
          onClose={() => setSelected(undefined)}
        >
          {selected === "models" ? (
            <ModelsSheet />
          ) : selected === "profile" ? (
            <ProfileSheet />
          ) : selected === "google" ? (
            <View style={{ gap: 18 }}>
              <Text style={s.muted}>
                Bring Gmail and Google Calendar into your conversations. Choose read access, then
                enable sending and editing when you need it.
              </Text>
              <View style={[s.row, { gap: 7, flexWrap: "wrap" }]}>
                {google?.capabilities.map((cap) => (
                  <Chip key={cap}>{capabilityLabel(cap)}</Chip>
                ))}
              </View>
              <ErrorNotice error={error} />
              <Button busy={busy} primary icon={Link2} onPress={() => void connect("read")}>
                Connect Google
              </Button>
              <Button busy={busy} onPress={() => void connect("write")}>
                Enable sending & editing
              </Button>
              {connected && (
                <Button busy={busy} danger onPress={() => void disconnect()}>
                  Disconnect Google
                </Button>
              )}
              <SettingsLine
                label="Environment"
                value={w.mode === "sample" ? "Local · example data" : "Live workspace"}
              />
              <SettingsLine
                label="Assistant"
                value={
                  w.runtime.provider === "sample"
                    ? "Guided workflows"
                    : w.runtime.configured
                      ? "Model connected"
                      : "Model not configured"
                }
              />
              <SettingsLine
                label="Rich Threads"
                value={w.runtime.richThreads ? "CopilotKit Intelligence" : "Not connected"}
              />
              <Button
                small
                icon={ArrowDownToLine}
                onPress={() => void refresh().catch((e) => setError(String(e)))}
              >
                Refresh connections
              </Button>
            </View>
          ) : (
            <View style={{ gap: 14 }}>
              <Text style={s.text}>
                The OpenBot adapter is available in this open-source project. A live OpenBot backend
                has not been configured.
              </Text>
              <Text style={s.muted}>
                Your browser uses OpenApply’s persistent Chromium worker. OpenBot integration will
                expand the execution backend while keeping this interface.
              </Text>
            </View>
          )}
        </Sheet>
      )}
    </View>
  );
}
interface ModelAccountSummary {
  provider: string;
  label: string;
  model_id: string;
  base_url?: string;
  auth_type: "api_key" | "oauth";
  connected_at: string;
}
/** A user-defined custom provider (Slice 15). There is no one-provider
 *  limit; each has its own id, base URL, and vault key. */
interface CustomProviderSummary {
  id: string;
  label: string;
  base_url: string;
  model_id: string;
  connected_at: string;
}
const apiKeyProviderOptions = [
  { id: "openai", label: "OpenAI", hint: "api.openai.com · GPT models" },
  { id: "anthropic", label: "Anthropic", hint: "api.anthropic.com · Claude models" },
  { id: "xai", label: "xAI", hint: "api.x.ai · Grok models" },
  { id: "google", label: "Google", hint: "generativelanguage.googleapis.com · Gemini models" },
];
const oauthProviderOptions = [
  { id: "chatgpt", label: "ChatGPT", hint: "Sign in with your ChatGPT plan" },
  { id: "grok", label: "Grok", hint: "Sign in with SuperGrok or X Premium+" },
];

/** Radio-style selectable row used for every provider pick in the Models sheet. */
function SelectRow({
  selected,
  label,
  hint,
  onPress,
}: {
  selected: boolean;
  label: string;
  hint?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={[s.selectRow, selected && { borderColor: colors.accent, backgroundColor: "#EFF4FE" }]}
    >
      <View style={[s.radio, selected && { borderColor: colors.accent }]}>
        {selected && <View style={[s.radioDot, { backgroundColor: colors.accent }]} />}
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={[s.text, { fontWeight: "600" }]}>{label}</Text>
        {!!hint && (
          <Text style={s.muted} numberOfLines={1}>
            {hint}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function ModelsSheet() {
  const { api, refresh, notify } = useWorkspace();
  const [accounts, setAccounts] = useState<ModelAccountSummary[]>([]);
  const [prefs, setPrefs] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [keyProvider, setKeyProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [keyModel, setKeyModel] = useState("");
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [manualModel, setManualModel] = useState(false);
  // Slice 15: user-defined custom providers. No one-provider limit.
  const [customProviders, setCustomProviders] = useState<CustomProviderSummary[]>([]);
  const [cpName, setCpName] = useState("");
  const [cpBaseUrl, setCpBaseUrl] = useState("");
  const [cpApiKey, setCpApiKey] = useState("");
  const [cpModel, setCpModel] = useState("");
  const [cpDiscovered, setCpDiscovered] = useState<string[] | null>(null);
  const [cpDiscovering, setCpDiscovering] = useState(false);
  const [cpManualModel, setCpManualModel] = useState(false);
  const [oauthCode, setOauthCode] = useState("");
  const [oauthProvider, setOauthProvider] = useState<string | null>(null);
  const [testResult, setTestResult] = useState("");
  // Image generation: works with connected API-key providers that expose an
  // OpenAI-style images endpoint, plus user-defined custom providers.
  const [imgProvider, setImgProvider] = useState("openai");
  const [imgPrompt, setImgPrompt] = useState("");
  const [imgModel, setImgModel] = useState("");
  const [imgSize, setImgSize] = useState("1024x1024");
  const [imgResult, setImgResult] = useState<{ b64_json: string; mime: string } | null>(null);
  const [imgBusy, setImgBusy] = useState(false);

  async function fetchModels() {
    setDiscovering(true);
    setError("");
    setNotice("");
    try {
      const result = await api.request<{ models: string[] }>("/api/models/discover", {
        provider: keyProvider,
        api_key: apiKey,
      });
      setDiscovered(result.models);
      setManualModel(false);
      if (result.models.length === 1) setKeyModel(result.models[0]);
      if (result.models.length === 0) setNotice("No models returned. Enter the model id manually.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscovering(false);
    }
  }

  function pickKeyProvider(id: string) {
    setKeyProvider(id);
    setDiscovered(null);
    setKeyModel("");
    setManualModel(false);
  }

  /** Test a custom endpoint's key: GET {base_url}/v1/models, nothing stored. */
  async function fetchCustomModels() {
    setCpDiscovering(true);
    setError("");
    setNotice("");
    try {
      const result = await api.request<{ models: string[] }>("/api/models/custom/test", {
        base_url: cpBaseUrl,
        api_key: cpApiKey,
      });
      setCpDiscovered(result.models);
      setCpManualModel(false);
      if (result.models.length === 1) setCpModel(result.models[0]);
      if (result.models.length === 0) setNotice("No models returned. Enter the model id manually.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCpDiscovering(false);
    }
  }

  function clearCustomForm() {
    setCpName("");
    setCpBaseUrl("");
    setCpApiKey("");
    setCpModel("");
    setCpDiscovered(null);
    setCpManualModel(false);
  }

  async function load() {
    try {
      const [models, preferences] = await Promise.all([
        api.request<{
          accounts: ModelAccountSummary[];
          custom_providers: CustomProviderSummary[];
        }>("/api/models"),
        api.request<Record<string, unknown>>("/api/preferences"),
      ]);
      setAccounts(models.accounts);
      setCustomProviders(models.custom_providers ?? []);
      setPrefs(preferences);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function run(label: string, work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await load();
      await refresh();
      if (label) notify(label);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  // Slice 15: tier selectors offer every connected provider — built-in
  // accounts plus all user-defined custom providers.
  const tierOptions: Array<{ id: string; label: string; model_id: string }> = [
    ...accounts.map((a) => ({ id: a.provider, label: a.label, model_id: a.model_id })),
    ...customProviders.map((p) => ({ id: p.id, label: p.label, model_id: p.model_id })),
  ];
  const setPref = (key: string) => (value: string) =>
    setPrefs((p) => ({ ...p, [key]: value === "" ? undefined : value }));

  return (
    <View style={{ gap: 22 }}>
      <ErrorNotice error={error} />
      {!!notice && <Text style={s.text}>{notice}</Text>}
      {!loaded ? (
        <ActivityIndicator />
      ) : (
        <>
          <View style={{ gap: 8 }}>
            <Text style={s.small}>Connected accounts</Text>
            {accounts.length === 0 && (
              <Text style={s.muted}>No model accounts yet. Connect one below.</Text>
            )}
            {accounts.map((account) => (
              <View key={account.provider} style={[s.row, { gap: 10 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={s.text}>{account.label}</Text>
                  <Text style={s.muted}>
                    {account.model_id} ·{" "}
                    {account.auth_type === "oauth" ? "account sign-in" : "API key"}
                  </Text>
                </View>
                <Button
                  small
                  danger
                  busy={busy}
                  onPress={() =>
                    void run("Disconnected.", () =>
                      api.request("/api/models/disconnect", { provider: account.provider }),
                    )
                  }
                >
                  Disconnect
                </Button>
              </View>
            ))}
          </View>

          <View style={{ gap: 10 }}>
            <Text style={s.small}>Custom providers</Text>
            <Text style={s.muted}>
              Add as many OpenAI-compatible endpoints as you like — Nebius, OpenRouter, your own lab
              server. Each gets its own name, base URL, and API key, and can back a tier or be
              picked in chat.
            </Text>
            {customProviders.length === 0 && <Text style={s.muted}>No custom providers yet.</Text>}
            {customProviders.map((provider) => (
              <View key={provider.id} style={[s.row, { gap: 10 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={s.text}>{provider.label}</Text>
                  <Text style={s.muted} numberOfLines={1}>
                    {provider.base_url} · {provider.model_id}
                  </Text>
                </View>
                <Button
                  small
                  danger
                  busy={busy}
                  onPress={() =>
                    void run("Custom provider deleted.", () =>
                      api.request("/api/models/disconnect", { provider: provider.id }),
                    )
                  }
                >
                  Delete
                </Button>
              </View>
            ))}
            <Field
              label="Provider name"
              value={cpName}
              onChangeText={setCpName}
              autoCapitalize="none"
              placeholder="e.g. Nebius Token Factory"
            />
            <Field
              label="Base URL"
              value={cpBaseUrl}
              onChangeText={setCpBaseUrl}
              autoCapitalize="none"
              placeholder="https://…"
            />
            <Field
              label="API key"
              value={cpApiKey}
              onChangeText={setCpApiKey}
              secureTextEntry
              autoCapitalize="none"
            />
            <Button
              busy={cpDiscovering}
              disabled={cpApiKey.length < 8 || !cpBaseUrl}
              icon={ListChecks}
              onPress={() => void fetchCustomModels()}
            >
              Test connection
            </Button>
            {cpDiscovered && cpDiscovered.length > 0 && !cpManualModel && (
              <View style={{ gap: 7 }}>
                <Text style={s.small}>Pick a model</Text>
                {cpDiscovered.map((id) => (
                  <SelectRow
                    key={id}
                    selected={cpModel === id}
                    label={id}
                    onPress={() => setCpModel(id)}
                  />
                ))}
                <Pressable onPress={() => setCpManualModel(true)}>
                  <Text style={[s.small, { color: colors.accent, fontWeight: "600" }]}>
                    Or enter a model id manually
                  </Text>
                </Pressable>
              </View>
            )}
            {(cpManualModel || !cpDiscovered) && (
              <Field
                label="Model id"
                value={cpModel}
                onChangeText={setCpModel}
                autoCapitalize="none"
                placeholder="e.g. nvidia/nemotron-3-nano-30b-a3b"
              />
            )}
            <Button
              busy={busy}
              primary
              icon={Link2}
              disabled={cpApiKey.length < 8 || !cpModel || !cpBaseUrl || !cpName.trim()}
              onPress={() =>
                run("Custom provider added.", () =>
                  api
                    .request("/api/models/custom/connect", {
                      label: cpName.trim(),
                      base_url: cpBaseUrl,
                      api_key: cpApiKey,
                      model_id: cpModel,
                    })
                    .then(() => clearCustomForm()),
                )
              }
            >
              Add custom provider
            </Button>
          </View>

          <View style={{ gap: 10 }}>
            <Text style={s.small}>Connect with an API key</Text>
            <View style={{ gap: 7 }}>
              {apiKeyProviderOptions.map((option) => (
                <SelectRow
                  key={option.id}
                  selected={keyProvider === option.id}
                  label={option.label}
                  hint={option.hint}
                  onPress={() => pickKeyProvider(option.id)}
                />
              ))}
            </View>
            <Field
              label="API key"
              value={apiKey}
              onChangeText={setApiKey}
              secureTextEntry
              autoCapitalize="none"
            />
            <Button
              busy={discovering}
              disabled={apiKey.length < 8}
              icon={ListChecks}
              onPress={() => void fetchModels()}
            >
              Fetch available models
            </Button>
            {discovered && discovered.length > 0 && !manualModel && (
              <View style={{ gap: 7 }}>
                <Text style={s.small}>Pick a model</Text>
                {discovered.map((id) => (
                  <SelectRow
                    key={id}
                    selected={keyModel === id}
                    label={id}
                    onPress={() => setKeyModel(id)}
                  />
                ))}
                <Pressable onPress={() => setManualModel(true)}>
                  <Text style={[s.small, { color: colors.accent, fontWeight: "600" }]}>
                    Or enter a model id manually
                  </Text>
                </Pressable>
              </View>
            )}
            {(manualModel || !discovered) && (
              <Field
                label="Model id"
                value={keyModel}
                onChangeText={setKeyModel}
                autoCapitalize="none"
                placeholder="e.g. gpt-5"
              />
            )}
            <Button
              busy={busy}
              primary
              icon={Link2}
              disabled={apiKey.length < 8 || !keyModel}
              onPress={() =>
                run("Model account connected.", () =>
                  api
                    .request<{ account: ModelAccountSummary }>("/api/models/connect", {
                      provider: keyProvider,
                      api_key: apiKey,
                      model_id: keyModel || undefined,
                    })
                    .then(() => {
                      setApiKey("");
                      setKeyModel("");
                      setDiscovered(null);
                      setManualModel(false);
                    }),
                )
              }
            >
              Connect API key
            </Button>
          </View>

          <View style={{ gap: 10 }}>
            <Text style={s.small}>Generate an image</Text>
            <Text style={s.muted}>
              Uses a connected API-key provider with an OpenAI-style images endpoint (OpenAI, xAI,
              or a custom provider). The key never leaves the server.
            </Text>
            <View style={{ gap: 7 }}>
              {[
                ...accounts
                  .filter((a) => ["openai", "xai", "openai-compatible"].includes(a.provider))
                  .map((a) => ({ id: a.provider, label: a.label })),
                ...customProviders.map((p) => ({ id: p.id, label: p.label })),
              ].map((option) => (
                <SelectRow
                  key={option.id}
                  selected={imgProvider === option.id}
                  label={option.label}
                  onPress={() => setImgProvider(option.id)}
                />
              ))}
            </View>
            <Field
              label="Prompt"
              value={imgPrompt}
              onChangeText={setImgPrompt}
              autoCapitalize="none"
              placeholder="A capybara filing paperwork at sunset"
            />
            <Field
              label="Image model (optional)"
              value={imgModel}
              onChangeText={setImgModel}
              autoCapitalize="none"
              placeholder="Defaults per provider, e.g. gpt-image-1"
            />
            <View style={{ gap: 7 }}>
              <Text style={s.small}>Size</Text>
              {["1024x1024", "1536x1024", "1024x1536"].map((size) => (
                <SelectRow
                  key={size}
                  selected={imgSize === size}
                  label={size}
                  onPress={() => setImgSize(size)}
                />
              ))}
            </View>
            {imgResult && (
              <Image
                source={{ uri: `data:${imgResult.mime};base64,${imgResult.b64_json}` }}
                style={{ width: 300, height: 300, borderRadius: 8 }}
                resizeMode="contain"
              />
            )}
            <Button
              busy={imgBusy}
              primary
              disabled={!imgPrompt.trim() || imgBusy}
              onPress={() =>
                void (async () => {
                  setImgBusy(true);
                  setError("");
                  try {
                    const result = await api.request<{ b64_json: string; mime: string }>(
                      "/api/models/image",
                      {
                        provider: imgProvider,
                        prompt: imgPrompt.trim(),
                        model: imgModel.trim() || undefined,
                        size: imgSize,
                      },
                    );
                    setImgResult(result);
                    notify("Image generated.");
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setImgBusy(false);
                  }
                })()
              }
            >
              Generate image
            </Button>
          </View>

          <View style={{ gap: 10 }}>
            <Text style={s.small}>Connect with your account</Text>
            <Text style={s.muted}>
              ChatGPT and Grok sign-in reuse the vendors' own CLI login flow. It works today but can
              break if they change it; an API key is the stable alternative.
            </Text>
            <View style={{ gap: 7 }}>
              {oauthProviderOptions.map((option) => (
                <SelectRow
                  key={option.id}
                  selected={oauthProvider === option.id}
                  label={option.label}
                  hint={option.hint}
                  onPress={() => setOauthProvider(option.id)}
                />
              ))}
            </View>
            {oauthProvider && (
              <>
                <Text style={s.muted}>
                  {oauthProviderOptions.find((o) => o.id === oauthProvider)?.hint}. After approving
                  in the browser, copy the code from the address bar and paste it here.
                </Text>
                <Button
                  busy={busy}
                  icon={ArrowUpRight}
                  onPress={() =>
                    run("", async () => {
                      const started = await api.request<{ url: string; state: string }>(
                        `/api/models/oauth/${oauthProvider}/start`,
                        {},
                      );
                      await Linking.openURL(started.url);
                      setPrefs((p) => ({ ...p, _oauth_state: started.state }));
                      setNotice("Browser opened. Paste the code from the address bar below.");
                    })
                  }
                >
                  Open sign-in
                </Button>
                <Field
                  label="Code from the browser"
                  value={oauthCode}
                  onChangeText={setOauthCode}
                  autoCapitalize="none"
                />
                <Button
                  busy={busy}
                  primary
                  onPress={() =>
                    run("Account connected.", async () => {
                      const state = String(prefs._oauth_state ?? "");
                      if (!state) throw new Error("Open the sign-in first.");
                      await api.request(`/api/models/oauth/${oauthProvider}/finish`, {
                        code: oauthCode,
                        state,
                      });
                      setOauthCode("");
                      setOauthProvider(null);
                    })
                  }
                >
                  Finish sign-in
                </Button>
              </>
            )}
          </View>

          <View style={{ gap: 10 }}>
            <Text style={s.small}>Tiers</Text>
            {(
              [
                ["cheap", "Cheap tier", "Classifiers, short agents"],
                ["strong", "Strong tier", "Resume, cover, statement packs"],
              ] as const
            ).map(([tier, title, hint]) => (
              <View key={tier} style={{ gap: 8 }}>
                <Text style={s.text}>{title}</Text>
                <Text style={s.muted}>{hint}</Text>
                <View style={{ gap: 7 }}>
                  {tierOptions.map((option) => (
                    <SelectRow
                      key={option.id}
                      selected={prefs[`${tier}_provider`] === option.id}
                      label={option.label}
                      hint={option.model_id}
                      onPress={() => setPref(`${tier}_provider`)(option.id)}
                    />
                  ))}
                  {tierOptions.length === 0 && (
                    <Text style={s.muted}>Connect an account first.</Text>
                  )}
                </View>
                <Field
                  label="Model override (optional)"
                  value={String(prefs[`${tier}_model`] ?? "")}
                  onChangeText={setPref(`${tier}_model`)}
                  autoCapitalize="none"
                />
              </View>
            ))}
            <Button
              busy={busy}
              onPress={() =>
                run("Tiers saved.", () =>
                  api.request(
                    "/api/preferences",
                    {
                      cheap_provider: prefs.cheap_provider,
                      cheap_model: prefs.cheap_model,
                      strong_provider: prefs.strong_provider,
                      strong_model: prefs.strong_model,
                    },
                    "PUT",
                  ),
                )
              }
            >
              Save tiers
            </Button>
            <View style={[s.row, { gap: 8 }]}>
              <Button
                small
                busy={busy}
                onPress={() =>
                  run("", async () => {
                    const result = await api.request<{
                      ok: boolean;
                      text?: string;
                      model_id?: string;
                      message?: string;
                    }>("/api/models/test", { tier: "cheap" });
                    setTestResult(
                      result.ok
                        ? `Cheap OK: ${result.model_id} replied “${result.text}”`
                        : `Cheap failed: ${result.message}`,
                    );
                  })
                }
              >
                Test cheap
              </Button>
              <Button
                small
                busy={busy}
                onPress={() =>
                  run("", async () => {
                    const result = await api.request<{
                      ok: boolean;
                      text?: string;
                      model_id?: string;
                      message?: string;
                    }>("/api/models/test", { tier: "strong" });
                    setTestResult(
                      result.ok
                        ? `Strong OK: ${result.model_id} replied “${result.text}”`
                        : `Strong failed: ${result.message}`,
                    );
                  })
                }
              >
                Test strong
              </Button>
            </View>
            {!!testResult && <Text style={s.text}>{testResult}</Text>}
          </View>

          <View style={{ gap: 10 }}>
            <Text style={s.small}>Budget</Text>
            <Field
              label="Strong model packs per cycle"
              value={String(prefs.max_strong_model_packs_per_cycle ?? 5)}
              onChangeText={setPref("max_strong_model_packs_per_cycle")}
              keyboardType="number-pad"
            />
            <Field
              label="Scan interval (hours, 6–24)"
              value={String(prefs.scan_interval_hours ?? 12)}
              onChangeText={setPref("scan_interval_hours")}
              keyboardType="number-pad"
            />
            <Field
              label="Job boards to scan (comma-separated)"
              value={
                Array.isArray(prefs.ats_boards)
                  ? prefs.ats_boards.join(", ")
                  : String(prefs.ats_boards ?? "")
              }
              onChangeText={setPref("ats_boards")}
            />
            <Text style={s.muted}>
              Format: greenhouse:&lt;board-token&gt; or lever:&lt;site-name&gt;. Add :&lt;Company
              label&gt; at the end for a nicer name, e.g. greenhouse:stripe:Stripe.
            </Text>
            <Text style={s.muted}>
              Strong matches notify you in the app inbox. Telegram alerts activate once you connect
              a bot token — ask Meyau to set it up.
            </Text>
            <Button
              busy={busy}
              onPress={() =>
                run("Preferences saved.", () =>
                  api.request(
                    "/api/preferences",
                    {
                      max_strong_model_packs_per_cycle:
                        Number(prefs.max_strong_model_packs_per_cycle) || 5,
                      scan_interval_hours: Number(prefs.scan_interval_hours) || 12,
                      ats_boards: String(prefs.ats_boards ?? "")
                        .split(",")
                        .map((b) => b.trim())
                        .filter(Boolean),
                    },
                    "PUT",
                  ),
                )
              }
            >
              Save preferences
            </Button>
          </View>
        </>
      )}
    </View>
  );
}
const EVIDENCE_KINDS = [
  { id: "resume", label: "Resume" },
  { id: "certificate", label: "Certificate" },
  { id: "transcript", label: "Transcript" },
  { id: "license", label: "License" },
  { id: "award", label: "Award" },
  { id: "portfolio", label: "Portfolio" },
  { id: "publication", label: "Publication" },
  { id: "recommendation", label: "Recommendation" },
  { id: "prior_statement", label: "Prior statement" },
  { id: "voice_sample", label: "Voice sample" },
];
const PICKER_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/zip",
];

interface ProfileEvidenceItem {
  id: string;
  kind: string;
  file_name: string;
  byte_size: number;
  confirmed: boolean;
  created_at: string;
  extraction?: { warnings: string[]; ocr: boolean };
}
interface ProfileFact {
  id: string;
  field: string;
  value: string;
  evidence_id: string;
  confirmed: boolean;
}
interface ProfileState {
  master_resume_id: string | null;
  evidence: ProfileEvidenceItem[];
  draft: {
    id: string;
    facts: ProfileFact[];
    evidence_ids: string[];
    updated_at: string;
  } | null;
  memory: Record<string, string>;
}

function kindLabel(kind: string): string {
  if (kind === "master_resume") return "Master resume";
  return EVIDENCE_KINDS.find((k) => k.id === kind)?.label ?? kind;
}

function ProfileSheet() {
  const { api, refresh, notify } = useWorkspace();
  const [profile, setProfile] = useState<ProfileState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [kind, setKind] = useState("certificate");
  const [factField, setFactField] = useState("");
  const [factValue, setFactValue] = useState("");
  const [factEvidence, setFactEvidence] = useState("");
  const [cvInterviewOpen, setCvInterviewOpen] = useState(false);

  async function load() {
    try {
      setProfile(await api.request<ProfileState>("/api/profile"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function run(label: string, work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await load();
      await refresh();
      if (label) notify(label);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function upload(uploadKind: string) {
    await run("", async () => {
      const result = await DocumentPicker.getDocumentAsync({
        type: PICKER_TYPES,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const file = result.assets[0];
      if (Platform.OS === "web") {
        if (!file.file)
          throw new Error("The selected file could not be read. Please choose it again.");
        const form = new FormData();
        form.append("file", file.file, file.name);
        form.append("kind", uploadKind);
        await api.request("/api/profile/upload", form);
      } else {
        const response = await FileSystem.uploadAsync(`${API_URL}/api/profile/upload`, file.uri, {
          httpMethod: "POST",
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: "file",
          mimeType: file.mimeType ?? "application/octet-stream",
          parameters: { kind: uploadKind },
          headers: { Authorization: `Bearer ${api.token}` },
        });
        const payload = JSON.parse(response.body);
        if (response.status < 200 || response.status >= 300)
          throw new Error(payload.error || "Could not upload this file.");
      }
      setNotice("Added to your draft. Confirm below to promote it to the locker.");
    });
  }

  const master = profile?.evidence.find((e) => e.kind === "master_resume") ?? null;
  const locker = (profile?.evidence ?? []).filter((e) => e.kind !== "master_resume");
  const draft = profile?.draft ?? null;
  const evidenceName = (id: string) =>
    profile?.evidence.find((e) => e.id === id)?.file_name ?? "evidence";

  return (
    <View style={{ gap: 22 }}>
      <ErrorNotice error={error} />
      {!!notice && <Text style={s.text}>{notice}</Text>}
      {!loaded || !profile ? (
        <ActivityIndicator />
      ) : (
        <>
          <View style={{ gap: 8 }}>
            <Text style={s.small}>Master resume</Text>
            {master ? (
              <Card>
                <View style={[s.row, { gap: 10 }]}>
                  <FileText size={18} color={colors.accent} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.text}>{master.file_name}</Text>
                    <Text style={s.muted}>Uploaded {dateLabel(master.created_at)}</Text>
                  </View>
                  <Chip>Immutable</Chip>
                </View>
              </Card>
            ) : (
              <Card>
                <Text style={[s.text, { marginBottom: 6 }]}>No master resume yet</Text>
                <Text style={[s.muted, { marginBottom: 12 }]}>
                  Upload the resume everything else is measured against. It can never be
                  overwritten.
                </Text>
                <Button primary icon={Upload} busy={busy} onPress={() => void upload("resume")}>
                  Upload master resume
                </Button>
                <View style={{ height: 8 }} />
                <Button busy={busy} onPress={() => setCvInterviewOpen(true)}>
                  No CV? Build one with an interview
                </Button>
              </Card>
            )}
          </View>
          {cvInterviewOpen && (
            <CvInterviewSheet
              onClose={() => {
                setCvInterviewOpen(false);
                void load();
              }}
            />
          )}

          <View style={{ gap: 8 }}>
            <Text style={s.small}>Add evidence</Text>
            <View style={[s.row, { gap: 7, flexWrap: "wrap" }]}>
              {EVIDENCE_KINDS.filter((k) => k.id !== "resume").map((k) => (
                <Pressable
                  key={k.id}
                  onPress={() => setKind(k.id)}
                  style={[
                    s.chip,
                    kind === k.id && { borderColor: colors.accent, backgroundColor: "#EFF4FE" },
                  ]}
                >
                  <Text style={[s.chipText, kind === k.id && { color: colors.accent }]}>
                    {k.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Button icon={Plus} busy={busy} onPress={() => void upload(kind)}>
              Upload {kindLabel(kind).toLowerCase()}
            </Button>
          </View>

          <View style={{ gap: 8 }}>
            <Text style={s.small}>Evidence locker</Text>
            {locker.length === 0 && (
              <Text style={s.muted}>Nothing here yet. Uploads land in your draft first.</Text>
            )}
            {locker.map((item) => (
              <Card key={item.id}>
                <View style={[s.row, { gap: 10 }]}>
                  <FileText size={18} color={colors.muted} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.text}>{item.file_name}</Text>
                    <Text style={s.muted}>{kindLabel(item.kind)}</Text>
                  </View>
                  <Chip tint={item.confirmed ? colors.green : colors.orange}>
                    {item.confirmed ? "Confirmed" : "Draft"}
                  </Chip>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Forget evidence"
                    onPress={() =>
                      void run("Evidence removed", () =>
                        api
                          .request(`/api/profile/evidence/${item.id}`, undefined, "DELETE")
                          .then(() => {}),
                      )
                    }
                    style={{ padding: 8 }}
                  >
                    <Trash2 size={17} color={colors.danger} />
                  </Pressable>
                </View>
                {item.extraction?.ocr === true && (
                  <Text style={[s.muted, { marginTop: 4 }]}>Text recovered by OCR</Text>
                )}
                {(item.extraction?.warnings ?? []).map((w) => (
                  <Text key={w} style={[s.muted, { color: colors.orange, marginTop: 2 }]}>
                    {w}
                  </Text>
                ))}
              </Card>
            ))}
          </View>

          {draft && (
            <View style={{ gap: 8 }}>
              <Text style={s.small}>Review draft</Text>
              <Text style={s.muted}>
                Nothing below is learned until you confirm. Each fact shows the evidence it came
                from.
              </Text>
              {draft.facts.length === 0 && (
                <Text style={s.muted}>No facts yet. Add one below or upload more evidence.</Text>
              )}
              {draft.facts.map((fact) => (
                <Card key={fact.id}>
                  <View style={[s.row, { gap: 10 }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.small, { textTransform: "uppercase" }]}>{fact.field}</Text>
                      <Text style={s.text}>{fact.value}</Text>
                      <Text style={s.muted}>from {evidenceName(fact.evidence_id)}</Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Remove fact"
                      onPress={() =>
                        void run("", () =>
                          api
                            .request(`/api/profile/facts/${fact.id}`, undefined, "DELETE")
                            .then(() => {}),
                        )
                      }
                      style={{ padding: 8 }}
                    >
                      <X size={16} color={colors.muted} />
                    </Pressable>
                  </View>
                </Card>
              ))}
              <Card>
                <View style={{ gap: 10 }}>
                  <Text style={s.text}>Add a fact</Text>
                  <Field label="Field" value={factField} onChangeText={setFactField} />
                  <Field label="Value" value={factValue} onChangeText={setFactValue} />
                  <View style={[s.row, { gap: 7, flexWrap: "wrap" }]}>
                    {(profile.evidence ?? []).map((e) => (
                      <Pressable
                        key={e.id}
                        onPress={() => setFactEvidence(e.id)}
                        style={[
                          s.chip,
                          factEvidence === e.id && {
                            borderColor: colors.accent,
                            backgroundColor: "#EFF4FE",
                          },
                        ]}
                      >
                        <Text
                          style={[s.chipText, factEvidence === e.id && { color: colors.accent }]}
                        >
                          {e.file_name}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <Button
                    icon={Plus}
                    busy={busy}
                    onPress={() =>
                      void run("", async () => {
                        if (!factEvidence)
                          throw new Error("Pick the evidence this fact comes from.");
                        await api.request("/api/profile/facts", {
                          field: factField,
                          value: factValue,
                          evidence_id: factEvidence,
                        });
                        setFactField("");
                        setFactValue("");
                      })
                    }
                  >
                    Add fact to draft
                  </Button>
                </View>
              </Card>
              <Button
                primary
                icon={ShieldCheck}
                busy={busy}
                onPress={() =>
                  void run("Profile confirmed", () =>
                    api.request("/api/profile/confirm", undefined, "POST").then(() => {}),
                  )
                }
              >
                Confirm &amp; promote to locker
              </Button>
            </View>
          )}

          {Object.keys(profile.memory).length > 0 && (
            <View style={{ gap: 8 }}>
              <Text style={s.small}>Confirmed memory</Text>
              {Object.entries(profile.memory).map(([field, value]) => (
                <View key={field} style={[s.row, { gap: 10 }]}>
                  <Check size={15} color={colors.accent} />
                  <Text style={s.muted}>{field}:</Text>
                  <Text style={[s.text, { flex: 1 }]}>{value}</Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
}
function SettingsLine({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={[
        s.between,
        { gap: 15, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line },
      ]}
    >
      <Text style={s.muted}>{label}</Text>
      <Text style={[s.text, { fontSize: 12, flexShrink: 1, textAlign: "right" }]}>{value}</Text>
    </View>
  );
}

function capabilityLabel(value: string) {
  const scope = value.split("/").at(-1) || value;
  const names: Record<string, string> = {
    "gmail.readonly": "Read Gmail",
    "gmail.send": "Send Gmail",
    "calendar.events.readonly": "Read calendar events",
    "calendar.calendarlist.readonly": "Read calendar list",
    "calendar.events": "Manage calendar events",
    "calendar.readonly": "Read calendars",
  };
  return names[scope] || scope;
}
