import { describe, expect, test, beforeEach, jest } from "@jest/globals";
import tradeWorker from "../src/index.js";
// We don't need the actual client/logger imports anymore for the test file itself

// Keep the stand-alone mock functions for client/logger methods
const mockExecuteTrade = jest.fn();
const mockSetLeverage = jest.fn();
const mockGetAccountInfo = jest.fn();
const mockLogRequest = jest.fn();
const mockLogResponse = jest.fn();

// Create mock CLASS implementations that use the stand-alone mocks
const MockMexcClient = jest.fn().mockImplementation(() => ({
  executeTrade: mockExecuteTrade,
  setLeverage: mockSetLeverage,
  getAccountInfo: mockGetAccountInfo,
}));
const MockBinanceClient = jest.fn().mockImplementation(() => ({
  executeTrade: mockExecuteTrade,
  setLeverage: mockSetLeverage,
  getAccountInfo: mockGetAccountInfo,
}));
const MockBybitClient = jest.fn().mockImplementation(() => ({
  executeTrade: mockExecuteTrade,
  setLeverage: mockSetLeverage,
  getAccountInfo: mockGetAccountInfo,
}));
const MockDbLogger = jest.fn().mockImplementation(() => ({
  logRequest: mockLogRequest,
  logResponse: mockLogResponse,
}));

// Remove the top-level jest.mock calls
// jest.mock('../src/mexc-client.js', ...);
// jest.mock('../src/binance-client.js', ...);
// jest.mock('../src/bybit-client.js', ...);
// jest.mock('../src/db-logger.js', ...);

const PROCESS_ENDPOINT = "/process"; // Define the endpoint used in the worker

