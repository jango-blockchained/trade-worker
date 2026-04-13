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
import { BinanceClient } from "../src/binance-client.js";

// --- Mocks ---
const mockFetch = mock(global.fetch);
// @ts-ignore - Ignore type mismatch for mock assignment
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
describe("BinanceClient", () => {
  const API_KEY = "test-binance-key";
  const API_SECRET = "test-binance-secret";
  const BASE_URL = "https://fapi.binance.com";

  let client: BinanceClient;
  let fixedTimestamp: number;
  let mockSignatureHex: string;

  beforeEach(() => {
    mock.restore(); // Keep bun mock restore
    mockFetch.mockClear(); // Add explicit clear
    mockImportKey.mockClear(); // Add explicit clear
    mockSign.mockClear(); // Add explicit clear

    fixedTimestamp = Date.now();
    spyOn(Date, "now").mockImplementation(() => fixedTimestamp);

    // Mock crypto
    mockImportKey.mockResolvedValue({} as CryptoKey);
    const mockSignatureArrayBuffer = new Uint8Array([
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    ]).buffer;
    mockSign.mockResolvedValue(mockSignatureArrayBuffer);
    mockSignatureHex = "0123456789abcdef"; // Expected hex signature

    // Default fetch mock using Response object
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true, // Default success for Binance (errors use HTTP status)
          data: "mock data",
        }),
        { status: 200 }
      )
    );

    client = new BinanceClient(API_KEY, API_SECRET);
  });

  afterEach(() => {
    // Ensure mocks are restored after each test if needed
    // mock.restore(); // Already in beforeEach, might be redundant unless spies need restoring here
  });

  // --- Constructor Tests ---
  test("should initialize with valid API key and secret", () => {
    expect(client).toBeInstanceOf(BinanceClient);
  });

  test("should throw error if API key is missing", () => {
    expect(() => new BinanceClient("", API_SECRET)).toThrow(
      "Binance API key and secret are required."
    );
  });

  test("should throw error if API secret is missing", () => {
    expect(() => new BinanceClient(API_KEY, "")).toThrow(
      "Binance API key and secret are required."
    );
  });

  // --- Signing Logic Test ---
  // (Assuming generateSignature is implicitly tested via makeRequest)

  // --- Request Execution Tests ---
  test("makeRequest should generate signature and call fetch correctly (GET)", async () => {
    const path = "/fapi/v2/account";
    const mockResponseData = { account: "data" };
    // Use mockResolvedValueOnce with new Response
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponseData), { status: 200 })
    );

    const result = await (client as any).makeRequest("GET", path); // Access private method for testing

    expect(result).toEqual(mockResponseData);
    expect(mockImportKey).toHaveBeenCalledTimes(1);
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const fetchCall = mockFetch.mock.calls[0];
    const url = new URL(fetchCall[0] as string); // Assert as string
    expect(url.origin + url.pathname).toBe(`${BASE_URL}${path}`);
    expect(url.searchParams.has("timestamp")).toBe(true);
    expect(url.searchParams.has("signature")).toBe(true);
    expect(url.searchParams.get("signature")).toBe(mockSignatureHex);

    const options = fetchCall[1] as RequestInit; // Assert as RequestInit
    expect(options.method).toBe("GET");
    expect((options.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe(
      API_KEY
    );
  });

  test("makeRequest should generate signature and call fetch correctly (POST)", async () => {
    const path = "/fapi/v1/leverage";
    const params = { symbol: "BTCUSDT", leverage: 20 };
    const mockResponseData = {
      symbol: "BTCUSDT",
      leverage: 20,
      maxNotionalValue: "1000000",
    };
    // Use mockResolvedValueOnce with new Response
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponseData), { status: 200 })
    );

    const result = await (client as any).makeRequest("POST", path, params);

    expect(result).toEqual(mockResponseData);
    expect(mockImportKey).toHaveBeenCalledTimes(1);
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const fetchCall = mockFetch.mock.calls[0];
    const url = new URL(fetchCall[0] as string);
    expect(url.origin + url.pathname).toBe(`${BASE_URL}${path}`);
    expect(url.searchParams.get("symbol")).toBe(params.symbol);
    expect(url.searchParams.get("leverage")).toBe(String(params.leverage));
    expect(url.searchParams.has("timestamp")).toBe(true);
    expect(url.searchParams.has("signature")).toBe(true);
    expect(url.searchParams.get("signature")).toBe(mockSignatureHex);

    const options = fetchCall[1] as RequestInit;
    expect(options.method).toBe("POST");
    expect((options.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe(
      API_KEY
    );
    expect(options.body).toBeUndefined(); // Params in query for Binance POST
  });

  // --- API Method Tests ---

  test("setLeverage should call makeRequest with correct params", async () => {
    const symbol = "ETHUSDT";
    const leverage = 10;
    const makeRequestSpy = spyOn(client as any, "makeRequest");

    await client.setLeverage(symbol, leverage);

    expect(makeRequestSpy).toHaveBeenCalledWith("POST", "/fapi/v1/leverage", {
      symbol,
      leverage,
    });
  });

  test("executeTrade (LIMIT BUY) should call makeRequest with correct params", async () => {
    const params = {
      symbol: "BTCUSDT",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 0.01,
      price: 50000,
    };
    const makeRequestSpy = spyOn(client as any, "makeRequest");

    await client.executeTrade(params);

    expect(makeRequestSpy).toHaveBeenCalledWith(
      "POST",
      "/fapi/v1/order",
      expect.objectContaining({
        symbol: params.symbol,
        side: "BUY",
        type: "LIMIT",
        quantity: params.quantity,
        price: params.price,
        timeInForce: "GTC", // Added for LIMIT orders
        // reduceOnly: undefined, // Check if client adds this or not
      })
    );
  });

  test("executeTrade (MARKET SELL) should call makeRequest with correct params", async () => {
    const params = {
      symbol: "BTCUSDT",
      side: "SELL",
      orderType: "MARKET",
      quantity: 0.01,
    };
    const makeRequestSpy = spyOn(client as any, "makeRequest");

    await client.executeTrade(params);

    expect(makeRequestSpy).toHaveBeenCalledWith(
      "POST",
      "/fapi/v1/order",
      expect.objectContaining({
        symbol: params.symbol,
        side: "SELL",
        type: "MARKET",
        quantity: params.quantity,
        // price: undefined,
        // reduceOnly: undefined,
      })
    );
  });

  test("executeTrade (CLOSE_LONG) should call makeRequest with side=SELL and reduceOnly=true", async () => {
    const params = {
      symbol: "BTCUSDT",
      side: "CLOSE_LONG",
      orderType: "MARKET",
      quantity: 0.01,
    };
    const makeRequestSpy = spyOn(client as any, "makeRequest");

    await client.executeTrade(params);

    expect(makeRequestSpy).toHaveBeenCalledWith(
      "POST",
      "/fapi/v1/order",
      expect.objectContaining({
        symbol: params.symbol,
        side: "SELL",
        type: "MARKET",
        quantity: params.quantity,
        reduceOnly: true,
      })
    );
  });

  test("executeTrade (CLOSE_SHORT) should call makeRequest with side=BUY and reduceOnly=true", async () => {
    const params = {
      symbol: "BTCUSDT",
      side: "CLOSE_SHORT",
      orderType: "MARKET",
      quantity: 0.01,
    };
    const makeRequestSpy = spyOn(client as any, "makeRequest");

    await client.executeTrade(params);

    expect(makeRequestSpy).toHaveBeenCalledWith(
      "POST",
      "/fapi/v1/order",
      expect.objectContaining({
        symbol: params.symbol,
        side: "BUY",
        type: "MARKET",
        quantity: params.quantity,
        reduceOnly: true,
      })
    );
  });

  test("openLong helper should call executeTrade correctly", async () => {
    const executeTradeSpy = spyOn(client, "executeTrade");
    const symbol = "LINKUSDT";
    const quantity = 10;

    await client.openLong(symbol, quantity);

    expect(executeTradeSpy).toHaveBeenCalledWith({
      symbol,
      side: "BUY",
      quantity,
      price: undefined,
      orderType: "MARKET",
    });
  });

  test("closeShort helper should call executeTrade correctly", async () => {
    const executeTradeSpy = spyOn(client, "executeTrade");
    const symbol = "LINKUSDT";
    const quantity = 10;

    await client.closeShort(symbol, quantity);

    expect(executeTradeSpy).toHaveBeenCalledWith({
      symbol,
      side: "BUY",
      quantity,
      orderType: "MARKET",
      reduceOnly: true,
    });
  });

  test("getAccountInfo should call makeRequest with correct params", async () => {
    const makeRequestSpy = spyOn(client as any, "makeRequest");
    await client.getAccountInfo();
    expect(makeRequestSpy).toHaveBeenCalledWith("GET", "/fapi/v2/account");
  });

  test("getPositions (no symbol) should call makeRequest correctly", async () => {
    const makeRequestSpy = spyOn(client as any, "makeRequest");
    await client.getPositions();
    expect(makeRequestSpy).toHaveBeenCalledWith(
      "GET",
      "/fapi/v2/positionRisk",
      {}
    ); // Empty params object
  });

  test("getPositions (with symbol) should call makeRequest correctly", async () => {
    const symbol = "ADAUSDT";
    const makeRequestSpy = spyOn(client as any, "makeRequest");
    await client.getPositions(symbol);
    expect(makeRequestSpy).toHaveBeenCalledWith(
      "GET",
      "/fapi/v2/positionRisk",
      { symbol }
    );
  });

  // --- Error Handling Tests ---

  test("makeRequest should throw formatted error on non-OK response", async () => {
    const errorResponse = { code: -1001, msg: "Invalid API Key" };
    // Use new Response for error mock
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(errorResponse), { status: 401 })
    );

    await expect(
      (client as any).makeRequest("GET", "/fapi/v2/account")
    ).rejects.toThrow(
      `Binance API Error (${errorResponse.code}): ${errorResponse.msg}`
    );
  });

  test("makeRequest should re-throw fetch error", async () => {
    const networkError = new Error("Fetch failed");
    mockFetch.mockRejectedValueOnce(networkError);

    await expect(
      (client as any).makeRequest("GET", "/fapi/v2/account")
    ).rejects.toThrow(networkError);
  });
});
