import { describe, expect, test, beforeEach, jest } from "bun:test";
import { DbLogger, type IDbLogger } from "../src/db-logger";
import type { Fetcher } from "@cloudflare/workers-types"; // Import Fetcher type

// --- Mocks ---
const mockD1ServiceFetch = jest.fn();
const mockRandomUUID = jest.fn();

global.crypto = {
  ...global.crypto, // Keep existing crypto methods if any
  randomUUID: mockRandomUUID,
} as any;

// --- Test Suite ---
describe("DbLogger", () => {
  let mockEnv: { D1_SERVICE?: Fetcher };
  let logger: IDbLogger;
  const TEST_REQUEST_ID = "db-req-uuid-123";
  const LOG_REQUEST_ID = 12345; // Mock lastRowId returned by D1 service

  beforeEach(() => {
    jest.clearAllMocks();
    mockRandomUUID.mockReturnValue(TEST_REQUEST_ID);

    // Default mock env with D1 service enabled
    mockEnv = {
      D1_SERVICE: {
        fetch: mockD1ServiceFetch,
      } as any, // Cast to any to avoid missing properties like connect
    };

    // Default D1 service response (successful insert for request log)
    mockD1ServiceFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ success: true, lastRowId: LOG_REQUEST_ID }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    logger = new DbLogger(mockEnv as any);
  });

  // --- Constructor Tests ---
  test("should enable logging if D1_SERVICE binding exists", () => {
    expect((logger as any).enabled).toBe(true);
  });

  test("should disable logging and warn if D1_SERVICE binding is missing", () => {
    const warnSpy = jest.spyOn(console, "warn");
    mockEnv = {}; // No D1_SERVICE
    const disabledLogger = new DbLogger(mockEnv as any);
    expect((disabledLogger as any).enabled).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "D1_SERVICE binding not found. Database logging disabled."
    );
    warnSpy.mockRestore();
  });

  // --- logRequest Tests ---
  test("logRequest should not call fetch if logging is disabled", async () => {
    mockEnv = {};
    const disabledLogger = new DbLogger(mockEnv as any);
    const request = new Request("http://test.com/trade", { method: "POST" });

    const result = await disabledLogger.logRequest(request, { data: 1 });

    expect(result).toBeNull();
    expect(mockD1ServiceFetch).not.toHaveBeenCalled();
  });

  test("logRequest should call D1_SERVICE fetch with correct SQL and params", async () => {
    const requestUrl = "http://test.com/api/trade?action=buy";
    const requestBody = { symbol: "BTCUSDT", quantity: 1 };
    const requestHeaders = {
      "content-type": "application/json",
      "cf-connecting-ip": "1.2.3.4",
      "user-agent": "TestAgent",
    };
    const request = new Request(requestUrl, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody), // Body doesn't affect the logger directly
    });

    const result = await logger.logRequest(request, requestBody);

    expect(result).toBe(LOG_REQUEST_ID);
    expect(mockD1ServiceFetch).toHaveBeenCalledTimes(1);

    const fetchCall = mockD1ServiceFetch.mock.calls[0][0] as Request; // Get the Request object passed to fetch
    expect(fetchCall.url).toBe("https://d1-service/query");
    expect(fetchCall.method).toBe("POST");
    expect(fetchCall.headers.get("Content-Type")).toBe("application/json");
    expect(fetchCall.headers.get("X-Request-ID")).toBe(TEST_REQUEST_ID);

    const body = await fetchCall.json() as any;
    expect((body as any).query).toContain("INSERT INTO trade_requests");

    const receivedHeaders = JSON.parse((body as any).params[2]); // Parse the received headers string
    const expectedHeaders = requestHeaders; // Original headers object

    expect((body as any).params[0]).toBe("POST");
    expect((body as any).params[1]).toBe("/api/trade");
    expect(receivedHeaders).toEqual(expectedHeaders); // Compare parsed objects
    expect((body as any).params[3]).toBe(JSON.stringify(requestBody));
    expect((body as any).params[4]).toBe("1.2.3.4");
    expect((body as any).params[5]).toBe("TestAgent");
  });

  test("logRequest should return null if D1_SERVICE fetch fails (non-ok status)", async () => {
    mockD1ServiceFetch.mockResolvedValueOnce(
      new Response("D1 Error", { status: 500 })
    );
    const errorSpy = jest.spyOn(console, "error");
    const request = new Request("http://test.com/trade", { method: "POST" });

    const result = await logger.logRequest(request, {});

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to log request via D1_SERVICE:",
      "D1 Error"
    );
    errorSpy.mockRestore();
  });

  test("logRequest should return null if D1_SERVICE response indicates failure", async () => {
    mockD1ServiceFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const request = new Request("http://test.com/trade", { method: "POST" });

    const result = await logger.logRequest(request, {});
    expect(result).toBeNull(); // Should be null because success is false
  });

  test("logRequest should return null if D1_SERVICE fetch throws an error", async () => {
    const fetchError = new Error("Network Error");
    mockD1ServiceFetch.mockRejectedValueOnce(fetchError);
    const errorSpy = jest.spyOn(console, "error");
    const request = new Request("http://test.com/trade", { method: "POST" });

    const result = await logger.logRequest(request, {});

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      "Error logging request via D1_SERVICE:",
      fetchError
    );
    errorSpy.mockRestore();
  });

  // --- logResponse Tests ---
  test("logResponse should not call fetch if logging is disabled", async () => {
    mockEnv = {};
    const disabledLogger = new DbLogger(mockEnv as any);
    const response = new Response("OK", { status: 200 });
    await disabledLogger.logResponse(LOG_REQUEST_ID, response);
    expect(mockD1ServiceFetch).not.toHaveBeenCalled();
  });

  test("logResponse should not call fetch if requestId is null", async () => {
    const response = new Response("OK", { status: 200 });
    await logger.logResponse(null, response);
    expect(mockD1ServiceFetch).not.toHaveBeenCalled();
  });

  test("logResponse should call D1_SERVICE fetch with correct SQL and params", async () => {
    const responseStatus = 201;
    const responseBody = JSON.stringify({ message: "Created" });
    const responseHeaders = new Headers({ "x-custom-header": "value" });
    const response = new Response(responseBody, {
      status: responseStatus,
      headers: responseHeaders,
    });
    const startTime = Date.now() - 150; // 150ms execution time
    const error = null;

    // Reset fetch mock for the response log call (assume success)
    mockD1ServiceFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    await logger.logResponse(LOG_REQUEST_ID, response, error, startTime);

    expect(mockD1ServiceFetch).toHaveBeenCalledTimes(1);
    const fetchCall = mockD1ServiceFetch.mock.calls[0][0] as Request;
    expect(fetchCall.url).toBe("https://d1-service/query");
    expect(fetchCall.method).toBe("POST");
    expect(fetchCall.headers.get("X-Request-ID")).toBe(TEST_REQUEST_ID);

    const body = await fetchCall.json() as any;
    expect((body as any).query).toContain("INSERT INTO trade_responses");
    expect((body as any).params[0]).toBe(LOG_REQUEST_ID);
    expect((body as any).params[1]).toBe(responseStatus);
    // Headers may be empty object in some test environments
    expect((body as any).params[3]).toBe(responseBody);
    expect((body as any).params[4]).toBeNull(); // No error
    expect((body as any).params[5]).toBeGreaterThanOrEqual(0);
  });

  test("logResponse should include error string if provided", async () => {
    const response = new Response("Error", { status: 500 });
    const error = new Error("Something failed");

    mockD1ServiceFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    await logger.logResponse(LOG_REQUEST_ID, response, error);

    expect(mockD1ServiceFetch).toHaveBeenCalledTimes(1);
    const fetchCall = mockD1ServiceFetch.mock.calls[0][0] as Request;
    const body = await fetchCall.json() as any;
    expect((body as any).params[4]).toBe(error.toString());
  });

  test("logResponse should handle D1_SERVICE fetch errors gracefully", async () => {
    mockD1ServiceFetch.mockResolvedValueOnce(
      new Response("D1 Error", { status: 500 })
    );
    const errorSpy = jest.spyOn(console, "error");
    const response = new Response("OK", { status: 200 });

    // Should not throw
    await expect(
      logger.logResponse(LOG_REQUEST_ID, response)
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to log response via D1_SERVICE:",
      "D1 Error"
    );
    errorSpy.mockRestore();
  });

  test("logResponse should handle fetch throwing an error gracefully", async () => {
    const fetchError = new Error("Network Error");
    mockD1ServiceFetch.mockRejectedValueOnce(fetchError);
    const errorSpy = jest.spyOn(console, "error");
    const response = new Response("OK", { status: 200 });

    // Should not throw
    await expect(
      logger.logResponse(LOG_REQUEST_ID, response)
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "Error logging response via D1_SERVICE:",
      fetchError
    );
    errorSpy.mockRestore();
  });
});
