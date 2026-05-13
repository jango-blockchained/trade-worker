// workers/trade-worker/src/mexc-client.ts

import { createLogger } from "@jango-blockchained/hoox-shared/middleware";
import type { Logger } from "@jango-blockchained/hoox-shared/middleware";
import { bufferToHex } from "./shared/exchange-client";

// Define interfaces for MEXC API responses (adjust based on actual API)
interface MexcSuccessResponse<T> {
  code: number; // Typically 200 for success
  data: T;
  msg?: string;
}

interface MexcErrorResponse {
  code: number;
  msg: string;
  data?: any;
}

type MexcApiResponse<T> = MexcSuccessResponse<T> | MexcErrorResponse;

// Interface for the client methods
export interface IMexcClient {
  setLeverage(
    symbol: string,
    leverage: number,
    positionSide?: string
  ): Promise<any>;
  executeTrade(params: {
    symbol: string;
    side: string;
    orderType: string;
    quantity: number;
    price?: number;
    reduceOnly?: boolean;
  }): Promise<any>;
  getAccountInfo(): Promise<any>;
  getPositions(symbol?: string): Promise<any>;
  openLong(
    symbol: string,
    quantity: number,
    price?: number,
    orderType?: string
  ): Promise<any>; // Helper
  openShort(
    symbol: string,
    quantity: number,
    price?: number,
    orderType?: string
  ): Promise<any>; // Helper
  closeLong(symbol: string, quantity: number): Promise<any>; // Helper
  closeShort(symbol: string, quantity: number): Promise<any>; // Helper
}

/**
 * MEXC API client implementation.
 */
