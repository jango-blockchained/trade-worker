import type { Fetcher } from "@cloudflare/workers-types";

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
  result: any,
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
    const telegramWorkerRequest = new Request("https://internal/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramPayload),
    });

    if (env.TELEGRAM_INTERNAL_KEY_BINDING) {
      telegramWorkerRequest.headers.set(
        "X-Internal-Auth-Key",
        env.TELEGRAM_INTERNAL_KEY_BINDING
      );
    }

    console.log(`[${dbLogId}] Calling TELEGRAM_SERVICE for notification...`);
    const notificationResponse = await env.TELEGRAM_SERVICE.fetch(
      telegramWorkerRequest as any
    );

    if (!notificationResponse.ok) {
      console.error(
        `[${dbLogId}] Error calling TELEGRAM_SERVICE for notification: ${notificationResponse.status} ${await notificationResponse.text()}`
      );
    } else {
      console.log(`[${dbLogId}] Notification sent via TELEGRAM_SERVICE.`);
    }
  } catch (notificationError: unknown) {
    const errorMsg =
      notificationError instanceof Error
        ? notificationError.message
        : String(notificationError || "Unknown notification error");
    console.error(
      `[${dbLogId}] Exception calling TELEGRAM_SERVICE for notification:`,
      errorMsg
    );
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
