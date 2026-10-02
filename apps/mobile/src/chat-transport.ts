import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import type { MuseApi } from "./api";

/* ------------------------------------------------------------------ */
/* Message shapes                                                      */
/*                                                                     */
/* These mirror the AG-UI message shapes the UI consumed from the      */
/* CopilotKit headless hooks (`Message`, `ToolMessage`, `ToolCall`),   */
/* so every render call site keeps working unchanged.                  */
/* ------------------------------------------------------------------ */

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatUserMessage {
  id: string;
  role: "user";
  content: string;
}

export interface ChatAssistantMessage {
  id: string;
  role: "assistant";
  content: string;
  toolCalls?: ChatToolCall[];
}

export interface ChatToolMessage {
  id: string;
  role: "tool";
  content: string;
  toolCallId: string;
}

export type ChatMessage = ChatUserMessage | ChatAssistantMessage | ChatToolMessage;

export interface ChatProviderSelection {
  provider: string;
  model: string;
}

export interface ApprovalRequest {
  runId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/* ------------------------------------------------------------------ */
/* Tool renderer registry (replaces useRenderTool / useRenderToolCall)  */
/*                                                                     */
/* The UI registers display-only renderers per tool name; the chat     */
/* screen looks them up per tool call. Registration is module-level    */
/* (like the old provider registry) so renderers survive unmount and   */
/* history keeps rendering. The tools themselves live on the server.   */
/* ------------------------------------------------------------------ */

export type ToolRenderStatus = "inProgress" | "executing" | "complete";

export interface ToolRenderProps<T = Record<string, unknown>> {
  name: string;
  toolCallId: string;
  args: T;
  status: ToolRenderStatus;
  result: string | undefined;
}

export interface RenderToolOptions<T extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description?: string;
  parameters?: unknown;
  render: (props: ToolRenderProps<Partial<T>>) => ReactElement | null;
}

type RegisteredRender = (props: ToolRenderProps) => ReactElement | null;
const toolRenderers = new Map<string, RegisteredRender>();

export function useRenderTool<T extends Record<string, unknown> = Record<string, unknown>>(
  options: RenderToolOptions<T>,
): void {
  const { name, render } = options;
  // Re-register on every render so the latest closure is always used.
  useEffect(() => {
    toolRenderers.set(name, render as RegisteredRender);
  }, [name, render]);
}

export function useRenderToolCall(): (props: {
  toolCall: ChatToolCall;
  toolMessage?: ChatToolMessage;
}) => ReactElement | null {
  return useCallback(({ toolCall, toolMessage }) => {
    const render = toolRenderers.get(toolCall.function.name);
    if (!render) return null;
    return render({
      name: toolCall.function.name,
      toolCallId: toolCall.id,
      args: parsePartialJson(toolCall.function.arguments),
      status: toolMessage ? "complete" : "inProgress",
      result: toolMessage?.content,
    });
  }, []);
}

/** Tolerant JSON parse for still-streaming tool arguments. */
function parsePartialJson(text: string): Record<string, unknown> {
  if (!text?.trim()) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    // fall through to the completion attempt below
  }
  // Close truncated JSON, then progressively trim the tail until it parses.
  let candidate = text;
  for (let attempt = 0; attempt < 400 && candidate.trim(); attempt++) {
    try {
      const value = JSON.parse(closeJson(candidate)) as unknown;
      if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
      return {};
    } catch {
      candidate = candidate.slice(0, -1);
    }
  }
  return {};
}

/** Append the closers for any brackets/quotes left open in truncated JSON. */
function closeJson(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      stack.push("}");
    } else if (ch === "[") {
      stack.push("]");
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    }
  }
  let out = text;
  if (inString) out += '"';
  while (stack.length) out += stack.pop();
  return out;
}

