// workers/trade-worker/src/execution.ts
// Core trade execution logic extracted from index.ts

import { serviceFetch } from "@jango-blockchained/hoox-shared/service-bindings";
import {
  createJsonResponse,
  toError,
} from "@jango-blockchained/hoox-shared/errors";
import { createLogger } from "@jango-blockchained/hoox-shared/middleware";
import type { WebhookPayload } from "@jango-blockchained/hoox-shared/types";

const logger = createLogger({ service: "trade-worker", module: "execution" });
import { trackAnalytics } from "@jango-blockchained/hoox-shared/analytics";
import { KVKeys } from "@jango-blockchained/hoox-shared/kvKeys";
import type { IDbLogger } from "./db-logger";
import { ExchangeRouter, type Env } from "./exchange-router";
import { sendTradeNotificationToTelegram } from "./notifications";

// --- Type Definitions ---

/**
 * Minimal environment interface for trade execution operations.
 * Only includes the bindings needed by the extracted execution functions
 * and their transitive dependencies (ExchangeRouter, trackAnalytics, etc.).
 */
export interface ExecutionEnv {
  CONFIG_KV?: KVNamespace;
  D1_SERVICE?: Fetcher;
  INTERNAL_KEY_BINDING?: string;
  TELEGRAM_SERVICE?: Fetcher;
  TELEGRAM_INTERNAL_KEY_BINDING?: string;
  MEXC_KEY_BINDING?: string;
  MEXC_SECRET_BINDING?: string;
  BINANCE_KEY_BINDING?: string;
  BINANCE_SECRET_BINDING?: string;
  BYBIT_KEY_BINDING?: string;
  BYBIT_SECRET_BINDING?: string;
}

// Generic client interface (mirrored from index.ts to avoid circular dependency)
export interface IExchangeClient {
  getAccountInfo: () => Promise<Record<string, unknown>>;
  setLeverage?: (symbol: string, leverage: number) => Promise<void>;
  openLong: (
    symbol: string,
    quantity: number,
    price?: number,
    orderType?: string
  ) => Promise<unknown>;
  openShort: (
    symbol: string,
    quantity: number,
    price?: number,
    orderType?: string
  ) => Promise<unknown>;
  closeLong: (symbol: string, quantity: number) => Promise<unknown>;
  closeShort: (symbol: string, quantity: number) => Promise<unknown>;
}

// Note: IExchangeClient uses `unknown` for the trade operation return types
// because each exchange (MEXC, Bybit, Binance) returns a different response
// shape from its respective REST API. The runtime type is exchange-specific
// (see mexc-client.ts, bybit-client.ts, binance-client.ts). The base class
// in @jango-blockchained/hoox-shared/exchanges uses OrderResponse for
// `executeTrade` and `Position[]` for `getPositions`.

interface ValidationResult {
  isValid: boolean;
  error?: string;
}

// --- Helper Functions ---

/**
 * Updates D1 database with trade and position records
 */
