import { describe, expect, test } from "bun:test";
import { MexcClient } from "../src/mexc-client";

const API_KEY = "test-api-key";
const API_SECRET = "test-api-secret";
const TEST_URL = "https://api.test.com";

describe("mexc-client", () => {
  test("MexcClient constructor creates instance", () => {
    const client = new MexcClient(API_KEY, API_SECRET);
    expect(client).toBeDefined();
  });

  test("MexcClient has setLeverage method", () => {
    const client = new MexcClient(API_KEY, API_SECRET);
    expect(typeof client.setLeverage).toBe("function");
  });

  test("MexcClient has executeTrade method", () => {
    const client = new MexcClient(API_KEY, API_SECRET);
    expect(typeof (client as any).executeTrade).toBe("function");
  });

  test("MexcClient has openLong method", () => {
    const client = new MexcClient(API_KEY, API_SECRET);
    expect(typeof client.openLong).toBe("function");
  });

  test("MexcClient has openShort method", () => {
    const client = new MexcClient(API_KEY, API_SECRET);
    expect(typeof client.openShort).toBe("function");
  });

  test("MexcClient has closeLong method", () => {
    const client = new MexcClient(API_KEY, API_SECRET);
    expect(typeof client.closeLong).toBe("function");
  });

  test("MexcClient has closeShort method", () => {
    const client = new MexcClient(API_KEY, API_SECRET);
    expect(typeof client.closeShort).toBe("function");
  });

  test("MexcClient has getAccountInfo method", () => {
    const client = new MexcClient(API_KEY, API_SECRET);
    expect(typeof client.getAccountInfo).toBe("function");
  });

  test("MexcClient has getPositions method", () => {
    const client = new MexcClient(API_KEY, API_SECRET);
    expect(typeof client.getPositions).toBe("function");
  });
});