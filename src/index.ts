import { MexcClient } from "./mexc-client";
import { BinanceClient } from "./binance-client";
import { BybitClient } from "./bybit-client";
import { DbLogger } from "./db-logger";
import type { KVNamespace } from "@cloudflare/workers-types";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { D1Database } from "@cloudflare/workers-types";
import type {
  Queue,
  QueueEvent,
  MessageSendRequest,
  Fetcher,
} from "@cloudflare/workers-types";
import type { Ai } from "@cloudflare/ai";
import type { ExecutionContext } from "@cloudflare/workers-types";
import {
  Errors,
  createJsonResponse,
  toError,
} from "@jango-blockchained/hoox-shared/errors";
import {
  createLogger,
  withRequestLog,
  validateJson,
  requireInternalAuth,
} from "@jango-blockchained/hoox-shared/middleware";
import { createRouter } from "@jango-blockchained/hoox-shared/router";
import {
  WebhookPayload,
  WebhookPayloadSchema,
  ProcessRequestBody,
} from "@jango-blockchained/hoox-shared/types";
import { trackAnalytics } from "@jango-blockchained/hoox-shared/analytics";
import type { AnalyticsEnv } from "@jango-blockchained/hoox-shared/analytics";
import { healthCheck } from "@jango-blockchained/hoox-shared/health";
import { KVKeys } from "@jango-blockchained/hoox-shared/kvKeys";
import {
  executeTrade,
  validateApiCredentials,
  updateD1TradeRecords,
  type ExecutionEnv,
  type TradeExecutionResult,
  type IExchangeClient,
} from "./execution";
import {
  insertSignal,
  getRecentSignals,
  handlePostSignalRequest,
  handleGetSignalsRequest,
} from "./signals";
import { saveReportToR2, handleGetReportRequest } from "./reports";
import {
  sendTradeNotification,
  sendTradeNotificationToTelegram,
  TradeQueueMessage,
} from "./notifications";

// --- Type Definitions ---

export interface Env extends Cloudflare.Env, AnalyticsEnv {
  // Optional Mocks for Testing
  __mocks__?: {
    MexcClient?: typeof MexcClient; // Constructor type
    BinanceClient?: typeof BinanceClient;
    BybitClient?: typeof BybitClient;
    DbLogger?: typeof DbLogger;
  };

  ENABLE_DEBUG_ENDPOINTS?: string;
}

// Payload structure for legacy /process requests
type TradeProcessRequestBody = ProcessRequestBody<WebhookPayload>;

// --- Constants ---
const MAX_RETRIES = 5;
const BACKOFF_DELAYS = [0, 30, 60, 300, 900]; // 0s, 30s, 1m, 5m, 15m

const PROCESS_ENDPOINT = "/process"; // For legacy/direct calls with internal key
const WEBHOOK_ENDPOINT = "/webhook"; // For calls from hoox via Service Binding
const SIGNALS_ENDPOINT = "/api/signals"; // New endpoint for D1 signals

// --- Queue Consumer Helper Functions ---

async function executeTradeFromQueue(
  trade: TradeQueueMessage,
  env: Env
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    const payload: WebhookPayload = {
      exchange: trade.exchange,
      action: trade.action as WebhookPayload["action"],
      symbol: trade.symbol,
      quantity: trade.quantity,
      price: trade.price,
      leverage: trade.leverage,
    };

    const dbLogger = new DbLogger(env as ExecutionEnv);
    const startTime = Date.now();
    const tradeResult = await executeTrade(
      payload,
      env,
      dbLogger,
      startTime,
      null
    );

    return {
      success: tradeResult.success ?? false,
      result: tradeResult.result,
      error: tradeResult.error,
    };
  } catch (error: unknown) {
    return { success: false, error: toError(error) };
  }
}

async function logFailedTrade(
  trade: TradeQueueMessage,
  errorMsg: string,
  env: Env
): Promise<void> {
  try {
    if (env.D1_SERVICE) {
      const logPayload = {
        query: `INSERT INTO system_logs (level, source, message, details) VALUES (?, ?, ?, ?)`,
        params: [
          "ERROR",
          "queue-consumer",
          `Trade failed: ${trade.requestId}`,
          JSON.stringify({ trade, error: errorMsg }),
        ],
      };

      await env.D1_SERVICE.fetch(
        new Request("http://localhost/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(logPayload),
        })
      );
    }
  } catch (error: unknown) {
    logger.error("Failed to log failed trade", { error: toError(error) });
  }
}

// --- Worker Definition ---

const logger = createLogger({ service: "trade-worker", module: "router" });

/**
 * Helper: queue R2 report save on successful trade execution.
 * Extracted to avoid duplicating this pattern across webhook + process handlers.
 */
