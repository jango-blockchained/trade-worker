// workers/trade-worker/src/bybit-client.ts

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
  result?: any; // Sometimes result might exist even on error
}

type BybitApiResponse<T> = BybitSuccessResponse<T> | BybitErrorResponse;

// Interface for the client methods
export interface IBybitClient {
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
 * Bybit API V5 client implementation.
 */
export class BybitClient implements IBybitClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string = "https://api.bybit.com";
  private readonly recvWindow: number = 5000; // Bybit specific recv_window

  constructor(apiKey: string, apiSecret: string) {
    if (!apiKey || !apiSecret) {
      throw new Error("Bybit API key and secret are required.");
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  /**
   * Generates HMAC-SHA256 signature for authenticated requests.
   */
  private async generateSignature(
    timestamp: number,
    paramsStr: string
  ): Promise<string> {
    // Bybit V5 signature: timestamp + apiKey + recvWindow + paramsStr
    const signaturePayload = `${timestamp}${this.apiKey}${this.recvWindow}${paramsStr}`;

    const encoder = new TextEncoder();
    const key = encoder.encode(this.apiSecret);
    const message = encoder.encode(signaturePayload);

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
   * Makes an authenticated request to the Bybit API V5.
   */
  private async makeRequest<T>(
    method: string,
    path: string,
    params: Record<string, any> = {}
  ): Promise<T> {
    const timestamp = Date.now();
    let paramsStr = "";
    let finalUrl = `${this.baseUrl}${path}`;

    if (method === "GET" || method === "DELETE") {
      if (Object.keys(params).length > 0) {
        // Sort GET params alphabetically for signature
        const sortedParams: Record<string, any> = {};
        Object.keys(params)
          .sort()
          .forEach((key) => (sortedParams[key] = params[key]));
        paramsStr = new URLSearchParams(sortedParams).toString();
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

    console.log(`Bybit Request: ${method} ${finalUrl}`);
    if (options.body) {
      console.log(`Bybit Request Body: ${options.body}`);
    }

    const response = await fetch(finalUrl, options);
    const responseData: BybitApiResponse<T> = await response.json();

    console.log("Bybit Response Status:", response.status);
    console.log("Bybit Response Body:", JSON.stringify(responseData, null, 2));

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
    const apiParams: Record<string, any> = {
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

    // Map actions to side and potentially reduceOnly
    if (params.side.toUpperCase() === "LONG") apiParams.side = "Buy";
    if (params.side.toUpperCase() === "SHORT") apiParams.side = "Sell";
    if (params.side.toUpperCase() === "CLOSE_LONG") {
      apiParams.side = "Sell";
      apiParams.reduceOnly = true;
    }
    if (params.side.toUpperCase() === "CLOSE_SHORT") {
      apiParams.side = "Buy";
      apiParams.reduceOnly = true;
    }

    return this.makeRequest<any>("POST", path, apiParams);
  }

  // --- Helper Methods ---
  async openLong(
    symbol: string,
    quantity: number,
    price?: number,
    orderType: string = "Market"
  ): Promise<any> {
    return this.executeTrade({
      symbol,
      side: "Buy",
      quantity,
      price,
      orderType,
    });
  }

  async openShort(
    symbol: string,
    quantity: number,
    price?: number,
    orderType: string = "Market"
  ): Promise<any> {
    return this.executeTrade({
      symbol,
      side: "Sell",
      quantity,
      price,
      orderType,
    });
  }

  async closeLong(symbol: string, quantity: number): Promise<any> {
    return this.executeTrade({
      symbol,
      side: "Sell",
      quantity,
      orderType: "Market",
      reduceOnly: true,
    });
  }

  async closeShort(symbol: string, quantity: number): Promise<any> {
    return this.executeTrade({
      symbol,
      side: "Buy",
      quantity,
      orderType: "Market",
      reduceOnly: true,
    });
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
