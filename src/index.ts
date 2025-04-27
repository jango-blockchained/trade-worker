import { MexcClient, type IMexcClient } from "./mexc-client"; // Removed .js
import { BinanceClient, type IBinanceClient } from "./binance-client"; // Removed .js
import { BybitClient, type IBybitClient } from "./bybit-client"; // Removed .js
import { DbLogger, type IDbLogger } from "./db-logger"; // Removed .js

// --- Type Definitions ---

interface SecretBinding {
  get: () => Promise<string | null>;
}

// Define the expected environment variables and bindings
interface Env {
  // Bindings from wrangler.toml
  D1_SERVICE?: Fetcher; // Service binding for d1-worker
  INTERNAL_KEY_BINDING?: SecretBinding; // For internal auth (expects WEBHOOK_INTERNAL_KEY)
  MEXC_KEY_BINDING?: SecretBinding;
  MEXC_SECRET_BINDING?: SecretBinding;
  BINANCE_KEY_BINDING?: SecretBinding;
  BINANCE_SECRET_BINDING?: SecretBinding;
  BYBIT_KEY_BINDING?: SecretBinding;
  BYBIT_SECRET_BINDING?: SecretBinding;

  // Optional Mocks for Testing
  __mocks__?: {
    MexcClient?: typeof MexcClient; // Constructor type
    BinanceClient?: typeof BinanceClient;
    BybitClient?: typeof BybitClient;
    DbLogger?: typeof DbLogger;
  };

  // Add other variables/bindings if needed
}

