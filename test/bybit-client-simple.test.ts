import { describe, expect, test } from "bun:test";
import { BybitClient } from "../src/bybit-client";

const API_KEY = "test-api-key";
const API_SECRET = "test-api-secret";
const TEST_URL = "https://api.test.com";

describe("bybit-client", () => {
  test("BybitClient constructor creates instance", () => {
    const client = new BybitClient(API_KEY, API_SECRET);
    expect(client).toBeDefined();
  });

  test("BybitClient has setLeverage method", () => {
    const client = new BybitClient(API_KEY, API_SECRET);
    expect(typeof client.setLeverage).toBe("function");
  });

  test("BybitClient has executeTrade method", () => {
    const client = new BybitClient(API_KEY, API_SECRET);
    expect(typeof (client as any).executeTrade).toBe("function");
  });

  test("BybitClient has openLong method", () => {
    const client = new BybitClient(API_KEY, API_SECRET);
    expect(typeof client.openLong).toBe("function");
  });

  test("BybitClient has openShort method", () => {
    const client = new BybitClient(API_KEY, API_SECRET);
    expect(typeof client.openShort).toBe("function");
  });

  test("BybitClient has closeLong method", () => {
    const client = new BybitClient(API_KEY, API_SECRET);
    expect(typeof client.closeLong).toBe("function");
  });

  test("BybitClient has closeShort method", () => {
    const client = new BybitClient(API_KEY, API_SECRET);
    expect(typeof client.closeShort).toBe("function");
  });

  test("BybitClient has getAccountInfo method", () => {
    const client = new BybitClient(API_KEY, API_SECRET);
    expect(typeof client.getAccountInfo).toBe("function");
  });

  test("BybitClient has getPositions method", () => {
    const client = new BybitClient(API_KEY, API_SECRET);
    expect(typeof client.getPositions).toBe("function");
  });
});
