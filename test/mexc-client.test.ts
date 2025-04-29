import { describe, expect, test, beforeEach, jest } from "@jest/globals";
import { MexcClient } from "../src/mexc-client";

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
    getRandomValues: jest.fn(),
} as any;

// --- Test Suite ---
describe("MexcClient (V1 Futures)", () => {
    const API_KEY = "test-mexc-key";
    const API_SECRET = "test-mexc-secret";
    const BASE_URL = "https://contract.mexc.com";

    let client: MexcClient;
    let fixedTimestamp: number;
    let mockSignatureHex: string;

    beforeEach(() => {
        jest.clearAllMocks();

        fixedTimestamp = Date.now();
        jest.spyOn(Date, 'now').mockImplementation(() => fixedTimestamp);

        // Mock crypto
        mockImportKey.mockResolvedValue({} as CryptoKey);
        const mockSignatureArrayBuffer = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22]).buffer;
        mockSign.mockResolvedValue(mockSignatureArrayBuffer);
        mockSignatureHex = "aabbccddeeff1122"; // Expected hex signature

        // Default fetch mock (successful MEXC response)
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                code: 200,
                msg: "Success",
                data: { result: "mock data" },
            }),
            status: 200,
        });

        client = new MexcClient(API_KEY, API_SECRET);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // --- Constructor Tests ---
    test("should initialize with valid API key and secret", () => {
        expect(client).toBeInstanceOf(MexcClient);
    });

    test("should throw error if API key is missing", () => {
        expect(() => new MexcClient("", API_SECRET)).toThrow("MEXC API key and secret are required.");
    });

    test("should throw error if API secret is missing", () => {
        expect(() => new MexcClient(API_KEY, "")).toThrow("MEXC API key and secret are required.");
    });

    // --- Signing Logic Test ---
    test("generateSignature should create correct HMAC-SHA256 signature string from sorted params", async () => {
        // Params out of order
        const params = { symbol: "BTC_USDT", type: 2, volume: 0.01 };
        const expectedSortedQuery = "symbol=BTC_USDT&type=2&volume=0.01"; // Sorted alphabetically
        const expectedPayload = `${expectedSortedQuery}&timestamp=${fixedTimestamp}`;

        const signature = await (client as any).generateSignature(params, fixedTimestamp);

        expect(signature).toBe(mockSignatureHex);
        expect(mockImportKey).toHaveBeenCalledTimes(1);
        expect(mockSign).toHaveBeenCalledTimes(1);

        // Verify the payload bytes passed to sign
        const signCall = mockSign.mock.calls[0];
        const payloadBuffer = signCall[2] as ArrayBuffer;
        const decodedPayload = new TextDecoder().decode(payloadBuffer);
        expect(decodedPayload).toBe(expectedPayload);
    });

    // --- Request Execution Tests ---
    test("makeRequest (GET) should format URL with all params (incl. sig/ts), set headers, and call fetch", async () => {
        const path = "/api/v1/private/account/assets";
        const params = { currency: "USDT" }; // Example GET param
        const mockResultData = { usdtBalance: 1000 };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ code: 200, msg: "Success", data: mockResultData }),
            status: 200,
        });

        // Expected sorted query from params + timestamp + signature for URL
        const expectedSortedQueryForSig = `currency=USDT`;
        const expectedSigPayload = `${expectedSortedQueryForSig}&timestamp=${fixedTimestamp}`;
        const expectedFinalQuery = `currency=USDT&timestamp=${fixedTimestamp}&signature=${mockSignatureHex}`; // All params in final URL


        const result = await (client as any).makeRequest('GET', path, params);

        expect(result).toEqual(mockResultData);
        expect(mockSign).toHaveBeenCalledTimes(1);

        // Check signature payload was correct
        const signCall = mockSign.mock.calls[0];
        const payloadBuffer = signCall[2] as ArrayBuffer;
        const decodedPayload = new TextDecoder().decode(payloadBuffer);
        expect(decodedPayload).toBe(expectedSigPayload);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const fetchCall = mockFetch.mock.calls[0];
        const url = new URL(fetchCall[0]);
        const options = fetchCall[1];

        expect(url.origin + url.pathname).toBe(`${BASE_URL}${path}`);
        expect(url.search).toBe(`?${expectedFinalQuery}`); // Verify full query string
        expect(options.method).toBe("GET");
        expect(options.headers["X-MEXC-APIKEY"]).toBe(API_KEY);
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(options.body).toBeUndefined();
    });

    test("makeRequest (POST) should include all params (incl. sig/ts) in body, set headers, and call fetch", async () => {
        const path = "/api/v1/private/order/submit";
        const params = { symbol: "ETH_USDT", side: 1, type: 2, volume: 0.1, openType: 1 };
        const mockResultData = { orderId: "mexc123" };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ code: 200, msg: "Success", data: mockResultData }),
            status: 200,
        });

        // Signature generation
        const expectedSortedQueryForSig = "openType=1&side=1&symbol=ETH_USDT&type=2&volume=0.1";
        const expectedSigPayload = `${expectedSortedQueryForSig}&timestamp=${fixedTimestamp}`;

        // Expected body includes original params + timestamp + signature
        const expectedBody = JSON.stringify({
            ...params,
            timestamp: fixedTimestamp,
            signature: mockSignatureHex
        });

        const result = await (client as any).makeRequest('POST', path, params);

        expect(result).toEqual(mockResultData);
        expect(mockSign).toHaveBeenCalledTimes(1);
        // Verify signature payload
        const signCall = mockSign.mock.calls[0];
        const payloadBuffer = signCall[2] as ArrayBuffer;
        const decodedPayload = new TextDecoder().decode(payloadBuffer);
        expect(decodedPayload).toBe(expectedSigPayload);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const fetchCall = mockFetch.mock.calls[0];
        const url = new URL(fetchCall[0]);
        const options = fetchCall[1];

        expect(url.origin + url.pathname).toBe(`${BASE_URL}${path}`);
        expect(url.search).toBe(""); // No query params for POST
        expect(options.method).toBe("POST");
        expect(options.headers["X-MEXC-APIKEY"]).toBe(API_KEY);
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(options.body).toBe(expectedBody);
    });

    // --- API Method Tests ---
    test("setLeverage should resolve immediately and warn (needs verification)", async () => {
      const warnSpy = jest.spyOn(console, 'warn');
      const result = await client.setLeverage("BTC_USDT", 10);
      expect(result).toEqual({ info: "Set leverage needs V1 API verification" });
      expect(warnSpy).toHaveBeenCalledWith("setLeverage for MEXC V1 Futures needs verification.");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("executeTrade (Market Open Long) should call makeRequest with correct params", async () => {
        const params = { symbol: "ETH_USDT", side: "LONG", orderType: "MARKET", quantity: 0.1 };
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');

        await client.executeTrade(params);

        expect(makeRequestSpy).toHaveBeenCalledWith('POST', '/api/v1/private/order/submit', {
            symbol: params.symbol,
            side: 1, // Open Long
            type: 2, // Market
            openType: 1,
            volume: params.quantity,
            price: undefined,
            // reduceOnly not included by default
        });
    });

     test("executeTrade (Limit Close Short) should call makeRequest with correct params", async () => {
        const params = { symbol: "ETH_USDT", side: "CLOSE_SHORT", orderType: "LIMIT", quantity: 0.1, price: 1800, reduceOnly: true };
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');
        const warnSpy = jest.spyOn(console, 'warn'); // Spy on warning for reduceOnly

        await client.executeTrade(params);

        expect(warnSpy).toHaveBeenCalledWith("MEXC V1 API reduceOnly parameter needs verification.");
        expect(makeRequestSpy).toHaveBeenCalledWith('POST', '/api/v1/private/order/submit', {
            symbol: params.symbol,
            side: 4, // Close Short
            type: 1, // Limit
            openType: 1,
            volume: params.quantity,
            price: params.price,
            // reduceOnly not included by default
        });
    });

    test("getAccountInfo should call makeRequest correctly", async () => {
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');
        await client.getAccountInfo();
        expect(makeRequestSpy).toHaveBeenCalledWith('GET', '/api/v1/private/account/assets');
    });

     test("getPositions should call makeRequest correctly", async () => {
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');
        await client.getPositions("BTC_USDT");
        expect(makeRequestSpy).toHaveBeenCalledWith('GET', '/api/v1/private/position/list', { symbol: "BTC_USDT" });
    });

    // --- Error Handling Tests ---
    test("makeRequest should throw formatted error on non-200 code in response", async () => {
        const errorCode = 10006;
        const errorMsg = "Signature verification failed";
        mockFetch.mockResolvedValueOnce({
            ok: true, // Status might be 200
            json: async () => ({ code: errorCode, msg: errorMsg, data: null }),
            status: 200,
        });

        await expect((client as any).makeRequest('GET', '/api/v1/private/account/assets'))
            .rejects
            .toThrow(`MEXC API Error (${errorCode}): ${errorMsg}`);
    });

    test("makeRequest should throw formatted error on non-OK HTTP status", async () => {
        const errorCode = 503;
        const errorMsg = "Service Unavailable";
        mockFetch.mockResolvedValueOnce({
            ok: false, // Non-OK status
            json: async () => ({ code: errorCode, msg: errorMsg, data: null }), // Body might still exist
            status: 503,
        });

        await expect((client as any).makeRequest('GET', '/api/v1/private/account/assets'))
            .rejects
            .toThrow(`MEXC API Error (${errorCode}): ${errorMsg}`);
    });

    test("makeRequest should re-throw fetch network error", async () => {
        const networkError = new Error("Connection refused");
        mockFetch.mockRejectedValueOnce(networkError);

        await expect((client as any).makeRequest('GET', '/api/v1/private/account/assets'))
            .rejects
            .toThrow(networkError);
    });
}); 