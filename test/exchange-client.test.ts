import { describe, expect, test, spyOn } from "bun:test";
import {
  bufferToHex,
  type TradeParams,
  type OrderResponse,
  type Position,
} from "../src/shared/exchange-client.js";
import { BaseExchangeClient } from "../src/shared/base-exchange-client.js";

// ---------------------------------------------------------------------------
// bufferToHex tests
// ---------------------------------------------------------------------------
describe("bufferToHex", () => {
  test("returns correct hex string for simple buffer", () => {
    const buf = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer;
    expect(bufferToHex(buf)).toBe("deadbeef");
  });

  test("handles buffer with leading zeros (preserves padding)", () => {
    const buf = new Uint8Array([0x00, 0x01, 0xab, 0x00]).buffer;
    expect(bufferToHex(buf)).toBe("0001ab00");
  });

  test("returns empty string for empty buffer", () => {
    const buf = new Uint8Array([]).buffer;
    expect(bufferToHex(buf)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Concrete test class for BaseExchangeClient
// ---------------------------------------------------------------------------
class TestClient extends BaseExchangeClient {
  protected getDefaultBaseUrl(): string {
    return "https://test.com";
  }

  setLeverage(_symbol: string, _leverage: number): Promise<unknown> {
    return Promise.resolve();
  }

  executeTrade(params: {
    symbol: string;
    side: string;
    orderType: string;
    quantity: number;
    price?: number;
    reduceOnly?: boolean;
  }): Promise<unknown> {
    return Promise.resolve({
      orderId: "test",
      symbol: params.symbol,
      status: "filled",
    });
  }

  getAccountInfo(): Promise<unknown> {
    return Promise.resolve({});
  }

  getPositions(_symbol?: string): Promise<unknown> {
    return Promise.resolve([]);
  }
}

// ---------------------------------------------------------------------------
// BaseExchangeClient constructor tests
// ---------------------------------------------------------------------------
describe("BaseExchangeClient constructor", () => {
  test("sets apiKey, apiSecret, baseUrl correctly", () => {
    const client = new TestClient("my-key", "my-secret", "https://custom.com");
    expect(client).toBeInstanceOf(BaseExchangeClient);
    // Access protected fields via cast for testing
    const c = client as unknown as {
      apiKey: string;
      apiSecret: string;
      baseUrl: string;
    };
    expect(c.apiKey).toBe("my-key");
    expect(c.apiSecret).toBe("my-secret");
    expect(c.baseUrl).toBe("https://custom.com");
  });

  test("throws when apiKey is missing", () => {
    expect(() => new TestClient("", "secret")).toThrow(
      "API key and secret are required."
    );
  });

  test("throws when apiSecret is missing", () => {
    expect(() => new TestClient("key", "")).toThrow(
      "API key and secret are required."
    );
  });

  test("uses default baseUrl from getDefaultBaseUrl()", () => {
    const client = new TestClient("key", "secret");
    const c = client as unknown as { baseUrl: string };
    expect(c.baseUrl).toBe("https://test.com");
  });
});

// ---------------------------------------------------------------------------
// Trade convenience methods
// ---------------------------------------------------------------------------
describe("BaseExchangeClient trade methods", () => {
  test("openLong calls executeTrade with side='long'", async () => {
    const client = new TestClient("k", "s");
    const spy = spyOn(client, "executeTrade");

    const result = await client.openLong("BTCUSDT", 0.5);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "BTCUSDT",
        side: "BUY",
        quantity: 0.5,
        orderType: "MARKET",
      })
    );
    expect(result).toEqual({
      orderId: "test",
      symbol: "BTCUSDT",
      status: "filled",
    });
  });

  test("openShort calls executeTrade with side='SELL'", async () => {
    const client = new TestClient("k", "s");
    const spy = spyOn(client, "executeTrade");

    const result = await client.openShort("ETHUSDT", 1.2, 1800, "LIMIT");

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "ETHUSDT",
        side: "SELL",
        quantity: 1.2,
        price: 1800,
        orderType: "LIMIT",
      })
    );
    expect(result).toEqual({
      orderId: "test",
      symbol: "ETHUSDT",
      status: "filled",
    });
  });

  test("closeLong calls executeTrade with reduceOnly=true", async () => {
    const client = new TestClient("k", "s");
    const spy = spyOn(client, "executeTrade");

    await client.closeLong("BTCUSDT", 0.3);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "BTCUSDT",
        side: "SELL",
        quantity: 0.3,
        reduceOnly: true,
      })
    );
  });

  test("closeShort calls executeTrade with side='SELL' and reduceOnly=true", async () => {
    const client = new TestClient("k", "s");
    const spy = spyOn(client, "executeTrade");

    await client.closeShort("SOLUSDT", 5);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "SOLUSDT",
        side: "BUY",
        quantity: 5,
        reduceOnly: true,
      })
    );
  });
});
