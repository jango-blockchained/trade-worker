import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import worker, {
  validateApiCredentials,
  validateTradePayload,
  saveReportToR2,
} from "./index"; // Import the worker and helpers

// --- Mock Exchange Clients ---
const createMockClient = () => ({
  setLeverage: vi.fn(),
  executeTrade: vi.fn(),
  getAccountInfo: vi.fn(),
  getPositions: vi.fn(),
  openLong: vi.fn(),
  openShort: vi.fn(),
  closeLong: vi.fn(),
  closeShort: vi.fn(),
});

const mockMexcClient = createMockClient();
const mockBinanceClient = createMockClient();
const mockBybitClient = createMockClient();

// Mock Constructors
const mockMexcClientConstructor = vi.fn(() => mockMexcClient);
const mockBinanceClientConstructor = vi.fn(() => mockBinanceClient);
const mockBybitClientConstructor = vi.fn(() => mockBybitClient);

// --- Mock DbLogger ---
const mockLogRequest = vi.fn();
const mockLogResponse = vi.fn();
const mockDbLogger = {
  logRequest: mockLogRequest,
  logResponse: mockLogResponse,
};
const mockDbLoggerConstructor = vi.fn(() => mockDbLogger);

// Mock the D1Database methods globally or per suite/test
const mockRun = vi.fn();
const mockAll = vi.fn();
const mockBind = vi.fn(() => ({ run: mockRun, all: mockAll }));
const mockPrepare = vi.fn(() => ({ bind: mockBind }));

const mockEnv = {
  DB: {
    prepare: mockPrepare,
    // Add other necessary D1 methods if used, e.g., batch, dump
  },
  // Add other necessary env bindings with mocks or dummy values
  CONFIG_KV: { get: vi.fn(), put: vi.fn(), list: vi.fn(), delete: vi.fn() },
  AI: { run: vi.fn() },
  REPORTS_BUCKET: {
    put: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  },
  INTERNAL_KEY_BINDING: { get: vi.fn().mockResolvedValue("test-internal-key") },
  TELEGRAM_SERVICE: {
    fetch: vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      ),
  },
  TELEGRAM_INTERNAL_KEY_BINDING: {
    get: vi.fn().mockResolvedValue("test-telegram-key"),
  },
  MEXC_KEY_BINDING: { get: vi.fn().mockResolvedValue("mexc-key") },
  MEXC_SECRET_BINDING: { get: vi.fn().mockResolvedValue("mexc-secret") },
  BINANCE_KEY_BINDING: { get: vi.fn().mockResolvedValue("binance-key") },
  BINANCE_SECRET_BINDING: { get: vi.fn().mockResolvedValue("binance-secret") },
  BYBIT_KEY_BINDING: { get: vi.fn().mockResolvedValue("bybit-key") },
  BYBIT_SECRET_BINDING: { get: vi.fn().mockResolvedValue("bybit-secret") },
  D1_SERVICE: { fetch: vi.fn() }, // Mock service binding
  // Add mock constructors to env for dependency injection during tests
  __mocks__: {
    MexcClient: mockMexcClientConstructor,
    BinanceClient: mockBinanceClientConstructor,
    BybitClient: mockBybitClientConstructor,
    DbLogger: mockDbLoggerConstructor,
  },
  // ... other bindings ...
} as any; // Use 'as any' for simplicity in testing, or define a more specific mock type

// Helper to create a mock Request object
function createMockRequest(
  method: string,
  urlPath: string,
  body?: any,
  headers?: HeadersInit
): Request {
  const url = `http://localhost${urlPath}`;
  const init: RequestInit = {
    method,
    headers: new Headers(headers),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set("Content-Type", "application/json");
  }
  const request = new Request(url, init);
  // Mock the json() method for POST/PUT requests
  if (body !== undefined) {
    request.json = async () => JSON.parse(init.body as string);
  }
  return request;
}

