/** AbortSignal listener lifecycle: a reused caller signal must never
 * accumulate handlers; timer and listener cleanup on every exit path. */

import { getEventListeners } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NetworkError } from "../src/errors.js";
import { fetchTransport } from "../src/http.js";

// one normal server (instant 200) and one that never responds (timeout path)
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("{}");
});
const hanging = http.createServer(() => {
  /* never responds */
});

let normalPort = 0;
let hangingPort = 0;

beforeAll(async () => {
  normalPort = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  hangingPort = await new Promise<number>((resolve) =>
    hanging.listen(0, "127.0.0.1", () => resolve((hanging.address() as AddressInfo).port)),
  );
});

afterAll(
  () =>
    new Promise<void>((resolve) =>
      server.close(() => hanging.close(() => resolve())),
    ),
);

describe("fetchTransport abort lifecycle", () => {
  it("20 sequential requests with one caller signal leave zero listeners", async () => {
    const caller = new AbortController();
    const warnings: string[] = [];
    const onWarning = (w: Error): void => {
      warnings.push(w.message);
    };
    process.on("warning", onWarning);
    try {
      for (let i = 0; i < 20; i += 1) {
        const response = await fetchTransport(`http://127.0.0.1:${normalPort}/x`, {
          method: "GET",
          headers: {},
          signal: caller.signal,
          redirect: "manual",
        });
        expect(response.status).toBe(200);
        // listener removed after EVERY completed request
        expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
      }
      expect(warnings.join(" | ")).not.toContain("MaxListenersExceededWarning");
    } finally {
      process.off("warning", onWarning);
    }
  });

  it("cleanup also runs on transport errors", async () => {
    const caller = new AbortController();
    await expect(
      fetchTransport("http://127.0.0.1:1/nope", {
        method: "GET",
        headers: {},
        signal: caller.signal,
        redirect: "manual",
        timeoutMs: 500,
      }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("caller abort still cancels the request (original reason surfaced)", async () => {
    const caller = new AbortController();
    caller.abort(new Error("caller cancelled"));
    await expect(
      fetchTransport(`http://127.0.0.1:${normalPort}/x`, {
        method: "GET",
        headers: {},
        signal: caller.signal,
        redirect: "manual",
      }),
    ).rejects.toThrowError(/caller cancelled/);
  });

  it("caller abort mid-flight cancels and cleans up", async () => {
    const caller = new AbortController();
    const pending = fetchTransport(`http://127.0.0.1:${hangingPort}/x`, {
      method: "GET",
      headers: {},
      signal: caller.signal,
      redirect: "manual",
      timeoutMs: 10_000,
    });
    setTimeout(() => caller.abort(new Error("mid-flight cancel")), 30);
    await expect(pending).rejects.toBeInstanceOf(NetworkError);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("the request timeout still fires", async () => {
    const started = Date.now();
    await expect(
      fetchTransport(`http://127.0.0.1:${hangingPort}/x`, {
        method: "GET",
        headers: {},
        redirect: "manual",
        timeoutMs: 80,
      }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
