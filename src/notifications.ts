import type { Fetcher } from "@cloudflare/workers-types";
import { createLogger } from "@jango-blockchained/hoox-shared/middleware";
import { toError } from "@jango-blockchained/hoox-shared/errors";
import { serviceFetch } from "@jango-blockchained/hoox-shared/service-bindings";

const logger = createLogger({
  service: "trade-worker",
  module: "notifications",
});

// --- Type Definitions ---

export interface TradeQueueMessage {
  requestId: string;
  exchange: string;
  action: string;
  symbol: string;
  quantity: number;
  price?: number;
  leverage?: number;
  queuedAt: string;
}

export interface NotificationsEnv {
  TELEGRAM_SERVICE?: Fetcher;
  TELEGRAM_INTERNAL_KEY_BINDING?: string;
}

// --- Notification Functions ---

/**
 * Sends trade notification to Telegram worker
 * Used by both direct execution and queue processing
 */
export async function sendTradeNotificationToTelegram(
  env: NotificationsEnv,
  result: { success?: boolean; result?: unknown; error?: string },
  routedExchange: string,
  action: string,
  quantity: number,
  symbol: string,
  dbLogId: string | null
): Promise<void> {
  if (!env.TELEGRAM_SERVICE) return;

  try {
    const notificationMessage = result?.success
      ? `Trade executed successfully on ${routedExchange}: ${action} ${quantity} ${symbol}. Result: ${JSON.stringify(result.result)}`
      : `Trade execution failed on ${routedExchange}: ${action} ${quantity} ${symbol}. Error: ${result?.error || "Unknown error"}`;

    const telegramPayload = { message: notificationMessage };
    logger.info("Calling TELEGRAM_SERVICE for notification", { dbLogId });
    const headers: Record<string, string> = {};
    if (env.TELEGRAM_INTERNAL_KEY_BINDING) {
      headers["X-Internal-Auth-Key"] = env.TELEGRAM_INTERNAL_KEY_BINDING;
    }
    const notificationResponse = await serviceFetch(
      env.TELEGRAM_SERVICE,
      "/webhook",
      telegramPayload,
      { headers }
    );

    if (!notificationResponse.ok) {
      logger.error("Error calling TELEGRAM_SERVICE for notification", {
        dbLogId,
        status: notificationResponse.status,
        responseText: await notificationResponse.text(),
      });
    } else {
      logger.info("Notification sent via TELEGRAM_SERVICE", { dbLogId });
    }
  } catch (notificationError: unknown) {
    const errorMsg = toError(notificationError, "Unknown notification error");
    logger.error("Exception calling TELEGRAM_SERVICE for notification", {
      dbLogId,
      error: errorMsg,
    });
  }
}

/**
 * Sends trade notification for queue-based trades
 * Wrapper around sendTradeNotificationToTelegram for queue message format
 */
export async function sendTradeNotification(
  trade: TradeQueueMessage,
  env: NotificationsEnv,
  result: { success: boolean; error?: string; result?: unknown }
): Promise<void> {
  await sendTradeNotificationToTelegram(
    env,
    result,
    trade.exchange,
    trade.action,
    trade.quantity,
    trade.symbol,
    trade.requestId
  );
}
