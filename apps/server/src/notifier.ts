/**
 * Notifier (Slice 6): in-app inbox + Telegram.
 *
 * Laws per apps/server/src/prompts/notifier.md: notifications say what happened
 * and which job (title + company only). They never carry resume/cover/
 * statement text, certificate images, credential ids, or keys.
 */
import { randomUUID } from "node:crypto";
import type { AgentNotification } from "../../../packages/domain/src/agent.ts";
import { decryptSecret } from "../../../packages/integrations/src/vault.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { backgroundFailure } from "./log.ts";

export interface NotifyInput {
  title: string;
  body: string;
  taskId?: string;
}

interface TelegramCredential {
  id: string;
  secret: string | null;
}

async function getTelegramConfig(
  db: Store,
  config: Config,
  owner: string,
): Promise<{ botToken: string; chatId: string } | null> {
  try {
    const stored = await db.get<TelegramCredential>(owner, "credentials", "telegram");
    if (!stored?.secret || !config.encryptionKey) return null;
    const parsed = JSON.parse(decryptSecret(stored.secret, config.encryptionKey)) as {
      botToken?: string;
      chatId?: string;
    };
    if (!parsed.botToken || !parsed.chatId) return null;
    return { botToken: parsed.botToken, chatId: parsed.chatId };
  } catch (error) {
    backgroundFailure("telegram credential read", error);
    return null;
  }
}

async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
    });
    if (!response.ok) throw new Error(`Telegram API ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver a notification. In-app is always written; Telegram goes out only
 * when the owner connected a bot token (stored encrypted as the `telegram`
 * credential). Returns the channels that actually received it.
 */
export async function notifyOwner(
  db: Store,
  config: Config,
  owner: string,
  input: NotifyInput,
): Promise<{ delivered_channels: string[] }> {
  const notification: AgentNotification = {
    id: randomUUID(),
    taskId: input.taskId,
    title: input.title,
    body: input.body,
    createdAt: new Date().toISOString(),
    read: false,
  };
  await db.put(owner, "notifications", notification);
  const delivered = ["in_app"];

  const telegram = await getTelegramConfig(db, config, owner);
  if (telegram) {
    try {
      await sendTelegramMessage(
        telegram.botToken,
        telegram.chatId,
        `${input.title}\n${input.body}`,
      );
      delivered.push("telegram");
    } catch (error) {
      backgroundFailure("telegram send", error);
    }
  }
  return { delivered_channels: delivered };
}
