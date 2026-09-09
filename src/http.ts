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
 * AbortSignal.any() equivalent for Node 20.0-20.2 (added in 20.3): a signal
 * that fires as soon as any input fires. Keeps the runtime floor at plain 20.
 */
export function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  if (a.aborted) {
    return a;
  }
  if (b.aborted) {
    return b;
  }
  const combined = new AbortController();
  const onAbort = (): void => combined.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return combined.signal;
}

export async function fetchTransport(url: string, init: FetchInit): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("request timeout")),
    init.timeoutMs ?? 15_000,
  );
  const signal = combineSignals(init.signal, controller.signal);

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal,
      redirect: "manual",
    });
  } catch (e) {
    // fetch rejects on network/timeout/abort; DNS/connect arrive as TypeError
    throw new NetworkError(`transport failure: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return httpResponse(response.status, await response.text(), headers);
}

/** Identifiable SDK user agent (CDNs commonly block library default UAs). */
export function sdkUserAgent(): string {
  return `zerokyc-node/${VERSION}`;
}
