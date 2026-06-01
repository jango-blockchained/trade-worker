// workers/trade-worker/src/binance-client.ts

import { createLogger } from "@jango-blockchained/hoox-shared/middleware";
import { BaseExchangeClient } from "./shared/base-exchange-client";

// Define interfaces for Binance API responses (adjust based on actual API)
interface BinanceErrorResponse {
  code: number;
  msg: string;
}

// Define generic or specific success response types if known
type BinanceApiResponse<T> = T | BinanceErrorResponse;

/**
 * Binance API client implementation.
 */
export class BinanceClient extends BaseExchangeClient {
  private logger = createLogger({
    service: "trade-worker",
    module: "binance-client",
  });

  constructor(apiKey: string, apiSecret: string) {
    super(apiKey, apiSecret);
  }

  protected getDefaultBaseUrl(): string {
    return "https://fapi.binance.com"; // Futures API
  }

  /**
   * Generates HMAC-SHA256 signature for authenticated requests.
   */
  private async generateSignature(
    params: Record<string, string | number | boolean>
  ): Promise<string> {
    // Binance expects URLSearchParams format for signature
    const queryString = new URLSearchParams(
      params as Record<string, string>
    ).toString();

    return this.cryptoSign(queryString);
  }

  /**
   * Makes an authenticated request to the Binance API.
   */
  private async makeRequest<T>(
    method: string,
    path: string,
    params: Record<string, string | number | boolean> = {}
  ): Promise<T> {
    const timestamp = Date.now();
    const allParams = { ...params, timestamp };

    const signature = await this.generateSignature(allParams);
    const stringParams: Record<string, string> = {};
    Object.entries(allParams).forEach(([k, v]) => {
      stringParams[k] = String(v);
    });
    const queryParams = new URLSearchParams(stringParams).toString();
    const url = `${this.baseUrl}${path}?${queryParams}&signature=${signature}`;

    const options: RequestInit = {
      method: method,
      headers: {
        "Content-Type": "application/json",
        "X-MBX-APIKEY": this.apiKey,
      },
    };

    // Binance usually includes params in query string even for POST/DELETE
    // If body is needed for specific endpoints, adjust here

    this.logger.info("Binance request", { method, url });

    const response = await fetch(url, options);
    const responseData: BinanceApiResponse<T> = await response.json();

    this.logger.info("Binance response", {
      status: response.status,
      body: JSON.stringify(responseData),
    });

    if (!response.ok) {
      const error = responseData as BinanceErrorResponse;
      throw new Error(
        `Binance API Error (${error.code}): ${error.msg || "Unknown error"}`
      );
    }

    // Return the data directly if successful (assuming error check passed)
    return responseData as T;
  }

  async setLeverage(symbol: string, leverage: number): Promise<any> {
    const path = "/fapi/v1/leverage";
    const params = { symbol, leverage };
    return this.makeRequest<any>("POST", path, params);
  }

  async executeTrade(params: {
    symbol: string;
    side: string;
    orderType: string;
    quantity: number;
    price?: number;
    reduceOnly?: boolean;
  }): Promise<any> {
    const path = "/fapi/v1/order";
    const apiParams: Record<string, string | number | boolean> = {
      symbol: params.symbol,
      side: params.side.toUpperCase(), // BUY or SELL
      type: params.orderType.toUpperCase(), // LIMIT, MARKET, etc.
      quantity: params.quantity,
    };

    if (params.orderType.toUpperCase() === "LIMIT" && params.price) {
      apiParams.price = params.price;
      apiParams.timeInForce = "GTC"; // Good Till Cancelled needed for LIMIT
    }

    if (params.reduceOnly !== undefined) {
      apiParams.reduceOnly = params.reduceOnly;
    }

    return this.makeRequest<any>("POST", path, apiParams);
  }

  // --- Account Info ---
  async getAccountInfo(): Promise<any> {
    const path = "/fapi/v2/account"; // Use v2 for more details potentially
    return this.makeRequest<any>("GET", path);
  }

  async getPositions(symbol?: string): Promise<any> {
    const path = "/fapi/v2/positionRisk"; // v2 endpoint
    const params: Record<string, string> = {};
    if (symbol) {
      params.symbol = symbol;
    }
    return this.makeRequest<any>("GET", path, params);
  }
}
