import type { D1Result } from "@cloudflare/workers-types";
import { createLogger } from "@jango-blockchained/hoox-shared/middleware";
import {
  createErrorResponse,
  createJsonResponse,
  toError,
} from "@jango-blockchained/hoox-shared/errors";

const logger = createLogger({ service: "trade-worker", module: "signals" });

// --- Type Definitions ---

/**
 * Minimal environment interface for D1 signal operations.
 * Only includes the bindings needed by these functions.
 */
export interface D1Env {
  D1_SERVICE: Fetcher;
  INTERNAL_KEY_BINDING?: string;
  [key: string]: unknown;
}

// Structure for storing trade signals in D1
export interface TradeSignalRecord {
  signal_id: string;
  timestamp: number;
  symbol: string;
  signal_type: string;
  source?: string;
  raw_data?: string;
}

// --- D1 Helper Functions ---

/**
 * Inserts a trade signal into the D1 database.
 */
export async function insertSignal(
  signal: TradeSignalRecord,
  env: D1Env
): Promise<D1Result> {
  if (!env.D1_SERVICE) {
    throw new Error("D1_SERVICE binding not configured.");
  }
  const query = `INSERT INTO trade_signals (signal_id, timestamp, symbol, signal_type, source, raw_data) 
         VALUES (?, ?, ?, ?, ?, ?)`;
  const params = [
    signal.signal_id,
    signal.timestamp,
    signal.symbol,
    signal.signal_type,
    signal.source ?? null,
    signal.raw_data ?? null,
  ];

  const response = await env.D1_SERVICE.fetch("http://internal/query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Auth-Key": env.INTERNAL_KEY_BINDING || "",
    },
    body: JSON.stringify({ query, params }),
  });

  if (!response.ok) {
    throw new Error(`D1_SERVICE responded with ${response.status}`);
  }

  const data = (await response.json()) as {
    success: boolean;
    error?: string;
    changes?: number;
    lastRowId?: number;
  };
  if (!data.success) {
    return {
      success: false,
      error: data.error || "D1 insert failed",
    } as unknown as D1Result;
  }

  return {
    success: true,
    meta: { changes: data.changes, last_row_id: data.lastRowId },
  } as unknown as D1Result;
}

/**
 * Retrieves recent trade signals from the D1 database.
 */
export async function getRecentSignals(
  env: D1Env,
  limit: number = 10
): Promise<D1Result<TradeSignalRecord>> {
  if (!env.D1_SERVICE) {
    throw new Error("D1_SERVICE binding not configured.");
  }
  const query = `SELECT signal_id, timestamp, symbol, signal_type, source, processed_at 
         FROM trade_signals 
         ORDER BY processed_at DESC 
         LIMIT ?`;

  const response = await env.D1_SERVICE.fetch("http://internal/query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Auth-Key": env.INTERNAL_KEY_BINDING || "",
    },
    body: JSON.stringify({ query, params: [limit] }),
  });

  if (!response.ok) {
    throw new Error(`D1_SERVICE responded with ${response.status}`);
  }

  const data = (await response.json()) as {
    success: boolean;
    error?: string;
    results?: unknown[];
  };
  if (!data.success) {
    throw new Error(data.error || "D1 getRecentSignals failed");
  }

  return {
    success: true,
    results: data.results,
  } as unknown as D1Result<TradeSignalRecord>;
}

// --- Request Handlers for D1 ---

/**
 * Handles POST requests to insert a new trade signal into D1.
 */
export async function handlePostSignalRequest(
  request: Request,
  env: D1Env
): Promise<Response> {
  let signalPayload: Record<string, unknown>;
  try {
    signalPayload = (await request.json()) as Record<string, unknown>;
  } catch (error: unknown) {
    return createJsonResponse(
      { success: false, error: "Invalid JSON payload" },
      400
    );
  }

  // Basic validation (expand as needed)
  if (
    !signalPayload.symbol ||
    !signalPayload.signal_type ||
    !signalPayload.timestamp
  ) {
    return createJsonResponse(
      {
        success: false,
        error: "Missing required fields: symbol, signal_type, timestamp",
      },
      400
    );
  }

  const signalRecord: TradeSignalRecord = {
    signal_id: crypto.randomUUID(), // Generate a unique ID
    timestamp: signalPayload.timestamp as number, // Assume provided timestamp is correct
    symbol: signalPayload.symbol as string,
    signal_type: signalPayload.signal_type as string,
    source: signalPayload.source as string | undefined,
    raw_data: JSON.stringify(signalPayload), // Store the whole payload as raw data
  };

  try {
    const result = await insertSignal(signalRecord, env);
    if (result.success) {
      logger.info("Successfully inserted signal", {
        signalId: signalRecord.signal_id,
      });
      return createJsonResponse(
        { success: true, result: { signalId: signalRecord.signal_id } },
        201
      ); // 201 Created
    } else {
      logger.error("D1 insert failed", { error: result.error });
      return createJsonResponse(
        { success: false, error: "Failed to store signal in database." },
        500
      );
    }
  } catch (error) {
    logger.error("Error inserting signal into D1", { error: toError(error) });
    return createJsonResponse(
      { success: false, error: "Internal server error while storing signal." },
      500
    );
  }
}

/**
 * Handles GET requests to retrieve recent trade signals from D1.
 */
export async function handleGetSignalsRequest(
  request: Request,
  env: D1Env
): Promise<Response> {
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? parseInt(limitParam, 10) : 10;

  if (isNaN(limit) || limit <= 0 || limit > 100) {
    // Add reasonable limit bounds
    return createJsonResponse(
      {
        success: false,
        error: "Invalid limit parameter. Must be between 1 and 100.",
      },
      400
    );
  }

  try {
    const results = await getRecentSignals(env, limit);
    return createJsonResponse(
      { success: true, result: results.results || [] },
      200
    );
  } catch (error) {
    logger.error("Error retrieving signals from D1", { error: toError(error) });
    return createJsonResponse(
      {
        success: false,
        error: "Internal server error while retrieving signals.",
      },
      500
    );
  }
}
