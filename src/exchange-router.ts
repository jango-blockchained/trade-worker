import { MexcClient } from "./mexc-client";
import { BinanceClient } from "./binance-client";
import { BybitClient } from "./bybit-client";
import type { Env } from "./index";
import type { IExchangeClient } from "./execution";
import type { WebhookPayload } from "@jango-blockchained/hoox-shared/types";
import type {
  IExchangeProvider,
  ExchangeRouter as IExchangeRouter,
} from "@jango-blockchained/hoox-shared/exchange-client";
import { ExchangeRouter as BaseRouter } from "@jango-blockchained/hoox-shared/exchange-client";
import { KVKeys } from "@jango-blockchained/hoox-shared/kvKeys";
import { createLogger } from "@jango-blockchained/hoox-shared/middleware";
import { toError } from "@jango-blockchained/hoox-shared/errors";

const logger = createLogger({
  service: "trade-worker",
  module: "exchange-router",
});

// Re-export generic IExchangeProvider for backward compat
export type { IExchangeProvider };

// Re-export worker Env type for execution.ts to use without circular import
export type { Env };

/**
 * Module-level factory functions for testability.
 * Use vi.spyOn(factories, "createBinanceClient") etc. in tests to inject mock clients.
 */
export const factories = {
  createBinanceClient(apiKey: string, apiSecret: string): IExchangeClient {
    return new BinanceClient(apiKey, apiSecret);
  },
  createMexcClient(apiKey: string, apiSecret: string): IExchangeClient {
    return new MexcClient(apiKey, apiSecret);
  },
  createBybitClient(apiKey: string, apiSecret: string): IExchangeClient {
    return new BybitClient(apiKey, apiSecret);
  },
};

// Provider type alias bound to trade-worker's types
type TradeExchangeProvider = IExchangeProvider<IExchangeClient, Env>;

export class BinanceProvider implements TradeExchangeProvider {
  readonly name = "binance";
  createClient(env: Env): IExchangeClient {
    const apiKey = env.BINANCE_KEY_BINDING;
    const apiSecret = env.BINANCE_SECRET_BINDING;
    if (!apiKey || !apiSecret)
      throw new Error("Binance API secrets unavailable.");
    return factories.createBinanceClient(apiKey, apiSecret);
  }
  hasCredentials(env: Env): boolean {
    return !!(env.BINANCE_KEY_BINDING && env.BINANCE_SECRET_BINDING);
  }
}

export class MexcProvider implements TradeExchangeProvider {
  readonly name = "mexc";
  createClient(env: Env): IExchangeClient {
    const apiKey = env.MEXC_KEY_BINDING;
    const apiSecret = env.MEXC_SECRET_BINDING;
    if (!apiKey || !apiSecret) throw new Error("MEXC API secrets unavailable.");
    return factories.createMexcClient(apiKey, apiSecret);
  }
  hasCredentials(env: Env): boolean {
    return !!(env.MEXC_KEY_BINDING && env.MEXC_SECRET_BINDING);
  }
}

export class BybitProvider implements TradeExchangeProvider {
  readonly name = "bybit";
  createClient(env: Env): IExchangeClient {
    const apiKey = env.BYBIT_KEY_BINDING;
    const apiSecret = env.BYBIT_SECRET_BINDING;
    if (!apiKey || !apiSecret)
      throw new Error("Bybit API secrets unavailable.");
    return factories.createBybitClient(apiKey, apiSecret);
  }
  hasCredentials(env: Env): boolean {
    return !!(env.BYBIT_KEY_BINDING && env.BYBIT_SECRET_BINDING);
  }
}

/**
 * Trade-worker-specific ExchangeRouter.
 * Composes the shared generic router and adds KV-based dynamic exchange routing.
 */
export class ExchangeRouter implements Pick<
  IExchangeRouter<IExchangeClient, Env>,
  "registerProvider" | "route"
> {
  private readonly baseRouter = new BaseRouter<IExchangeClient, Env>();

  constructor() {
    this.baseRouter.registerProvider(new BinanceProvider());
    this.baseRouter.registerProvider(new MexcProvider());
    this.baseRouter.registerProvider(new BybitProvider());
  }

  registerProvider(provider: IExchangeProvider<IExchangeClient, Env>): void {
    this.baseRouter.registerProvider(provider);
  }

  async route(
    payload: WebhookPayload,
    env: Env
  ): Promise<{ exchange: string; client: IExchangeClient }> {
    let exchange = payload.exchange.toLowerCase();

    // Check KV for dynamic routing
    if (env.CONFIG_KV) {
      try {
        const routingTableStr = await env.CONFIG_KV.get(
          KVKeys.KV_TRADE_ROUTING
        );
        if (routingTableStr) {
          const routingTable = JSON.parse(routingTableStr);
          if (routingTable[payload.symbol]) {
            exchange = routingTable[payload.symbol].toLowerCase();
            logger.info("Dynamic route for symbol", {
              symbol: payload.symbol,
              exchange,
            });
          }
        }
      } catch (e) {
        logger.error("Failed to parse routing table from KV", {
          error: toError(e),
        });
      }
    }

    return this.baseRouter.route(exchange, env);
  }
}
