// workers/trade-worker/src/binance-client.ts

// Define interfaces for Binance API responses (adjust based on actual API)
interface BinanceErrorResponse {
  code: number;
  msg: string;
}

// Define generic or specific success response types if known
type BinanceApiResponse<T> = T | BinanceErrorResponse;

// Interface for the client methods
export interface IBinanceClient {
  setLeverage(symbol: string, leverage: number): Promise<any>;
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
 * Binance API client implementation.
 */
export class BinanceClient implements IBinanceClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string = "https://fapi.binance.com"; // Futures API

  constructor(apiKey: string, apiSecret: string) {
    if (!apiKey || !apiSecret) {
      throw new Error("Binance API key and secret are required.");
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
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

    const encoder = new TextEncoder();
    const key = encoder.encode(this.apiSecret);
    const message = encoder.encode(queryString);

    const importedKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      importedKey,
      message
    );

    return Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
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
    const queryParams = new URLSearchParams(
      allParams as Record<string, string>
    ).toString();
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

    console.log(`Binance Request: ${method} ${url}`);

    const response = await fetch(url, options);
    const responseData: BinanceApiResponse<T> = await response.json();

    console.log("Binance Response Status:", response.status);
    console.log(
      "Binance Response Body:",
      JSON.stringify(responseData, null, 2)
    );

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

    // Map LONG/SHORT/CLOSE actions to Binance BUY/SELL sides
    if (params.side.toUpperCase() === "LONG") apiParams.side = "BUY";
    if (params.side.toUpperCase() === "SHORT") apiParams.side = "SELL";
    if (params.side.toUpperCase() === "CLOSE_LONG") {
      apiParams.side = "SELL";
      apiParams.reduceOnly = true;
    }
    if (params.side.toUpperCase() === "CLOSE_SHORT") {
      apiParams.side = "BUY";
      apiParams.reduceOnly = true;
    }

    return this.makeRequest<any>("POST", path, apiParams);
  }

  // --- Helper Methods ---
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
    // Close long = place a SELL order with reduceOnly=true
    return this.executeTrade({
      symbol,
      side: "SELL",
      quantity,
      orderType: "MARKET",
      reduceOnly: true,
    });
  }

  async closeShort(symbol: string, quantity: number): Promise<any> {
    // Close short = place a BUY order with reduceOnly=true
    return this.executeTrade({
      symbol,
      side: "BUY",
      quantity,
      orderType: "MARKET",
      reduceOnly: true,
    });
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
