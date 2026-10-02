import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";

export const demoModel = "openai/openapply-browser-demo";

/** Minimal OpenAI chat-completions shapes the scripted demo fixture works with. */
export interface DemoContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}
export interface DemoToolCallMessage {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface DemoChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | DemoContentPart[] | null;
  name?: string;
  tool_calls?: DemoToolCallMessage[];
  tool_call_id?: string;
}
/** Alias kept for call sites that used the mock library's name. */
export type ChatMessage = DemoChatMessage;
export interface DemoToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters?: object };
}
export interface ChatCompletionRequest {
  model: string;
  messages: DemoChatMessage[];
  stream?: boolean;
  tools?: DemoToolDefinition[];
  [key: string]: unknown;
}
export interface FixtureToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface FixtureResponse {
  content?: string;
  toolCalls?: FixtureToolCall[];
}

export function getTextContent(content: DemoChatMessage["content"]): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

const pageSchema = z.object({
  sessionId: z.string().min(1),
  url: z.url(),
  title: z.string(),
  text: z.string(),
  truncated: z.boolean(),
});

function targetUrl(prompt: string): string | undefined {
  if (/monterey|aquarium/i.test(prompt))
    return "https://www.montereybayaquarium.org/visit/exhibits";
  if (/ag-?ui|docs\.ag-ui\.com/i.test(prompt)) return "https://docs.ag-ui.com";
  if (/hacker\s*news|news\.ycombinator\.com|cool stuff/i.test(prompt))
    return "https://news.ycombinator.com";
  return undefined;
}

function summarizePage(message: DemoChatMessage): FixtureResponse {
  let value: unknown;
  try {
    value = JSON.parse(getTextContent(message.content) ?? "");
  } catch {
    return { content: "The browser did not return readable page data. Check the browser result." };
  }
  const parsed = pageSchema.safeParse(value);
  if (!parsed.success)
    return { content: "The browser could not read that page. Check the browser result and retry." };
  const page = parsed.data;
  const lines = page.text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  let excerpts: string[];
  let introduction: string;
  if (new URL(page.url).hostname === "news.ycombinator.com") {
    excerpts = lines
      .map(
        (line, index) =>
          /^\d+\.\s+(.+)$/.exec(line)?.[1] ?? (/^\d+\.$/.test(line) ? lines[index + 1] : undefined),
      )
      .filter((line): line is string => Boolean(line))
      .slice(0, 3);
    introduction = "From the current Hacker News front page:";
  } else if (new URL(page.url).hostname.endsWith("montereybayaquarium.org")) {
    excerpts = lines
      .flatMap((line, index) => {
        if (lines[index - 1] !== "EXHIBIT" || !/^(Kelp Forest|Open Sea|Sea Otters)$/i.test(line))
          return [];
        const description = lines[index + 1];
        return [
          description && description !== "Explore exhibit" ? `${line}: ${description}` : line,
        ];
      })
      .slice(0, 3);
    introduction = "Exhibits from the aquarium’s own guide:";
  } else {
    excerpts = lines
      .filter((line) => line.length >= 45 && /agent|ag.ui|framework/i.test(line))
      .slice(0, 3);
    introduction = "From the linked docs page:";
  }
  if (!excerpts.length) {
    excerpts = lines.filter((line) => line.length >= 30).slice(0, 3);
    introduction = "Here are excerpts from the page I just opened:";
  }
  if (!excerpts.length)
    return { content: "The page opened, but it did not expose enough readable text to summarize." };
  const bullets = excerpts.map(
    (line) => `• ${line.length > 110 ? `${line.slice(0, 110).replace(/\s+\S*$/, "")}…` : line}`,
  );
  return {
    content: `${introduction}\n\n${bullets.join("\n")}\n\nSource: ${page.url}${page.truncated ? "\nThe browser returned a shortened page extract." : ""}`,
  };
}

function turnResult(turn: DemoChatMessage[], name: string, prefix: string) {
  const ids = new Set(
    turn.flatMap((message) =>
      (message.tool_calls ?? [])
        .filter((call) => call.function.name === name)
        .map((call) => call.id),
    ),
  );
  return turn.findLast(
    (message) =>
      message.role === "tool" &&
      message.tool_call_id &&
      (ids.has(message.tool_call_id) || message.tool_call_id.startsWith(prefix)),
  );
}

