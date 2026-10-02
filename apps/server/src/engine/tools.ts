import type { z } from "zod";

/**
 * Local tool definition helper. This is the same name and shape the call
 * sites used from the previous runtime package's `defineTool`, without the
 * dependency: a name, description, parameters schema, a server-side executor,
 * and the optional human-approval (interrupt) fields.
 *
 * Tools that set `interrupt: true` do not execute immediately. The chat
 * agent pauses the run, emits an `approval-request` event on the stream, and
 * waits for the client's decision on `POST /api/chat/approve` before the
 * executor runs.
 */
export interface ToolDefinition<TParameters extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: TParameters;
  /** Server-side executor. Optional only for interrupt tools, which pause instead. */
  execute?: (args: z.output<TParameters>) => Promise<unknown>;
  /** When true, calling this tool pauses the run for human approval first. */
  interrupt?: boolean;
  /** Optional categorical reason surfaced with the approval request. */
  interruptReason?: string;
  /** Optional human-readable prompt surfaced with the approval request. */
  interruptMessage?: string;
}

export function defineTool<TParameters extends z.ZodType>(
  config: ToolDefinition<TParameters>,
): ToolDefinition<TParameters> {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: config.execute,
    interrupt: config.interrupt,
    interruptReason: config.interruptReason,
    interruptMessage: config.interruptMessage,
  };
}
