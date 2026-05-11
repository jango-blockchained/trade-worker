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
  createErrorResponse,
  Errors,
  createJsonResponse,
} from "@jango-blockchained/hoox-shared/errors";
import {
  createLogger,
  withRequestLog,
} from "@jango-blockchained/hoox-shared/middleware";
import { createRouter } from "@jango-blockchained/hoox-shared/router";
import {
  WebhookPayload,
  ProcessRequestBody,
} from "@jango-blockchained/hoox-shared/types";
import { trackAnalytics } from "@jango-blockchained/hoox-shared/analytics";
import type { AnalyticsEnv } from "@jango-blockchained/hoox-shared/analytics";
import { healthCheck } from "@jango-blockchained/hoox-shared/health";
import { KVKeys } from "@jango-blockchained/hoox-shared/kvKeys";
import {
  executeTrade,
  validateTradePayload,
  validateApiCredentials,
  updateD1TradeRecords,
  type ExecutionEnv,
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

// Define the expected environment variables and bindings from wrangler.toml
export interface Env extends AnalyticsEnv {
  // Database
  DB?: D1Database;

  // KV Namespace
  CONFIG_KV?: KVNamespace;

  // Secrets
  INTERNAL_KEY_BINDING?: string;
  TELEGRAM_INTERNAL_KEY_BINDING?: string;
  MEXC_KEY_BINDING?: string;
  MEXC_SECRET_BINDING?: string;
  BINANCE_KEY_BINDING?: string;
  BINANCE_SECRET_BINDING?: string;
  BYBIT_KEY_BINDING?: string;
  BYBIT_SECRET_BINDING?: string;
  TRADE_QUEUE?: Queue;

  // Optional Mocks for Testing
  __mocks__?: {
    MexcClient?: typeof MexcClient; // Constructor type
    BinanceClient?: typeof BinanceClient;
    BybitClient?: typeof BybitClient;
    DbLogger?: typeof DbLogger;
  };

  ENABLE_DEBUG_ENDPOINTS?: string;
  AI?: Ai;
  D1_SERVICE?: Fetcher;
  REPORTS_BUCKET?: R2Bucket;
  TELEGRAM_SERVICE?: Fetcher;

  // Add other variables/bindings if needed
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

    const dbLogger = new DbLogger(env as any);
    const startTime = Date.now();
    const response = await executeTrade(
      payload,
      env,
      dbLogger,
      startTime,
      null
    );
    const result = (await response.json()) as {
      success?: boolean;
      result?: unknown;
      error?: string;
    };

    return {
      success: result.success ?? false,
      result: result.result,
      error: result.error,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMsg };
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
        }) as any
      );
    }
  } catch (error: unknown) {
    console.error("Failed to log failed trade:", error);
  }
}

// --- Worker Definition ---

const logger = createLogger({ service: "trade-worker", module: "router" });

/**
 * Helper: queue R2 report save on successful trade execution.
 * Extracted to avoid duplicating this pattern across webhook + process handlers.
 */