function parseResult(message: DemoChatMessage): unknown {
  try {
    return JSON.parse(getTextContent(message.content) ?? "");
  } catch {
    return undefined;
  }
}

function demoMailResponse(
  request: ChatCompletionRequest,
  turn: DemoChatMessage[],
): FixtureResponse {
  const read = turnResult(turn, "read_mail_thread", "call_openapply_demo_mail_read_");
  if (read) {
    const parsed = z
      .object({
        messages: z.array(z.object({ sender: z.string(), subject: z.string(), body: z.string() })),
      })
      .safeParse(parseResult(read));
    const message = parsed.success ? parsed.data.messages.at(-1) : undefined;
    if (!message)
      return {
        content: "I couldn’t read the school-trip email. Check the mail result and try again.",
      };
    const paragraphs = message.body
      .split(/\n\s*\n/)
      .map((text) => text.trim())
      .filter((text) => text.length > 40 && !/local workspace/i.test(text))
      .slice(0, 2);
    if (!paragraphs.length)
      return { content: "The email was found, but it did not include readable trip details." };
    return {
      content: `From ${message.sender}:\n“${message.subject}”\n\n${paragraphs.join("\n\n")}\n\nI can look up the aquarium next.`,
    };
  }
  const search = turnResult(turn, "search_mail", "call_openapply_demo_mail_search_");
  if (search) {
    const parsed = z
      .object({ matches: z.array(z.object({ threadId: z.string(), subject: z.string() })) })
      .safeParse(parseResult(search));
    if (!parsed.success)
      return { content: "I couldn’t check your inbox. Check the mail connection and try again." };
    const match = parsed.data.matches[0];
    if (!match) return { content: "I didn’t find a school-trip email in the connected mailbox." };
    if (!request.tools?.some((tool) => tool.function.name === "read_mail_thread"))
      return {
        content: "The email reader is unavailable. Open Mail to read the matching message.",
      };
    return {
      content: "I found the school’s reminder. I’ll read the details.",
      toolCalls: [
        {
          id: `call_openapply_demo_mail_read_${randomUUID()}`,
          name: "read_mail_thread",
          arguments: JSON.stringify({ threadId: match.threadId }),
        },
      ],
    };
  }
  if (!request.tools?.some((tool) => tool.function.name === "search_mail"))
    return { content: "Mail search is unavailable. Connect the mailbox before checking email." };
  return {
    content: "I’ll check your inbox for the school trip.",
    toolCalls: [
      {
        id: `call_openapply_demo_mail_search_${randomUUID()}`,
        name: "search_mail",
        arguments: JSON.stringify({ query: "aquarium" }),
      },
    ],
  };
}

/** Script only the model: the app executes real mailbox reads and browser tools. */
export function demoResponse(request: ChatCompletionRequest): FixtureResponse {
  const userIndex = request.messages.findLastIndex((message) => message.role === "user");
  const user = request.messages[userIndex];
  const prompt = user ? (getTextContent(user.content) ?? "") : "";
  const turn = request.messages.slice(userIndex + 1);
  if (/email|inbox/i.test(prompt)) return demoMailResponse(request, turn);
  const url = targetUrl(prompt);
  if (!url)
    return {
      content:
        "Try “Find cool stuff on Hacker News”, “Summarize the AG-UI docs”, “Check my emails for the school trip”, or “Research Monterey Bay Aquarium”.",
    };

  // Only the latest turn can satisfy this request; older browser reads cannot suppress a new visit.
  const calls = new Set(
    turn.flatMap((message) =>
      (message.tool_calls ?? [])
        .filter((call) => call.function.name === "browse_web")
        .map((call) => call.id),
    ),
  );
  const result = turn.findLast(
    (message) =>
      message.role === "tool" &&
      message.tool_call_id &&
      (calls.has(message.tool_call_id) ||
        message.tool_call_id.startsWith("call_openapply_demo_browse_")),
  );
  if (result) return summarizePage(result);
  if (!request.tools?.some((tool) => tool.function.name === "browse_web"))
    return { content: "The browse_web tool is not available. Start the API with browser support." };
  return {
    content: url.includes("ycombinator")
      ? "I’ll open Hacker News and read the front page."
      : url.includes("montereybayaquarium")
        ? "I’ll research the exhibits on the aquarium’s own website."
        : "I’ll open the linked docs page and read it.",
    toolCalls: [
      {
        id: `call_openapply_demo_browse_${randomUUID()}`,
        name: "browse_web",
        arguments: JSON.stringify({ url }),
      },
    ],
  };
}

