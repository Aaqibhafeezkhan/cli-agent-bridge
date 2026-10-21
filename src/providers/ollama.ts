import {
  classifyProviderError,
  type Provider,
  type ProviderRequest,
  type ProviderOptions,
} from "./types.js";
import { readTextStream } from "./stream.js";

/** Options for connecting to a local Ollama server. */
export interface OllamaProviderOptions {
  baseUrl?: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
}

/** Ollama chat provider using its native newline-delimited streaming API. */
export class OllamaProvider implements Provider {
  readonly name = "ollama";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  /** Create a provider for a local or remote Ollama-compatible server. */
  constructor(options: OllamaProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:11434").replace(
      /\/+$/,
      "",
    );
    this.model = options.model ?? "llama3.2";
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  /** Stream generated text from `/api/chat`. */
  async *complete(
    request: ProviderRequest,
    options: ProviderOptions = {},
  ): AsyncGenerator<string> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model ?? this.model,
          messages: request.messages,
          stream: true,
          ...(request.temperature !== undefined
            ? { options: { temperature: request.temperature } }
            : {}),
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw classifyProviderError(this.name, error);
    }
    if (!response.ok) {
      const body = await response.text();
      throw classifyProviderError(
        this.name,
        new Error(body || response.statusText),
        {
          status: response.status,
          body,
        },
      );
    }
    yield* readTextStream({
      provider: this.name,
      response,
      ...(options.signal ? { signal: options.signal } : {}),
      parseLine: (line) => {
        if (line.trim() === "") return undefined;
        try {
          const item: unknown = JSON.parse(line);
          if (typeof item !== "object" || item === null) return undefined;
          if ("error" in item && typeof item.error === "string") {
            throw classifyProviderError(this.name, new Error(item.error), {
              body: item.error,
            });
          }
          if (
            !("message" in item) ||
            typeof item.message !== "object" ||
            item.message === null
          )
            return undefined;
          return "content" in item.message &&
            typeof item.message.content === "string"
            ? item.message.content
            : undefined;
        } catch (error) {
          if (error instanceof SyntaxError) return undefined;
          throw error;
        }
      },
    });
  }
}