async function queueReportSave(
  tradeResult: TradeExecutionResult,
  payload: WebhookPayload,
  dbLogId: string | null,
  env: Env,
  ctx: ExecutionContext,
  requestId: string | undefined
): Promise<void> {
  if (tradeResult.success) {
    try {
      logger.info(
        `[${requestId}] Trade successful, queueing report save to R2.`
      );
      ctx.waitUntil(saveReportToR2(tradeResult.result, payload, dbLogId, env));
    } catch (e) {
      logger.error(`[${requestId}] Failed to queue R2 report save`, {
        error: toError(e),
      });
    }
  }
}

const router = createRouter<Env>();

// Define routes
router.get(
  "/health",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    return healthCheck({ worker: "trade-worker" });
  }
);

router.get(
  SIGNALS_ENDPOINT,
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    return await handleGetSignalsRequest(request, env);
  }
);

router.post(
  SIGNALS_ENDPOINT,
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    return await handlePostSignalRequest(request, env);
  }
);

router.post(
  WEBHOOK_ENDPOINT,
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    return await handleWebhookRequest(request, env, ctx);
  }
);

router.post(
  PROCESS_ENDPOINT,
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    return await handleProcessRequest(request, env, ctx);
  }
);

router.get(
  "/report",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    return await handleGetReportRequest(request, env);
  }
);

export default {
  fetch: withRequestLog(
    (request: Request, env: Env, ctx: ExecutionContext) => {
      return router.handle(request, env, ctx);
    },
    { service: "trade-worker", module: "router" }
  ),

  async queue(
    messages: QueueEvent<TradeQueueMessage>[],
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    logger.info(`[Queue] Received ${messages.length} message(s)`);

    for (const msg of messages) {
      // TODO: fix queue handler signature — QueueEvent wraps Message<Body>, needs batch.messages iteration
      const trade = (msg as unknown as { body: TradeQueueMessage }).body;
      logger.info(
        `[Queue] Processing trade: ${trade.requestId} - ${trade.action} ${trade.symbol}`
      );

      // Get retry count from message metadata
      const retryCount =
        (msg as { retry?: { count: number } }).retry?.count || 0;

      try {
        // Execute the trade
        const result = await executeTradeFromQueue(trade, env);

        if (result.success) {
          logger.info(
            `[Queue] Trade executed successfully: ${trade.requestId}`
          );
          // Send notification if configured
          await sendTradeNotification(trade, env, result);
        } else {
          throw new Error(result.error || "Trade execution failed");
        }
      } catch (error: unknown) {
        const errorMsg = toError(error);
        logger.error(
          `[Queue] Trade failed: ${trade.requestId}, attempt ${retryCount + 1}, error: ${errorMsg}`
        );

        if (retryCount < MAX_RETRIES) {
          const delaySeconds =
            BACKOFF_DELAYS[retryCount] || BACKOFF_DELAYS[MAX_RETRIES - 1];
          logger.info(
            `[Queue] Scheduling retry for ${trade.requestId} in ${delaySeconds}s (attempt ${retryCount + 2})`
          );

          // Re-queue with delay using the message's retry mechanism
          // TODO: fix queue handler signature — retry is on Message<Body>, not QueueEvent
          (
            msg as unknown as {
              retry?: (opts: { delaySeconds: number }) => void;
            }
          ).retry?.({
            delaySeconds,
          });
        } else {
          logger.error(
            `[Queue] Max retries exceeded for ${trade.requestId}, moving to DLQ`
          );

          // Log failure to D1 for tracking
          await logFailedTrade(trade, errorMsg, env);

          // Send failure notification
          await sendTradeNotification(trade, env, {
            success: false,
            error: errorMsg,
          });
        }
      }
    }
  },
};

// --- Request Handlers ---

/**
 * Handles POST requests to the /webhook endpoint (from service bindings).
 */