/* ------------------------------------------------------------------ */
/* SSE plumbing                                                        */
/*                                                                     */
/* Expo web streams through fetch + ReadableStream; React Native's     */
/* fetch has no streaming body, so native uses XMLHttpRequest with     */
/* onprogress, the standard RN approach for SSE.                       */
/* ------------------------------------------------------------------ */

type AgUiEvent = Record<string, unknown>;

function createSseParser(onEvent: (event: AgUiEvent) => void) {
  let buffer = "";
  function handleLine(line: string) {
    if (!line || line.startsWith(":")) return; // comment / heartbeat
    if (!line.startsWith("data:")) return; // event:/id:/retry: lines carry no payload
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      onEvent(JSON.parse(payload) as AgUiEvent);
    } catch {
      // ignore malformed lines; the stream stays usable
    }
  }
  return {
    push(text: string) {
      buffer += text;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        handleLine(line);
        index = buffer.indexOf("\n");
      }
    },
    flush() {
      const rest = buffer.trim();
      buffer = "";
      if (rest) handleLine(rest);
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "Aborted");
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

async function httpError(response: Response): Promise<Error> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string") return new Error(payload.error);
  } catch {
    // fall through
  }
  return new Error(`Request failed (${response.status})`);
}

function readXhrChunks(opts: {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  onText: (text: string) => void;
}): Promise<{ status: number; errorText: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let seen = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener("abort", onAbort);
      fn();
    };
    const emit = () => {
      const text = xhr.responseText ?? "";
      if (text.length > seen) {
        opts.onText(text.slice(seen));
        seen = text.length;
      }
    };
    function onAbort() {
      finish(() => {
        try {
          xhr.abort();
        } catch {
          // ignore
        }
        resolve({ status: 0, errorText: "" });
      });
    }
    xhr.open("POST", opts.url);
    for (const [key, value] of Object.entries(opts.headers)) xhr.setRequestHeader(key, value);
    xhr.onprogress = emit;
    xhr.onload = () => {
      emit();
      finish(() => resolve({ status: xhr.status, errorText: xhr.responseText ?? "" }));
    };
    xhr.onerror = () => finish(() => reject(new Error("Network request failed")));
    xhr.ontimeout = () => finish(() => reject(new Error("Request timed out")));
    opts.signal.addEventListener("abort", onAbort, { once: true });
    if (opts.signal.aborted) {
      onAbort();
      return;
    }
    xhr.send(opts.body);
  });
}

interface StreamOptions {
  api: MuseApi;
  threadId: string;
  message: { id: string; role: "user"; content: string };
  provider: ChatProviderSelection | null;
  signal: AbortSignal;
  /** Applied strictly in arrival order; may await (e.g. approval decisions). */
  applyEvent: (event: AgUiEvent) => Promise<void>;
  isFailed: () => boolean;
}

/**
 * POSTs one chat turn and applies AG-UI events to the UI in arrival order.
 * Resolves when the stream ends cleanly, throws on HTTP/network/run errors.
 * A user abort resolves quietly (no error is surfaced).
 */
