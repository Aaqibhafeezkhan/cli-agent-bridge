/** Provider failure categories used to make fallback decisions. */
export type ProviderErrorKind =
  | "context_overflow"
  | "connection_refused"
  | "timeout"
  | "rate_limited"
  | "auth"
  | "server_error"
  | "unknown";

/** One message in a chat completion request. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Provider request shape shared by local and OpenAI-compatible endpoints. */
export interface ProviderRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Options passed to a provider request. */
export interface ProviderOptions {
  signal?: AbortSignal;
}

/** A normalized provider error that preserves its category and source details. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  /** Create a typed error for provider failures. */
  constructor(
    provider: string,
    kind: ProviderErrorKind,
    message: string,
    details: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: details.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = kind;
    if (details.status !== undefined) this.status = details.status;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
  }
}

/** A text-generating provider that returns chunks as they arrive. */
export interface Provider {
  readonly name: string;
  complete(request: ProviderRequest, options?: ProviderOptions): AsyncIterable<string>;
}

function errorText(error: unknown, body = ""): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${body} ${message}`.toLowerCase();
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

/** Classify transport, HTTP, and provider-body failures consistently across providers. */
export function classifyProviderError(
  provider: string,
  error: unknown,
  details: { status?: number; body?: string; retryAfterMs?: number } = {},
): ProviderError {
  if (error instanceof ProviderError) return error;
  const text = errorText(error, details.body);
  const status = details.status;
  const code = errorCode(error);
  let kind: ProviderErrorKind = "unknown";
  if (
    text.includes("context_length_exceeded") ||
    text.includes("context length") ||
    text.includes("context window") ||
    text.includes("context overflow") ||
    text.includes("prompt is too long") ||
    text.includes("input is too long") ||
    text.includes("maximum context") ||
    text.includes("truncat")
  ) {
    kind = "context_overflow";
  } else if (status === 401 || status === 403 || text.includes("invalid api key") || text.includes("unauthorized")) {
    kind = "auth";
  } else if (status === 429 || text.includes("rate limit")) {
    kind = "rate_limited";
  } else if (status !== undefined && status >= 500) {
    kind = "server_error";
  } else if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    text.includes("connection refused") ||
    text.includes("fetch failed")
  ) {
    kind = "connection_refused";
  } else if (
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    code === "ETIMEDOUT" ||
    text.includes("timed out") ||
    text.includes("timeout")
  ) {
    kind = "timeout";
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(provider, kind, message, {
    ...(status !== undefined ? { status } : {}),
    ...(details.retryAfterMs !== undefined ? { retryAfterMs: details.retryAfterMs } : {}),
    cause: error,
  });
}
