import {
  classifyProviderError,
  type Provider,
  type ProviderRequest,
  type ProviderOptions,
} from "./types.js";
import { readTextStream } from "./stream.js";

/** Options for an OpenAI-compatible chat completion endpoint. */
export interface OpenAIProviderOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

/** OpenAI-compatible provider implemented with native fetch and server-sent events. */
export class OpenAIProvider implements Provider {
  readonly name = "openai";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImplementation: typeof globalThis.fetch;

  /** Create a provider for OpenAI or a compatible endpoint. */
  constructor(options: OpenAIProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    );
    this.model = options.model ?? "gpt-4o-mini";
    this.apiKey = options.apiKey;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  /** Stream generated text from `/chat/completions`. */
  async *complete(
    request: ProviderRequest,
    options: ProviderOptions = {},
  ): AsyncGenerator<string> {
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: request.model ?? this.model,
            messages: request.messages,
            stream: true,
            ...(request.temperature !== undefined
              ? { temperature: request.temperature }
              : {}),
            ...(request.maxTokens !== undefined
              ? { max_tokens: request.maxTokens }
              : {}),
          }),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
    } catch (error) {
      throw classifyProviderError(this.name, error);
    }
    if (!response.ok) {
      const body = await response.text();
      let retryAfterMs: number | undefined;
      const retryHeader = response.headers.get("retry-after");
      if (retryHeader) {
        const seconds = Number(retryHeader);
        if (Number.isFinite(seconds)) retryAfterMs = seconds * 1000;
        else {
          const date = Date.parse(retryHeader);
          if (Number.isFinite(date))
            retryAfterMs = Math.max(0, date - Date.now());
        }
      }
      throw classifyProviderError(
        this.name,
        new Error(body || response.statusText),
        {
          status: response.status,
          body,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      );
    }
    yield* readTextStream({
      provider: this.name,
      response,
      ...(options.signal ? { signal: options.signal } : {}),
      parseLine: (line) => {
        if (!line.startsWith("data:")) return undefined;
        const content = line.slice(5).trim();
        if (content === "[DONE]" || content === "") return undefined;
        try {
          const item: unknown = JSON.parse(content);
          if (typeof item !== "object" || item === null) return undefined;
          if ("error" in item) {
            const body = JSON.stringify(item.error);
            throw classifyProviderError(this.name, new Error(body), { body });
          }
          if (!("choices" in item) || !Array.isArray(item.choices))
            return undefined;
          const first = item.choices[0];
          if (
            typeof first !== "object" ||
            first === null ||
            !("delta" in first) ||
            typeof first.delta !== "object" ||
            first.delta === null
          )
            return undefined;
          return "content" in first.delta &&
            typeof first.delta.content === "string"
            ? first.delta.content
            : undefined;
        } catch (error) {
          if (error instanceof SyntaxError) return undefined;
          throw error;
        }
      },
    });
  }
}
