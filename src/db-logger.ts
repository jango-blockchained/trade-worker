// workers/trade-worker/src/db-logger.ts

// Database Schema Reference:
// See scripts/init-db.sql for the complete DDL
//
// CREATE TABLE trade_requests (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
//     method TEXT NOT NULL,
//     path TEXT NOT NULL,
//     headers TEXT,
//     body TEXT,
//     source_ip TEXT,
//     user_agent TEXT
// );
//
// CREATE TABLE trade_responses (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     request_id INTEGER,
//     timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
//     status_code INTEGER,
//     headers TEXT,
//     body TEXT,
//     error TEXT,
//     execution_time_ms INTEGER,
//     FOREIGN KEY (request_id) REFERENCES trade_requests(id)
// );

// Define Env structure expected by the logger
// This should align with the Env interface in index.ts
interface LoggerEnv {
  D1_SERVICE?: Fetcher;
  // Add other env vars if DbLogger uses them
}

// Interface defining the DbLogger's capabilities (optional but good practice)
export interface IDbLogger {
  logRequest(request: Request, requestBody: any): Promise<number | null>;
  logResponse(
    requestId: number | null,
    response: Response,
    error?: Error | null,
    startTime?: number
  ): Promise<void>;
}

/**
 * Database logging utility for trade worker using D1 Service Binding.
 */
export class DbLogger implements IDbLogger {
  private env: LoggerEnv;
  private enabled: boolean;

  constructor(env: LoggerEnv) {
    this.env = env;
    this.enabled = !!env.D1_SERVICE;
    if (!this.enabled) {
      console.warn("D1_SERVICE binding not found. Database logging disabled.");
    }
  }

  /**
   * Logs request details to the database.
   * @param request The incoming Request object.
   * @param requestBody The parsed body of the request (can be any type).
   * @returns The ID of the inserted request log record, or null if disabled/failed.
   */
  async logRequest(request: Request, requestBody: any): Promise<number | null> {
    if (!this.enabled || !this.env.D1_SERVICE) return null;

    try {
      const headers = Object.fromEntries(request.headers.entries());
      const logPayload = {
        query: `INSERT INTO trade_requests
                         (method, path, headers, body, source_ip, user_agent)
                         VALUES (?, ?, ?, ?, ?, ?)`,
        params: [
          request.method,
          new URL(request.url).pathname,
          JSON.stringify(headers),
          JSON.stringify(requestBody), // Assumes body is JSON-serializable
          request.headers.get("cf-connecting-ip") || "unknown",
          request.headers.get("user-agent") || "unknown",
        ],
      };

      // Construct request to D1 worker via service binding
      const serviceRequest = new Request(`https://d1-service/query`, {
        // Dummy URL, path matters
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": crypto.randomUUID(), // Unique ID for this specific log operation
        },
        body: JSON.stringify(logPayload),
      });

      const d1Response = await this.env.D1_SERVICE.fetch(serviceRequest);

      if (!d1Response.ok) {
        console.error(
          "Failed to log request via D1_SERVICE:",
          await d1Response.text()
        );
        return null;
      }

      // Assuming D1 worker returns { success: boolean, lastRowId?: number }
      const result: { success: boolean; lastRowId?: number } =
        await d1Response.json();
      console.log(
        `Request log result: Success=${result.success}, ID=${result.lastRowId}`
      );
      return result.success && result.lastRowId ? result.lastRowId : null;
    } catch (error: any) {
      console.error("Error logging request via D1_SERVICE:", error);
      return null;
    }
  }

  /**
   * Logs response details to the database.
   * @param requestId The ID of the corresponding request log record.
   * @param response The Response object sent back to the client.
   * @param error Optional error object if the request failed.
   * @param startTime Optional start timestamp (ms) to calculate execution time.
   */
  async logResponse(
    requestId: number | null,
    response: Response,
    error: Error | null = null,
    startTime?: number
  ): Promise<void> {
    if (!this.enabled || !this.env.D1_SERVICE || requestId === null) return;

    try {
      const executionTime = startTime ? Date.now() - startTime : null;
      // Safely get headers, handling potential differences in mock/real Response objects
      let headersObject = {};
      if (response.headers && typeof response.headers.entries === "function") {
        try {
          headersObject = Object.fromEntries(response.headers.entries());
        } catch (e) {
          console.error("Failed to get headers using entries():", e);
          // Fallback or alternative way to get headers if needed?
          // For now, log the error and continue with empty headersObject
        }
      } else {
        console.warn(
          "response.headers.entries is not a function or headers missing for logResponse"
        );
        // Attempt to get headers another way if possible, or accept it might be missing
      }

      const responseBody = response.body ? await response.clone().text() : null; // Get body safely
      const errorString = error ? error.toString() : null;

      const logPayload = {
        query: `INSERT INTO trade_responses
                         (request_id, status_code, headers, body, error, execution_time_ms)
                         VALUES (?, ?, ?, ?, ?, ?)`,
        params: [
          requestId,
          response.status,
          JSON.stringify(headersObject),
          responseBody,
          errorString,
          executionTime,
        ],
      };

      const serviceRequest = new Request(`https://d1-service/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": crypto.randomUUID(),
        },
        body: JSON.stringify(logPayload),
      });

      const d1Response = await this.env.D1_SERVICE.fetch(serviceRequest);

      if (!d1Response.ok) {
        console.error(
          "Failed to log response via D1_SERVICE:",
          await d1Response.text()
        );
      }
      // We don't usually need the result of the response log insert
      console.log(`Logged response for request ID: ${requestId}`);
    } catch (error: any) {
      console.error("Error logging response via D1_SERVICE:", error);
    }
  }
}
