import { MexcClient, type IMexcClient } from "./mexc-client";
import { BinanceClient, type IBinanceClient } from "./binance-client";
import { BybitClient, type IBybitClient } from "./bybit-client";
import { DbLogger, type IDbLogger } from "./db-logger";
import { ExchangeRouter } from "./exchange-router";
import type { KVNamespace } from "@cloudflare/workers-types";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { D1Database } from "@cloudflare/workers-types";
import type { Queue, QueueEvent, MessageSendRequest, Fetcher } from "@cloudflare/workers-types";
import type { Ai } from "@cloudflare/ai";
import type { ExecutionContext } from "@cloudflare/workers-types";

// --- Type Definitions ---

// Define the expected environment variables and bindings from wrangler.toml
export interface Env {
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

// Generic client interface (adapt based on actual client methods)
export interface IExchangeClient {
  getAccountInfo: () => Promise<any>;
  setLeverage?: (symbol: string, leverage: number) => Promise<any>;
  openLong: (
    symbol: string,
    quantity: number,
    price?: number,
    orderType?: string
  ) => Promise<any>;
  openShort: (
    symbol: string,
    quantity: number,
    price?: number,
    orderType?: string
  ) => Promise<any>;
  closeLong: (symbol: string, quantity: number) => Promise<any>;
  closeShort: (symbol: string, quantity: number) => Promise<any>;
}

// Payload structure for incoming webhook requests
export interface WebhookPayload {
  exchange: string;
  action: "LONG" | "SHORT" | "CLOSE_LONG" | "CLOSE_SHORT";
  symbol: string;
  quantity: number;
  price?: number;
  orderType?: string;
  leverage?: number;
}

// Payload structure for legacy /process requests
interface ProcessRequestBody {
  requestId?: string;
  internalAuthKey?: string;
  payload: WebhookPayload; // Nested payload
}

interface ValidationResult {
  isValid: boolean;
  error?: string;
}

// Standardized response structure
interface StandardResponse {
  success: boolean;
  result?: unknown;
  error?: string | null;
}

// Structure for storing trade signals in D1
interface TradeSignalRecord {
  signal_id: string;
  timestamp: number;
  symbol: string;
  signal_type: string;
  source?: string;
  raw_data?: string;
}

// --- Constants ---
const MAX_RETRIES = 5;
const BACKOFF_DELAYS = [0, 30, 60, 300, 900]; // 0s, 30s, 1m, 5m, 15m
const PROCESS_ENDPOINT = "/process"; // For legacy/direct calls with internal key
const WEBHOOK_ENDPOINT = "/webhook"; // For calls from hoox via Service Binding
const SIGNALS_ENDPOINT = "/api/signals"; // New endpoint for D1 signals

// --- Queue Consumer Helper Functions ---

async function handleTestAiRequest(request: Request, env: Env): Promise<Response> {
  try {
    if (!env.AI) {
      return new Response(JSON.stringify({ error: "AI not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    const body = await request.json() as { prompt?: string };
    const response = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
      messages: [{ role: "user", content: body.prompt || "Say hello" }],
    });
    
    return new Response(JSON.stringify({ success: true, result: response }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: String(error) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function executeTradeFromQueue(
  trade: TradeQueueMessage,
  env: Env
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    const payload: WebhookPayload = {
      exchange: trade.exchange,
      action: trade.action as WebhookPayload['action'],
      symbol: trade.symbol,
      quantity: trade.quantity,
      price: trade.price,
      leverage: trade.leverage,
    };
    
    const dbLogger = new DbLogger(env as any);
    const startTime = Date.now();
    const response = await executeTrade(payload, env, dbLogger, startTime, null);
    const result = await response.json() as { success?: boolean; result?: unknown; error?: string };
    
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
        params: ["ERROR", "queue-consumer", `Trade failed: ${trade.requestId}`, JSON.stringify({ trade, error: errorMsg })],
      };
      
      await env.D1_SERVICE.fetch(
        new Request("http://d1-service/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(logPayload),
        }) as any
      );
    }
  } catch (e) {
    console.error("Failed to log failed trade:", e);
  }
}

// --- Worker Definition ---

type QueueMessage = {
  requestId: string;
  exchange: string;
  action: string;
  symbol: string;
  quantity: number;
  price?: number;
  leverage?: number;
  queuedAt: string;
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const debugEndpointsEnabled = env.ENABLE_DEBUG_ENDPOINTS === "true";

    // Handle queue consumer invocations
    if (request.method === "POST" && url.pathname === "/queue") {
      return new Response(JSON.stringify({ queue: "consumer" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Call the shared KV logging function
    // await logKvTimestamp(env); // Temporarily commented out due to test module resolution issues

    // --- Add GET endpoint for retrieving R2 reports ---
    if (request.method === "GET" && url.pathname === "/report") {
      return await handleGetReportRequest(request, env);
    } else if (url.pathname === SIGNALS_ENDPOINT) {
      // Handle GET and POST for D1 signals
      if (request.method === "GET") {
        return await handleGetSignalsRequest(request, env);
      } else if (request.method === "POST") {
        return await handlePostSignalRequest(request, env);
      }
    }
    // --- End R2 report endpoint ---

    // --- Add worker health check endpoint ---
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          timestamp: new Date().toISOString(),
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // --- Add temporary GET endpoint for testing AI ---
    if (request.method === "GET" && url.pathname === "/test-ai") {
      if (!debugEndpointsEnabled) {
        return new Response("Debug endpoints not enabled", { status: 403 });
      }
      return handleTestAiRequest(request, env);
    }

    // --- Process Trade Webhook ---
    if (request.method === "POST" && url.pathname === WEBHOOK_ENDPOINT) {
      return await handleWebhookRequest(request, env, ctx);
    }

    // --- Process Legacy Endpoint ---
    if (request.method === "POST" && url.pathname === PROCESS_ENDPOINT) {
      return await handleProcessRequest(request, env, ctx);
    }

    // --- Default: Return 404 ---
    return new Response("Not Found", { status: 404 });
  },

  async queue(messages: QueueEvent<QueueMessage>[], env: Env): Promise<void> {
    console.log(`[QueueHandler] Received ${messages.length} message(s)`);

    for (const msg of messages) {
      const trade = (msg as unknown as { body: QueueMessage }).body;
      console.log(`[QueueHandler] Processing trade: ${trade.requestId} - ${trade.action} ${trade.symbol}`);

      const retryCount = (msg as any).retry?.count || 0;

      try {
        const result = await executeTradeFromQueue(trade, env);

        if (result.success) {
          console.log(`[QueueHandler] Trade executed: ${trade.requestId}`);
          await sendTradeNotification(trade, env, result);
        } else {
          throw new Error(result.error || "Trade execution failed");
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[QueueHandler] Trade failed: ${trade.requestId}, attempt ${retryCount + 1}, error: ${errorMsg}`);

        if (retryCount < MAX_RETRIES) {
          const delaySeconds = BACKOFF_DELAYS[retryCount] || BACKOFF_DELAYS[MAX_RETRIES - 1];
          console.log(`[QueueHandler] Scheduling retry for ${trade.requestId} in ${delaySeconds}s`);

          (msg as any).retry?.({
            delaySeconds,
          });
        } else {
          console.error(`[QueueHandler] Max retries exceeded for ${trade.requestId}`);
          await logFailedTrade(trade, errorMsg, env);
          await sendTradeNotification(trade, env, { success: false, error: errorMsg });
        }
      }
    }
  },
};

// --- Helper Functions ---

/**
 * Checks if API credentials seem configured for a given exchange.
 */
export async function validateApiCredentials(
  exchange: string,
  env: Env
): Promise<boolean> {
  const checkBinding = async (
    keyBinding?: string,
    secretBinding?: string
  ) => {
    try {
      const key = keyBinding;
      const secret = secretBinding;
      return !!key && !!secret;
    } catch {
      return false;
    }
  };

  switch (exchange.toLowerCase()) {
    case "mexc":
      return await checkBinding(env.MEXC_KEY_BINDING, env.MEXC_SECRET_BINDING);
    case "binance":
      return await checkBinding(
        env.BINANCE_KEY_BINDING,
        env.BINANCE_SECRET_BINDING
      );
    case "bybit":
      return await checkBinding(
        env.BYBIT_KEY_BINDING,
        env.BYBIT_SECRET_BINDING
      );
    default:
      return false;
  }
}

/**
 * Validates the core trade payload structure and content.
 */
export function validateTradePayload(payload: any): ValidationResult {
  // Use any initially, then refine
  if (!payload || typeof payload !== "object") {
    return { isValid: false, error: "Invalid or missing payload" };
  }

  const { exchange, action, symbol, quantity } = payload as WebhookPayload;

  if (
    !exchange ||
    !action ||
    !symbol ||
    quantity === undefined ||
    quantity === null
  ) {
    return { isValid: false, error: "Missing required fields in payload" };
  }

  const validActions: WebhookPayload["action"][] = [
    "LONG",
    "SHORT",
    "CLOSE_LONG",
    "CLOSE_SHORT",
  ];
  if (
    !validActions.includes(action.toUpperCase() as WebhookPayload["action"])
  ) {
    return { isValid: false, error: `Invalid action in payload: ${action}` };
  }

  if (typeof quantity !== "number" || isNaN(quantity) || quantity <= 0) {
    return { isValid: false, error: "Invalid quantity in payload" };
  }

  // Add further checks (e.g., price/leverage types if present)
  if (
    payload.price !== undefined &&
    (typeof payload.price !== "number" || isNaN(payload.price))
  ) {
    return { isValid: false, error: "Invalid price in payload" };
  }
  if (
    payload.leverage !== undefined &&
    (typeof payload.leverage !== "number" ||
      isNaN(payload.leverage) ||
      !Number.isInteger(payload.leverage) ||
      payload.leverage <= 0)
  ) {
    return { isValid: false, error: "Invalid leverage in payload" };
  }

  return { isValid: true };
}

/**
 * Creates a standard JSON response.
 */
function createJsonResponse(
  body: StandardResponse,
  status: number = 200
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Saves a trade report object to the R2 bucket.
 * Task 3.5 & 3.6
 */
export async function saveReportToR2(
  reportData: any, // The trade result or formatted report data
  payload: WebhookPayload,
  dbLogId: string | null, // Changed to string
  env: Env
): Promise<void> {
  if (!env.REPORTS_BUCKET) {
    console.error(
      `[${dbLogId}] REPORTS_BUCKET binding is not configured. Skipping report save.`
    );
    return;
  }

  try {
    // Format a simple report (can be expanded later)
    const reportContent = JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        tradePayload: payload,
        tradeResult: reportData,
        dbLogId: dbLogId,
      },
      null,
      2
    );

    // Generate a unique filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-"); // Filesystem-friendly timestamp
    const filename = `trade-reports/${payload.exchange}/${payload.symbol}/${timestamp}-${dbLogId || "no-id"}.json`;

    console.log(`[${dbLogId}] Attempting to save report to R2: ${filename}`);

    // Put the object into the R2 bucket
    const r2Object = await env.REPORTS_BUCKET.put(filename, reportContent, {
      httpMetadata: { contentType: "application/json" },
      // Optionally add custom metadata
      // customMetadata: {
      //   exchange: payload.exchange,
      //   symbol: payload.symbol,
      //   action: payload.action,
      // },
    });

    console.log(
      `[${dbLogId}] Successfully saved report to R2. ETag: ${r2Object?.etag}`
    );
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : String(error || "Unknown R2 error");
    console.error(
      `[${dbLogId}] Failed to save report to R2: ${errorMsg}`,
      error
    );
    // Decide if this error should trigger an alert or other action
  }
}

// --- Core Trade Execution Logic ---

/**
 * Core logic to process a validated trade payload.
 */
async function executeTrade(
  payload: WebhookPayload,
  env: Env,
  dbLogger: IDbLogger,
  startTime: number,
  dbLogId: string | null // Changed to string
): Promise<Response> {
  try {
    const {
      exchange,
      action,
      symbol,
      quantity,
      price,
      orderType = "MARKET",
      leverage,
    } = payload;

    // --- Risk Management via CONFIG_KV ---
    let overriddenLeverage = leverage;
    let maxPositionSize: number | null = null;
    
    try {
        if (env.CONFIG_KV) {
            const defaultLevStr = await env.CONFIG_KV.get('trade:default_leverage');
            if (defaultLevStr && !overriddenLeverage) {
               overriddenLeverage = parseInt(defaultLevStr, 10);
               console.log(`[Risk Management] Applied default leverage: ${overriddenLeverage}`);
            }
            const maxSizeStr = await env.CONFIG_KV.get('trade:max_position_size');
            if (maxSizeStr) {
               maxPositionSize = parseFloat(maxSizeStr);
            }
        }
    } catch(e) {
        console.error("Failed to fetch risk management settings from KV:", e);
    }

    if (maxPositionSize !== null && quantity > maxPositionSize) {
        const errorMsg = `Trade quantity (${quantity}) exceeds maximum allowed size (${maxPositionSize})`;
        console.error(errorMsg);
        const response = createJsonResponse({ success: false, error: errorMsg }, 400);
        await dbLogger.logResponse(dbLogId, response, null, startTime);
        return response;
    }
    // --- End Risk Management ---

    const router = new ExchangeRouter();
    
    let client: IExchangeClient;
    let routedExchange = exchange;

    try {
        const routeResult = await router.route(payload, env);
        client = routeResult.client;
        routedExchange = routeResult.exchange;
    } catch (e: any) {
        const errorMsg = e.message || `Failed to route exchange: ${exchange}`;
        console.error(errorMsg);
        const response = createJsonResponse({ success: false, error: errorMsg }, 400);
        await dbLogger.logResponse(dbLogId, response, null, startTime);
        return response;
    }

    if (client.setLeverage && overriddenLeverage) {
      try {
        await client.setLeverage(symbol, overriddenLeverage);
      } catch (leverageError) {
        console.error(`Failed to set leverage:`, leverageError);
        // Continue with trade execution even if setting leverage fails
      }
    }

    let result: any;
    switch (action.toUpperCase()) {
      case "LONG":
        result = await client.openLong(symbol, quantity, price, orderType);
        break;
      case "SHORT":
        result = await client.openShort(symbol, quantity, price, orderType);
        break;
      case "CLOSE_LONG":
        result = await client.closeLong(symbol, quantity);
        break;
      case "CLOSE_SHORT":
        result = await client.closeShort(symbol, quantity);
        break;
      // No default needed due to validation earlier
    }

    console.log("Trade execution successful:", result);
    
    // --- Update D1 Tables (Trades and Positions) ---
    if (env.D1_SERVICE) {
      try {
         const tradeId = crypto.randomUUID();
         const tradeStatus = 'EXECUTED'; // Assuming success if it reached here
         
         const tradePayload = {
            query: `INSERT INTO trades (id, timestamp, exchange, symbol, action, quantity, price, leverage, status, raw_response) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
               tradeId,
               Math.floor(Date.now() / 1000),
               routedExchange,
               symbol,
               action,
               quantity,
               price || null,
               overriddenLeverage || null,
               tradeStatus,
               JSON.stringify(result)
            ]
         };
await env.D1_SERVICE.fetch(new Request('http://d1-service/query', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(tradePayload)
          }) as any);

         // Update or insert into positions table
         const side = action.includes('LONG') ? 'LONG' : 'SHORT';
         const posStatus = action.startsWith('CLOSE') ? 'CLOSED' : 'OPEN';
         const posId = `${routedExchange}-${symbol}-${side}`;
         
         const posPayload = {
             query: `REPLACE INTO positions (id, exchange, symbol, side, size, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
             params: [
                posId,
                routedExchange,
                symbol,
                side,
                posStatus === 'OPEN' ? quantity : 0, // Simplify size logic for now
                posStatus,
                Math.floor(Date.now() / 1000)
             ]
         };
await env.D1_SERVICE.fetch(new Request('http://d1-service/query', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(posPayload)
          }) as any);
      } catch (e) {
         console.error("Failed to update D1 trades and positions tables", e);
      }
    }

    const response = createJsonResponse({
      success: true,
      result: result,
      error: null,
    });
    await dbLogger.logResponse(dbLogId, response, null, startTime);

    // --- Send notification via telegram-worker after trade execution ---
    if (env.TELEGRAM_SERVICE) {
      try {
        const notificationMessage = result?.success
          ? `Trade executed successfully on ${routedExchange}: ${action} ${quantity} ${symbol}. Result: ${JSON.stringify(result.result)}`
          : `Trade execution failed on ${routedExchange}: ${action} ${quantity} ${symbol}. Error: ${result?.error || "Unknown error"}`;

        const telegramPayload = {
          message: notificationMessage,
        };

        const telegramWorkerRequest = new Request(
          "https://internal/webhook", // Service binding uses internal URL
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(telegramPayload),
          }
        );

        // Add internal auth key if configured
        if (env.TELEGRAM_INTERNAL_KEY_BINDING) {
          const internalKey = env.TELEGRAM_INTERNAL_KEY_BINDING;
          if (internalKey) {
            telegramWorkerRequest.headers.set(
              "X-Internal-Auth-Key",
              internalKey
            );
          }
        }

        console.log(
          `[${dbLogId}] Calling TELEGRAM_SERVICE for notification...`
        );
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

    return response;
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : String(error || "Internal server error");
    console.error("Error in executeTrade:", errorMsg, error);
    const response = createJsonResponse(
      { success: false, error: `Trade execution failed: ${errorMsg}` },
      500
    );
    // Log failure response, even if dbLogId might be null in edge cases
    if (dbLogger && dbLogId !== null) {
      try {
        await dbLogger.logResponse(dbLogId, response, null, startTime);
      } catch (logErr) {
        console.error("Failed to log error response to D1:", logErr);
      }
    }
    return response;
  }
}

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
      console.error("INTERNAL_KEY_BINDING not configured for /webhook endpoint.");
      const response = createJsonResponse(
        { success: false, error: "Service configuration error" },
        500
      );
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    if (!internalAuthKey || internalAuthKey !== expectedInternalKey) {
      console.warn(`Authentication failed for webhook request ID: ${incomingRequestId}`);
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

    // --- Task 3.5: Save Report on Success ---
    if (tradeResponse.ok) {
      // Check if trade execution itself was successful
      try {
        const tradeResult = (await tradeResponse.clone().json()) as any; // Need the result for the report
        if (tradeResult.success) {
          console.log(
            `[${incomingRequestId}] Trade successful, queueing report save to R2.`
          );
          ctx.waitUntil(
            saveReportToR2(tradeResult.result, payload, dbLogId, env)
          );
        } else {
          console.log(
            `[${incomingRequestId}] Trade execution reported failure, skipping R2 report save.`
          );
        }
      } catch (e) {
        console.error(
          `[${incomingRequestId}] Failed to parse trade response for R2 reporting:`,
          e
        );
      }
    }
    // --- End Task 3.5 ---

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
    const data: ProcessRequestBody = await request.json();
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

    // --- Task 3.5: Save Report on Success ---
    if (tradeResponse.ok) {
      // Check if trade execution itself was successful
      try {
        const tradeResult = (await tradeResponse.clone().json()) as any; // Need the result for the report
        if (tradeResult.success) {
          console.log(
            `[${incomingRequestId}] Trade successful, queueing report save to R2.`
          );
          ctx.waitUntil(
            saveReportToR2(tradeResult.result, payload, dbLogId, env)
          );
        } else {
          console.log(
            `[${incomingRequestId}] Trade execution reported failure, skipping R2 report save.`
          );
        }
      } catch (e) {
        console.error(
          `[${incomingRequestId}] Failed to parse trade response for R2 reporting:`,
          e
        );
      }
    }
    // --- End Task 3.5 ---

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

/**
 * Handles GET requests to retrieve a specific report from R2.
 * Expects a 'key' query parameter specifying the R2 object key.
 * Task 3.5
 */
async function handleGetReportRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (!key) {
    return new Response("Missing 'key' query parameter", { status: 400 });
  }

  if (!env.REPORTS_BUCKET) {
    console.error("REPORTS_BUCKET binding is not configured.");
    return new Response("R2 service not configured.", { status: 500 });
  }

  try {
    console.log(`Attempting to retrieve R2 object with key: ${key}`);
    const object = await env.REPORTS_BUCKET.get(key);

    if (object === null) {
      console.log(`R2 object not found for key: ${key}`);
      return new Response("Report not found", { status: 404 });
    }

    console.log(
      `Successfully retrieved R2 object: ${key}, Size: ${object.size}`
    );

    // Prepare headers for the response
    const headers = new Headers() as any;
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);

    // Stream the body back
    return new Response(object.body as any, {
      headers,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : String(error || "Unknown R2 get error");
    console.error(`Failed to retrieve R2 object ${key}: ${errorMsg}`, error);
    return new Response(`Failed to retrieve report: ${errorMsg}`, {
      status: 500,
    });
  }
}

/**
 * Temporary handler for testing basic Workers AI LLM calls.
 * Expects a 'prompt' query parameter.
 * REMOVE OR SECURE BEFORE PRODUCTION.
 */
async function handleAiTest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const prompt = url.searchParams.get("prompt");

  if (!prompt) {
    return createJsonResponse(
      { success: false, error: "Missing 'prompt' query parameter" },
      400
    );
  }

  if (!env.AI) {
    console.error("AI binding is not configured in the environment.");
    return createJsonResponse(
      { success: false, error: "AI service not available." },
      500
    );
  }

  try {
    console.log(`Sending prompt to AI: "${prompt}"`);

    // Basic call to the LLM
    const response = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
      messages: [
        { role: "system", content: "You are a trading assistant." }, // Adjusted system prompt
        { role: "user", content: prompt },
      ],
    });

    console.log("Received AI response.");
    return createJsonResponse({ success: true, result: response }, 200);
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : String(error || "Unknown AI error");
    console.error(`Error calling AI: ${errorMsg}`, error);
    return createJsonResponse(
      { success: false, error: `AI request failed: ${errorMsg}` },
      500
    );
  }
}

// --- D1 Helper Functions ---

/**
 * Inserts a trade signal into the D1 database.
 */
async function insertSignal(
  signal: TradeSignalRecord,
  env: Env
): Promise<D1Result> {
  if (!env.DB) {
    throw new Error("D1 Database (DB) binding not configured.");
  }
  const stmt = env.DB.prepare(
    `INSERT INTO trade_signals (signal_id, timestamp, symbol, signal_type, source, raw_data) 
         VALUES (?, ?, ?, ?, ?, ?)`
  );
  return await stmt
    .bind(
      signal.signal_id,
      signal.timestamp,
      signal.symbol,
      signal.signal_type,
      signal.source ?? null, // Use null if source is undefined
      signal.raw_data ?? null // Use null if raw_data is undefined
    )
    .run();
}

/**
 * Retrieves recent trade signals from the D1 database.
 */
async function getRecentSignals(
  env: Env,
  limit: number = 10
): Promise<D1Result<TradeSignalRecord>> {
  if (!env.DB) {
    throw new Error("D1 Database (DB) binding not configured.");
  }
  const stmt = env.DB.prepare(
    `SELECT signal_id, timestamp, symbol, signal_type, source, processed_at 
         FROM trade_signals 
         ORDER BY processed_at DESC 
         LIMIT ?`
  );
  return await stmt.bind(limit).all<TradeSignalRecord>();
}

// --- Request Handlers for D1 ---

/**
 * Handles POST requests to insert a new trade signal into D1.
 */
async function handlePostSignalRequest(
  request: Request,
  env: Env
): Promise<Response> {
  let signalPayload: any;
  try {
    signalPayload = await request.json();
  } catch (e) {
    return createJsonResponse(
      { success: false, error: "Invalid JSON payload" },
      400
    );
  }

  // Basic validation (expand as needed)
  if (
    !signalPayload.symbol ||
    !signalPayload.signal_type ||
    !signalPayload.timestamp
  ) {
    return createJsonResponse(
      {
        success: false,
        error: "Missing required fields: symbol, signal_type, timestamp",
      },
      400
    );
  }

  const signalRecord: TradeSignalRecord = {
    signal_id: crypto.randomUUID(), // Generate a unique ID
    timestamp: signalPayload.timestamp, // Assume provided timestamp is correct
    symbol: signalPayload.symbol,
    signal_type: signalPayload.signal_type,
    source: signalPayload.source,
    raw_data: JSON.stringify(signalPayload), // Store the whole payload as raw data
  };

  try {
    const result = await insertSignal(signalRecord, env);
    if (result.success) {
      console.log(`Successfully inserted signal ID: ${signalRecord.signal_id}`);
      return createJsonResponse(
        { success: true, result: { signalId: signalRecord.signal_id } },
        201
      ); // 201 Created
    } else {
      console.error("D1 insert failed:", result.error);
      return createJsonResponse(
        { success: false, error: "Failed to store signal in database." },
        500
      );
    }
  } catch (error) {
    console.error("Error inserting signal into D1:", error);
    return createJsonResponse(
      { success: false, error: "Internal server error while storing signal." },
      500
    );
  }
}

/**
 * Handles GET requests to retrieve recent trade signals from D1.
 */
async function handleGetSignalsRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? parseInt(limitParam, 10) : 10;

  if (isNaN(limit) || limit <= 0 || limit > 100) {
    // Add reasonable limit bounds
    return createJsonResponse(
      {
        success: false,
        error: "Invalid limit parameter. Must be between 1 and 100.",
      },
      400
    );
  }

  try {
    const results = await getRecentSignals(env, limit);
    return createJsonResponse(
      { success: true, result: results.results || [] },
      200
    );
  } catch (error) {
    console.error("Error retrieving signals from D1:", error);
    return createJsonResponse(
      {
        success: false,
        error: "Internal server error while retrieving signals.",
      },
      500
    );
  }
}

// --- Queue Consumer Handler ---
interface TradeQueueMessage {
  requestId: string;
  exchange: string;
  action: string;
  symbol: string;
  quantity: number;
  price?: number;
  leverage?: number;
  queuedAt: string;
}

export const queue = async (
  messages: QueueEvent<TradeQueueMessage>[],
  env: Env,
  ctx: ExecutionContext
): Promise<void> => {
  console.log(`[Queue] Received ${messages.length} message(s)`);

  for (const msg of messages) {
    const trade = (msg as unknown as { body: TradeQueueMessage }).body;
    console.log(`[Queue] Processing trade: ${trade.requestId} - ${trade.action} ${trade.symbol}`);

    // Get retry count from message metadata
    const retryCount = (msg as { retry?: { count: number } }).retry?.count || 0;

    try {
      // Execute the trade
      const result = await executeTradeFromQueue(trade, env);

      if (result.success) {
        console.log(`[Queue] Trade executed successfully: ${trade.requestId}`);
        // Send notification if configured
        await sendTradeNotification(trade, env, result);
      } else {
        throw new Error(result.error || "Trade execution failed");
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Queue] Trade failed: ${trade.requestId}, attempt ${retryCount + 1}, error: ${errorMsg}`);

      if (retryCount < MAX_RETRIES) {
        const delaySeconds = BACKOFF_DELAYS[retryCount] || BACKOFF_DELAYS[MAX_RETRIES - 1];
        console.log(`[Queue] Scheduling retry for ${trade.requestId} in ${delaySeconds}s (attempt ${retryCount + 2})`);

        // Re-queue with delay using the message's retry mechanism
        (msg as any).retry?.({
          delaySeconds,
        });
      } else {
        console.error(`[Queue] Max retries exceeded for ${trade.requestId}, moving to DLQ`);

        // Log failure to D1 for tracking
        await logFailedTrade(trade, errorMsg, env);

        // Send failure notification
        await sendTradeNotification(trade, env, { success: false, error: errorMsg });
      }
    }
  }
};

/**
 * Send notification about trade status
 */
async function sendTradeNotification(
  trade: TradeQueueMessage,
  env: Env,
  result: { success: boolean; error?: string; result?: unknown }
): Promise<void> {
  if (!env.TELEGRAM_SERVICE) return;

  try {
    const message = result.success
      ? `✅ Trade Executed (Queue): ${trade.action} ${trade.symbol} x${trade.quantity}`
      : `❌ Trade Failed (Queue): ${trade.action} ${trade.symbol} - ${result.error}`;

    await env.TELEGRAM_SERVICE?.fetch(
      new Request("http://telegram-service/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
        }),
      }) as any
    );
  } catch (e) {
    console.error("[Queue] Failed to send notification:", e);
  }
}
