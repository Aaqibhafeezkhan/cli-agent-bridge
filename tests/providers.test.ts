import { describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "../src/providers/ollama.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { classifyProviderError, ProviderError } from "../src/providers/types.js";

async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const chunk of chunks) result.push(chunk);
  return result;
}

describe("provider error classification", () => {
  it.each([
    ["context_length_exceeded", "context_overflow"],
    ["prompt is too long for the context window", "context_overflow"],
    ["connection refused", "connection_refused"],
    ["request timed out", "timeout"],
    ["rate limit exceeded", "rate_limited"],
    ["invalid api key", "auth"],
  ] as const)("classifies %s as %s", (message, kind) => {
    expect(classifyProviderError("test", new Error(message)).kind).toBe(kind);
  });

  it("classifies HTTP status and retains retry delay", () => {
    const error = classifyProviderError("openai", new Error("busy"), { status: 503, retryAfterMs: 1200 });
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe("server_error");
    expect(error.status).toBe(503);
    expect(error.retryAfterMs).toBe(1200);
  });
});

describe("provider streaming clients", () => {
  it("sends Ollama chat requests and decodes NDJSON content", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"message":{"content":"hello"},"done":false}\n{"message":{"content":" world"},"done":true}\n', {
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    const provider = new OllamaProvider({ fetch: fetchMock, model: "qwen2.5" });
    const output = await collect(provider.complete({ messages: [{ role: "user", content: "hi" }] }));
    const request = fetchMock.mock.calls[0];

    expect(output).toEqual(["hello", " world"]);
    expect(request?.[0]).toBe("http://localhost:11434/api/chat");
    expect(request?.[1]?.body).toContain('"model":"qwen2.5"');
  });

  it("sends OpenAI-compatible chat requests and decodes SSE content", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const provider = new OpenAIProvider({ fetch: fetchMock, apiKey: "secret-key", baseUrl: "https://example.test/v1/" });
    const output = await collect(provider.complete({ messages: [{ role: "user", content: "hi" }] }));
    const request = fetchMock.mock.calls[0];

    expect(output).toEqual(["hello"]);
    expect(request?.[0]).toBe("https://example.test/v1/chat/completions");
    expect(new Headers(request?.[1]?.headers).get("authorization")).toBe("Bearer secret-key");
  });

  it("classifies provider error responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } }), { status: 400 }),
    );
    const provider = new OpenAIProvider({ fetch: fetchMock });

    await expect(collect(provider.complete({ messages: [{ role: "user", content: "x" }] }))).rejects.toMatchObject({
      kind: "context_overflow",
      provider: "openai",
    });
  });
});
