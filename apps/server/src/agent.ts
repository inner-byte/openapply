import "./config.ts";
import { HttpAgent } from "@ag-ui/client";
import type { Config } from "./config.ts";
import { type ChatProviderDeps, ConversationAgent } from "./engine/conversation.ts";
import type { AgentService } from "./engine/service.ts";
import type { ApprovalRequest } from "./engine/tanstack-agent.ts";

/**
 * Human-approval channel for chat tool calls that declare `interrupt: true`.
 * The chat routes implement this against the thread store; resolving true
 * executes the tool, false reports the call as denied.
 */
export interface ApprovalGate {
  requestApproval(owner: string, request: ApprovalRequest, signal: AbortSignal): Promise<boolean>;
}

export function agentConfigured(config: Config) {
  return (
    config.agentBackend === "sample" ||
    (config.agentBackend === "agui"
      ? Boolean(config.agentUrl)
      : Boolean(
          config.model &&
            (process.env.OPENAI_API_KEY ||
              process.env.ANTHROPIC_API_KEY ||
              process.env.GOOGLE_API_KEY),
        ))
  );
}

/** Pick the agent for a chat run: the local conversation agent for the
 *  sample/model backends, or a proxy to the configured AG-UI endpoint. */
export function selectAgent(
  config: Config,
  service: AgentService,
  owner: string,
  /** Slice 15: lets the chat panel resolve a per-session provider selection. */
  chatProviders?: ChatProviderDeps,
  approvals?: ApprovalGate,
): ConversationAgent | HttpAgent {
  if (config.agentBackend === "agui")
    return new HttpAgent({
      url: config.agentUrl ?? "http://127.0.0.1:1/unconfigured",
      headers: config.agentToken ? { Authorization: `Bearer ${config.agentToken}` } : {},
    });
  return new ConversationAgent(
    config,
    service,
    owner,
    chatProviders,
    approvals
      ? { requestApproval: (request, signal) => approvals.requestApproval(owner, request, signal) }
      : undefined,
  );
}
