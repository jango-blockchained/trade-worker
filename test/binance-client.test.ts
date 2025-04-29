import { describe, expect, test, beforeEach, jest } from "@jest/globals";
import { BinanceClient } from "../src/binance-client";

// --- Mocks ---
const mockFetch = jest.fn();
global.fetch = mockFetch;

const mockImportKey = jest.fn();
const mockSign = jest.fn();
global.crypto = {
    subtle: {
        importKey: mockImportKey,
        sign: mockSign,
    },
    getRandomValues: jest.fn(), // Add if needed by other parts of the code or dependencies
} as any; // Using 'any' for simplicity in mocking crypto

// --- Test Suite ---
describe("BinanceClient", () => {
    const API_KEY = "test-api-key";
    const API_SECRET = "test-api-secret";
    const BASE_URL = "https://fapi.binance.com";

    let client: BinanceClient;

    beforeEach(() => {
        jest.clearAllMocks();

        // Mock crypto functions
        mockImportKey.mockResolvedValue({} as CryptoKey); // Return a dummy CryptoKey object
        // Simulate signature generation (return a fixed hex string)
        const mockSignatureArrayBuffer = new Uint8Array([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]).buffer;
        mockSign.mockResolvedValue(mockSignatureArrayBuffer);


        // Default fetch mock (successful response)
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ success: true, data: "mock data" }),
            status: 200,
        });

        client = new BinanceClient(API_KEY, API_SECRET);
    });

    // --- Constructor Tests ---
    test("should initialize with valid API key and secret", () => {
        expect(client).toBeInstanceOf(BinanceClient);
    });

    test("should throw error if API key is missing", () => {
        expect(() => new BinanceClient("", API_SECRET)).toThrow("Binance API key and secret are required.");
    });

    test("should throw error if API secret is missing", () => {
        expect(() => new BinanceClient(API_KEY, "")).toThrow("Binance API key and secret are required.");
    });

    // --- Request Signing and Execution Test ---
    test("makeRequest should generate signature and call fetch correctly (GET)", async () => {
        const path = "/fapi/v2/account";
        const mockResponseData = { account: "data" };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockResponseData,
            status: 200,
        });

        const result = await (client as any).makeRequest('GET', path); // Access private method for testing

        expect(result).toEqual(mockResponseData);
        expect(mockImportKey).toHaveBeenCalledTimes(1);
        expect(mockSign).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        const fetchCall = mockFetch.mock.calls[0];
        const url = new URL(fetchCall[0]);
        expect(url.origin + url.pathname).toBe(`${BASE_URL}${path}`);
        expect(url.searchParams.has("timestamp")).toBe(true);
        expect(url.searchParams.has("signature")).toBe(true);
        // Check signature value (derived from the mockSign output)
        expect(url.searchParams.get("signature")).toBe("0123456789abcdef");

        const options = fetchCall[1];
        expect(options.method).toBe("GET");
        expect(options.headers["X-MBX-APIKEY"]).toBe(API_KEY);
    });

     test("makeRequest should generate signature and call fetch correctly (POST)", async () => {
        const path = "/fapi/v1/leverage";
        const params = { symbol: "BTCUSDT", leverage: 20 };
         const mockResponseData = { symbol: "BTCUSDT", leverage: 20, maxNotionalValue: "1000000" };
         mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockResponseData,
            status: 200,
        });


        const result = await (client as any).makeRequest('POST', path, params);

        expect(result).toEqual(mockResponseData);
        expect(mockImportKey).toHaveBeenCalledTimes(1);
        expect(mockSign).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        const fetchCall = mockFetch.mock.calls[0];
        const url = new URL(fetchCall[0]);
        expect(url.origin + url.pathname).toBe(`${BASE_URL}${path}`);
        expect(url.searchParams.get("symbol")).toBe(params.symbol);
        expect(url.searchParams.get("leverage")).toBe(String(params.leverage));
        expect(url.searchParams.has("timestamp")).toBe(true);
        expect(url.searchParams.has("signature")).toBe(true);
        expect(url.searchParams.get("signature")).toBe("0123456789abcdef"); // Same mock signature

        const options = fetchCall[1];
        expect(options.method).toBe("POST");
        expect(options.headers["X-MBX-APIKEY"]).toBe(API_KEY);
        expect(options.body).toBeUndefined(); // Params in query for Binance POST
    });

    // --- API Method Tests ---

    test("setLeverage should call makeRequest with correct params", async () => {
        const symbol = "ETHUSDT";
        const leverage = 10;
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');

        await client.setLeverage(symbol, leverage);

        expect(makeRequestSpy).toHaveBeenCalledWith('POST', '/fapi/v1/leverage', { symbol, leverage });
    });

     test("executeTrade (LIMIT BUY) should call makeRequest with correct params", async () => {
        const params = { symbol: "BTCUSDT", side: "BUY", orderType: "LIMIT", quantity: 0.01, price: 50000 };
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');

        await client.executeTrade(params);

        expect(makeRequestSpy).toHaveBeenCalledWith('POST', '/fapi/v1/order', expect.objectContaining({
            symbol: params.symbol,
            side: 'BUY',
            type: 'LIMIT',
            quantity: params.quantity,
            price: params.price,
            timeInForce: "GTC", // Added for LIMIT orders
            reduceOnly: undefined,
        }));
    });

    test("executeTrade (MARKET SELL) should call makeRequest with correct params", async () => {
        const params = { symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", quantity: 0.01 };
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');

        await client.executeTrade(params);

        expect(makeRequestSpy).toHaveBeenCalledWith('POST', '/fapi/v1/order', expect.objectContaining({
            symbol: params.symbol,
            side: 'SELL',
            type: 'MARKET',
            quantity: params.quantity,
            price: undefined,
            reduceOnly: undefined,
        }));
    });

     test("executeTrade (CLOSE_LONG) should call makeRequest with side=SELL and reduceOnly=true", async () => {
        const params = { symbol: "BTCUSDT", side: "CLOSE_LONG", orderType: "MARKET", quantity: 0.01 };
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');

        await client.executeTrade(params);

        expect(makeRequestSpy).toHaveBeenCalledWith('POST', '/fapi/v1/order', expect.objectContaining({
            symbol: params.symbol,
            side: 'SELL',
            type: 'MARKET',
            quantity: params.quantity,
            reduceOnly: true,
        }));
    });

     test("executeTrade (CLOSE_SHORT) should call makeRequest with side=BUY and reduceOnly=true", async () => {
        const params = { symbol: "BTCUSDT", side: "CLOSE_SHORT", orderType: "MARKET", quantity: 0.01 };
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');

        await client.executeTrade(params);

        expect(makeRequestSpy).toHaveBeenCalledWith('POST', '/fapi/v1/order', expect.objectContaining({
            symbol: params.symbol,
            side: 'BUY',
            type: 'MARKET',
            quantity: params.quantity,
            reduceOnly: true,
        }));
    });

     test("openLong helper should call executeTrade correctly", async () => {
        const executeTradeSpy = jest.spyOn(client, 'executeTrade');
        const symbol = "LINKUSDT";
        const quantity = 10;

        await client.openLong(symbol, quantity);

        expect(executeTradeSpy).toHaveBeenCalledWith({ symbol, side: 'BUY', quantity, price: undefined, orderType: 'MARKET' });
    });

    test("closeShort helper should call executeTrade correctly", async () => {
        const executeTradeSpy = jest.spyOn(client, 'executeTrade');
        const symbol = "LINKUSDT";
        const quantity = 10;

        await client.closeShort(symbol, quantity);

        expect(executeTradeSpy).toHaveBeenCalledWith({ symbol, side: 'BUY', quantity, orderType: 'MARKET', reduceOnly: true });
    });

    test("getAccountInfo should call makeRequest with correct params", async () => {
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');
        await client.getAccountInfo();
        expect(makeRequestSpy).toHaveBeenCalledWith('GET', '/fapi/v2/account');
    });

     test("getPositions (no symbol) should call makeRequest correctly", async () => {
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');
        await client.getPositions();
        expect(makeRequestSpy).toHaveBeenCalledWith('GET', '/fapi/v2/positionRisk', {}); // Empty params object
    });

    test("getPositions (with symbol) should call makeRequest correctly", async () => {
        const symbol = "ADAUSDT";
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');
        await client.getPositions(symbol);
        expect(makeRequestSpy).toHaveBeenCalledWith('GET', '/fapi/v2/positionRisk', { symbol });
    });

    // --- Error Handling Tests ---

    test("makeRequest should throw formatted error on non-OK response", async () => {
        const errorResponse = { code: -1001, msg: "Invalid API Key" };
        mockFetch.mockResolvedValueOnce({
            ok: false,
            json: async () => errorResponse,
            status: 401,
        });

        await expect((client as any).makeRequest('GET', '/fapi/v2/account'))
            .rejects
            .toThrow(`Binance API Error (${errorResponse.code}): ${errorResponse.msg}`);
    });

    test("makeRequest should re-throw fetch error", async () => {
        const networkError = new Error("Fetch failed");
        mockFetch.mockRejectedValueOnce(networkError);

        await expect((client as any).makeRequest('GET', '/fapi/v2/account'))
            .rejects
            .toThrow(networkError);
    });
}); 