export async function updateD1TradeRecords(
  env: ExecutionEnv,
  result: unknown,
  payload: WebhookPayload,
  routedExchange: string,
  overriddenLeverage: number | undefined
): Promise<void> {
  if (!env.D1_SERVICE) return;

  try {
    const tradeId = crypto.randomUUID();
    const { action, symbol, quantity, price } = payload;
    const tradeStatus = "EXECUTED";

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
        JSON.stringify(result),
      ],
    };

    const side = action.includes("LONG") ? "LONG" : "SHORT";
    const posStatus = action.startsWith("CLOSE") ? "CLOSED" : "OPEN";
    const posId = `${routedExchange}-${symbol}-${side}`;

    const posPayload = {
      query: `REPLACE INTO positions (id, exchange, symbol, side, size, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        posId,
        routedExchange,
        symbol,
        side,
        posStatus === "OPEN" ? quantity : 0,
        posStatus,
        Math.floor(Date.now() / 1000),
      ],
    };

    // Fail closed: if INTERNAL_KEY_BINDING is not configured, don't send the request
    if (!env.INTERNAL_KEY_BINDING) {
      logger.error(
        "INTERNAL_KEY_BINDING not configured, cannot update D1 trade records"
      );
      return;
    }

    await Promise.all([
      serviceFetch(env.D1_SERVICE, "/query", tradePayload, {
        headers: { "X-Internal-Auth-Key": env.INTERNAL_KEY_BINDING },
      }),
      serviceFetch(env.D1_SERVICE, "/query", posPayload, {
        headers: { "X-Internal-Auth-Key": env.INTERNAL_KEY_BINDING },
      }),
    ]);
  } catch (error: unknown) {
    logger.error("Failed to update D1 trades and positions tables", {
      error: toError(error),
    });
  }
}

/**
 * Checks if API credentials seem configured for a given exchange.
 */
export function validateApiCredentials(
  exchange: string,
  env: ExecutionEnv
): boolean {
  const checkBinding = (
    keyBinding?: string,
    secretBinding?: string
  ): boolean => {
    return !!keyBinding && !!secretBinding;
  };

  switch (exchange.toLowerCase()) {
    case "mexc":
      return checkBinding(env.MEXC_KEY_BINDING, env.MEXC_SECRET_BINDING);
    case "binance":
      return checkBinding(env.BINANCE_KEY_BINDING, env.BINANCE_SECRET_BINDING);
    case "bybit":
      return checkBinding(env.BYBIT_KEY_BINDING, env.BYBIT_SECRET_BINDING);
    default:
      return false;
  }
}

/**
 * Validates the core trade payload structure and content.
 */
export function validateTradePayload(payload: unknown): ValidationResult {
  // Use unknown initially, then refine
  if (!payload || typeof payload !== "object") {
    return { isValid: false, error: "Invalid or missing payload" };
  }

  const wp = payload as WebhookPayload;
  const { exchange, action, symbol, quantity } = wp;

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
    wp.price !== undefined &&
    (typeof wp.price !== "number" || isNaN(wp.price))
  ) {
    return { isValid: false, error: "Invalid price in payload" };
  }
  if (
    wp.leverage !== undefined &&
    (typeof wp.leverage !== "number" ||
      isNaN(wp.leverage) ||
      !Number.isInteger(wp.leverage) ||
      wp.leverage <= 0)
  ) {
    return { isValid: false, error: "Invalid leverage in payload" };
  }

  return { isValid: true };
}

// --- Core Trade Execution Logic ---

/**
 * Structured result from trade execution, avoiding raw Response passing.
 */
export interface TradeExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string | null;
  /** HTTP status code appropriate for this result (e.g. 200, 400, 500) */
  status?: number;
}

/**
 * Core logic to process a validated trade payload.
 */
export async function executeTrade(
  payload: WebhookPayload,
  env: Env,
  dbLogger: IDbLogger,
  startTime: number,
  dbLogId: string | null,
  ctx: ExecutionContext
): Promise<TradeExecutionResult> {
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

    let overriddenLeverage = leverage;
    let maxPositionSize: number | null = null;

    // --- Kill Switch & Risk Management via CONFIG_KV ---
    // Read all independent KV keys in parallel
    if (env.CONFIG_KV) {
      try {
        const [killSwitch, defaultLevStr, maxSizeStr] = await Promise.all([
          env.CONFIG_KV.get("kill_switch"),
          env.CONFIG_KV.get(KVKeys.KV_TRADE_DEFAULT_LEVERAGE),
          env.CONFIG_KV.get(KVKeys.KV_TRADE_MAX_POSITION_SIZE),
        ]);

        if (killSwitch === "true") {
          throw new Error(
            "KILL_SWITCH_ACTIVE: Trading is disabled by kill switch"
          );
        }

        if (defaultLevStr && !overriddenLeverage) {
          overriddenLeverage = parseInt(defaultLevStr, 10);
          logger.info(
            `[Risk Management] Applied default leverage: ${overriddenLeverage}`
          );
        }
        if (maxSizeStr) {
          maxPositionSize = parseFloat(maxSizeStr);
        }
      } catch (e) {
        // Re-throw kill switch errors, swallow and log KV failures
        if (e instanceof Error && e.message.startsWith("KILL_SWITCH_ACTIVE")) {
          throw e;
        }
        logger.error("Failed to fetch trade settings from KV", {
          error: toError(e),
        });
      }
    }
    // --- End Kill Switch & Risk Management ---

    if (maxPositionSize !== null && quantity > maxPositionSize) {
      const errorMsg = `Trade quantity (${quantity}) exceeds maximum allowed size (${maxPositionSize})`;
      logger.error(errorMsg);
      const result: TradeExecutionResult = {
        success: false,
        error: errorMsg,
        status: 400,
      };
      await dbLogger.logResponse(
        dbLogId,
        createJsonResponse(result, 400),
        null,
        startTime,
        ctx
      );
      return result;
    }
    // --- End Risk Management ---

    const router = new ExchangeRouter();

    let client: IExchangeClient;
    let routedExchange: string;
    let useWebsocketDO = false;

    try {
      const routeResult = await router.route(payload, env);
      client = routeResult.client;
      routedExchange = routeResult.exchange;
      useWebsocketDO = routeResult.useWebsocketDO || false;
    } catch (error: unknown) {
      const errorMsg = toError(error, `Failed to route exchange: ${exchange}`);
      logger.error(errorMsg);
      const result: TradeExecutionResult = {
        success: false,
        error: errorMsg,
        status: 400,
      };
      await dbLogger.logResponse(
        dbLogId,
        createJsonResponse(result, 400),
        null,
        startTime,
        ctx
      );
      return result;
    }

    let result: unknown;

    if (useWebsocketDO && env.EXCHANGE_CONNECTION_MANAGER) {
      logger.info(`Routing trade to DO for ${routedExchange}`);
      const id = env.EXCHANGE_CONNECTION_MANAGER.idFromName(routedExchange);
      // DurableObjectStub is an RPC proxy — cast to access RPC methods
      const stub = env.EXCHANGE_CONNECTION_MANAGER.get(id) as unknown as {
        executeTrade(
          payload: WebhookPayload,
          env: Env
        ): Promise<TradeExecutionResult>;
      };
      const doResult = await stub.executeTrade(payload, env);
      if (!doResult.success) {
        throw new Error(doResult.error || "DO execution failed");
      }
      result = doResult.result;
    } else {
      if (client.setLeverage && overriddenLeverage) {
        try {
          await client.setLeverage(symbol, overriddenLeverage);
        } catch (leverageError) {
          logger.error("Failed to set leverage", {
            error: toError(leverageError),
          });
          // Continue with trade execution even if setting leverage fails
        }
      }

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
    }

    logger.debug("Trade execution successful", { result });

    // Update D1 tables with trade and position data
    if (env.D1_SERVICE) {
      await updateD1TradeRecords(
        env,
        result,
        payload,
        routedExchange,
        overriddenLeverage
      );
    }

    const tradeResult: TradeExecutionResult = {
      success: true,
      result,
      error: null,
      status: 200,
    };
    await dbLogger.logResponse(
      dbLogId,
      createJsonResponse(tradeResult),
      null,
      startTime,
      ctx
    );

    // Track trade analytics (non-blocking)
    const latencyMs = Date.now() - startTime;
    ctx.waitUntil(
      trackAnalytics(env, "/track/trade", {
        payload: { exchange: routedExchange, action, symbol, quantity, price },
        result: { success: true },
        latencyMs,
      }).catch((err) =>
        logger.error("trackAnalytics failed", { error: String(err) })
      )
    );

    // Send notification via telegram-worker after trade execution (non-blocking)
    if (env.TELEGRAM_SERVICE) {
      ctx.waitUntil(
        sendTradeNotificationToTelegram(
          env,
          result as { success?: boolean; result?: unknown; error?: string },
          routedExchange,
          action,
          quantity,
          symbol,
          dbLogId
        ).catch((err) =>
          logger.error("Send notification failed", { error: toError(err) })
        )
      );
    }

    return tradeResult;
  } catch (error: unknown) {
    const errorMsg = toError(error, "Internal server error");
    logger.error("Error in executeTrade", { errorMsg, error: toError(error) });
    const tradeResult: TradeExecutionResult = {
      success: false,
      error: `Trade execution failed: ${errorMsg}`,
      status: 500,
    };
    const response = createJsonResponse(tradeResult, 500);
    // Log failure response, even if dbLogId might be null in edge cases
    if (dbLogger && dbLogId !== null) {
      try {
        await dbLogger.logResponse(dbLogId, response, null, startTime, ctx);
      } catch (logErr) {
        logger.error("Failed to log error response to D1", {
          error: toError(logErr),
        });
      }
    }

    // Track failed trade analytics (non-blocking)
    const latencyMs = Date.now() - startTime;
    ctx.waitUntil(
      trackAnalytics(env, "/track/trade", {
        payload: {
          exchange: payload.exchange,
          action: payload.action,
          symbol: payload.symbol,
          quantity: payload.quantity,
          price: payload.price,
        },
        result: { success: false, error: errorMsg },
        latencyMs,
      }).catch((err) =>
        logger.error("trackAnalytics failed", { error: String(err) })
      )
    );

    return tradeResult;
  }
}
