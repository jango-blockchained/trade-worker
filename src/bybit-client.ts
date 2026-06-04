// workers/trade-worker/src/bybit-client.ts

import { createLogger } from "@jango-blockchained/hoox-shared/middleware";
import type { Logger } from "@jango-blockchained/hoox-shared/middleware";
import { BaseExchangeClient } from "@jango-blockchained/hoox-shared/exchanges";

// Define interfaces for Bybit V5 API responses
interface BybitBaseResponse {
  retCode: number;
  retMsg: string;
  time: number;
}

interface BybitSuccessResponse<T> extends BybitBaseResponse {
  retCode: 0;
  result: T;
}

interface BybitErrorResponse extends BybitBaseResponse {
  retCode: Exclude<number, 0>; // Any number other than 0
  result?: unknown; // Sometimes result might exist even on error
}

type BybitApiResponse<T> = BybitSuccessResponse<T> | BybitErrorResponse;

/**
 * Bybit API V5 client implementation.
 */
export class BybitClient extends BaseExchangeClient {
  private readonly recvWindow: number = 5000; // Bybit specific recv_window
  private readonly logger: Logger;

  constructor(apiKey: string, apiSecret: string) {
    super(apiKey, apiSecret);
    this.logger = createLogger({
      service: "trade-worker",
      module: "bybit-client",
    });
  }

  protected getErrorMessagePrefix(): string {
    return "BybitClient ";
  }

  protected getDefaultBaseUrl(): string {
    return "https://api.bybit.com";
  }

  /**
   * Generates HMAC-SHA256 signature for authenticated requests.
   * Bybit V5 signature: timestamp + apiKey + recvWindow + paramsStr
   */
  private async generateSignature(
    timestamp: number,
    paramsStr: string
  ): Promise<string> {
    const signaturePayload = `${timestamp}${this.apiKey}${this.recvWindow}${paramsStr}`;
    return this.cryptoSign(signaturePayload);
  }

  /**
   * Makes an authenticated request to the Bybit API V5.
   */
  private async makeRequest<T>(
    method: string,
    path: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    const timestamp = Date.now();
    let paramsStr = "";
    let finalUrl = `${this.baseUrl}${path}`;

    if (method === "GET" || method === "DELETE") {
      if (Object.keys(params).length > 0) {
        // Sort GET params alphabetically for signature
        const sortedParams: Record<string, unknown> = {};
        Object.keys(params)
          .sort()
          .forEach((key) => (sortedParams[key] = params[key]));
        paramsStr = new URLSearchParams(
          sortedParams as Record<string, string>
        ).toString();
        finalUrl += `?${paramsStr}`;
      }
    } else {
      // POST/PUT params are stringified in the body AND used for signature
      paramsStr = JSON.stringify(params);
    }

    const signature = await this.generateSignature(timestamp, paramsStr);

    const options: RequestInit = {
      method: method,
      headers: {
        "Content-Type": "application/json",
        "X-BAPI-API-KEY": this.apiKey,
        "X-BAPI-TIMESTAMP": String(timestamp),
        "X-BAPI-RECV-WINDOW": String(this.recvWindow),
        "X-BAPI-SIGN": signature,
      },
    };

    if (method === "POST" || method === "PUT") {
      options.body = paramsStr;
    }

    this.logger.info("Bybit Request", { method, url: finalUrl });
    if (options.body) {
      this.logger.info("Bybit Request Body", { body: options.body });
    }

    const response = await fetch(finalUrl, options);
    const responseData: BybitApiResponse<T> = await response.json();

    this.logger.info("Bybit Response Status", { status: response.status });
    this.logger.info("Bybit Response Body", {
      body: JSON.stringify(responseData),
    });

    if (responseData.retCode !== 0) {
      throw new Error(
        `Bybit API Error (${responseData.retCode}): ${responseData.retMsg}`
      );
    }

    return (responseData as BybitSuccessResponse<T>).result;
  }

  async setLeverage(symbol: string, leverage: number): Promise<any> {
    const path = "/v5/position/set-leverage";
    const params = {
      category: "linear", // Assuming linear perpetual futures
      symbol: symbol,
      buyLeverage: String(leverage),
      sellLeverage: String(leverage),
    };
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
    const path = "/v5/order/create";
    const apiParams: Record<string, unknown> = {
      category: "linear",
      symbol: params.symbol,
      side:
        params.side.charAt(0).toUpperCase() +
        params.side.slice(1).toLowerCase(), // Bybit uses "Buy" or "Sell"
      orderType:
        params.orderType.charAt(0).toUpperCase() +
        params.orderType.slice(1).toLowerCase(), // "Market" or "Limit"
      qty: String(params.quantity),
    };

    if (params.orderType.toLowerCase() === "limit" && params.price) {
      apiParams.price = String(params.price);
    }

    if (params.reduceOnly !== undefined) {
      apiParams.reduceOnly = params.reduceOnly;
    }

    return this.makeRequest<any>("POST", path, apiParams);
  }

  // --- Account Info ---
  async getAccountInfo(): Promise<any> {
    const path = "/v5/account/wallet-balance";
    const params = {
      accountType: "UNIFIED", // Or CONTRACT if specifically needed
    };
    return this.makeRequest<any>("GET", path, params);
  }

  async getPositions(symbol?: string): Promise<any> {
    const path = "/v5/position/list";
    const params: Record<string, string> = {
      category: "linear",
    };
    if (symbol) {
      params.symbol = symbol;
    }
    return this.makeRequest<any>("GET", path, params);
  }
}
