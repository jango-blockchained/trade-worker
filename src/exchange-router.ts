import { MexcClient } from "./mexc-client";
import { BinanceClient } from "./binance-client";
import { BybitClient } from "./bybit-client";
import type { Env, IExchangeClient } from "./index";
import type { WebhookPayload } from "@jango-blockchained/hoox-shared/types";
import { KVKeys } from "@jango-blockchained/hoox-shared/kvKeys";
import { createLogger } from "@jango-blockchained/hoox-shared/middleware";
import { toError } from "@jango-blockchained/hoox-shared/errors";

const logger = createLogger({ service: "trade-worker", module: "exchange-router" });

export interface IExchangeProvider {
  name: string;
  createClient(env: Env): IExchangeClient;
  hasCredentials(env: Env): boolean;
}

export class BinanceProvider implements IExchangeProvider {
  name = "binance";
  createClient(env: Env): IExchangeClient {
    const apiKey = env.BINANCE_KEY_BINDING;
    const apiSecret = env.BINANCE_SECRET_BINDING;
    if (!apiKey || !apiSecret)
      throw new Error("Binance API secrets unavailable.");
    const ClientClass = env.__mocks__?.BinanceClient || BinanceClient;
    return new ClientClass(apiKey, apiSecret);
  }
  hasCredentials(env: Env): boolean {
    return !!(env.BINANCE_KEY_BINDING && env.BINANCE_SECRET_BINDING);
  }
}

export class MexcProvider implements IExchangeProvider {
  name = "mexc";
  createClient(env: Env): IExchangeClient {
    const apiKey = env.MEXC_KEY_BINDING;
    const apiSecret = env.MEXC_SECRET_BINDING;
    if (!apiKey || !apiSecret) throw new Error("MEXC API secrets unavailable.");
    const ClientClass = env.__mocks__?.MexcClient || MexcClient;
    return new ClientClass(apiKey, apiSecret);
  }
  hasCredentials(env: Env): boolean {
    return !!(env.MEXC_KEY_BINDING && env.MEXC_SECRET_BINDING);
  }
}

export class BybitProvider implements IExchangeProvider {
  name = "bybit";
  createClient(env: Env): IExchangeClient {
    const apiKey = env.BYBIT_KEY_BINDING;
    const apiSecret = env.BYBIT_SECRET_BINDING;
    if (!apiKey || !apiSecret)
      throw new Error("Bybit API secrets unavailable.");
    const ClientClass = env.__mocks__?.BybitClient || BybitClient;
    return new ClientClass(apiKey, apiSecret);
  }
  hasCredentials(env: Env): boolean {
    return !!(env.BYBIT_KEY_BINDING && env.BYBIT_SECRET_BINDING);
  }
}

export class ExchangeRouter {
  providers = new Map<string, IExchangeProvider>();

  constructor() {
    this.registerProvider(new BinanceProvider());
    this.registerProvider(new MexcProvider());
    this.registerProvider(new BybitProvider());
  }

  registerProvider(provider: IExchangeProvider) {
    this.providers.set(provider.name.toLowerCase(), provider);
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
            logger.info("Dynamic route for symbol", { symbol: payload.symbol, exchange });
          }
        }
      } catch (e) {
        logger.error("Failed to parse routing table from KV", { error: toError(e) });
      }
    }

    const provider = this.providers.get(exchange);
    if (!provider) {
      throw new Error(`Unsupported exchange: ${exchange}`);
    }

    if (!provider.hasCredentials(env)) {
      throw new Error(
        `API secret bindings not configured or accessible for ${exchange}`
      );
    }

    return { exchange, client: provider.createClient(env) };
  }
}
