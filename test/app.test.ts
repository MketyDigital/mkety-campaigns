import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";

describe("health routes", () => {
  it("returns a lightweight liveness response", async () => {
    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves a simple standalone portal landing response", async () => {
    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Mkety Campaigns");
  });
});
