/**
 * Runs one conversation turn against the OpenApply chat transport.
 *
 * Previously this wrapped CopilotKit's runAgent and translated its onError
 * subscription into a thrown error. The new transport surfaces run failures
 * (RUN_ERROR events, HTTP errors, network failures) as promise rejections
 * from sendMessage itself, so this is now a thin pass-through kept so the
 * queue/outbox flow in chat.tsx does not change shape.
 */
export async function runConversationTurn(execute: () => Promise<unknown>): Promise<void> {
  await execute();
}