async function queueReportSave(
  tradeResponse: Response,
  payload: WebhookPayload,
  dbLogId: string | null,
  env: Env,
  ctx: ExecutionContext,
  requestId: string | undefined
): Promise<void> {
  if (tradeResponse.ok) {
    try {
      const tradeResult = (await tradeResponse.clone().json()) as any;
      if (tradeResult.success) {
        console.log(
          `[${requestId}] Trade successful, queueing report save to R2.`
        );
        ctx.waitUntil(saveReportToR2(tradeResult.result, payload, dbLogId, env));
      } else {
        console.log(
          `[${requestId}] Trade execution reported failure, skipping R2 report save.`
        );
      }
    } catch (e) {
      console.error(
        `[${requestId}] Failed to parse trade response for R2 reporting:`,
        e
      );
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
    console.log(`[Queue] Received ${messages.length} message(s)`);

    for (const msg of messages) {
      const trade = (msg as unknown as { body: TradeQueueMessage }).body;
      console.log(
        `[Queue] Processing trade: ${trade.requestId} - ${trade.action} ${trade.symbol}`
      );

      // Get retry count from message metadata
      const retryCount =
        (msg as { retry?: { count: number } }).retry?.count || 0;

      try {
        // Execute the trade
        const result = await executeTradeFromQueue(trade, env);

        if (result.success) {
          console.log(
            `[Queue] Trade executed successfully: ${trade.requestId}`
          );
          // Send notification if configured
          await sendTradeNotification(trade, env, result);
        } else {
          throw new Error(result.error || "Trade execution failed");
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `[Queue] Trade failed: ${trade.requestId}, attempt ${retryCount + 1}, error: ${errorMsg}`
        );

        if (retryCount < MAX_RETRIES) {
          const delaySeconds =
            BACKOFF_DELAYS[retryCount] || BACKOFF_DELAYS[MAX_RETRIES - 1];
          console.log(
            `[Queue] Scheduling retry for ${trade.requestId} in ${delaySeconds}s (attempt ${retryCount + 2})`
          );

          // Re-queue with delay using the message's retry mechanism
          (msg as any).retry?.({
            delaySeconds,
          });
        } else {
          console.error(
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
  const dbLogger = new DbLoggerClass(env as any);
  let dbLogId: string | null = null;
  const incomingRequestId =
    request.headers.get("X-Request-ID") || crypto.randomUUID();

  try {
    const payload: WebhookPayload = await request.json();
    console.log(`Processing webhook request ID: ${incomingRequestId}`);
    console.log("Received webhook payload:", JSON.stringify(payload, null, 2));

    // Assuming logRequest can handle the payload directly and returns a number ID
    // Might need adjustment based on DbLogger implementation
    dbLogId = await dbLogger.logRequest(request, payload);

    // Internal authentication check
    const internalAuthKey = request.headers.get("X-Internal-Auth-Key");
    const expectedInternalKey = env.INTERNAL_KEY_BINDING;

    if (!expectedInternalKey) {
      console.error(
        "INTERNAL_KEY_BINDING not configured for /webhook endpoint."
      );
      const response = createJsonResponse(
        { success: false, error: "Service configuration error" },
        500
      );
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    if (!internalAuthKey || internalAuthKey !== expectedInternalKey) {
      console.warn(
        `Authentication failed for webhook request ID: ${incomingRequestId}`
      );
      const response = createJsonResponse(
        { success: false, error: "Unauthorized" },
        403
      );
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    const validation = validateTradePayload(payload);
    if (!validation.isValid) {
      const response = createJsonResponse(
        { success: false, error: validation.error },
        400
      );
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    // *** Call executeTrade ***
    const tradeResponse = await executeTrade(
      payload,
      env,
      dbLogger,
      startTime,
      dbLogId
    );

    // Queue R2 report save (if trade was successful)
    await queueReportSave(tradeResponse, payload, dbLogId, env, ctx, incomingRequestId);

    // Track API call analytics (non-blocking)
    const webhookLatencyMs = Date.now() - startTime;
    trackAnalytics(env, "/track/api-call", {
      worker: "trade-worker",
      endpoint: "/webhook",
      latencyMs: webhookLatencyMs,
      success: tradeResponse.ok,
    });

    return tradeResponse; // Return the original trade response
  } catch (error: any) {
    console.error(
      `Error in handleWebhookRequest for ID ${incomingRequestId}:`,
      error
    );
    const response = createJsonResponse(
      {
        success: false,
        error: error.message || "Failed to process webhook request",
      },
      500
    );
    // Log error response if dbLogId was obtained
    if (dbLogId !== null) {
      await dbLogger.logResponse(dbLogId, response, error, startTime);
    } else {
      try {
        const rawBody = await request.clone().text();
        dbLogId = await dbLogger.logRequest(request, rawBody); // Log raw body
        await dbLogger.logResponse(dbLogId, response, error, startTime);
      } catch (logError) {
        console.error(
          "Failed to log error response after initial failure:",
          logError
        );
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
  const dbLogger = new DbLoggerClass(env as any);
  let dbLogId: string | null = null;
  let incomingRequestId: string | undefined;

  try {
    const data: TradeProcessRequestBody = await request.json();
    incomingRequestId = data?.requestId;
    const internalAuthKey = data?.internalAuthKey;

    console.log(`Processing /process request ID: ${incomingRequestId}`);
    console.log(
      "Received standardized request:",
      JSON.stringify(data, null, 2)
    );

    // Log the request *before* authentication check
    // Pass the full original body data for logging
    dbLogId = await dbLogger.logRequest(request, data);

    const expectedInternalKey = env.INTERNAL_KEY_BINDING;

    if (!expectedInternalKey) {
      console.error(
        "INTERNAL_KEY_BINDING binding not configured or accessible."
      );
      const response = createJsonResponse(
        { success: false, error: "Service configuration error" },
        500
      );
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    if (!internalAuthKey || internalAuthKey !== expectedInternalKey) {
      console.warn(
        `Authentication failed for request ID: ${incomingRequestId}`
      );
      const response = createJsonResponse(
        { success: false, error: "Authentication failed" },
        403
      );
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    const payload = data?.payload;
    if (!payload) {
      const response = createJsonResponse(
        { success: false, error: "Missing payload in request" },
        400
      );
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    const validation = validateTradePayload(payload);
    if (!validation.isValid) {
      const response = createJsonResponse(
        { success: false, error: validation.error },
        400
      );
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    // *** Call executeTrade ***
    const tradeResponse = await executeTrade(
      payload,
      env,
      dbLogger,
      startTime,
      dbLogId
    );

    // Queue R2 report save (if trade was successful)
    await queueReportSave(tradeResponse, payload, dbLogId, env, ctx, incomingRequestId);

    // Track API call analytics (non-blocking)
    const processLatencyMs = Date.now() - startTime;
    trackAnalytics(env, "/track/api-call", {
      worker: "trade-worker",
      endpoint: "/process",
      latencyMs: processLatencyMs,
      success: tradeResponse.ok,
    });

    return tradeResponse; // Return the original trade response
  } catch (error: any) {
    console.error(
      `Error in handleProcessRequest for ID ${incomingRequestId}:`,
      error
    );
    const response = createJsonResponse(
      {
        success: false,
        error: error.message || "Failed to process request",
      },
      500
    );
    // Log error response if dbLogId was obtained
    if (dbLogId !== null) {
      await dbLogger.logResponse(dbLogId, response, error, startTime);
    } else {
      // Attempt to log the raw request if logging failed earlier
      try {
        const rawBody = await request.clone().text();
        dbLogId = await dbLogger.logRequest(request, rawBody); // Log raw body
        await dbLogger.logResponse(dbLogId, response, error, startTime);
      } catch (logError) {
        console.error(
          "Failed to log error response after initial failure:",
          logError
        );
      }
    }
    return response;
  }
}
