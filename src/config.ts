/**
 * SDK configuration: sandbox/production, base URL, timeouts, retries.
 *
 * The base URL is defined centrally here; the override exists for tests and
 * local development only - adapters must never hard-code URLs.
 */

export const DEFAULT_BASE_URL = "https://api.zerokyc-payments.com";

export const SANDBOX = "sandbox";
export const PRODUCTION = "production";

export type Environment = typeof SANDBOX | typeof PRODUCTION;

export interface ConfigOptions {
  apiKey: string;
  environment?: Environment;
  webhookSecret?: string;
  timeoutMs?: number;
  maxRetries?: number;
  baseUrl?: string;
}

export class Config {
  readonly apiKey: string;
  readonly environment: Environment;
  readonly webhookSecret: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly baseUrl: string;

  constructor(options: ConfigOptions) {
    const { apiKey } = options;
    if (!apiKey) {
      throw new Error("apiKey is required");
    }
    const environment =
      options.environment ?? (apiKey.startsWith("pk_test_") ? SANDBOX : PRODUCTION);
    if (environment !== SANDBOX && environment !== PRODUCTION) {
      throw new Error(`environment must be 'sandbox' or 'production', got '${environment}'`);
    }
    // Mixing up sandbox and live keys is the classic production incident:
    // refuse the mismatch outright instead of hoping for the best.
    const isTestKey = apiKey.startsWith("pk_test_");
    if (environment === PRODUCTION && isTestKey) {
      throw new Error(
        "environment is production but the apiKey is a sandbox key (pk_test_...); " +
          "use a pk_live_... key or set environment: 'sandbox'",
      );
    }
    if (environment === SANDBOX && !isTestKey) {
      throw new Error(
        "environment is sandbox but the apiKey is not a sandbox key; expected a pk_test_... key",
      );
    }
    const maxRetries = options.maxRetries ?? 2;
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
      throw new Error("maxRetries must be an integer between 0 and 5");
    }

    this.apiKey = apiKey;
    this.environment = environment;
    this.webhookSecret = options.webhookSecret ?? "";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = maxRetries;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  get isSandbox(): boolean {
    return this.environment === SANDBOX;
  }
}
