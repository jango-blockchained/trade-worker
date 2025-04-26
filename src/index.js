// trade-worker/src/index.js - Only accepts requests from the webhook receiver
import { MexcClient } from "./mexc-client.js";
import { BinanceClient } from "./binance-client.js";
import { BybitClient } from "./bybit-client.js";
import { DbLogger } from "./db-logger.js";

// ES Module format requires a default export
export default {
  async fetch(request, env) {
    return await handleRequest(request, env);
  },
};

// Define SecretBinding structure for clarity (not enforced in JS)
/**
 * @typedef {object} SecretBinding
 * @property {() => Promise<string | null>} get
 */

// Update Env JSDoc to include optional mocks
/**
 * @typedef {object} Env
 * @property {string} [D1_WORKER_URL]
 * @property {SecretBinding} [INTERNAL_KEY_BINDING]
 * @property {SecretBinding} [MEXC_KEY_BINDING]
 * @property {SecretBinding} [MEXC_SECRET_BINDING]
 * @property {SecretBinding} [BINANCE_KEY_BINDING]
 * @property {SecretBinding} [BINANCE_SECRET_BINDING]
 * @property {SecretBinding} [BYBIT_KEY_BINDING]
 * @property {SecretBinding} [BYBIT_SECRET_BINDING]
 * @property {object} [__mocks__] Optional property for test mocks
 * @property {typeof MexcClient} [__mocks__.MexcClient]
 * @property {typeof BinanceClient} [__mocks__.BinanceClient]
 * @property {typeof BybitClient} [__mocks__.BybitClient]
 * @property {typeof DbLogger} [__mocks__.DbLogger]
 */

// Add validation functions
/**
 * @param {string} exchange
 * @param {Env} env
 * @returns {Promise<boolean>}
 */
