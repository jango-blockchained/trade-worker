// workers/trade-worker/src/execution.ts
// Core trade execution logic extracted from index.ts

import type { KVNamespace } from "@cloudflare/workers-types";
import type { Fetcher } from "@cloudflare/workers-types";
import { serviceFetch } from "@jango-blockchained/hoox-shared/service-bindings";
import {
  createJsonResponse,
  toError,
} from "@jango-blockchained/hoox-shared/errors";
import { createLogger } from "@jango-blockchained/hoox-shared/middleware";
import type { WebhookPayload } from "@jango-blockchained/hoox-shared/types";

const logger = createLogger({ service: "trade-worker", module: "execution" });
import {
  trackAnalytics,
  type AnalyticsEnv,
} from "@jango-blockchained/hoox-shared/analytics";
import { KVKeys } from "@jango-blockchained/hoox-shared/kvKeys";
import type { IDbLogger } from "./db-logger";
import { ExchangeRouter } from "./exchange-router";
import { sendTradeNotificationToTelegram } from "./notifications";

// --- Type Definitions ---

/**
 * Minimal environment interface for trade execution operations.
 * Only includes the bindings needed by the extracted execution functions
 * and their transitive dependencies (ExchangeRouter, trackAnalytics, etc.).
 */
export interface ExecutionEnv extends AnalyticsEnv {
  CONFIG_KV?: KVNamespace;
  D1_SERVICE?: Fetcher;
  TELEGRAM_SERVICE?: Fetcher;
  TELEGRAM_INTERNAL_KEY_BINDING?: string;
  MEXC_KEY_BINDING?: string;
  MEXC_SECRET_BINDING?: string;
  BINANCE_KEY_BINDING?: string;
  BINANCE_SECRET_BINDING?: string;
  BYBIT_KEY_BINDING?: string;
  BYBIT_SECRET_BINDING?: string;
  __mocks__?: {
    MexcClient?: any;
    BinanceClient?: any;
    BybitClient?: any;
    DbLogger?: any;
  };
}

// Generic client interface (mirrored from index.ts to avoid circular dependency)
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
  result: any,
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

    await Promise.all([
      serviceFetch(env.D1_SERVICE, "/query", tradePayload),
      serviceFetch(env.D1_SERVICE, "/query", posPayload),
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
  env: ExecutionEnv,
  dbLogger: IDbLogger,
  startTime: number,
  dbLogId: string | null // Changed to string
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

    // --- Risk Management via CONFIG_KV ---
    let overriddenLeverage = leverage;
    let maxPositionSize: number | null = null;

    try {
      if (env.CONFIG_KV) {
        const defaultLevStr = await env.CONFIG_KV.get(
          KVKeys.KV_TRADE_DEFAULT_LEVERAGE
        );
        if (defaultLevStr && !overriddenLeverage) {
          overriddenLeverage = parseInt(defaultLevStr, 10);
          logger.info(
            `[Risk Management] Applied default leverage: ${overriddenLeverage}`
          );
        }
        const maxSizeStr = await env.CONFIG_KV.get(
          KVKeys.KV_TRADE_MAX_POSITION_SIZE
        );
        if (maxSizeStr) {
          maxPositionSize = parseFloat(maxSizeStr);
        }
      }
    } catch (error: unknown) {
      logger.error("Failed to fetch risk management settings from KV", {
        error: toError(error),
      });
    }

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
        startTime
      );
      return result;
    }
    // --- End Risk Management ---

    const router = new ExchangeRouter();

    let client: IExchangeClient;
    let routedExchange: string;

    try {
      const routeResult = await router.route(payload, env);
      client = routeResult.client;
      routedExchange = routeResult.exchange;
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
        startTime
      );
      return result;
    }

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

    logger.info("Trade execution successful", { result });

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
      startTime
    );

    // Track trade analytics (non-blocking)
    const latencyMs = Date.now() - startTime;
    trackAnalytics(env, "/track/trade", {
      payload: { exchange: routedExchange, action, symbol, quantity, price },
      result: { success: true },
      latencyMs,
    });

    // Send notification via telegram-worker after trade execution
    if (env.TELEGRAM_SERVICE) {
      await sendTradeNotificationToTelegram(
        env,
        result,
        routedExchange,
        action,
        quantity,
        symbol,
        dbLogId
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
        await dbLogger.logResponse(dbLogId, response, null, startTime);
      } catch (logErr) {
        logger.error("Failed to log error response to D1", {
          error: toError(logErr),
        });
      }
    }

    // Track failed trade analytics (non-blocking)
    const latencyMs = Date.now() - startTime;
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
    });

    return tradeResult;
  }
}
