import { DurableObject } from "cloudflare:workers";
import { createLogger } from "@jango-blockchained/hoox-shared/middleware";
import type { Env } from "./index";
import { BinanceClient } from "./binance-client";
import type { WebhookPayload } from "@jango-blockchained/hoox-shared/types";
import type { TradeExecutionResult } from "./execution";

const logger = createLogger({
  service: "trade-worker",
  module: "exchange-connection-manager",
});

export class ExchangeConnectionManager extends DurableObject {
  private ws: WebSocket | null = null;
  private isConnecting = false;
  private exchange: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.exchange = "binance"; // Hardcoded for now, can be dynamic based on DO name/id

    // Kick off connection in background
    this.ctx.waitUntil(this.connectToExchange());
  }

  async connectToExchange() {
    if (this.ws || this.isConnecting) return;
    this.isConnecting = true;

    try {
      logger.info(`Connecting to ${this.exchange} WebSocket...`);

      // Example: Connect to Binance Futures public stream just to keep connection alive
      // In a real scenario, this would be the authenticated user data stream or WS API
      const resp = await fetch(
        "wss://fstream.binance.com/ws/btcusdt@bookTicker",
        {
          headers: { Upgrade: "websocket" },
        }
      );

      this.ws = resp.webSocket;
      if (!this.ws) {
        throw new Error("Failed to get WebSocket from response");
      }

      this.ws.accept();

      this.ws.addEventListener("message", (event) => {
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
      this.ctx.storage.setAlarm(Date.now() + 60 * 1000);
    } catch (err) {
      logger.error(`Failed to connect to ${this.exchange} WebSocket`, {
        error: err,
      });
      this.isConnecting = false;
      this.ctx.storage.setAlarm(Date.now() + 10000); // Try again in 10s
    }
  }

  async alarm() {
    if (!this.ws) {
      logger.info("Alarm fired: WebSocket disconnected. Reconnecting...");
      await this.connectToExchange();
    } else {
      // We are connected, just push the alarm forward
      this.ctx.storage.setAlarm(Date.now() + 60 * 1000);
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
