import { DurableObject } from "cloudflare:workers";
import { createLogger } from "@jango-blockchained/hoox-shared/middleware";
import type { Env } from "./index";
import { BinanceClient } from "./binance-client";
import type { WebhookPayload } from "@jango-blockchained/hoox-shared/types";
import type { TradeExecutionResult } from "./execution";
import { getAdapter } from "./wsAdapters/adapters";
import type { IWsAdapter } from "./wsAdapters/types";

const logger = createLogger({
  service: "trade-worker",
  module: "exchange-connection-manager",
});

export class ExchangeConnectionManager extends DurableObject {
  private ws: WebSocket | null = null;
  private isConnecting = false;
  private exchange: string;
  private adapter: IWsAdapter | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.exchange = this.deriveExchange(ctx);

    // Load the configured adapter for this exchange, if creds are available.
    const apiKey = readApiKey(env, this.exchange);
    const apiSecret = readApiSecret(env, this.exchange);
    if (apiKey && apiSecret) {
      this.adapter = getAdapter(this.exchange, { apiKey, apiSecret });
      if (!this.adapter) {
        logger.warn(
          `No WS adapter registered for "${this.exchange}"; DO is REST-only`
        );
      }
    } else {
      logger.warn(`Missing ${this.exchange} credentials; DO is REST-only`);
    }

    // Kick off connection in background
    this.ctx.waitUntil(this.connectToExchange());
  }

  /**
   * Derive the exchange name from the DO's id name.
   * Caller is expected to use `idFromName("exchange:<name>")`.
   * Falls back to "binance" if the id name doesn't match the pattern
   * (backward compat for tests / accidental raw ids).
   */
  private deriveExchange(ctx: DurableObjectState): string {
    const name = ctx.id.name ?? "";
    const m = name.match(/^exchange:(.+)$/);
    return m ? m[1] : "binance";
  }

  async connectToExchange() {
    if (this.ws || this.isConnecting) return;
    if (!this.adapter) {
      logger.info(`No adapter for ${this.exchange}; skipping WS connect`);
      return;
    }
    this.isConnecting = true;

    try {
      logger.info(
        `Connecting to ${this.exchange} WebSocket at ${this.adapter.url}`
      );
      const resp = await fetch(this.adapter.url, {
        headers: { Upgrade: "websocket" },
      });

      this.ws = resp.webSocket;
      if (!this.ws) {
        throw new Error("Failed to get WebSocket from response");
      }

      this.ws.accept();

      this.ws.addEventListener("message", (_event) => {
        // We receive messages here.
        // Push the alarm forward to keep the DO alive if it goes idle.
        this.ctx.storage.setAlarm(Date.now() + 60 * 1000); // 1 minute
      });

      this.ws.addEventListener("close", () => {
        logger.warn(`${this.exchange} WebSocket closed`);
        this.ws = null;
        this.isConnecting = false;
        this.ctx.storage.setAlarm(Date.now() + 5000); // Reconnect in 5s
      });

      this.ws.addEventListener("error", (error) => {
        logger.error(`${this.exchange} WebSocket error`, { error });
        this.ws = null;
        this.isConnecting = false;
      });

      logger.info(`Connected to ${this.exchange} WebSocket`);
      this.isConnecting = false;

      // Set initial alarm
      this.ctx.storage.setAlarm(Date.now() + 60_000);
    } catch (err) {
      logger.error(`Failed to connect to ${this.exchange} WebSocket`, {
        error: err,
      });
      this.isConnecting = false;
      this.ctx.storage.setAlarm(Date.now() + 10_000); // Try again in 10s
    }
  }

  async alarm() {
    if (!this.ws) {
      logger.info("Alarm fired: WebSocket disconnected. Reconnecting...");
      await this.connectToExchange();
    } else {
      // We are connected, just push the alarm forward
      this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  // RPC Method called by the worker
  async executeTrade(
    payload: WebhookPayload,
    env: Env
  ): Promise<TradeExecutionResult> {
    logger.info(`Executing trade via DO for ${this.exchange}`, { payload });

    // For now, we still use the REST client for execution,
    // but we are doing it from within the "always online" DO.
    // Later, this can be upgraded to use WS order placement.

    const apiKey = env.BINANCE_KEY_BINDING;
    const apiSecret = env.BINANCE_SECRET_BINDING;

    if (!apiKey || !apiSecret) {
      return {
        success: false,
        error: "Missing Binance credentials",
        status: 400,
      };
    }

    const client = new BinanceClient(apiKey, apiSecret);

    try {
      let result: unknown;
      const { action, symbol, quantity, price, orderType = "MARKET" } = payload;

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
        default:
          return {
            success: false,
            error: `Invalid action: ${action}`,
            status: 400,
          };
      }

      return { success: true, result, status: 200 };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg, status: 500 };
    }
  }
}

/**
 * Read the API key env binding for the given exchange.
 * Returns "" if the binding is missing.
 */
function readApiKey(env: Env, exchange: string): string {
  switch (exchange) {
    case "bybit":
      return env.BYBIT_KEY_BINDING ?? "";
    case "mexc":
      return env.MEXC_KEY_BINDING ?? "";
    case "binance":
    default:
      return env.BINANCE_KEY_BINDING ?? "";
  }
}

/**
 * Read the API secret env binding for the given exchange.
 * Returns "" if the binding is missing.
 */
function readApiSecret(env: Env, exchange: string): string {
  switch (exchange) {
    case "bybit":
      return env.BYBIT_SECRET_BINDING ?? "";
    case "mexc":
      return env.MEXC_SECRET_BINDING ?? "";
    case "binance":
    default:
      return env.BINANCE_SECRET_BINDING ?? "";
  }
}