// --- Local deterministic stub of the OpenAI Responses API -----------------
// The recording demo points the OpenAI adapter at this server; the fixture
// above scripts the model while the app executes real tools.

export interface DemoRequestJournal {
  method: string;
  path: string;
  body: string;
}

interface ResponsesRequest {
  model?: string;
  instructions?: string;
  input?: unknown;
  tools?: { type?: string; name?: string; description?: string; parameters?: object }[];
  stream?: boolean;
  [key: string]: unknown;
}

function extractResponsesText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part) =>
        part &&
        typeof part === "object" &&
        (part.type === "input_text" || part.type === "output_text"),
    )
    .map((part) => (part as { text?: string }).text ?? "")
    .join("");
}

/** Convert an OpenAI Responses request into the chat-completions shape the fixture reads. */
function responsesToCompletionRequest(req: ResponsesRequest): ChatCompletionRequest {
  const messages: DemoChatMessage[] = [];
  if (req.instructions) messages.push({ role: "system", content: req.instructions });
  const input = req.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input as Record<string, unknown>[]) {
      if (item.role === "system" || item.role === "developer")
        messages.push({ role: "system", content: extractResponsesText(item.content) });
      else if (item.role === "user")
        messages.push({ role: "user", content: extractResponsesText(item.content) });
      else if (item.role === "assistant")
        messages.push({ role: "assistant", content: extractResponsesText(item.content) || null });
      else if (item.type === "function_call")
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: String(item.call_id ?? `call_${randomUUID()}`),
              type: "function",
              function: {
                name: String(item.name ?? ""),
                arguments: String(item.arguments ?? ""),
              },
            },
          ],
        });
      else if (item.type === "function_call_output")
        messages.push({
          role: "tool",
          content:
            typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
          tool_call_id: String(item.call_id ?? ""),
        });
    }
  }
  const tools = (req.tools ?? [])
    .filter((tool) => tool.type === "function")
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name ?? "",
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  return {
    model: req.model ?? "",
    messages,
    stream: req.stream,
    ...(tools.length ? { tools } : {}),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface DemoModelServer {
  readonly url: string;
  start(): Promise<string>;
  stop(): Promise<void>;
  getRequests(): DemoRequestJournal[];
}

/**
 * A tiny deterministic stand-in for a hosted model: it serves the OpenAI
 * Responses API over HTTP, scripts every reply through `demoResponse`, and
 * streams the reply back with a configurable time-to-first-token and
 * per-chunk latency so the demo feels like a real model.
 */
export function createDemoModel(
  options: { port?: number; latency?: number; firstByteDelay?: number } = {},
): DemoModelServer {
  const latency = options.latency ?? 80;
  const firstByteDelay = options.firstByteDelay ?? options.latency ?? 1500;
  if (![latency, firstByteDelay].every((value) => Number.isFinite(value) && value >= 0))
    throw new Error("Demo model delays must be finite nonnegative milliseconds");
  const chunkSize = 14;
  const journal: DemoRequestJournal[] = [];
  let server: Server | undefined;
  let baseUrl = "";

  const writeSse = async (
    send: (event: Record<string, unknown>) => void,
    fixture: FixtureResponse,
    model: string,
  ) => {
    const respId = `resp_${randomUUID().replace(/-/g, "")}`;
    const created = Math.floor(Date.now() / 1000);
    const header = {
      id: respId,
      object: "response",
      created_at: created,
      model,
      status: "in_progress",
      output: [],
    };
    await sleep(firstByteDelay);
    send({ type: "response.created", response: header });
    send({ type: "response.in_progress", response: header });
    const output: Record<string, unknown>[] = [];
    let outputIndex = 0;
    if (fixture.content) {
      const msgId = `msg_${randomUUID().replace(/-/g, "")}`;
      send({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { type: "message", id: msgId, status: "in_progress", role: "assistant", content: [] },
      });
      send({
        type: "response.content_part.added",
        item_id: msgId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      for (let i = 0; i < fixture.content.length; i += chunkSize) {
        await sleep(latency);
        send({
          type: "response.output_text.delta",
          item_id: msgId,
          output_index: outputIndex,
          content_index: 0,
          delta: fixture.content.slice(i, i + chunkSize),
        });
      }
      send({
        type: "response.output_text.done",
        item_id: msgId,
        output_index: outputIndex,
        content_index: 0,
        text: fixture.content,
      });
      send({
        type: "response.content_part.done",
        item_id: msgId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: fixture.content, annotations: [] },
      });
      const msgItem = {
        type: "message",
        id: msgId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: fixture.content, annotations: [] }],
      };
      send({ type: "response.output_item.done", output_index: outputIndex, item: msgItem });
      output.push(msgItem);
      outputIndex++;
    }
    for (const toolCall of fixture.toolCalls ?? []) {
      const callId = toolCall.id;
      const fcId = `fc_${randomUUID().replace(/-/g, "")}`;
      send({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          type: "function_call",
          id: fcId,
          call_id: callId,
          name: toolCall.name,
          arguments: "",
          status: "in_progress",
        },
      });
      for (let i = 0; i < toolCall.arguments.length; i += chunkSize) {
        await sleep(latency);
        send({
          type: "response.function_call_arguments.delta",
          item_id: fcId,
          output_index: outputIndex,
          delta: toolCall.arguments.slice(i, i + chunkSize),
        });
      }
      send({
        type: "response.function_call_arguments.done",
        item_id: fcId,
        output_index: outputIndex,
        arguments: toolCall.arguments,
      });
      const doneItem = {
        type: "function_call",
        id: fcId,
        call_id: callId,
        name: toolCall.name,
        arguments: toolCall.arguments,
        status: "completed",
      };
      send({ type: "response.output_item.done", output_index: outputIndex, item: doneItem });
      output.push(doneItem);
      outputIndex++;
    }
    send({
      type: "response.completed",
      response: {
        id: respId,
        object: "response",
        created_at: created,
        model,
        status: "completed",
        output,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
  };

  return {
    get url() {
      return baseUrl;
    },
    async start() {
      if (server) return baseUrl;
      const listening = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        journal.push({ method: req.method ?? "POST", path: pathname, body });
        if (journal.length > 100) journal.splice(0, journal.length - 100);
        if (req.method !== "POST" || pathname !== "/v1/responses") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }),
          );
          return;
        }
        let parsed: ResponsesRequest;
        try {
          parsed = JSON.parse(body) as ResponsesRequest;
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "Invalid JSON body", type: "invalid_request_error" },
            }),
          );
          return;
        }
        // Strict like the mock this replaces: only the demo model is scripted.
        // The adapter sends the bare model id ("openapply-browser-demo");
        // accept the prefixed spec too.
        const modelId = demoModel.split("/").pop();
        if (parsed.model !== demoModel && parsed.model !== modelId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: `No fixture for model "${parsed.model ?? ""}"`,
                type: "invalid_request_error",
              },
            }),
          );
          return;
        }
        const fixture = await demoResponse(responsesToCompletionRequest(parsed));
        if (parsed.stream === false) {
          const output: Record<string, unknown>[] = [];
          if (fixture.content)
            output.push({
              type: "message",
              id: `msg_${randomUUID().replace(/-/g, "")}`,
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: fixture.content, annotations: [] }],
            });
          for (const toolCall of fixture.toolCalls ?? [])
            output.push({
              type: "function_call",
              id: `fc_${randomUUID().replace(/-/g, "")}`,
              call_id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
              status: "completed",
            });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: `resp_${randomUUID().replace(/-/g, "")}`,
              object: "response",
              created_at: Math.floor(Date.now() / 1000),
              model: parsed.model,
              status: "completed",
              output,
              usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            }),
          );
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const send = (event: Record<string, unknown>) =>
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        try {
          await writeSse(send, fixture, parsed.model ?? demoModel);
        } catch {
          // Client went away; nothing to do.
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
      server = listening;
      await new Promise<void>((resolve) =>
        listening.listen(options.port ?? 0, "127.0.0.1", resolve),
      );
      const address = listening.address();
      const port = typeof address === "object" && address ? address.port : (options.port ?? 0);
      baseUrl = `http://127.0.0.1:${port}`;
      return baseUrl;
    },
    async stop() {
      if (!server) return;
      const closing = server;
      server = undefined;
      baseUrl = "";
      await new Promise<void>((resolve, reject) =>
        closing.close((error) => (error ? reject(error) : resolve())),
      );
    },
    getRequests() {
      return [...journal];
    },
  };
}
