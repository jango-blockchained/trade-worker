import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  spyOn,
  mock,
  type Mock,
} from "bun:test";
import { MexcClient } from "../src/mexc-client.js";

// --- Mocks ---
const mockFetch = mock(global.fetch);
global.fetch = mockFetch as any;

const mockImportKey: Mock<typeof crypto.subtle.importKey> = mock(() =>
  Promise.resolve({} as CryptoKey)
);
const mockSign: Mock<typeof crypto.subtle.sign> = mock(() =>
  Promise.resolve(new ArrayBuffer(0))
);

// Mock crypto for Bun's environment
Object.defineProperty(globalThis, "crypto", {
  value: {
    subtle: {
      importKey: mockImportKey,
      sign: mockSign,
    },
    getRandomValues: mock(<T extends ArrayBufferView | null>(arr: T): T => {
      if (arr instanceof Uint8Array) {
        arr.fill(1);
      }
      return arr;
    }),
  },
  writable: true,
});

// --- Test Suite ---
describe("MexcClient (V1 Futures)", () => {
  const API_KEY = "test-mexc-key";
  const API_SECRET = "test-mexc-secret";
  const BASE_URL = "https://contract.mexc.com";

  let client: MexcClient;
  let fixedTimestamp: number;
  let mockSignatureHex: string;

  beforeEach(() => {
    mock.restore();
    mockFetch.mockClear();
    mockImportKey.mockClear();
    mockSign.mockClear();

    fixedTimestamp = Date.now();
    spyOn(Date, "now").mockImplementation(() => fixedTimestamp);

    // Mock crypto
    mockImportKey.mockResolvedValue({} as CryptoKey);
    const mockSignatureArrayBuffer = new Uint8Array([
      0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22,
    ]).buffer;
    mockSign.mockResolvedValue(mockSignatureArrayBuffer);
    mockSignatureHex = "aabbccddeeff1122"; // Expected hex signature

    // Default fetch mock (successful MEXC response)
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 200,
          msg: "Success",
          data: { result: "mock data" },
        }),
        { status: 200 }
      )
    );

    client = new MexcClient(API_KEY, API_SECRET);
  });

  // --- Constructor Tests ---
  test("should initialize with valid API key and secret", () => {
    expect(client).toBeInstanceOf(MexcClient);
  });

  test("should throw error if API key is missing", () => {
    expect(() => new MexcClient("", API_SECRET)).toThrow(
      "MEXC API key and secret are required."
    );
  });

  test("should throw error if API secret is missing", () => {
    expect(() => new MexcClient(API_KEY, "")).toThrow(
      "MEXC API key and secret are required."
    );
  });

  // --- Signing Logic Test ---
  test("generateSignature should create correct HMAC-SHA256 signature string from sorted params", async () => {
    // Params out of order
    const params = { symbol: "BTC_USDT", type: 2, volume: 0.01 };
    const expectedSortedQuery = "symbol=BTC_USDT&type=2&volume=0.01"; // Sorted alphabetically
    const expectedPayload = `${expectedSortedQuery}&timestamp=${fixedTimestamp}`;

    const signature = await (client as any).generateSignature(
      params,
      fixedTimestamp
    );

    expect(signature).toBe(mockSignatureHex);
    expect(mockImportKey).toHaveBeenCalledTimes(1);
    expect(mockSign).toHaveBeenCalledTimes(1);

    // Verify the payload bytes passed to sign
    expect(mockSign.mock.calls.length).toBeGreaterThan(0);
    const signCallArgs = mockSign.mock.calls[0];
    // @ts-ignore - Ignore complex mock args type
    const payloadBuffer = signCallArgs[2] as ArrayBuffer;
    const decodedPayload = new TextDecoder().decode(payloadBuffer);
    expect(decodedPayload).toBe(expectedPayload);
  });

  // --- Request Execution Tests ---
  test("makeRequest (GET) should format URL with all params (incl. sig/ts), set headers, and call fetch", async () => {
    const path = "/api/v1/private/account/assets";
    const params = { currency: "USDT" }; // Example GET param
    const mockResultData = { usdtBalance: 1000 };
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 200,
          msg: "Success",
          data: mockResultData,
        }),
        { status: 200 }
      )
    );

    // Expected sorted query from params + timestamp + signature for URL
    const expectedSortedQueryForSig = `currency=USDT`;
    const expectedSigPayload = `${expectedSortedQueryForSig}&timestamp=${fixedTimestamp}`;
    const expectedFinalQuery = `currency=USDT&timestamp=${fixedTimestamp}&signature=${mockSignatureHex}`; // All params in final URL

    const result = await (client as any).makeRequest("GET", path, params);

    expect(result).toEqual(mockResultData);
    expect(mockSign).toHaveBeenCalledTimes(1);

    // Check signature payload was correct
    expect(mockSign.mock.calls.length).toBeGreaterThan(0);
    const signCallArgs = mockSign.mock.calls[0];
    // @ts-ignore
    const payloadBuffer = signCallArgs[2] as ArrayBuffer;
    const decodedPayload = new TextDecoder().decode(payloadBuffer);
    expect(decodedPayload).toBe(expectedSigPayload);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
    const fetchCallArgs = mockFetch.mock.calls[0];
    const url = new URL(fetchCallArgs[0] as string);
    const options = fetchCallArgs[1] as RequestInit;

    expect(url.origin + url.pathname).toBe(`${BASE_URL}${path}`);
    expect(url.search).toBe(`?${expectedFinalQuery}`); // Verify full query string
    expect(options.method).toBe("GET");
    expect(options.headers).toBeDefined();
    const headers = options.headers as Record<string, string>; // Assert as Record
    expect(headers["X-MEXC-APIKEY"]).toBe(API_KEY);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(options.body).toBeUndefined();
  });

  test("makeRequest (POST) should include all params (incl. sig/ts) in body, set headers, and call fetch", async () => {
    const path = "/api/v1/private/order/submit";
    const params = {
      symbol: "ETH_USDT",
      side: 1,
      type: 2,
      volume: 0.1,
      openType: 1,
    };
    const mockResultData = { orderId: "mexc123" };
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 200,
          msg: "Success",
          data: mockResultData,
        }),
        { status: 200 }
      )
    );

    // Signature generation
    const expectedSortedQueryForSig =
      "openType=1&side=1&symbol=ETH_USDT&type=2&volume=0.1";
    const expectedSigPayload = `${expectedSortedQueryForSig}&timestamp=${fixedTimestamp}`;

    // Expected body includes original params + timestamp + signature
    const expectedBody = JSON.stringify({
      ...params,
      timestamp: fixedTimestamp,
      signature: mockSignatureHex,
    });

    const result = await (client as any).makeRequest("POST", path, params);

    expect(result).toEqual(mockResultData);
    expect(mockSign).toHaveBeenCalledTimes(1);
    // Verify signature payload
    expect(mockSign.mock.calls.length).toBeGreaterThan(0);
    const signCallArgs = mockSign.mock.calls[0];
    // @ts-ignore
    const payloadBuffer = signCallArgs[2] as ArrayBuffer;
    const decodedPayload = new TextDecoder().decode(payloadBuffer);
    expect(decodedPayload).toBe(expectedSigPayload);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
    const fetchCallArgs = mockFetch.mock.calls[0];
    const url = new URL(fetchCallArgs[0] as string);
    const options = fetchCallArgs[1] as RequestInit;

    expect(url.origin + url.pathname).toBe(`${BASE_URL}${path}`);
    expect(url.search).toBe(""); // No query params for POST
    expect(options.method).toBe("POST");
    expect(options.headers).toBeDefined();
    const headers = options.headers as Record<string, string>; // Assert as Record
    expect(headers["X-MEXC-APIKEY"]).toBe(API_KEY);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(options.body).toBe(expectedBody);
  });

  // --- API Method Tests ---
  test("setLeverage should resolve immediately and warn (needs verification)", async () => {
    const warnSpy = spyOn(console, "warn");
    const result = await client.setLeverage("BTC_USDT", 10);
    expect(result).toEqual({ info: "Set leverage needs V1 API verification" });
    expect(warnSpy).toHaveBeenCalledWith(
      "setLeverage for MEXC V1 Futures needs verification."
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("executeTrade (Market Open Long) should call makeRequest with correct params", async () => {
    const params = {
      symbol: "ETH_USDT",
      side: "LONG",
      orderType: "MARKET",
      quantity: 0.1,
    };
    const makeRequestSpy = spyOn(client as any, "makeRequest");

    await client.executeTrade(params);

    expect(makeRequestSpy).toHaveBeenCalledWith(
      "POST",
      "/api/v1/private/order/submit",
      {
        symbol: params.symbol,
        side: 1, // Open Long
        type: 2, // Market
        openType: 1,
        volume: params.quantity,
        price: undefined,
        // reduceOnly not included by default
      }
    );
  });

  test("executeTrade (Limit Close Short) should call makeRequest with correct params", async () => {
    const params = {
      symbol: "ETH_USDT",
      side: "CLOSE_SHORT",
      orderType: "LIMIT",
      quantity: 0.1,
      price: 1800,
      reduceOnly: true,
    };
    const makeRequestSpy = spyOn(client as any, "makeRequest");
    const warnSpy = spyOn(console, "warn"); // Spy on warning for reduceOnly

    await client.executeTrade(params);

    expect(warnSpy).toHaveBeenCalledWith(
      "MEXC V1 API reduceOnly parameter needs verification."
    );
    expect(makeRequestSpy).toHaveBeenCalledWith(
      "POST",
      "/api/v1/private/order/submit",
      {
        symbol: params.symbol,
        side: 4, // Close Short
        type: 1, // Limit
        openType: 1,
        volume: params.quantity,
        price: params.price,
        // reduceOnly not included by default
      }
    );
  });

  test("getAccountInfo should call makeRequest correctly", async () => {
    const makeRequestSpy = spyOn(client as any, "makeRequest");
    await client.getAccountInfo();
    expect(makeRequestSpy).toHaveBeenCalledWith(
      "GET",
      "/api/v1/private/account/assets"
    );
  });

  test("getPositions should call makeRequest correctly", async () => {
    const makeRequestSpy = spyOn(client as any, "makeRequest");
    await client.getPositions("BTC_USDT");
    expect(makeRequestSpy).toHaveBeenCalledWith(
      "GET",
      "/api/v1/private/position/list",
      { symbol: "BTC_USDT" }
    );
  });

  // --- Error Handling Tests ---
  test("makeRequest should throw formatted error on non-200 code in response", async () => {
    const errorCode = 10006;
    const errorMsg = "Signature verification failed";
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: errorCode,
          msg: errorMsg,
          data: null,
        }),
        { status: 200 }
      )
    );

    await expect(
      (client as any).makeRequest("GET", "/api/v1/private/account/assets")
    ).rejects.toThrow(`MEXC API Error (${errorCode}): ${errorMsg}`);
  });

  test("makeRequest should throw formatted error on non-OK HTTP status", async () => {
    const errorCode = 503;
    const errorMsg = "Service Unavailable";
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: errorCode,
          msg: errorMsg,
          data: null,
        }),
        { status: 503, statusText: errorMsg }
      )
    );

    await expect(
      (client as any).makeRequest("GET", "/api/v1/private/account/assets")
    ).rejects.toThrow(`MEXC API Error (${errorCode}): ${errorMsg}`);
  });

  test("makeRequest should re-throw fetch network error", async () => {
    const networkError = new Error("Connection refused");
    mockFetch.mockRejectedValueOnce(networkError);

    await expect(
      (client as any).makeRequest("GET", "/api/v1/private/account/assets")
    ).rejects.toThrow(networkError);
  });
});