async function handleWebhookRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const startTime = Date.now();
  // Use mock or real DbLogger
  const DbLoggerClass = env.__mocks__?.DbLogger || DbLogger;
  const dbLogger = new DbLoggerClass(env as ExecutionEnv);
  let dbLogId: string | null = null;
  const incomingRequestId =
    request.headers.get("X-Request-ID") || crypto.randomUUID();

  try {
    const payload: WebhookPayload = await request.json();
    logger.info(`Processing webhook request ID: ${incomingRequestId}`);
    logger.info("Received webhook payload", { payload });

    // Assuming logRequest can handle the payload directly and returns a number ID
    // Might need adjustment based on DbLogger implementation
    dbLogId = await dbLogger.logRequest(request, payload);

    // Internal authentication check
    const authError = requireInternalAuth(request, env, "INTERNAL_KEY_BINDING");
    if (authError) {
      logger.warn(
        `Authentication failed for webhook request ID: ${incomingRequestId}`
      );
      await dbLogger.logResponse(dbLogId, authError, null, startTime);
      return authError;
    }

    const validation = validateJson(WebhookPayloadSchema, payload);
    if (!validation.ok) {
      const response = Errors.badRequest(validation.error);
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    // *** Use validated payload ***
    const validatedPayload = validation.value;

    // *** Call executeTrade ***
    const tradeResult = await executeTrade(
      validatedPayload,
      env,
      dbLogger,
      startTime,
      dbLogId
    );
    const tradeResponse = createJsonResponse(
      tradeResult,
      tradeResult.status ?? (tradeResult.success ? 200 : 500)
    );

    // Queue R2 report save (if trade was successful)
    await queueReportSave(
      tradeResult,
      validatedPayload,
      dbLogId,
      env,
      ctx,
      incomingRequestId
    );

    // Track API call analytics (non-blocking)
    const webhookLatencyMs = Date.now() - startTime;
    ctx.waitUntil(
      trackAnalytics(env, "/track/api-call", {
        worker: "trade-worker",
        endpoint: "/webhook",
        latencyMs: webhookLatencyMs,
        success: tradeResult.success,
      })
    );

    return tradeResponse;
  } catch (error: unknown) {
    const errorMsg = toError(error, "Failed to process webhook request");
    logger.error(`Error in handleWebhookRequest for ID ${incomingRequestId}`, {
      error: errorMsg,
    });
    const response = Errors.internal(errorMsg);
    // Log error response if dbLogId was obtained
    if (dbLogId !== null) {
      await dbLogger.logResponse(dbLogId, response, error, startTime);
    } else {
      // Body already consumed by request.json() above, log URL and method instead
      try {
        logger.error("Failed to capture request body after error", {
          url: request.url,
          method: request.method,
        });
        dbLogId = await dbLogger.logRequest(
          request,
          `[body consumed] ${request.url}`
        );
        await dbLogger.logResponse(dbLogId, response, error, startTime);
      } catch (logError) {
        logger.error("Failed to log error response after initial failure", {
          error: toError(logError),
        });
      }
    }
    return response;
  }
}

/**
 * Handles the standardized processing request (/process endpoint).
 */
async function handleProcessRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const startTime = Date.now();
  const DbLoggerClass = env.__mocks__?.DbLogger || DbLogger;
  const dbLogger = new DbLoggerClass(env as ExecutionEnv);
  let dbLogId: string | null = null;
  let incomingRequestId: string | undefined;

  try {
    // Internal authentication check (before body parsing)
    const bodyPromise = request.json() as Promise<TradeProcessRequestBody>;

    const authError = requireInternalAuth(request, env, "INTERNAL_KEY_BINDING");
    if (authError) {
      logger.warn(`Authentication failed for request`);
      return authError;
    }

    const data: TradeProcessRequestBody = await bodyPromise;
    incomingRequestId = data?.requestId;

    logger.info(`Processing /process request ID: ${incomingRequestId}`);
    logger.info("Received standardized request", { data });

    // Log the request
    dbLogId = await dbLogger.logRequest(request, data);

    const payload = data?.payload;
    if (!payload) {
      const response = Errors.badRequest("Missing payload in request");
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    const validation = validateJson(WebhookPayloadSchema, payload);
    if (!validation.ok) {
      const response = Errors.badRequest(validation.error);
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    // *** Use validated payload ***
    const validatedPayload = validation.value;

    // *** Call executeTrade ***
    const tradeResult = await executeTrade(
      validatedPayload,
      env,
      dbLogger,
      startTime,
      dbLogId
    );
    const tradeResponse = createJsonResponse(
      tradeResult,
      tradeResult.status ?? (tradeResult.success ? 200 : 500)
    );

    // Queue R2 report save (if trade was successful)
    await queueReportSave(
      tradeResult,
      validatedPayload,
      dbLogId,
      env,
      ctx,
      incomingRequestId
    );

    // Track API call analytics (non-blocking)
    const processLatencyMs = Date.now() - startTime;
    ctx.waitUntil(
      trackAnalytics(env, "/track/api-call", {
        worker: "trade-worker",
        endpoint: "/process",
        latencyMs: processLatencyMs,
        success: tradeResult.success,
      })
    );

    return tradeResponse;
  } catch (error: unknown) {
    const errorMsg = toError(error, "Failed to process request");
    logger.error(`Error in handleProcessRequest for ID ${incomingRequestId}`, {
      error: errorMsg,
    });
    const response = Errors.internal(errorMsg);
    // Log error response if dbLogId was obtained
    if (dbLogId !== null) {
      await dbLogger.logResponse(dbLogId, response, error, startTime);
    } else {
      // Body already consumed by request.json() above, log URL and method instead
      try {
        logger.error("Failed to capture request body after error", {
          url: request.url,
          method: request.method,
        });
        dbLogId = await dbLogger.logRequest(
          request,
          `[body consumed] ${request.url}`
        );
        await dbLogger.logResponse(dbLogId, response, error, startTime);
      } catch (logError) {
        logger.error("Failed to log error response after initial failure", {
          error: toError(logError),
        });
      }
    }
    return response;
  }
}