describe("Trade Worker", () => {
  const TEST_INTERNAL_KEY = "test-internal-key";
  const TEST_MEXC_KEY = "test-mexc-key";
  const TEST_MEXC_SECRET = "test-mexc-secret";
  // Add other test keys/secrets if needed for other exchanges

  // Mock environment setup function - now includes mocks
  const createMockEnv = (secrets, mocks = {}) => ({
    // Secret bindings
    INTERNAL_KEY_BINDING: {
      get: jest.fn().mockResolvedValue(secrets.internalKey),
    },
    MEXC_KEY_BINDING: { get: jest.fn().mockResolvedValue(secrets.mexcKey) },
    MEXC_SECRET_BINDING: {
      get: jest.fn().mockResolvedValue(secrets.mexcSecret),
    },
    BINANCE_KEY_BINDING: {
      get: jest.fn().mockResolvedValue(secrets.binanceKey ?? null),
    },
    BINANCE_SECRET_BINDING: {
      get: jest.fn().mockResolvedValue(secrets.binanceSecret ?? null),
    },
    BYBIT_KEY_BINDING: {
      get: jest.fn().mockResolvedValue(secrets.bybitKey ?? null),
    },
    BYBIT_SECRET_BINDING: {
      get: jest.fn().mockResolvedValue(secrets.bybitSecret ?? null),
    },
    D1_WORKER_URL: "mock-d1-url",
    // Inject mocks
    __mocks__: {
      MexcClient: mocks.MexcClient ?? MockMexcClient,
      BinanceClient: mocks.BinanceClient ?? MockBinanceClient,
      BybitClient: mocks.BybitClient ?? MockBybitClient,
      DbLogger: mocks.DbLogger ?? MockDbLogger,
    },
  });

  let mockEnv;

  const validTradePayload = { // Renamed for clarity
    exchange: "mexc",
    action: "LONG",
    symbol: "BTC_USDT",
    quantity: 0.1,
    price: 50000,
    leverage: 20,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Clear constructor mocks as well
    MockMexcClient.mockClear();
    MockBinanceClient.mockClear();
    MockBybitClient.mockClear();
    MockDbLogger.mockClear();
    // Reset method mocks to default resolved values
    mockExecuteTrade.mockResolvedValue({ orderId: "mock123" });
    mockSetLeverage.mockResolvedValue(true);
    mockGetAccountInfo.mockResolvedValue({ accountId: "mockAcc" });
    mockLogRequest.mockResolvedValue("req-log-id-123");
    mockLogResponse.mockResolvedValue(undefined);

    // Setup default valid env for MEXC (will use default mocks)
    mockEnv = createMockEnv({
      internalKey: TEST_INTERNAL_KEY,
      mexcKey: TEST_MEXC_KEY,
      mexcSecret: TEST_MEXC_SECRET,
    });
  });

  test("rejects request with invalid internal key config", async () => {
    mockEnv = createMockEnv({
      mexcKey: TEST_MEXC_KEY,
      mexcSecret: TEST_MEXC_SECRET,
      internalKey: null,
    });
    const request = new Request(`https://trade-worker.workers.dev${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: validTradePayload, internalAuthKey: "header-key", requestId: "req-1" }), // Moved keys to body
    });
    const response = await tradeWorker.fetch(request, mockEnv);
    expect(response.status).toBe(500); // Expect service config error
    expect(MockMexcClient).not.toHaveBeenCalled(); // Check constructor mock
    expect(mockExecuteTrade).not.toHaveBeenCalled();
  });

  test("rejects request if internalAuthKey doesn't match secret", async () => {
    // Use default mock env
    const request = new Request(`https://trade-worker.workers.dev${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: validTradePayload, internalAuthKey: "wrong-key", requestId: "req-2" }), // Moved keys to body, wrong key
    });
    const response = await tradeWorker.fetch(request, mockEnv);
    expect(response.status).toBe(403); // Unauthorized
    expect(MockMexcClient).not.toHaveBeenCalled(); // Check constructor mock
    expect(mockExecuteTrade).not.toHaveBeenCalled();
  });

  test("rejects request if API key bindings not configured", async () => {
    mockEnv = createMockEnv({
      internalKey: TEST_INTERNAL_KEY,
      mexcKey: null,
      mexcSecret: null,
    });
    const request = new Request(`https://trade-worker.workers.dev${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: validTradePayload, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-3" }), // Moved keys to body
    });
    const response = await tradeWorker.fetch(request, mockEnv);
    expect(response.status).toBe(400); // Bad request (missing config)
    const body = await response.json();
    expect(body.error).toContain(
      "API secret bindings not configured or accessible for mexc"
    );
    expect(MockMexcClient).not.toHaveBeenCalled(); // Check constructor mock
    expect(mockExecuteTrade).not.toHaveBeenCalled();
  });

  test("executes long position on MEXC successfully", async () => {
    // Use default mock env
    const request = new Request(`https://trade-worker.workers.dev${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: validTradePayload, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-4" }), // Moved keys to body
    });

    const response = await tradeWorker.fetch(request, mockEnv);
    expect(response.status).toBe(200);

    // Verify correct bindings were checked/retrieved
    expect(mockEnv.INTERNAL_KEY_BINDING.get).toHaveBeenCalledTimes(1);
    expect(mockEnv.MEXC_KEY_BINDING.get).toHaveBeenCalledTimes(2); // Called in validate and again before client creation
    expect(mockEnv.MEXC_SECRET_BINDING.get).toHaveBeenCalledTimes(2); // Called in validate and again before client creation
    // Remove checks for other bindings being called by get()
    // expect(mockEnv.BINANCE_KEY_BINDING.get).toHaveBeenCalledTimes(1);
    // expect(mockEnv.BYBIT_KEY_BINDING.get).toHaveBeenCalledTimes(1);

    // Verify the mock constructor was called via env.__mocks__
    expect(MockMexcClient).toHaveBeenCalledTimes(1);
    expect(MockMexcClient).toHaveBeenCalledWith(
      TEST_MEXC_KEY,
      TEST_MEXC_SECRET
    );

    // Verify client methods were called (using the stand-alone mocks)
    expect(mockExecuteTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "BTC_USDT",
        action: "LONG",
        quantity: 0.1,
      })
    );

    // Verify logger was used
    expect(MockDbLogger).toHaveBeenCalledTimes(1);
    expect(mockLogRequest).toHaveBeenCalledTimes(1);
    expect(mockLogResponse).toHaveBeenCalledTimes(1);

    const responseData = await response.json();
    expect(responseData.success).toBe(true);
    expect(responseData.result.orderId).toBe("mock123");
  });

  test("handles API connection test failure", async () => {
    mockGetAccountInfo.mockRejectedValue(new Error("Connection failed"));
    const request = new Request(`https://trade-worker.workers.dev${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: validTradePayload, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-5" }), // Moved keys to body
    });
    const response = await tradeWorker.fetch(request, mockEnv);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain("Failed to connect to exchange API");
    expect(MockMexcClient).toHaveBeenCalledTimes(1);
    expect(mockGetAccountInfo).toHaveBeenCalledTimes(1);
    expect(mockExecuteTrade).not.toHaveBeenCalled();
    expect(mockLogResponse).toHaveBeenCalledTimes(1); // Logger should still log the error response
  });

  test("handles trade execution failure", async () => {
    mockExecuteTrade.mockRejectedValue(new Error("Order execution failed"));
    const request = new Request(`https://trade-worker.workers.dev${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: validTradePayload, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-6" }), // Moved keys to body
    });
    const response = await tradeWorker.fetch(request, mockEnv);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain("Order execution failed");
    expect(MockMexcClient).toHaveBeenCalledTimes(1);
    expect(mockGetAccountInfo).toHaveBeenCalledTimes(1);
    expect(mockExecuteTrade).toHaveBeenCalledTimes(1);
    expect(mockLogResponse).toHaveBeenCalledTimes(1); // Logger should still log the error response
  });

  // Add tests for other exchanges (Binance, Bybit) if needed,
  // setting up mockEnv appropriately for their secrets.
});
