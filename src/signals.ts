import type { D1Database, D1Result } from "@cloudflare/workers-types";
import {
  createErrorResponse,
  createJsonResponse,
} from "@jango-blockchained/hoox-shared/errors";

// --- Type Definitions ---

/**
 * Minimal environment interface for D1 signal operations.
 * Only includes the bindings needed by these functions.
 */
export interface D1Env {
  DB: D1Database;
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
  if (!env.DB) {
    throw new Error("D1 Database (DB) binding not configured.");
  }
  const stmt = env.DB.prepare(
    `INSERT INTO trade_signals (signal_id, timestamp, symbol, signal_type, source, raw_data) 
         VALUES (?, ?, ?, ?, ?, ?)`
  );
  return await stmt
    .bind(
      signal.signal_id,
      signal.timestamp,
      signal.symbol,
      signal.signal_type,
      signal.source ?? null, // Use null if source is undefined
      signal.raw_data ?? null // Use null if raw_data is undefined
    )
    .run();
}

/**
 * Retrieves recent trade signals from the D1 database.
 */
export async function getRecentSignals(
  env: D1Env,
  limit: number = 10
): Promise<D1Result<TradeSignalRecord>> {
  if (!env.DB) {
    throw new Error("D1 Database (DB) binding not configured.");
  }
  const stmt = env.DB.prepare(
    `SELECT signal_id, timestamp, symbol, signal_type, source, processed_at 
         FROM trade_signals 
         ORDER BY processed_at DESC 
         LIMIT ?`
  );
  return await stmt.bind(limit).all<TradeSignalRecord>();
}

// --- Request Handlers for D1 ---

/**
 * Handles POST requests to insert a new trade signal into D1.
 */
export async function handlePostSignalRequest(
  request: Request,
  env: D1Env
): Promise<Response> {
  let signalPayload: any;
  try {
    signalPayload = await request.json();
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
    timestamp: signalPayload.timestamp, // Assume provided timestamp is correct
    symbol: signalPayload.symbol,
    signal_type: signalPayload.signal_type,
    source: signalPayload.source,
    raw_data: JSON.stringify(signalPayload), // Store the whole payload as raw data
  };

  try {
    const result = await insertSignal(signalRecord, env);
    if (result.success) {
      console.log(`Successfully inserted signal ID: ${signalRecord.signal_id}`);
      return createJsonResponse(
        { success: true, result: { signalId: signalRecord.signal_id } },
        201
      ); // 201 Created
    } else {
      console.error("D1 insert failed:", result.error);
      return createJsonResponse(
        { success: false, error: "Failed to store signal in database." },
        500
      );
    }
  } catch (error) {
    console.error("Error inserting signal into D1:", error);
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
    console.error("Error retrieving signals from D1:", error);
    return createJsonResponse(
      {
        success: false,
        error: "Internal server error while retrieving signals.",
      },
      500
    );
  }
}