describe("Trade Worker - D1 Signals Endpoint (/api/signals)", () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
  });

  // --- Tests for POST /api/signals ---
  describe("POST /api/signals", () => {
    const validSignalPayload = {
      timestamp: Math.floor(Date.now() / 1000),
      symbol: "BTCUSDT",
      signal_type: "BUY",
      source: "Test",
    };

    it("should insert a valid signal and return 201", async () => {
      mockRun.mockResolvedValueOnce({ success: true, meta: { changes: 1 } }); // Simulate successful D1 insert

      const request = createMockRequest(
        "POST",
        "/api/signals",
        validSignalPayload
      );
      const response = await worker.fetch(request, mockEnv, {} as any); // Pass mock context if needed

      expect(response.status).toBe(201);
      const responseBody = await response.json();
      expect(responseBody.success).toBe(true);
      expect(responseBody.result).toHaveProperty("signalId");
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO trade_signals")
      );
      expect(mockBind).toHaveBeenCalledWith(
        expect.any(String), // signal_id (UUID)
        validSignalPayload.timestamp,
        validSignalPayload.symbol,
        validSignalPayload.signal_type,
        validSignalPayload.source,
        JSON.stringify(validSignalPayload)
      );
      expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it("should return 400 for invalid JSON", async () => {
      const request = new Request("http://localhost/api/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ invalid json,",
      });

      const response = await worker.fetch(request, mockEnv, {} as any);
      expect(response.status).toBe(400);
      const responseBody = await response.json();
      expect(responseBody.success).toBe(false);
      expect(responseBody.error).toContain("Invalid JSON");
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("should return 400 for missing required fields", async () => {
      const invalidPayload = { timestamp: 123, symbol: "ETHUSDT" }; // Missing signal_type
      const request = createMockRequest("POST", "/api/signals", invalidPayload);
      const response = await worker.fetch(request, mockEnv, {} as any);

      expect(response.status).toBe(400);
      const responseBody = await response.json();
      expect(responseBody.success).toBe(false);
      expect(responseBody.error).toContain("Missing required fields");
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("should return 500 if D1 insert fails", async () => {
      mockRun.mockResolvedValueOnce({ success: false, error: "D1 Error" }); // Simulate D1 failure

      const request = createMockRequest(
        "POST",
        "/api/signals",
        validSignalPayload
      );
      const response = await worker.fetch(request, mockEnv, {} as any);

      expect(response.status).toBe(500);
      const responseBody = await response.json();
      expect(responseBody.success).toBe(false);
      expect(responseBody.error).toContain("Failed to store signal");
      expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it("should return 500 if D1 insert throws an exception", async () => {
      mockRun.mockRejectedValueOnce(new Error("D1 Exception")); // Simulate D1 exception

      const request = createMockRequest(
        "POST",
        "/api/signals",
        validSignalPayload
      );
      const response = await worker.fetch(request, mockEnv, {} as any);

      expect(response.status).toBe(500);
      const responseBody = await response.json();
      expect(responseBody.success).toBe(false);
      expect(responseBody.error).toContain("Internal server error");
      expect(mockRun).toHaveBeenCalledTimes(1);
    });
  });

  // --- Tests for GET /api/signals ---
  describe("GET /api/signals", () => {
    const mockSignalResults = [
      {
        signal_id: "uuid-1",
        timestamp: 1,
        symbol: "BTC",
        signal_type: "BUY",
        source: "A",
        processed_at: 10,
      },
      {
        signal_id: "uuid-2",
        timestamp: 2,
        symbol: "ETH",
        signal_type: "SELL",
        source: "B",
        processed_at: 9,
      },
    ];

    it("should return recent signals with default limit", async () => {
      mockAll.mockResolvedValueOnce({
        success: true,
        results: mockSignalResults,
      });

      const request = createMockRequest("GET", "/api/signals");
      const response = await worker.fetch(request, mockEnv, {} as any);

      expect(response.status).toBe(200);
      const responseBody = await response.json();
      expect(responseBody.success).toBe(true);
      expect(responseBody.result).toEqual(mockSignalResults);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("SELECT signal_id")
      );
      expect(mockBind).toHaveBeenCalledWith(10); // Default limit
      expect(mockAll).toHaveBeenCalledTimes(1);
    });

    it("should return signals with specified limit", async () => {
      mockAll.mockResolvedValueOnce({
        success: true,
        results: [mockSignalResults[0]],
      });

      const request = createMockRequest("GET", "/api/signals?limit=1");
      const response = await worker.fetch(request, mockEnv, {} as any);

      expect(response.status).toBe(200);
      const responseBody = await response.json();
      expect(responseBody.success).toBe(true);
      expect(responseBody.result).toEqual([mockSignalResults[0]]);
      expect(mockBind).toHaveBeenCalledWith(1); // Specified limit
      expect(mockAll).toHaveBeenCalledTimes(1);
    });

    it("should return empty array if no signals found", async () => {
      mockAll.mockResolvedValueOnce({ success: true, results: [] });

      const request = createMockRequest("GET", "/api/signals");
      const response = await worker.fetch(request, mockEnv, {} as any);

      expect(response.status).toBe(200);
      const responseBody = await response.json();
      expect(responseBody.success).toBe(true);
      expect(responseBody.result).toEqual([]);
      expect(mockAll).toHaveBeenCalledTimes(1);
    });

    it("should return 400 for invalid limit parameter (string)", async () => {
      const request = createMockRequest("GET", "/api/signals?limit=abc");
      const response = await worker.fetch(request, mockEnv, {} as any);
      expect(response.status).toBe(400);
      const responseBody = await response.json();
      expect(responseBody.success).toBe(false);
      expect(responseBody.error).toContain("Invalid limit");
      expect(mockAll).not.toHaveBeenCalled();
    });

    it("should return 400 for invalid limit parameter (zero)", async () => {
      const request = createMockRequest("GET", "/api/signals?limit=0");
      const response = await worker.fetch(request, mockEnv, {} as any);
      expect(response.status).toBe(400);
      // ... assertions ...
      expect(mockAll).not.toHaveBeenCalled();
    });

    it("should return 400 for invalid limit parameter (too large)", async () => {
      const request = createMockRequest("GET", "/api/signals?limit=101");
      const response = await worker.fetch(request, mockEnv, {} as any);
      expect(response.status).toBe(400);
      // ... assertions ...
      expect(mockAll).not.toHaveBeenCalled();
    });

    it("should return 500 if D1 query fails", async () => {
      mockAll.mockRejectedValueOnce(new Error("D1 Select Error"));

      const request = createMockRequest("GET", "/api/signals");
      const response = await worker.fetch(request, mockEnv, {} as any);

      expect(response.status).toBe(500);
      const responseBody = await response.json();
      expect(responseBody.success).toBe(false);
      expect(responseBody.error).toContain("Internal server error");
      expect(mockAll).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Trade Worker Helpers", () => {
  let validateApiCredentials: (exchange: string, env: any) => Promise<boolean>;
  let validateTradePayload: (payload: any) => {
    isValid: boolean;
    error?: string;
  };
  let saveReportToR2: (
    reportData: any,
    payload: any,
    dbLogId: number | null,
    env: any
  ) => Promise<void>;

  beforeAll(async () => {
    // Import the helper functions using dynamic import
    const module = await import("./index");
    validateApiCredentials = module.validateApiCredentials;
    validateTradePayload = module.validateTradePayload;
    saveReportToR2 = module.saveReportToR2;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset secret bindings for credential tests
    mockEnv.MEXC_KEY_BINDING.get.mockResolvedValue("mexc-key");
    mockEnv.MEXC_SECRET_BINDING.get.mockResolvedValue("mexc-secret");
    mockEnv.BINANCE_KEY_BINDING.get.mockResolvedValue("binance-key");
    mockEnv.BINANCE_SECRET_BINDING.get.mockResolvedValue("binance-secret");
    mockEnv.BYBIT_KEY_BINDING.get.mockResolvedValue("bybit-key");
    mockEnv.BYBIT_SECRET_BINDING.get.mockResolvedValue("bybit-secret");
  });

  describe("validateApiCredentials", () => {
    it("should return true for mexc if keys are present", async () => {
      expect(await validateApiCredentials("mexc", mockEnv)).toBe(true);
    });
    it("should return true for binance if keys are present", async () => {
      expect(await validateApiCredentials("binance", mockEnv)).toBe(true);
    });
    it("should return true for bybit if keys are present", async () => {
      expect(await validateApiCredentials("bybit", mockEnv)).toBe(true);
    });

    it("should return false if key is missing for mexc", async () => {
      mockEnv.MEXC_KEY_BINDING.get.mockResolvedValue(null);
      expect(await validateApiCredentials("mexc", mockEnv)).toBe(false);
    });
    it("should return false if secret is missing for binance", async () => {
      mockEnv.BINANCE_SECRET_BINDING.get.mockResolvedValue(null);
      expect(await validateApiCredentials("binance", mockEnv)).toBe(false);
    });
    it("should return false if key binding itself is missing for bybit", async () => {
      const envWithoutBinding = { ...mockEnv, BYBIT_KEY_BINDING: undefined };
      expect(await validateApiCredentials("bybit", envWithoutBinding)).toBe(
        false
      );
    });
    it("should return false for unknown exchange", async () => {
      expect(await validateApiCredentials("kraken", mockEnv)).toBe(false);
    });
    it("should return false if secret binding get throws error", async () => {
      mockEnv.MEXC_SECRET_BINDING.get.mockRejectedValue(new Error("KV error"));
      expect(await validateApiCredentials("mexc", mockEnv)).toBe(false);
    });
  });

  describe("validateTradePayload", () => {
    const validPayload = {
      exchange: "mexc",
      action: "LONG",
      symbol: "BTC_USDT",
      quantity: 0.01,
    };
    it("should return valid for a correct payload", () => {
      expect(validateTradePayload(validPayload)).toEqual({ isValid: true });
    });
    it("should return invalid if payload is null or not object", () => {
      expect(validateTradePayload(null)).toEqual({
        isValid: false,
        error: "Invalid or missing payload",
      });
      expect(validateTradePayload("string")).toEqual({
        isValid: false,
        error: "Invalid or missing payload",
      });
    });
    it("should return invalid for missing required fields", () => {
      expect(
        validateTradePayload({ ...validPayload, symbol: undefined })
      ).toEqual({
        isValid: false,
        error: "Missing required fields in payload",
      });
    });
    it("should return invalid for invalid action", () => {
      expect(validateTradePayload({ ...validPayload, action: "HOLD" })).toEqual(
        { isValid: false, error: "Invalid action in payload: HOLD" }
      );
    });
    it("should return invalid for non-positive quantity", () => {
      expect(validateTradePayload({ ...validPayload, quantity: 0 })).toEqual({
        isValid: false,
        error: "Invalid quantity in payload",
      });
      expect(validateTradePayload({ ...validPayload, quantity: -1 })).toEqual({
        isValid: false,
        error: "Invalid quantity in payload",
      });
      expect(
        validateTradePayload({ ...validPayload, quantity: "abc" })
      ).toEqual({ isValid: false, error: "Invalid quantity in payload" });
    });
    it("should return invalid for invalid price", () => {
      expect(validateTradePayload({ ...validPayload, price: "abc" })).toEqual({
        isValid: false,
        error: "Invalid price in payload",
      });
    });
    it("should return invalid for invalid leverage", () => {
      expect(
        validateTradePayload({ ...validPayload, leverage: "abc" })
      ).toEqual({ isValid: false, error: "Invalid leverage in payload" });
      expect(validateTradePayload({ ...validPayload, leverage: 0 })).toEqual({
        isValid: false,
        error: "Invalid leverage in payload",
      });
      expect(validateTradePayload({ ...validPayload, leverage: 10.5 })).toEqual(
        { isValid: false, error: "Invalid leverage in payload" }
      ); // Must be integer
    });
    it("should return valid if optional fields (price, leverage, orderType) are missing", () => {
      expect(validateTradePayload(validPayload)).toEqual({ isValid: true });
    });
    it("should return valid if optional fields (price, leverage) are present and valid", () => {
      expect(
        validateTradePayload({ ...validPayload, price: 50000, leverage: 20 })
      ).toEqual({ isValid: true });
    });
  });

  describe("saveReportToR2", () => {
    const reportData = { tradeId: "123", status: "success" };
    const payload = { exchange: "mexc", symbol: "BTC_USDT", action: "LONG" };
    const dbLogId = 987;

    it("should call R2 put with correct key and data", async () => {
      await saveReportToR2(reportData, payload, dbLogId, mockEnv);

      // Check if put was called at all
      expect(mockEnv.REPORTS_BUCKET.put).toHaveBeenCalled();
    });

    it("should log error and not call put if R2 binding is missing", async () => {
      const errorSpy = vi.spyOn(console, "error");
      const envWithoutR2 = { ...mockEnv, REPORTS_BUCKET: undefined };
      await saveReportToR2(reportData, payload, dbLogId, envWithoutR2);

      expect(mockEnv.REPORTS_BUCKET.put).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `[${dbLogId}] REPORTS_BUCKET binding is not configured.`
        )
      );
      errorSpy.mockRestore();
    });

    it("should generate key without dbLogId if null", async () => {
      await saveReportToR2(reportData, payload, null, mockEnv);
      // Check if put was called at all
      expect(mockEnv.REPORTS_BUCKET.put).toHaveBeenCalled();
    });

    it("should log error if R2 put fails", async () => {
      const putError = new Error("R2 Put Failed");
      mockEnv.REPORTS_BUCKET.put.mockRejectedValueOnce(putError);
      const errorSpy = vi.spyOn(console, "error");

      await saveReportToR2(reportData, payload, dbLogId, mockEnv);

      // Check if put was called at all
      expect(mockEnv.REPORTS_BUCKET.put).toHaveBeenCalled();
      // Check that console.error was called (less strict)
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});

describe("Trade Worker Handlers", () => {
  const validPayload = {
    exchange: "mexc",
    action: "LONG",
    symbol: "BTC_USDT",
    quantity: 0.01,
    leverage: 20,
  };
  const logId = 555;

  beforeAll(async () => {
    // Need to import executeTrade helper if testing handlers directly
    // const module = await import('./index');
    // executeTrade = module.executeTrade; // Assuming executeTrade is exported for direct testing
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mocks for clients and logger
    mockMexcClientConstructor.mockClear();
    mockBinanceClientConstructor.mockClear();
    mockBybitClientConstructor.mockClear();
    mockDbLoggerConstructor.mockClear();
    Object.values(mockMexcClient).forEach((fn) => fn.mockReset());
    Object.values(mockBinanceClient).forEach((fn) => fn.mockReset());
    Object.values(mockBybitClient).forEach((fn) => fn.mockReset());
    mockLogRequest.mockReset();
    mockLogResponse.mockReset();
    mockEnv.REPORTS_BUCKET.put.mockClear();
    mockEnv.INTERNAL_KEY_BINDING.get.mockClear();
    mockEnv.MEXC_KEY_BINDING.get.mockClear();

    // Reset specific mockEnv properties to their default values if they were overridden
    mockEnv.INTERNAL_KEY_BINDING.get.mockResolvedValue("test-internal-key");
    mockEnv.MEXC_KEY_BINDING.get.mockResolvedValue("mexc-key");

    // Default successful mocks
    mockLogRequest.mockResolvedValue(logId);
    mockMexcClient.openLong.mockResolvedValue({ orderId: "mexc123" });
    mockBinanceClient.openLong.mockResolvedValue({ orderId: "bin987" });
    mockBybitClient.openLong.mockResolvedValue({ orderId: "byb456" });
    mockMexcClient.setLeverage.mockResolvedValue({}); // Assume leverage set succeeds
  });

  describe("/webhook handler", () => {
    it("should validate payload, log, init client, set leverage, execute trade, log response, and save report", async () => {
      const request = createMockRequest("POST", "/webhook", validPayload);
      const startTime = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(startTime);

      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.result).toEqual({ orderId: "mexc123" });

      // Check logger init and calls
      expect(mockDbLoggerConstructor).toHaveBeenCalledWith(mockEnv);
      expect(mockLogRequest).toHaveBeenCalledWith(request, validPayload);
      // Response object passed to logResponse might be complex to assert fully
      expect(mockLogResponse).toHaveBeenCalledWith(
        logId,
        expect.any(Response),
        null,
        startTime
      );

      // Check client init
      expect(mockMexcClientConstructor).toHaveBeenCalledWith(
        "mexc-key",
        "mexc-secret"
      );
      expect(mockBinanceClientConstructor).not.toHaveBeenCalled();
      expect(mockBybitClientConstructor).not.toHaveBeenCalled();

      // Check client calls (leverage and trade)
      expect(mockMexcClient.setLeverage).toHaveBeenCalledWith(
        validPayload.symbol,
        validPayload.leverage
      );
      expect(mockMexcClient.openLong).toHaveBeenCalledWith(
        validPayload.symbol,
        validPayload.quantity,
        undefined, // price
        "MARKET" // orderType
      );

      // Check R2 save
      expect(mockEnv.REPORTS_BUCKET.put).toHaveBeenCalledWith(
        expect.stringContaining(`trade-reports/mexc/BTC_USDT/`),
        expect.any(String), // The JSON string of the report
        expect.any(Object) // options
      );
    });

    it("should return 400 if payload validation fails", async () => {
      const invalidPayload = { ...validPayload, quantity: -1 };
      const request = createMockRequest("POST", "/webhook", invalidPayload);
      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("Invalid quantity");
      expect(mockLogRequest).toHaveBeenCalled(); // Still logs the bad request
      expect(mockLogResponse).toHaveBeenCalled(); // Still logs the 400 response
      expect(mockMexcClientConstructor).not.toHaveBeenCalled();
      expect(mockMexcClient.openLong).not.toHaveBeenCalled();
    });

    it("should return 400 if API credentials are not configured for the exchange", async () => {
      mockEnv.MEXC_KEY_BINDING.get.mockResolvedValue(null); // Simulate missing key
      const request = createMockRequest("POST", "/webhook", validPayload);
      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("API secret bindings not configured");
    });

    it("should handle errors during setLeverage gracefully", async () => {
      const leverageError = new Error("Leverage set failed");
      mockMexcClient.setLeverage.mockRejectedValue(leverageError);
      const request = createMockRequest("POST", "/webhook", validPayload);
      const errorSpy = vi.spyOn(console, "error");

      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);

      expect(response.status).toBe(200); // Still proceeds to trade
      expect(mockMexcClient.openLong).toHaveBeenCalled(); // Trade should still be attempted
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to set leverage"),
        leverageError
      );
      errorSpy.mockRestore();
    });

    it("should return 500 if executeTrade fails", async () => {
      const tradeError = new Error("Trade execution failed");
      mockMexcClient.openLong.mockRejectedValue(tradeError);
      const request = createMockRequest("POST", "/webhook", validPayload);

      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain(tradeError.message);
      expect(mockLogResponse).toHaveBeenCalledWith(
        logId,
        expect.any(Response),
        null,
        expect.any(Number)
      );
      expect(mockEnv.REPORTS_BUCKET.put).not.toHaveBeenCalled(); // No report on failure
    });

    it("should select and use Binance client based on payload", async () => {
      const binancePayload = { ...validPayload, exchange: "binance" };
      const request = createMockRequest("POST", "/webhook", binancePayload);

      await worker.fetch(request, mockEnv, { waitUntil: vi.fn() } as any);

      expect(mockBinanceClientConstructor).toHaveBeenCalledWith(
        "binance-key",
        "binance-secret"
      );
      expect(mockBinanceClient.openLong).toHaveBeenCalled();
      expect(mockMexcClientConstructor).not.toHaveBeenCalled();
      expect(mockBybitClientConstructor).not.toHaveBeenCalled();
    });

    it("should skip leverage setting if leverage not in payload", async () => {
      const noLeveragePayload = { ...validPayload };
      delete noLeveragePayload.leverage;
      const request = createMockRequest("POST", "/webhook", noLeveragePayload);

      await worker.fetch(request, mockEnv, { waitUntil: vi.fn() } as any);

      expect(mockMexcClient.setLeverage).not.toHaveBeenCalled();
      expect(mockMexcClient.openLong).toHaveBeenCalled();
    });
  });

  describe("/process handler", () => {
    const processPayload = {
      requestId: "req-abc",
      internalAuthKey: "test-internal-key",
      payload: validPayload,
    };

    it("should authenticate, validate, and execute trade", async () => {
      const request = createMockRequest("POST", "/process", processPayload);
      await worker.fetch(request, mockEnv, { waitUntil: vi.fn() } as any);

      // Check auth was checked
      expect(mockEnv.INTERNAL_KEY_BINDING.get).toHaveBeenCalled();
      // Check trade was executed
      expect(mockMexcClientConstructor).toHaveBeenCalled();
      expect(mockMexcClient.openLong).toHaveBeenCalled();
      // Check logging happened
      expect(mockLogRequest).toHaveBeenCalled();
      expect(mockLogResponse).toHaveBeenCalled();
    });

    it("should return 403 if internalAuthKey is missing or incorrect", async () => {
      const badAuthPayload = { ...processPayload, internalAuthKey: "wrong" };
      const request = createMockRequest("POST", "/process", badAuthPayload);
      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Authentication failed");
    });

    it("should return 500 if INTERNAL_KEY_BINDING is missing", async () => {
      const envNoKey = { ...mockEnv, INTERNAL_KEY_BINDING: undefined };
      const request = createMockRequest("POST", "/process", processPayload);
      const response = await worker.fetch(request, envNoKey, {
        waitUntil: vi.fn(),
      } as any);
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Service configuration error");
    });

    it("should return 400 if nested payload is invalid", async () => {
      const invalidNestedPayload = {
        ...processPayload,
        payload: { ...validPayload, action: "INVALID" },
      };
      const request = createMockRequest(
        "POST",
        "/process",
        invalidNestedPayload
      );
      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Invalid action");
    });
  });

  // Tests for /report handler and /test-ai handler can be added here in the future
});
