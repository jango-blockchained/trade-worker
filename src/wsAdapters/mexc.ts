// workers/trade-worker/src/wsAdapters/mexc.ts
//
// MEXC contract edge adapter.
// Docs: https://mexcdevelop.github.io/apidocs/contract_v1_en/#websocket
//
// Auth model: a one-time signed `login` method sent after connect
// (handled by the DO's connect logic, out of scope for the adapter).
// For trade execution the adapter uses `method: "order.place"`
// request/response.
//
// Response shape: { id, code, data?, msg? }

import type { IWsAdapter, WsResponse } from "./types";

export class MexcAdapter implements IWsAdapter {
  readonly url = "wss://contract.mexc.com/edge";

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly creds: { apiKey: string; apiSecret: string }) {}

  async buildRequest(
    method: string,
    params: Record<string, unknown>
  ): Promise<string> {
    const id = crypto.randomUUID();
    return JSON.stringify({
      id,
      method,
      param: params,
    });
  }

  parseResponse(raw: string): WsResponse | null {
    let msg: {
      id?: unknown;
      code?: unknown;
      data?: unknown;
      msg?: unknown;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!msg || typeof msg.id !== "string") return null; // push event
    if (msg.code !== undefined && msg.code !== 0) {
      return {
        id: msg.id,
        error: { code: Number(msg.code), msg: String(msg.msg ?? "") },
      };
    }
    return { id: msg.id, result: msg.data };
  }
}
