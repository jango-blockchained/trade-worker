// workers/trade-worker/src/wsAdapters/types.ts
//
// Shared interface for per-exchange WebSocket adapters.
// Each adapter wraps one exchange's WS API (URL + envelope) behind a
// uniform shape so the DO doesn't need exchange-specific code.

/**
 * Per-exchange WebSocket adapter.
 *
 * Responsibilities:
 *   - Know the WS endpoint URL for this exchange's API.
 *   - Build the outbound envelope for a request (with auth/signing).
 *   - Parse inbound messages; return the request/response result or
 *     `null` for push events the DO doesn't care about.
 */
export interface WsAdapter {
  /** WebSocket endpoint URL (e.g. `wss://ws-api.binance.com:443/ws-api/v3`). */
  readonly url: string;

  /**
   * Build the outbound string to `ws.send(...)` for a logical request.
   *
   * @param method  Logical method name (e.g. `"order.place"`). The adapter
   *                decides how to translate this into its exchange's envelope.
   * @param params  Method parameters. May be signed inside the adapter.
   * @param creds   Exchange API credentials. Used for signing/auth.
   * @returns       String ready to be passed to `ws.send()`.
   */
  buildRequest(
    method: string,
    params: Record<string, unknown>,
    creds: { apiKey: string; apiSecret: string }
  ): string;

  /**
   * Parse an inbound WS message.
   *
   * @returns A `{ id, result?, error? }` object if the message is a
   *          response to a previously-sent request (caller routes by `id`),
   *          or `null` if the message is a push event the DO doesn't track.
   */
  parseResponse(raw: string): {
    id: string;
    result?: unknown;
    error?: { code: number; msg: string };
  } | null;
}