async function validateApiCredentials(exchange, env) {
  // Helper to check if both key and secret bindings seem configured
  /**
   * @param {SecretBinding | undefined} keyBinding
   * @param {SecretBinding | undefined} secretBinding
   * @returns {Promise<boolean>}
   */
  const checkBinding = async (keyBinding, secretBinding) => {
    if (!keyBinding || !secretBinding) return false;
    // Check if *getting* the secrets works (returns non-null).
    const key = await keyBinding.get();
    const secret = await secretBinding.get();
    return key !== null && secret !== null;
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

async function validateRequest(data) {
  const { exchange, action, symbol, quantity } = data;

  if (!exchange || !action || !symbol || !quantity) {
    return { isValid: false, error: "Missing required fields" };
  }

  // Validate action
  const validActions = ["LONG", "SHORT", "CLOSE_LONG", "CLOSE_SHORT"];
  if (!validActions.includes(action.toUpperCase())) {
    return { isValid: false, error: `Invalid action: ${action}` };
  }

  // Validate quantity
  if (isNaN(quantity) || quantity <= 0) {
    return { isValid: false, error: "Invalid quantity" };
  }

  return { isValid: true };
}

async function testApiConnection(client) {
  try {
    // Try to get account info as a test
    await client.getAccountInfo();
    return true;
  } catch (error) {
    console.error("API connection test failed:", error);
    return false;
  }
}

/**
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
async function handleRequest(request, env) {
  const startTime = Date.now();
  // Use provided mock DbLogger if available, otherwise create real one
  const DbLoggerClass = env.__mocks__?.DbLogger || DbLogger;
  const dbLogger = new DbLoggerClass(env);
  let requestId = null;

  // Verify internal service authentication
  const internalKeyHeader = request.headers.get("X-Internal-Key");
  const headerRequestId = request.headers.get("X-Request-ID");

  const expectedInternalKey = await env.INTERNAL_KEY_BINDING?.get();

  if (!expectedInternalKey) {
    console.error("INTERNAL_KEY_BINDING binding not configured or accessible.");
    // Avoid logging response here as DbLogger handles it in catch block
    return new Response(
      JSON.stringify({ success: false, error: "Service configuration error" }),
      { status: 500 }
    );
  }

  if (
    !internalKeyHeader ||
    internalKeyHeader !== expectedInternalKey ||
    !headerRequestId
  ) {
    // Avoid logging response here as DbLogger handles it in catch block
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 403 }
    );
  }

  try {
    // Process the trade request
    const data = await request.json();
    console.log("Received trade request:", JSON.stringify(data, null, 2));

    // Log the request to database
    requestId = await dbLogger.logRequest(request, data);

    // Validate request data
    const validation = await validateRequest(data);
    if (!validation.isValid) {
      const response = new Response(
        JSON.stringify({
          success: false,
          error: validation.error,
        }),
        { status: 400 }
      );
      await dbLogger.logResponse(requestId, response, null, startTime);
      return response;
    }

    const {
      exchange,
      action,
      symbol,
      quantity,
      price,
      orderType = "MARKET",
      leverage = 20,
    } = data;

    // Validate API credentials are *configured*
    if (!(await validateApiCredentials(exchange, env))) {
      const errorMsg = `API secret bindings not configured or accessible for ${exchange}`;
      console.error(errorMsg);
      // Log response explicitly here as it's a config validation error before client creation
      const response = new Response(
        JSON.stringify({ success: false, error: errorMsg }),
        { status: 400 }
      );
      await dbLogger.logResponse(requestId, response, null, startTime);
      return response;
    }

    // Get actual secrets for client initialization
    let apiKey = null; // Initialize as null
    let apiSecret = null;

    switch (exchange.toLowerCase()) {
      case "mexc": {
        // Use optional chaining and nullish coalescing, though validate passed
        apiKey = (await env.MEXC_KEY_BINDING?.get()) ?? null;
        apiSecret = (await env.MEXC_SECRET_BINDING?.get()) ?? null;
        break;
      }
      case "binance": {
        apiKey = (await env.BINANCE_KEY_BINDING?.get()) ?? null;
        apiSecret = (await env.BINANCE_SECRET_BINDING?.get()) ?? null;
        break;
      }
      case "bybit": {
        apiKey = (await env.BYBIT_KEY_BINDING?.get()) ?? null;
        apiSecret = (await env.BYBIT_SECRET_BINDING?.get()) ?? null;
        break;
      }
      default: {
        // but handle defensively.
        // This case should ideally not be reached if validateRequest is comprehensive
        const response = new Response(
          JSON.stringify({ success: false, error: "Unsupported exchange" }),
          { status: 400 }
        );
        await dbLogger.logResponse(requestId, response, null, startTime);
        return response;
      }
    }

    // Check if secrets were actually retrieved
    if (!apiKey || !apiSecret) {
      const errorMsg = `Failed to retrieve API credentials for ${exchange} from Secrets Store.`;
      console.error(errorMsg);
      const response = new Response(
        JSON.stringify({ success: false, error: errorMsg }),
        { status: 500 }
      );
      // Ensure requestId is defined before logging
      if (requestId) {
        await dbLogger.logResponse(requestId, response, null, startTime);
      }
      return response;
    }

    // Initialize the appropriate exchange client
    // Use provided mock client class if available, otherwise use real one
    let client;
    switch (exchange.toLowerCase()) {
      case "mexc": {
        const MexcClientClass = env.__mocks__?.MexcClient || MexcClient;
        client = new MexcClientClass(apiKey, apiSecret);
        break;
      }
      case "binance": {
        const BinanceClientClass =
          env.__mocks__?.BinanceClient || BinanceClient;
        client = new BinanceClientClass(apiKey, apiSecret);
        break;
      }
      case "bybit": {
        const BybitClientClass = env.__mocks__?.BybitClient || BybitClient;
        client = new BybitClientClass(apiKey, apiSecret);
        break;
      }
      // No default needed here as exchange was validated earlier
    }

    // Test API connection using the (potentially mocked) client
    if (!(await testApiConnection(client))) {
      const response = new Response(
        JSON.stringify({
          success: false,
          error: "Failed to connect to exchange API",
        }),
        { status: 500 }
      );
      await dbLogger.logResponse(requestId, response, null, startTime);
      return response;
    }

    // Map action to parameters
    let side,
      reduceOnly = false;

    switch (action.toUpperCase()) {
      case "LONG": {
        side = "BUY";
        reduceOnly = false;
        break;
      }
      case "SHORT": {
        side = "SELL";
        reduceOnly = false;
        break;
      }
      case "CLOSE_LONG": {
        side = "SELL";
        reduceOnly = true;
        break;
      }
      case "CLOSE_SHORT": {
        side = "BUY";
        reduceOnly = true;
        break;
      }
      default: {
        const response = new Response(
          JSON.stringify({
            success: false,
            error: `Invalid action: ${action}`,
          }),
          { status: 400 }
        );
        await dbLogger.logResponse(requestId, response, null, startTime);
        return response;
      }
    }

    // Set leverage if provided
    if (leverage) {
      console.log(`Setting leverage for ${symbol} to ${leverage}`);
      await client.setLeverage(symbol, leverage);
    }

    // Prepare trade parameters
    const tradeParams = {
      symbol,
      side,
      orderType,
      quantity,
      price,
      reduceOnly,
      leverage,
    };

    // Add exchange-specific parameters
    if (exchange.toLowerCase() === "mexc") {
      tradeParams.positionMode = "ONE_WAY";
      tradeParams.openType = "ISOLATED";
      tradeParams.positionType = 2;
    }

    console.log(
      "Executing trade with params:",
      JSON.stringify(tradeParams, null, 2)
    );

    // Execute the trade using the client
    const result = await client.executeTrade(tradeParams);

    console.log("Trade result:", JSON.stringify(result, null, 2));

    const response = new Response(
      JSON.stringify({
        success: true,
        requestId: headerRequestId,
        result,
      })
    );

    // Log the successful response
    await dbLogger.logResponse(requestId, response, null, startTime);
    return response;
  } catch (error) {
    console.error("Error processing trade request:", error);

    const response = new Response(
      JSON.stringify({
        success: false,
        error: error.message || "Unknown error occurred",
      }),
      { status: 500 }
    );

    // Log the error response
    await dbLogger.logResponse(requestId, response, error, startTime);
    return response;
  }
}
