import {
  Bell,
  CalendarDays,
  ChevronRight,
  FileText,
  Globe2,
  ListChecks,
  Mail,
  Pause,
  Play,
  RefreshCw,
  X,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, Text, View } from "react-native";
import type { Artifact, BrowserSession } from "../../../packages/domain/src";
import type {
  AgentArtifact,
  AgentMemory,
  AgentTask,
  Evidence,
  RunEvent,
} from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { PacksScreen } from "./pack-review";
import { ActivityScreen, ConnectionsScreen } from "./screens";
import {
  Button,
  Card,
  CheckRow,
  Chip,
  colors,
  Empty,
  ErrorNotice,
  Field,
  LinkRow,
  Mascot,
  resultSummary,
  SectionHeading,
  Sheet,
  s,
} from "./ui";
import { useWorkspace } from "./workspace";

export function statusLabel(value: string) {
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
function stamp(value?: string) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not checked yet";
}
function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
function activeTask(task: AgentTask) {
  return !["succeeded", "failed", "cancelled"].includes(task.status);
}
export function AgentStatus() {
  const { data, error, refresh } = useAgentWorkspace();
  if (data?.worker.running && !error) return null;
  return (
    <View style={{ gap: 8 }}>
      <ErrorNotice error={error ? `Agent updates unavailable. ${error}` : ""} />
      {!!error && (
        <Button small onPress={() => void refresh().catch(() => {})}>
          Reconnect agent
        </Button>
      )}
      {!data && !error && <ActivityIndicator color={colors.blueDark} />}
      {data && !data.worker.running && (
        <Text style={s.small}>Worker is offline. Saved work will continue when it reconnects.</Text>
      )}
    </View>
  );
}
export function TaskCard({
  task,
  compact = false,
  onOpen,
}: {
  task: AgentTask;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const { open } = useWorkspace();
  const done = task.plan.filter((step) => step.status === "succeeded").length;
  const next = task.plan.find((step) => ["running", "waiting"].includes(step.status));
  const waiting = ["waiting_input", "waiting_approval"].includes(task.status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open task: ${task.title}`}
      onPress={() => {
        onOpen?.();
        open({ type: "task", taskId: task.id });
      }}
    >
      <Card
        style={{
          padding: compact ? 15 : 20,
          gap: 11,
          borderRadius: 22,
          backgroundColor: "#F0F1F2",
        }}
      >
        <View style={[s.row, { gap: 10 }]}>
          <View
            style={[
              s.iconBox,
              { width: 34, height: 34, backgroundColor: waiting ? colors.orange : colors.sky },
            ]}
          >
            <ListChecks size={18} color={colors.blueDark} />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.heading}>{task.title}</Text>
            <Text style={s.small}>
              {statusLabel(task.status)}
              {task.plan.length ? ` · ${done}/${task.plan.length} steps` : ""}
            </Text>
          </View>
          <ChevronRight size={17} color={colors.muted} />
        </View>
        {!!task.plan.length && (
          <View style={{ height: 4, backgroundColor: colors.line, borderRadius: 4 }}>
            <View
              style={{
                height: 4,
                width: `${Math.round((done / task.plan.length) * 100)}%`,
                backgroundColor: "#6AAEE0",
                borderRadius: 4,
              }}
            />
          </View>
        )}
        {(task.question || task.result || task.error || next?.title) && (
          <Text numberOfLines={compact ? 2 : 4} style={s.muted}>
            {task.question || task.error || resultSummary(task.result || next?.title || "")}
          </Text>
        )}
        {waiting && (
          <Text style={[s.small, { color: colors.blueDark, fontWeight: "600" }]}>
            {task.status === "waiting_approval" ? "Review requested" : "Your input is needed"}
          </Text>
        )}
      </Card>
    </Pressable>
  );
}
export function ChatWork() {
  const { data } = useAgentWorkspace();
  const tasks = [...(data?.tasks || [])]
    .filter(activeTask)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 2);
  if (!tasks.length) return null;
  return (
    <View style={{ gap: 10 }}>
      {tasks.map((task) => (
        <TaskCard task={task} key={task.id} compact />
      ))}
    </View>
  );
}
export function AgentActivityScreen() {
  const { data } = useAgentWorkspace();
  const [filter, setFilter] = useState("All");
  const tasks = [...(data?.tasks || [])]
    .filter(
      (task) =>
        filter === "All" || (filter === "In progress" ? activeTask(task) : !activeTask(task)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <View style={{ gap: 20 }}>
      <AgentStatus />
      <View style={[s.row, { gap: 8 }]}>
        {["All", "In progress", "Finished"].map((item) => (
          <Button key={item} small primary={filter === item} onPress={() => setFilter(item)}>
            {item}
          </Button>
        ))}
      </View>
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} />
      ))}
      {!tasks.length && (
        <Empty
          icon={ListChecks}
          title="A place for the work"
          detail="Delegate a task in Chat. Its plan, progress and results stay here."
        />
      )}
      <SectionHeading title="Reviews & receipts" />
      <ActivityScreen />
    </View>
  );
}
export function EvidenceList({ items }: { items: Evidence[] }) {
  const { workspace, open } = useWorkspace();
  const [error, setError] = useState("");
  return (
    <View style={{ gap: 10 }}>
      {items.map((item) => (
        <View
          key={item.id}
          style={{ borderLeftWidth: 2, borderLeftColor: colors.blue, paddingLeft: 12, gap: 4 }}
        >
          <Text style={[s.small, { color: colors.text, fontWeight: "600" }]}>{item.title}</Text>
          <Text selectable style={s.small}>
            {item.excerpt}
          </Text>
          {item.url && /^https?:\/\//i.test(item.url) && (
            <Button
              small
              onPress={() =>
                void Linking.openURL(item.url || "").catch((e) => setError(errorText(e)))
              }
            >
              Open source
            </Button>
          )}
          {item.kind === "mail" && workspace.mail.some((mail) => mail.id === item.id) && (
            <Button
              small
              onPress={() => {
                const mail = workspace.mail.find((m) => m.id === item.id);
                if (mail) open({ type: "mail", mail });
              }}
            >
              View email
            </Button>
          )}
          {item.kind === "file" && workspace.files.some((file) => file.id === item.id) && (
            <Button
              small
              onPress={() => {
                const file = workspace.files.find((f) => f.id === item.id);
                if (file) open({ type: "file", file });
              }}
            >
              View file
            </Button>
          )}
        </View>
      ))}
      <ErrorNotice error={error} />
    </View>
  );
}
export function TaskDetail({ taskId }: { taskId: string }) {
  const { api, workspace, close, open, refresh: refreshWorkspace } = useWorkspace();
  const { data, mutate } = useAgentWorkspace();
  const [detail, setDetail] = useState<{
    task: AgentTask;
    events: RunEvent[];
    artifacts: AgentArtifact[];
    files: Artifact[];
    browsers: BrowserSession[];
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [fieldJson, setFieldJson] = useState("");
  const [showFieldJson, setShowFieldJson] = useState(false);
  const [fields, setFields] = useState<Record<string, string | boolean>>({});
  const task = data?.tasks.find((item) => item.id === taskId) || detail?.task;
  useEffect(() => {
    let active = true;
    void api
      .request<{
        task: AgentTask;
        events: RunEvent[];
        artifacts: AgentArtifact[];
        files: Artifact[];
        browsers: BrowserSession[];
      }>(`/api/agent/tasks/${taskId}`)
      .then((result) => {
        if (active) {
          setDetail(result);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [api, taskId, task?.updatedAt]);
  async function act(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/tasks/${taskId}/${path}`, body);
      if (path === "input") {
        setAnswer("");
        setFields({});
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function submitInput() {
    try {
      let parsed: Record<string, string | boolean> = fields;
      if (fieldJson.trim()) {
        const raw: unknown = JSON.parse(fieldJson);
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          Object.values(raw).some(
            (value) => typeof value !== "string" && typeof value !== "boolean",
          )
        )
          throw new Error("Form fields must be a JSON object with text or true/false values.");
        parsed = raw as Record<string, string | boolean>;
      }
      await act("input", {
        answer: answer.trim() || "Provided the requested fields.",
        fields: parsed,
      });
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function review() {
    setBusy(true);
    setError("");
    try {
      await refreshWorkspace();
      const snapshot = await api.request<typeof workspace>("/api/workspace");
      const action = snapshot.actions.find((item) => item.id === task?.actionId);
      if (!action) throw new Error("This review is not available yet. Refresh and try again.");
      open({ type: "review", action });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const missing = Array.isArray(task?.state.missingFields) ? task.state.missingFields : [];
  const fieldNames = missing
    .map((field) =>
      typeof field === "string"
        ? field
        : typeof field === "object" && field && "name" in field
          ? String(field.name)
          : "",
    )
    .filter(Boolean);
  return (
    <Sheet
      title={task?.title || "Task"}
      subtitle={
        task ? `${statusLabel(task.status)} · ${stamp(task.updatedAt)}` : "Loading saved progress…"
      }
      onClose={close}
    >
      <ErrorNotice error={error} />
      {!task ? (
        <ActivityIndicator color={colors.blueDark} />
      ) : (
        <View style={{ gap: 20 }}>
          <Text selectable style={s.text}>
            {task.prompt}
          </Text>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {["queued", "running", "scheduled", "waiting_input", "waiting_approval"].includes(
              task.status,
            ) && (
              <Button
                small
                icon={Pause}
                busy={busy}
                onPress={() => void act("control", { action: "pause" })}
              >
                Pause
              </Button>
            )}
            {task.status === "paused" && (
              <Button
                small
                icon={Play}
                busy={busy}
                onPress={() => void act("control", { action: "resume" })}
              >
                Resume
              </Button>
            )}
            {task.status === "failed" && (
              <Button
                small
                icon={RefreshCw}
                busy={busy}
                onPress={() => void act("control", { action: "retry" })}
              >
                Retry task
              </Button>
            )}
            {activeTask(task) && (
              <Button
                small
                danger
                icon={X}
                busy={busy}
                onPress={() => void act("control", { action: "cancel" })}
              >
                Cancel task
              </Button>
            )}
          </View>
          {task.status === "waiting_approval" && (
            <Card style={{ backgroundColor: colors.lavender, gap: 12 }}>
              <Text style={s.heading}>Ready for your review</Text>
              <Text style={s.muted}>Review the exact action and account before it proceeds.</Text>
              <Button primary busy={busy} onPress={() => void review()}>
                Review action
              </Button>
            </Card>
          )}
          {task.status === "waiting_input" && (
            <Card style={{ backgroundColor: colors.sky, gap: 10 }}>
              <Text style={s.heading}>{task.question || "A detail from you will help"}</Text>
              {fieldNames.map((name) =>
                missing.some(
                  (f) => typeof f === "object" && f && f.name === name && f.type === "checkbox",
                ) ? (
                  <CheckRow
                    key={name}
                    label={name.replace(/_/g, " ")}
                    checked={Boolean(fields[name])}
                    onPress={() => setFields((current) => ({ ...current, [name]: !current[name] }))}
                  />
                ) : (
                  <Field
                    key={name}
                    label={name.replace(/_/g, " ")}
                    value={String(fields[name] ?? "")}
                    onChangeText={(value) =>
                      setFields((current) => ({ ...current, [name]: value }))
                    }
                  />
                ),
              )}
              {!fieldNames.length && (
                <Field
                  label="Your answer"
                  value={answer}
                  onChangeText={setAnswer}
                  multiline
                  placeholder="Add the missing details…"
                />
              )}
              {task.kind === "document" && !fieldNames.length && (
                <>
                  <Button small onPress={() => setShowFieldJson(!showFieldJson)}>
                    Form field values
                  </Button>
                  {showFieldJson && (
                    <Field
                      label="Fields (JSON: field name to value)"
                      value={fieldJson}
                      onChangeText={setFieldJson}
                      multiline
                      autoCapitalize="none"
                      placeholder={'{"full_name":"Your name","consent":true}'}
                    />
                  )}
                </>
              )}
              <Button
                primary
                busy={busy}
                disabled={!answer.trim() && !Object.keys(fields).length && !fieldJson.trim()}
                onPress={() => void submitInput()}
              >
                Continue task
              </Button>
            </Card>
          )}
          {!!task.plan.length && (
            <Card style={{ gap: 15 }}>
              <Text style={s.heading}>Plan</Text>
              {task.plan.map((step, index) => (
                <View key={step.id} style={[s.row, { gap: 10, alignItems: "flex-start" }]}>
                  <Text
                    style={[
                      s.text,
                      { color: step.status === "succeeded" ? colors.blueDark : colors.muted },
                    ]}
                  >
                    {step.status === "succeeded" ? "✓" : `${index + 1}.`}
                  </Text>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={s.text}>{step.title}</Text>
                    <Text style={s.small}>
                      {statusLabel(step.status)}
                      {step.detail ? ` · ${step.detail}` : ""}
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
          )}
          {!!task.result && (
            <Card style={{ backgroundColor: colors.green }}>
              <Text selectable style={s.text}>
                {resultSummary(task.result)}
              </Text>
            </Card>
          )}
          <ErrorNotice error={task.error ?? undefined} />
          {detail?.browsers?.map((browser) => (
            <Card key={browser.id} style={{ gap: 10 }}>
              <Text style={s.heading}>{browser.title || "Agent browser"}</Text>
              <Text style={s.small}>{browser.url}</Text>
              {browser.status === "active" && browser.previewUrl && (
                <Image
                  accessibilityLabel="Agent browser preview"
                  source={{ uri: api.url(browser.previewUrl) }}
                  style={{ width: "100%", aspectRatio: 1.6, borderRadius: 12 }}
                />
              )}
              <Button
                small
                busy={busy}
                onPress={() => {
                  setBusy(true);
                  void (async () => {
                    try {
                      if (["running", "scheduled", "queued"].includes(task.status))
                        await mutate(`/tasks/${taskId}/control`, { action: "pause" });
                      open({ type: "browser", browser });
                    } catch (error) {
                      setError(errorText(error));
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              >
                {["running", "scheduled", "queued"].includes(task.status)
                  ? "Pause and open browser"
                  : "Open browser"}
              </Button>
            </Card>
          ))}
          {detail?.files?.map((file) => (
            <LinkRow
              key={file.id}
              title={file.name}
              detail={`${file.pageCount} pages · PDF`}
              icon={FileText}
              onPress={() => open({ type: "file", file })}
            />
          ))}
          {(
            data?.artifacts.filter((artifact) => artifact.taskId === taskId) ||
            detail?.artifacts ||
            []
          ).map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
          {!!task.evidence.length && (
            <View style={{ gap: 14 }}>
              <Text style={s.heading}>Sources</Text>
              <EvidenceList items={task.evidence} />
            </View>
          )}
          <Text style={s.heading}>Timeline</Text>
          {detail?.events.map((event) => (
            <View
              key={event.id}
              style={{ gap: 4, paddingLeft: 14, borderLeftWidth: 2, borderLeftColor: colors.line }}
            >
              <Text style={s.small}>
                {stamp(event.date)} · {statusLabel(event.kind)}
              </Text>
              <Text style={s.text}>{event.title}</Text>
              <Text selectable style={s.muted}>
                {event.detail}
              </Text>
            </View>
          ))}
          {!detail?.events.length && (
            <Text style={s.muted}>The worker will record each step here.</Text>
          )}
        </View>
      )}
    </Sheet>
  );
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function display(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : value === null
        ? "—"
        : JSON.stringify(value, null, 2) || "";
}
export function ArtifactCard({ artifact }: { artifact: AgentArtifact }) {
  const [expanded, setExpanded] = useState(false);
  const rows = Object.entries(artifact.data);
  return (
    <Card style={{ gap: 13, backgroundColor: colors.card }}>
      <View style={s.between}>
        <Text style={s.heading}>{artifact.title}</Text>
        <Chip>{statusLabel(artifact.kind)}</Chip>
      </View>
      <Text selectable style={s.muted}>
        {artifact.summary}
      </Text>
      {(expanded ? rows : rows.slice(0, 4)).map(([key, value]) => (
        <View key={key} style={{ gap: 6 }}>
          <Text style={s.label}>{key.replace(/_/g, " ")}</Text>
          {Array.isArray(value) ? (
            value.slice(0, expanded ? 100 : 5).map((item) => {
              const row = record(item);
              return (
                <View
                  key={`${key}-${display(row?.id ?? item)}`}
                  style={{
                    paddingVertical: 8,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.line,
                  }}
                >
                  <Text selectable style={s.text}>
                    {row
                      ? Object.entries(row)
                          .map(([name, val]) => `${name}: ${display(val)}`)
                          .join(" · ")
                      : display(item)}
                  </Text>
                </View>
              );
            })
          ) : record(value) ? (
            Object.entries(record(value) || {}).map(([name, val]) => (
              <View key={name} style={s.between}>
                <Text style={s.muted}>{name}</Text>
                <Text selectable style={s.text}>
                  {display(val)}
                </Text>
              </View>
            ))
          ) : (
            <Text selectable style={[s.text, { fontSize: typeof value === "number" ? 24 : 14 }]}>
              {display(value)}
            </Text>
          )}
        </View>
      ))}
      <Button small onPress={() => setExpanded(!expanded)}>
        {expanded ? "Show summary" : "Explore full result"}
      </Button>
    </Card>
  );
}
export function DelegateSheet() {
  const { workspace, close, open } = useWorkspace();
  const { delegate } = useAgentWorkspace();
  const [kind, setKind] = useState<AgentTask["kind"]>("plan");
  const [prompt, setPrompt] = useState("");
  const [messageId, setMessageId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const task = await delegate({
        prompt: prompt.trim(),
        kind,
        input: kind === "document" ? { messageId } : {},
      });
      open({ type: "task", taskId: task.id });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Hand over an outcome"
      subtitle="OpenApply saves a plan and keeps working on the server."
      onClose={close}
    >
      <View style={[s.row, { flexWrap: "wrap", gap: 8, marginBottom: 20 }]}>
        {(["plan", "document", "agent"] as const).map((item) => (
          <Button small primary={kind === item} key={item} onPress={() => setKind(item)}>
            {item === "agent" ? "General task" : statusLabel(item)}
          </Button>
        ))}
      </View>
      <Field
        label="What would you like done?"
        value={prompt}
        onChangeText={setPrompt}
        multiline
        placeholder={
          kind === "document"
            ? "Fill the attached form and prepare a reply for my review"
            : "Make a practical plan for my week"
        }
      />
      {kind === "document" && (
        <View style={{ gap: 8, marginBottom: 18 }}>
          <Text style={s.heading}>Choose the email with the PDF</Text>
          {workspace.mail
            .filter((mail) => mail.attachments.length)
            .map((mail) => (
              <CheckRow
                key={mail.id}
                checked={mail.id === messageId}
                label={`${mail.subject} · ${mail.sender}`}
                onPress={() => setMessageId(mail.id)}
              />
            ))}
          {!workspace.mail.some((mail) => mail.attachments.length) && (
            <Text style={s.muted}>
              Connect mail in Apps and select a message with a PDF attachment.
            </Text>
          )}
        </View>
      )}
      {kind === "agent" && !workspace.runtime.configured && (
        <Text style={[s.muted, { marginBottom: 16 }]}>
          General tasks and plans require a configured model. Document jobs and page watches have
          guided workflows.
        </Text>
      )}
      <ErrorNotice error={error} />
      <Button
        primary
        busy={busy}
        disabled={!prompt.trim() || (kind === "document" && !messageId)}
        onPress={() => void submit()}
      >
        Delegate task
      </Button>
    </Sheet>
  );
}
export function NotificationsSheet() {
  const { data, mutate } = useAgentWorkspace();
  const { close, open } = useWorkspace();
  const [error, setError] = useState("");
  async function read(id: string, taskId?: string) {
    try {
      await mutate(`/notifications/${id}/read`, {});
      if (taskId) open({ type: "task", taskId });
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <Sheet
      title="Notifications"
      subtitle="Results and decisions that need your attention."
      onClose={close}
    >
      <View style={{ gap: 14 }}>
        <ErrorNotice error={error} />
        {data?.notifications.map((item) => (
          <Card
            key={item.id}
            style={{ gap: 8, backgroundColor: item.read ? colors.card : colors.sky }}
          >
            <View style={s.between}>
              <Text style={s.heading}>{item.title}</Text>
              {!item.read && <Chip>New</Chip>}
            </View>
            <Text style={s.muted}>{item.body}</Text>
            <Text style={s.small}>{stamp(item.createdAt)}</Text>
            <Button small onPress={() => void read(item.id, item.taskId)}>
              {item.taskId ? "View task" : item.read ? "Read" : "Mark read"}
            </Button>
          </Card>
        ))}
        {!data?.notifications.length && (
          <Empty
            icon={Bell}
            title="You're all caught up"
            detail="Results, meaningful changes and requests for your input will appear here."
          />
        )}
      </View>
    </Sheet>
  );
}
export function AppsScreen() {
  const { navigate } = useWorkspace();
  const { data, mutate } = useAgentWorkspace();
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(false);
  const [name, setName] = useState(data?.identity.name || "OpenApply");
  const [tone, setTone] = useState(data?.identity.tone || "warm");
  const [avatar, setAvatar] = useState(data?.identity.avatar || "sky");
  const [showChatUpdates, setShowChatUpdates] = useState(data?.identity.showChatUpdates !== false);
  const [memory, setMemory] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data?.identity) {
      setName(data.identity.name);
      setTone(data.identity.tone);
      setAvatar(data.identity.avatar || "sky");
      setShowChatUpdates(data.identity.showChatUpdates !== false);
    }
  }, [
    data?.identity.name,
    data?.identity.tone,
    data?.identity.avatar,
    data?.identity.showChatUpdates,
  ]);
  async function save(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await mutate(path, body);
      if (path === "/memories") setMemory("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const shortcuts = [
    {
      section: "mail" as const,
      title: "Mail",
      detail: "Read messages and prepare replies",
      icon: Mail,
    },
    {
      section: "calendar" as const,
      title: "Calendar",
      detail: "Events and reviewed invitations",
      icon: CalendarDays,
    },
    {
      section: "browser" as const,
      title: "Browser",
      detail: "Persistent browser sessions",
      icon: Globe2,
    },
    {
      section: "files" as const,
      title: "Files",
      detail: "PDFs, forms and filled copies",
      icon: FileText,
    },
  ];
  return (
    <View style={{ gap: 22 }}>
      <AgentStatus />
      <Field
        label="Search apps"
        value={query}
        onChangeText={setQuery}
        placeholder="Search connectors"
      />
      <ConnectionsScreen query={query} />
      <Text style={s.heading}>Shortcuts</Text>
      <Card style={{ paddingVertical: 3, backgroundColor: "#F4F5F6" }}>
        {shortcuts
          .filter((item) =>
            `${item.title} ${item.detail}`.toLowerCase().includes(query.toLowerCase()),
          )
          .map((item) => (
            <LinkRow
              key={item.section}
              icon={item.icon}
              title={item.title}
              detail={item.detail}
              onPress={() => navigate(item.section)}
            />
          ))}
      </Card>
      <PacksScreen />
      <Button onPress={() => setSettings(!settings)}>
        {settings ? "Close agent settings" : "Personality & memory"}
      </Button>
      {settings && (
        <>
          <Card style={{ gap: 10 }}>
            <SectionHeading title="Your agent" />
            <View style={[s.row, { gap: 16, justifyContent: "center", marginBottom: 12 }]}>
              {(["sky", "sand", "lilac"] as const).map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="radio"
                  accessibilityLabel={`${statusLabel(item)} avatar`}
                  accessibilityState={{ checked: avatar === item }}
                  onPress={() => setAvatar(item)}
                  style={{
                    padding: 7,
                    borderRadius: 24,
                    backgroundColor: avatar === item ? colors.sky : colors.canvas,
                  }}
                >
                  <Mascot size={62} variant={item} />
                </Pressable>
              ))}
            </View>
            <Field label="Name" value={name} onChangeText={setName} />
            <View style={[s.row, { gap: 8 }]}>
              {(["warm", "concise", "thoughtful"] as const).map((item) => (
                <Button key={item} small primary={tone === item} onPress={() => setTone(item)}>
                  {statusLabel(item)}
                </Button>
              ))}
            </View>
            <CheckRow
              label="Show background updates in chat"
              checked={showChatUpdates}
              onPress={() => setShowChatUpdates(!showChatUpdates)}
            />
            <Text style={s.small}>
              Activity and notifications always keep the full record, including requests for
              approval.
            </Text>
            <Button
              busy={busy}
              disabled={!name.trim()}
              onPress={() =>
                void save("/identity", { name: name.trim(), tone, avatar, showChatUpdates })
              }
            >
              Save preferences
            </Button>
          </Card>
          <Card style={{ gap: 12 }}>
            <SectionHeading title="Memory" />
            <Text style={s.muted}>Context you can inspect, correct or forget.</Text>
            {data?.memories.map((item) => (
              <MemoryRow key={item.id} memory={item} />
            ))}
            <Field
              label="Remember something about me"
              value={memory}
              onChangeText={setMemory}
              placeholder="I prefer morning meetings"
            />
            <Button
              busy={busy}
              disabled={!memory.trim()}
              onPress={() =>
                void save("/memories", { text: memory.trim(), source: "User added in Apps" })
              }
            >
              Remember
            </Button>
          </Card>
        </>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}
function MemoryRow({ memory }: { memory: AgentMemory }) {
  const { mutate } = useAgentWorkspace();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(forget: boolean) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/memories/${memory.id}${forget ? "/forget" : ""}`, forget ? {} : { text });
      setEditing(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View
      style={{ gap: 8, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: colors.line }}
    >
      {editing ? (
        <Field label="Memory" value={text} onChangeText={setText} />
      ) : (
        <Text style={s.text}>{memory.text}</Text>
      )}
      <Text style={s.small}>
        {memory.source} · {stamp(memory.createdAt)}
      </Text>
      <View style={[s.row, { gap: 8 }]}>
        {editing ? (
          <Button small busy={busy} disabled={!text.trim()} onPress={() => void act(false)}>
            Save correction
          </Button>
        ) : (
          <Button small onPress={() => setEditing(true)}>
            Edit
          </Button>
        )}
        <Button small danger busy={busy} onPress={() => void act(true)}>
          Forget
        </Button>
      </View>
      <ErrorNotice error={error} />
    </View>
  );
}