// Generic client interface (adapt based on actual client methods)
interface IExchangeClient {
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
interface WebhookPayload {
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
  result?: any; // Data returned on success
  error?: string | null; // Error message on failure
}

// --- Constants ---

const PROCESS_ENDPOINT = "/process"; // For legacy/direct calls with internal key
const WEBHOOK_ENDPOINT = "/webhook"; // For calls from webhook-receiver via Service Binding

// --- Worker Definition ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST") {
      if (url.pathname === PROCESS_ENDPOINT) {
        return await handleProcessRequest(request, env);
      } else if (url.pathname === WEBHOOK_ENDPOINT) {
        return await handleWebhookRequest(request, env);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

// --- Helper Functions ---

/**
 * Checks if API credentials seem configured for a given exchange.
 */
async function validateApiCredentials(
  exchange: string,
  env: Env
): Promise<boolean> {
  const checkBinding = async (
    keyBinding?: SecretBinding,
    secretBinding?: SecretBinding
  ): Promise<boolean> => {
    if (!keyBinding || !secretBinding) return false;
    try {
        const key = await keyBinding.get();
        const secret = await secretBinding.get();
        return key !== null && secret !== null;
    } catch (e) {
        console.error(`Error getting secret binding for ${exchange}:`, e);
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
      return await checkBinding(env.BYBIT_KEY_BINDING, env.BYBIT_SECRET_BINDING);
    default:
      return false;
  }
}

/**
 * Validates the core trade payload structure and content.
 */
function validateTradePayload(payload: any): ValidationResult { // Use any initially, then refine
    if (!payload || typeof payload !== 'object') {
        return { isValid: false, error: "Invalid or missing payload" };
    }

  const { exchange, action, symbol, quantity } = payload as WebhookPayload;

  if (!exchange || !action || !symbol || quantity === undefined || quantity === null) {
    return { isValid: false, error: "Missing required fields in payload" };
  }

  const validActions: WebhookPayload['action'][] = ["LONG", "SHORT", "CLOSE_LONG", "CLOSE_SHORT"];
  if (!validActions.includes(action.toUpperCase() as WebhookPayload['action'])) {
    return { isValid: false, error: `Invalid action in payload: ${action}` };
  }

  if (typeof quantity !== 'number' || isNaN(quantity) || quantity <= 0) {
    return { isValid: false, error: "Invalid quantity in payload" };
  }

  // Add further checks (e.g., price/leverage types if present)
  if (payload.price !== undefined && (typeof payload.price !== 'number' || isNaN(payload.price))) {
      return { isValid: false, error: "Invalid price in payload" };
  }
   if (payload.leverage !== undefined && (typeof payload.leverage !== 'number' || isNaN(payload.leverage) || !Number.isInteger(payload.leverage) || payload.leverage <= 0)) {
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

// --- Core Trade Execution Logic ---

/**
 * Core logic to process a validated trade payload.
 */
async function executeTrade(
  payload: WebhookPayload,
  env: Env,
  dbLogger: IDbLogger,
  startTime: number,
  dbLogId: number | null // Assuming logRequest returns a number ID
): Promise<Response> {
  try {
    const {
      exchange,
      action,
      symbol,
      quantity,
      price,
      orderType = "MARKET",
      leverage = 20,
    } = payload;

    if (!(await validateApiCredentials(exchange, env))) {
      const errorMsg = `API secret bindings not configured or accessible for ${exchange}`;
      console.error(errorMsg);
      const response = createJsonResponse({ success: false, error: errorMsg }, 400);
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    let apiKey: string | null = null;
    let apiSecret: string | null = null;
    let client: IExchangeClient;

    // Use provided mock clients if available, otherwise create real ones
    const MexcClientClass = env.__mocks__?.MexcClient || MexcClient;
    const BinanceClientClass = env.__mocks__?.BinanceClient || BinanceClient;
    const BybitClientClass = env.__mocks__?.BybitClient || BybitClient;

    switch (exchange.toLowerCase()) {
      case "mexc":
        apiKey = (await env.MEXC_KEY_BINDING?.get()) ?? null;
        apiSecret = (await env.MEXC_SECRET_BINDING?.get()) ?? null;
        if (!apiKey || !apiSecret) throw new Error("MEXC API secrets unavailable.");
        client = new MexcClientClass(apiKey, apiSecret);
        break;
      case "binance":
        apiKey = (await env.BINANCE_KEY_BINDING?.get()) ?? null;
        apiSecret = (await env.BINANCE_SECRET_BINDING?.get()) ?? null;
        if (!apiKey || !apiSecret) throw new Error("Binance API secrets unavailable.");
        client = new BinanceClientClass(apiKey, apiSecret);
        break;
      case "bybit":
        apiKey = (await env.BYBIT_KEY_BINDING?.get()) ?? null;
        apiSecret = (await env.BYBIT_SECRET_BINDING?.get()) ?? null;
        if (!apiKey || !apiSecret) throw new Error("Bybit API secrets unavailable.");
        client = new BybitClientClass(apiKey, apiSecret);
        break;
      default:
        throw new Error(`Unsupported exchange: ${exchange}`);
    }

    if (client.setLeverage && leverage) {
      await client.setLeverage(symbol, leverage);
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
    const response = createJsonResponse({ success: true, result: result, error: null });
    await dbLogger.logResponse(dbLogId, response, null, startTime);
    return response;

  } catch (error: any) {
    console.error("Error during trade execution:", error);
    const response = createJsonResponse({
      success: false,
      error: error.message || "Trade execution failed",
    }, 500);
    await dbLogger.logResponse(dbLogId, response, error, startTime);
    return response;
  }
}

// --- Request Handlers ---

/**
 * Handles POST requests to the /webhook endpoint (from service bindings).
 */
async function handleWebhookRequest(request: Request, env: Env): Promise<Response> {
  const startTime = Date.now();
  // Use mock or real DbLogger
  const DbLoggerClass = env.__mocks__?.DbLogger || DbLogger;
  const dbLogger = new DbLoggerClass(env);
  let dbLogId: number | null = null;
  const incomingRequestId = request.headers.get("X-Request-ID") || crypto.randomUUID();

  try {
    const payload: WebhookPayload = await request.json();
    console.log(`Processing webhook request ID: ${incomingRequestId}`);
    console.log("Received webhook payload:", JSON.stringify(payload, null, 2));

    // Assuming logRequest can handle the payload directly and returns a number ID
    // Might need adjustment based on DbLogger implementation
    dbLogId = await dbLogger.logRequest(request, payload); 

    const validation = validateTradePayload(payload);
    if (!validation.isValid) {
      const response = createJsonResponse({ success: false, error: validation.error }, 400);
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    return await executeTrade(payload, env, dbLogger, startTime, dbLogId);

  } catch (error: any) {
    console.error(`Error in handleWebhookRequest for ID ${incomingRequestId}:`, error);
    const response = createJsonResponse({
      success: false,
      error: error.message || "Failed to process webhook request",
    }, 500);
    // Log error response if dbLogId was obtained
    if (dbLogId !== null) {
       await dbLogger.logResponse(dbLogId, response, error, startTime);
    } else {
        try {
            const rawBody = await request.clone().text();
            dbLogId = await dbLogger.logRequest(request, rawBody); // Log raw body
            await dbLogger.logResponse(dbLogId, response, error, startTime);
        } catch (logError) {
            console.error("Failed to log error response after initial failure:", logError);
        }
    }
    return response;
  }
}

/**
 * Handles the standardized processing request (/process endpoint).
 */
async function handleProcessRequest(request: Request, env: Env): Promise<Response> {
  const startTime = Date.now();
  const DbLoggerClass = env.__mocks__?.DbLogger || DbLogger;
  const dbLogger = new DbLoggerClass(env);
  let dbLogId: number | null = null;
  let incomingRequestId: string | undefined;

  try {
    const data: ProcessRequestBody = await request.json();
    incomingRequestId = data?.requestId;
    const internalAuthKey = data?.internalAuthKey;

    console.log(`Processing /process request ID: ${incomingRequestId}`);
    console.log("Received standardized request:", JSON.stringify(data, null, 2));

    // Log the request *before* authentication check
    // Pass the full original body data for logging
    dbLogId = await dbLogger.logRequest(request, data); 

    const expectedInternalKey = await env.INTERNAL_KEY_BINDING?.get();

    if (!expectedInternalKey) {
      console.error("INTERNAL_KEY_BINDING binding not configured or accessible.");
      const response = createJsonResponse({ success: false, error: "Service configuration error" }, 500);
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    if (!internalAuthKey || internalAuthKey !== expectedInternalKey) {
      console.warn(`Authentication failed for request ID: ${incomingRequestId}`);
      const response = createJsonResponse({ success: false, error: "Authentication failed" }, 403);
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    const payload = data?.payload;
    if (!payload) {
      const response = createJsonResponse({ success: false, error: "Missing payload in request" }, 400);
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    const validation = validateTradePayload(payload);
    if (!validation.isValid) {
      const response = createJsonResponse({ success: false, error: validation.error }, 400);
      await dbLogger.logResponse(dbLogId, response, null, startTime);
      return response;
    }

    // Execute the trade using the refactored function
    return await executeTrade(payload, env, dbLogger, startTime, dbLogId);

  } catch (error: any) {
    console.error(`Error in handleProcessRequest for ID ${incomingRequestId}:`, error);
    const response = createJsonResponse({
      success: false,
      error: error.message || "Failed to process request",
    }, 500);
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
            console.error("Failed to log error response after initial failure:", logError);
        }
    }
    return response;
  }
} 