async function postChatStream(opts: StreamOptions): Promise<void> {
  const { api, signal, applyEvent, isFailed } = opts;
  const pending: AgUiEvent[] = [];
  let pumping: Promise<void> | null = null;
  let cancelSource: (() => void) | null = null;

  function onEvent(event: AgUiEvent) {
    pending.push(event);
    if (pumping) return;
    pumping = (async () => {
      try {
        while (pending.length) {
          if (isFailed()) {
            pending.length = 0;
            break;
          }
          const next = pending.shift();
          if (next === undefined) break;
          await applyEvent(next);
        }
      } finally {
        pumping = null;
        if (isFailed()) cancelSource?.();
      }
    })();
  }

  const parser = createSseParser(onEvent);
  const pushText = (text: string) => parser.push(text);
  async function drain() {
    parser.flush();
    while (pumping) await pumping;
  }

  const payload = { threadId: opts.threadId, message: opts.message, provider: opts.provider };

  if (Platform.OS === "web") {
    const response = await api.stream("/api/chat/stream", payload, signal);
    if (!response.ok) throw await httpError(response);
    const body = response.body as
      | (ReadableStream<Uint8Array> & {
          getReader?: unknown;
        })
      | null;
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      cancelSource = () => {
        void reader.cancel().catch(() => {});
      };
      const onAbort = () => cancelSource?.();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pushText(decoder.decode(value, { stream: true }));
          if (isFailed() || signal.aborted) break;
        }
        pushText(decoder.decode());
      } finally {
        signal.removeEventListener("abort", onAbort);
        reader.releaseLock();
      }
    } else {
      pushText(await response.text());
    }
  } else {
    const { status, errorText } = await readXhrChunks({
      url: api.url("/api/chat/stream"),
      headers: {
        Authorization: `Bearer ${api.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
      onText: pushText,
    });
    if (signal.aborted) {
      await drain();
      return;
    }
    if (status < 200 || status >= 300) {
      let message = `Request failed (${status})`;
      try {
        const parsed = JSON.parse(errorText) as { error?: unknown };
        if (typeof parsed.error === "string") message = parsed.error;
      } catch {
        // keep the status message
      }
      throw new Error(message);
    }
  }

  await drain();
  if (signal.aborted) return;
}

/* ------------------------------------------------------------------ */
/* useOpenApplyChat                                                    */
/* ------------------------------------------------------------------ */

export interface OpenApplyChat {
  messages: ChatMessage[];
  isRunning: boolean;
  /** Always true: there is no provider handshake; the hook is ready on mount. */
  isReady: boolean;
  error: string;
  approvalRequest: ApprovalRequest | null;
  setMessages: (messages: ChatMessage[]) => void;
  /** Appends the user message and streams the turn. Rejects on run failure. */
  sendMessage: (text: string, messageId?: string) => Promise<void>;
  stop: () => Promise<void>;
  decideApproval: (approved: boolean) => Promise<void>;
  clearError: () => void;
}

interface PendingApproval {
  req: ApprovalRequest;
  resolve: () => void;
  reject: (error: Error) => void;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isApprovalEvent(event: AgUiEvent): boolean {
  if (event.type === "approval-request") return true;
  return event.type === "CUSTOM" && (event as { name?: unknown }).name === "approval-request";
}

function attachToolCall(
  prev: ChatMessage[],
  messageId: string | null,
  toolCall: ChatToolCall,
): ChatMessage[] {
  let target = messageId;
  if (!target || !prev.some((m) => m.id === target)) {
    const lastAssistant = [...prev].reverse().find((m) => m.role === "assistant");
    target = lastAssistant?.id ?? null;
  }
  if (!target) {
    return [...prev, { id: newId("msg"), role: "assistant", content: "", toolCalls: [toolCall] }];
  }
  return prev.map((m) =>
    m.id === target && m.role === "assistant"
      ? { ...m, toolCalls: [...(m.toolCalls ?? []), toolCall] }
      : m,
  );
}

export function useOpenApplyChat(opts: {
  threadId: string;
  provider: ChatProviderSelection | null;
  api: MuseApi;
}): OpenApplyChat {
  const { threadId, api } = opts;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);

  const providerRef = useRef(opts.provider);
  useEffect(() => {
    providerRef.current = opts.provider;
  }, [opts.provider]);

  const abortRef = useRef<AbortController | null>(null);
  const runDoneRef = useRef<Promise<void> | null>(null);
  const runFailureRef = useRef<string | null>(null);
  const currentAssistantRef = useRef<string | null>(null);
  const approvalsRef = useRef<PendingApproval[]>([]);

  const failRun = useCallback((message: string) => {
    runFailureRef.current = message;
    setError(message);
  }, []);

  const clearError = useCallback(() => setError(""), []);

  const setMessagesStable = useCallback((next: ChatMessage[]) => setMessages(next), []);

  /** Releases approval waiters when the run is stopped: no approve POST. */
  const releaseApprovals = useCallback(() => {
    const waiters = approvalsRef.current.splice(0);
    setApprovalRequest(null);
    for (const waiter of waiters) waiter.reject(abortError());
  }, []);

  const decideApproval = useCallback(
    async (approved: boolean) => {
      const pending = approvalsRef.current.shift();
      setApprovalRequest(approvalsRef.current[0]?.req ?? null);
      if (!pending) return;
      try {
        await api.request("/api/chat/approve", {
          runId: pending.req.runId,
          toolCallId: pending.req.toolCallId,
          approved,
        });
        pending.resolve();
      } catch (e) {
        pending.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    [api],
  );

  const waitForApproval = useCallback(
    (event: AgUiEvent): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        // The wire event may carry the fields at the top level or nested
        // under `value` (AG-UI CUSTOM shape); accept both.
        const payload =
          (event as { value?: Record<string, unknown> }).value ??
          (event as unknown as Record<string, unknown>);
        const runId = typeof payload.runId === "string" ? payload.runId : "";
        const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
        const toolName =
          typeof payload.toolName === "string" && payload.toolName ? payload.toolName : "tool";
        approvalsRef.current.push({
          req: { runId, toolCallId, toolName, args: payload.args },
          resolve,
          reject,
        });
        setApprovalRequest(approvalsRef.current[0].req);
      }),
    [],
  );

  const applyEvent = useCallback(
    async (event: AgUiEvent): Promise<void> => {
      if (isApprovalEvent(event)) {
        const payload = (event as { value?: unknown }).value ?? event;
        if (
          typeof (payload as { runId?: unknown }).runId !== "string" ||
          typeof (payload as { toolCallId?: unknown }).toolCallId !== "string"
        )
          return;
        try {
          await waitForApproval(event);
        } catch (e) {
          if (isAbortError(e)) return; // run was stopped; stay silent
          failRun(e instanceof Error ? e.message : String(e));
        }
        return;
      }
      switch (event.type as string | undefined) {
        case "RUN_STARTED":
          setError("");
          currentAssistantRef.current = null;
          return;
        case "TEXT_MESSAGE_START": {
          const id = typeof event.messageId === "string" ? event.messageId : newId("msg");
          currentAssistantRef.current = id;
          const content = typeof event.content === "string" ? event.content : "";
          const message: ChatAssistantMessage = { id, role: "assistant", content };
          setMessages((prev) => (prev.some((m) => m.id === id) ? prev : [...prev, message]));
          return;
        }
        case "TEXT_MESSAGE_CONTENT":
        case "TEXT_MESSAGE_CHUNK": {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (!delta) return;
          const id =
            typeof event.messageId === "string" ? event.messageId : currentAssistantRef.current;
          if (!id) return;
          currentAssistantRef.current = id;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === id && m.role === "assistant" ? { ...m, content: m.content + delta } : m,
            ),
          );
          return;
        }
        case "TEXT_MESSAGE_END":
          return;
        case "TOOL_CALL_START": {
          const toolCallId = event.toolCallId;
          const toolCallName = event.toolCallName;
          if (typeof toolCallId !== "string" || typeof toolCallName !== "string") return;
          const toolCall: ChatToolCall = {
            id: toolCallId,
            type: "function",
            function: { name: toolCallName, arguments: "" },
          };
          const messageId =
            typeof event.messageId === "string" ? event.messageId : currentAssistantRef.current;
          setMessages((prev) => attachToolCall(prev, messageId, toolCall));
          return;
        }
        case "TOOL_CALL_ARGS":
        case "TOOL_CALL_CHUNK": {
          const toolCallId = event.toolCallId;
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (typeof toolCallId !== "string" || !delta) return;
          setMessages((prev) =>
            prev.map((m) => {
              if (m.role !== "assistant" || !m.toolCalls) return m;
              if (!m.toolCalls.some((tc) => tc.id === toolCallId)) return m;
              return {
                ...m,
                toolCalls: m.toolCalls.map((tc) =>
                  tc.id === toolCallId
                    ? {
                        ...tc,
                        function: {
                          ...tc.function,
                          arguments: tc.function.arguments + delta,
                        },
                      }
                    : tc,
                ),
              };
            }),
          );
          return;
        }
        case "TOOL_CALL_END":
          return;
        case "TOOL_CALL_RESULT": {
          const toolCallId = event.toolCallId;
          if (typeof toolCallId !== "string") return;
          const raw = (event as { content?: unknown }).content;
          const content = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
          const id = typeof event.messageId === "string" ? event.messageId : newId("toolmsg");
          const toolMessage: ChatToolMessage = { id, role: "tool", content, toolCallId };
          setMessages((prev) => (prev.some((m) => m.id === id) ? prev : [...prev, toolMessage]));
          return;
        }
        case "MESSAGES_SNAPSHOT": {
          const items = (event as { messages?: unknown }).messages;
          if (Array.isArray(items)) setMessages(items as ChatMessage[]);
          return;
        }
        case "RUN_FINISHED":
          currentAssistantRef.current = null;
          return;
        case "RUN_ERROR": {
          const message =
            typeof event.message === "string" && event.message ? event.message : "The run failed.";
          failRun(message);
          return;
        }
        default:
          return;
      }
    },
    [failRun, waitForApproval],
  );

  const sendMessage = useCallback(
    async (text: string, messageId?: string): Promise<void> => {
      if (abortRef.current) throw new Error("A response is already running.");
      const id = messageId ?? newId("user");
      runFailureRef.current = null;
      approvalsRef.current = [];
      setApprovalRequest(null);
      setMessages((prev) => [...prev, { id, role: "user", content: text }]);
      setIsRunning(true);
      setError("");
      currentAssistantRef.current = null;
      const controller = new AbortController();
      abortRef.current = controller;
      const isFailed = () => runFailureRef.current !== null;
      try {
        await postChatStream({
          api,
          threadId,
          message: { id, role: "user", content: text },
          provider: providerRef.current,
          signal: controller.signal,
          applyEvent,
          isFailed,
        });
        const failure = runFailureRef.current;
        if (failure) throw new Error(failure);
      } catch (e) {
        if (isAbortError(e) || controller.signal.aborted) return;
        const message = e instanceof Error ? e.message : String(e);
        failRun(message);
        throw e instanceof Error ? e : new Error(message);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setIsRunning(false);
        currentAssistantRef.current = null;
      }
    },
    [api, threadId, applyEvent, failRun],
  );

  const stop = useCallback(async () => {
    const controller = abortRef.current;
    if (!controller) return;
    abortRef.current = null;
    releaseApprovals();
    controller.abort();
    const done = runDoneRef.current;
    if (done) await done.catch(() => {});
  }, [releaseApprovals]);

  // Track the in-flight run so stop() can wait for teardown.
  const sendMessageTracked = useCallback(
    async (text: string, messageId?: string): Promise<void> => {
      const done = sendMessage(text, messageId);
      runDoneRef.current = done.catch(() => {});
      try {
        await done;
      } finally {
        if (runDoneRef.current) runDoneRef.current = null;
      }
    },
    [sendMessage],
  );

  // Switching threads abandons any in-flight run for the previous thread.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [threadId],
  );

  return useMemo(
    () => ({
      messages,
      isRunning,
      isReady: true,
      error,
      approvalRequest,
      setMessages: setMessagesStable,
      sendMessage: sendMessageTracked,
      stop,
      decideApproval,
      clearError,
    }),
    [
      messages,
      isRunning,
      error,
      approvalRequest,
      setMessagesStable,
      sendMessageTracked,
      stop,
      decideApproval,
      clearError,
    ],
  );
}
