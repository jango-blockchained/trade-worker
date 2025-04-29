import { describe, expect, test, beforeEach, jest } from "@jest/globals";
import { BybitClient } from "../src/bybit-client";

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
describe("BybitClient (V5)", () => {
    const API_KEY = "test-bybit-key";
    const API_SECRET = "test-bybit-secret";
    const BASE_URL = "https://api.bybit.com";
    const RECV_WINDOW = 5000;

    let client: BybitClient;
    let fixedTimestamp: number;
    let mockSignatureHex: string;

    beforeEach(() => {
        jest.clearAllMocks();

        fixedTimestamp = Date.now(); // Use a fixed timestamp for predictable signatures
        jest.spyOn(Date, 'now').mockImplementation(() => fixedTimestamp);

        // Mock crypto functions
        mockImportKey.mockResolvedValue({} as CryptoKey); // Dummy key
        // Fixed signature for predictability
        const mockSignatureArrayBuffer = new Uint8Array([0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10]).buffer;
        mockSign.mockResolvedValue(mockSignatureArrayBuffer);
        mockSignatureHex = "fedcba9876543210"; // Expected hex signature

        // Default fetch mock (successful Bybit V5 response)
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                retCode: 0,
                retMsg: "OK",
                result: { data: "mock result" },
                time: Date.now(),
            }),
            status: 200,
        });

        client = new BybitClient(API_KEY, API_SECRET);
    });

    afterEach(() => {
        // Restore Date.now mock
        jest.restoreAllMocks();
    });

    // --- Constructor Tests ---
    test("should initialize with valid API key and secret", () => {
        expect(client).toBeInstanceOf(BybitClient);
    });

    test("should throw error if API key is missing", () => {
        expect(() => new BybitClient("", API_SECRET)).toThrow("Bybit API key and secret are required.");
    });

    test("should throw error if API secret is missing", () => {
        expect(() => new BybitClient(API_KEY, "")).toThrow("Bybit API key and secret are required.");
    });

    // --- Signing Logic Test ---
    test("generateSignature should create correct HMAC-SHA256 signature string", async () => {
        const paramsStr = JSON.stringify({ symbol: "BTCUSDT", orderType: "Market" });
        const expectedPayload = `${fixedTimestamp}${API_KEY}${RECV_WINDOW}${paramsStr}`;

        const signature = await (client as any).generateSignature(fixedTimestamp, paramsStr);

        expect(signature).toBe(mockSignatureHex);
        expect(mockImportKey).toHaveBeenCalledWith(
            "raw",
            expect.any(Uint8Array), // Secret key bytes
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
        );
        expect(mockSign).toHaveBeenCalledWith(
            "HMAC",
            {}, // The dummy CryptoKey from mockImportKey
            expect.any(Uint8Array) // Encoded payload bytes
        );

        // Verify the payload bytes passed to sign
        const signCall = mockSign.mock.calls[0];
        const payloadBuffer = signCall[2] as ArrayBuffer;
        const decodedPayload = new TextDecoder().decode(payloadBuffer);
        expect(decodedPayload).toBe(expectedPayload);
    });

    // --- Request Execution Tests ---
    test("makeRequest (GET) should format URL, generate signature, set headers, and call fetch", async () => {
        const path = "/v5/account/wallet-balance";
        const params = { accountType: "UNIFIED", coin: "USDT" };
        const mockResultData = { list: [{ coin: "USDT", balance: "1000" }] };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ retCode: 0, retMsg: "OK", result: mockResultData, time: Date.now() }),
            status: 200,
        });

        // Expected sorted query string for signature and URL
        const expectedQueryString = "accountType=UNIFIED&coin=USDT";
        const expectedSigPayload = `${fixedTimestamp}${API_KEY}${RECV_WINDOW}${expectedQueryString}`;

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
        const url = fetchCall[0];
        const options = fetchCall[1];

        expect(url).toBe(`${BASE_URL}${path}?${expectedQueryString}`);
        expect(options.method).toBe("GET");
        expect(options.headers["X-BAPI-API-KEY"]).toBe(API_KEY);
        expect(options.headers["X-BAPI-TIMESTAMP"]).toBe(String(fixedTimestamp));
        expect(options.headers["X-BAPI-RECV-WINDOW"]).toBe(String(RECV_WINDOW));
        expect(options.headers["X-BAPI-SIGN"]).toBe(mockSignatureHex);
        expect(options.body).toBeUndefined();
    });

    test("makeRequest (POST) should format body, generate signature, set headers, and call fetch", async () => {
        const path = "/v5/order/create";
        const params = { category: "linear", symbol: "ETHUSDT", side: "Buy", orderType: "Market", qty: "0.1" };
        const mockResultData = { orderId: "12345", orderLinkId: "abc" };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ retCode: 0, retMsg: "OK", result: mockResultData, time: Date.now() }),
            status: 200,
        });

        const paramsStr = JSON.stringify(params);
        const expectedSigPayload = `${fixedTimestamp}${API_KEY}${RECV_WINDOW}${paramsStr}`;

        const result = await (client as any).makeRequest('POST', path, params);

        expect(result).toEqual(mockResultData);
        expect(mockSign).toHaveBeenCalledTimes(1);
         // Check signature payload was correct
         const signCall = mockSign.mock.calls[0];
         const payloadBuffer = signCall[2] as ArrayBuffer;
         const decodedPayload = new TextDecoder().decode(payloadBuffer);
         expect(decodedPayload).toBe(expectedSigPayload);


        expect(mockFetch).toHaveBeenCalledTimes(1);
        const fetchCall = mockFetch.mock.calls[0];
        const url = fetchCall[0];
        const options = fetchCall[1];

        expect(url).toBe(`${BASE_URL}${path}`);
        expect(options.method).toBe("POST");
        expect(options.headers["X-BAPI-API-KEY"]).toBe(API_KEY);
        expect(options.headers["X-BAPI-TIMESTAMP"]).toBe(String(fixedTimestamp));
        expect(options.headers["X-BAPI-RECV-WINDOW"]).toBe(String(RECV_WINDOW));
        expect(options.headers["X-BAPI-SIGN"]).toBe(mockSignatureHex);
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(options.body).toBe(paramsStr);
    });

    // --- API Method Tests ---

    test("setLeverage should call makeRequest with correct params", async () => {
        const symbol = "BTCUSDT";
        const leverage = 25;
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');

        await client.setLeverage(symbol, leverage);

        expect(makeRequestSpy).toHaveBeenCalledWith('POST', '/v5/position/set-leverage', {
            category: "linear",
            symbol: symbol,
            buyLeverage: String(leverage),
            sellLeverage: String(leverage),
        });
    });

    test("executeTrade (Market Long) should call makeRequest with correct params", async () => {
        const params = { symbol: "ETHUSDT", side: "LONG", orderType: "MARKET", quantity: 0.5 };
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');

        await client.executeTrade(params);

        expect(makeRequestSpy).toHaveBeenCalledWith('POST', '/v5/order/create', {
            category: "linear",
            symbol: params.symbol,
            side: "Buy", // Mapped from LONG
            orderType: "Market",
            qty: String(params.quantity),
            reduceOnly: undefined,
        });
    });

     test("executeTrade (Limit Close Short) should call makeRequest with correct params", async () => {
        const params = { symbol: "ETHUSDT", side: "CLOSE_SHORT", orderType: "LIMIT", quantity: 0.5, price: 2000 };
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');

        await client.executeTrade(params);

        expect(makeRequestSpy).toHaveBeenCalledWith('POST', '/v5/order/create', {
            category: "linear",
            symbol: params.symbol,
            side: "Buy", // Mapped from CLOSE_SHORT
            orderType: "Limit",
            qty: String(params.quantity),
            price: String(params.price),
            reduceOnly: true, // Set for CLOSE_SHORT
        });
    });

    test("getAccountInfo should call makeRequest correctly", async () => {
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');
        await client.getAccountInfo();
        expect(makeRequestSpy).toHaveBeenCalledWith('GET', '/v5/account/wallet-balance', { accountType: "UNIFIED" });
    });

     test("getPositions should call makeRequest correctly", async () => {
        const makeRequestSpy = jest.spyOn(client as any, 'makeRequest');
        await client.getPositions("BTCUSDT");
        expect(makeRequestSpy).toHaveBeenCalledWith('GET', '/v5/position/list', { category: "linear", symbol: "BTCUSDT" });
    });

    // --- Error Handling Tests ---

    test("makeRequest should throw formatted error on non-zero retCode", async () => {
        const errorCode = 10001;
        const errorMsg = "Invalid API Key";
        mockFetch.mockResolvedValueOnce({
            ok: true, // Status might be 200 even if retCode is non-zero
            json: async () => ({ retCode: errorCode, retMsg: errorMsg, result: {}, time: Date.now() }),
            status: 200,
        });

        await expect((client as any).makeRequest('GET', '/v5/account/wallet-balance', { accountType: "UNIFIED" }))
            .rejects
            .toThrow(`Bybit API Error (${errorCode}): ${errorMsg}`);
    });

     test("makeRequest should handle non-200 status codes (though Bybit usually uses retCode)", async () => {
        // This test is less likely for Bybit V5 but good practice
        const errorMsg = "Gateway Timeout";
        mockFetch.mockResolvedValueOnce({
            ok: false,
            json: async () => ({ retCode: 50400, retMsg: errorMsg }), // Simulate possible body
            status: 504,
        });

        // Expect it to fail based on retCode primarily
         await expect((client as any).makeRequest('GET', '/v5/account/wallet-balance', { accountType: "UNIFIED" }))
            .rejects
            .toThrow(`Bybit API Error (50400): ${errorMsg}`);
    });

    test("makeRequest should re-throw fetch network error", async () => {
        const networkError = new Error("Fetch connection failed");
        mockFetch.mockRejectedValueOnce(networkError);

        await expect((client as any).makeRequest('GET', '/v5/account/wallet-balance', { accountType: "UNIFIED" }))
            .rejects
            .toThrow(networkError);
    });
}); 