export class MexcClient implements IMexcClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string = "https://contract.mexc.com"; // Use V1 futures API
  private readonly importedKeyPromise: Promise<CryptoKey>;
  private readonly logger: Logger;

  constructor(apiKey: string, apiSecret: string) {
    if (!apiKey || !apiSecret) {
      throw new Error("MEXC API key and secret are required.");
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.logger = createLogger({
      service: "trade-worker",
      module: "mexc-client",
    });

    // Pre-import the HMAC key to avoid expensive importKey on every request
    const encoder = new TextEncoder();
    this.importedKeyPromise = crypto.subtle.importKey(
      "raw",
      encoder.encode(apiSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
  }

  /**
   * Generates HMAC-SHA256 signature for authenticated requests.
   */
  private async generateSignature(
    params: Record<string, string | number>,
    timestamp: number
  ): Promise<string> {
    // Convert all values to string for consistency
    const stringParams: Record<string, string> = {};
    for (const key in params) {
      stringParams[key] = String(params[key]);
    }

    const queryString = Object.keys(stringParams)
      .sort()
      .map((key) => `${key}=${stringParams[key]}`)
      .join("&");

    // Signature payload includes timestamp
    const signaturePayload = `${queryString}&timestamp=${timestamp}`;

    const encoder = new TextEncoder();
    const message = encoder.encode(signaturePayload);

    const importedKey = await this.importedKeyPromise;
    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      importedKey,
      message
    );

    return bufferToHex(signatureBuffer);
  }

  /**
   * Makes an authenticated request to the MEXC API.
   */
  private async makeRequest<T>(
    method: string,
    path: string,
    params: Record<string, string | number> = {}
  ): Promise<T> {
    const timestamp = Date.now();
    const signature = await this.generateSignature(params, timestamp);

    const allParams = { ...params, timestamp, signature };

    const url = new URL(`${this.baseUrl}${path}`);

    const options: RequestInit = {
      method: method,
      headers: {
        "Content-Type": "application/json",
        "X-MEXC-APIKEY": this.apiKey,
      },
    };

    if (method === "GET" || method === "DELETE") {
      // Append params to URL for GET/DELETE
      Object.entries(allParams).forEach(([key, value]) =>
        url.searchParams.append(key, String(value))
      );
    } else if (method === "POST" || method === "PUT") {
      // Send params in body for POST/PUT
      options.body = JSON.stringify(allParams);
    }

    this.logger.info("MEXC Request", { method, url: url.toString() });
    if (options.body) {
      this.logger.info("MEXC Request Body", { body: options.body });
    }

    const response = await fetch(url.toString(), options);
    const responseData: MexcApiResponse<T> = await response.json();

    this.logger.info("MEXC Response Status", { status: response.status });
    this.logger.info("MEXC Response Body", {
      body: JSON.stringify(responseData),
    });

    if (!response.ok || responseData.code !== 200) {
      throw new Error(
        `MEXC API Error (${responseData.code}): ${responseData.msg || "Unknown error"}`
      );
    }

    return (responseData as MexcSuccessResponse<T>).data;
  }

  /**
   * Set leverage for a symbol.
   * MEXC V1 Futures API endpoint: POST /api/v1/private/position/change_leverage
   */
  async setLeverage(
    symbol: string,
    leverage: number,
    positionSide: string = "BOTH"
  ): Promise<any> {
    const path = "/api/v1/private/position/change_leverage";
    const params: Record<string, string | number> = {
      symbol: symbol,
      leverage: leverage,
    };
    return this.makeRequest<any>("POST", path, params);
  }

  /**
   * Execute a trade order.
   */
  async executeTrade(params: {
    symbol: string;
    side: string;
    orderType: string;
    quantity: number;
    price?: number;
    reduceOnly?: boolean;
  }): Promise<any> {
    const path = "/api/v1/private/order/submit";
    const apiParams: Record<string, string | number> = {
      symbol: params.symbol,
      side: 1, // Default to Open Long, will be overridden below if needed
      type: params.orderType?.toUpperCase() === "LIMIT" ? 1 : 2, // 1: Limit, 2: Market
      openType: 1, // 1: Isolated, 2: Cross
      volume: params.quantity, // Quantity
      // positionId?
      // reduceOnly?  Need to map this correctly if V1 supports it
    };

    // Handle specific open/close logic based on side
    if (params.side.toUpperCase() === "CLOSE_LONG") {
      apiParams.side = 3;
    } else if (params.side.toUpperCase() === "CLOSE_SHORT") {
      apiParams.side = 4;
    }

    if (apiParams.type === 1 && params.price) {
      // Only add price for LIMIT orders
      apiParams.price = params.price;
    }

    if (params.reduceOnly) {
      this.logger.warn("MEXC V1 API reduceOnly parameter needs verification");
    }

    return this.makeRequest<any>("POST", path, apiParams);
  }

  // --- Helper Methods (Consistent Interface) ---

  async openLong(
    symbol: string,
    quantity: number,
    price?: number,
    orderType: string = "MARKET"
  ): Promise<any> {
    return this.executeTrade({
      symbol,
      side: "BUY",
      quantity,
      price,
      orderType,
    });
  }

  async openShort(
    symbol: string,
    quantity: number,
    price?: number,
    orderType: string = "MARKET"
  ): Promise<any> {
    return this.executeTrade({
      symbol,
      side: "SELL",
      quantity,
      price,
      orderType,
    });
  }

  async closeLong(symbol: string, quantity: number): Promise<any> {
    // Assuming closing uses a market order
    return this.executeTrade({
      symbol,
      side: "CLOSE_LONG",
      quantity,
      orderType: "MARKET",
      reduceOnly: true,
    });
  }

  async closeShort(symbol: string, quantity: number): Promise<any> {
    // Assuming closing uses a market order
    return this.executeTrade({
      symbol,
      side: "CLOSE_SHORT",
      quantity,
      orderType: "MARKET",
      reduceOnly: true,
    });
  }

  // --- Account Info ---

  async getAccountInfo(): Promise<any> {
    const path = "/api/v1/private/account/assets";
    return this.makeRequest<any>("GET", path);
  }

  async getPositions(symbol?: string): Promise<any> {
    const path = "/api/v1/private/position/list";
    const params: Record<string, string> = {};
    if (symbol) {
      params.symbol = symbol;
    }
    return this.makeRequest<any>("GET", path, params);
  }
}
