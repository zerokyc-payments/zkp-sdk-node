/**
 * HTTP transport: built-in fetch with per-request timeout via
 * AbortController, an injectable fetch for tests, and redirect: "manual"
 * (a 3xx must surface - the same rule as the PHP/Python SDKs).
 */

import { NetworkError } from "./errors.js";
import { VERSION } from "./version.js";

export interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
  header(name: string): string | null;
}

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect: "manual";
  timeoutMs?: number;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<HttpResponse>;

export function httpResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): HttpResponse {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    normalized[k.toLowerCase()] = v;
  }
  return {
    status,
    body,
    headers: normalized,
    header(name: string): string | null {
      return normalized[name.toLowerCase()] ?? null;
    },
  };
}

/**
 * Built-in fetch transport: per-request timeout via AbortController, caller
 * aborts forwarded into the same controller (original reason preserved),
 * redirect: "manual" - a 3xx must surface (same rule as the PHP/Python SDKs).
 * Listener and timer lifecycles are leak-free: everything is cleaned in
 * finally, so a reused caller signal never accumulates handlers.
 */
export async function fetchTransport(url: string, init: FetchInit): Promise<HttpResponse> {
  // ONE request controller: caller aborts are forwarded into it, and the
  // forwarding listener plus the timeout timer are always removed in finally
  // (a reused caller signal must never accumulate listeners).
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("request timeout"));
  }, init.timeoutMs ?? 15_000);

  const caller = init.signal;
  const onCallerAbort = (): void => {
    // surface the caller's own abort reason, not a generic one
    controller.abort(caller?.reason);
  };
  if (caller?.aborted) {
    clearTimeout(timer);
    throw new NetworkError(`transport failure: ${String(caller.reason ?? "aborted")}`);
  }
  caller?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
      redirect: "manual",
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return httpResponse(response.status, await response.text(), headers);
  } catch (e) {
    // fetch rejects on network/timeout/abort; DNS/connect arrive as TypeError
    throw new NetworkError(`transport failure: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
  }
}

/** Identifiable SDK user agent (CDNs commonly block library default UAs). */
export function sdkUserAgent(): string {
  return `zerokyc-node/${VERSION}`;
}
