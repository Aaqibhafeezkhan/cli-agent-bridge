import { describe, expect, it, vi } from "vitest";
import { executePrompt, shouldFallback } from "../src/executor.js";
import { ProviderError, type Provider } from "../src/providers/types.js";

function makeProvider(
  name: string,
  run: () => AsyncGenerator<string>,
): Provider {
  return { name, complete: run };
}

describe("fallback decisions", () => {
  it.each([
    "context_overflow",
    "connection_refused",
    "timeout",
    "server_error",
  ] as const)("allows fallback after %s", (kind) =>
    expect(shouldFallback(new ProviderError("ollama", kind, "failed"))).toBe(
      true,
    ),
  );

  it.each(["auth", "rate_limited", "unknown"] as const)(
    "does not fall back after %s",
    (kind) => {
      expect(shouldFallback(new ProviderError("ollama", kind, "failed"))).toBe(
        false,
      );
    },
  );

  it("switches after partial primary output and reports the partial result", async () => {
    const primary = makeProvider(
      "ollama",
      async function* (): AsyncGenerator<string> {
        yield "partial";
        throw new ProviderError("ollama", "context_overflow", "context full");
      },
    );
    const cloud = makeProvider(
      "openai",
      async function* (): AsyncGenerator<string> {
        yield "recovered";
      },
    );
    const fallbackNotice = vi.fn();

    const result = await executePrompt({
      prompt: "test",
      primary,
      primaryModel: "local-model",
      fallbackProvider: cloud,
      fallbackModel: "gpt-4o-mini",
      timeoutSeconds: 2,
      rateLimitRetries: 0,
      onFallback: fallbackNotice,
    });

    expect(result).toMatchObject({
      text: "partialrecovered",
      provider: "openai",
      fallbackUsed: true,
    });
    expect(fallbackNotice).toHaveBeenCalledWith(
      expect.objectContaining({ partialOutput: true, to: cloud }),
    );
  });

  it("never switches on authentication errors", async () => {
    const primary = makeProvider(
      "openai",
      async function* (): AsyncGenerator<string> {
        throw new ProviderError("openai", "auth", "invalid key");
      },
    );
    const alternateRun = vi.fn(async function* (): AsyncGenerator<string> {
      yield "should not run";
    });
    const alternate = makeProvider("ollama", alternateRun);

    await expect(
      executePrompt({
        prompt: "test",
        primary,
        primaryModel: "cloud-model",
        fallbackProvider: alternate,
        timeoutSeconds: 2,
        rateLimitRetries: 0,
      }),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(alternateRun).not.toHaveBeenCalled();
  });

  it("retries rate limits before returning a provider response", async () => {
    let attempts = 0;
    const primary = makeProvider(
      "openai",
      async function* (): AsyncGenerator<string> {
        attempts += 1;
        if (attempts === 1)
          throw new ProviderError("openai", "rate_limited", "busy", {
            retryAfterMs: 0,
          });
        yield "ok";
      },
    );
    const retryNotice = vi.fn();

    const result = await executePrompt({
      prompt: "test",
      primary,
      primaryModel: "gpt-4o-mini",
      timeoutSeconds: 2,
      rateLimitRetries: 1,
      onRetry: retryNotice,
    });

    expect(result.text).toBe("ok");
    expect(attempts).toBe(2);
    expect(retryNotice).toHaveBeenCalledOnce();
  });

  it("starts with OpenAI when cloud-first is requested", async () => {
    const calls: string[] = [];
    const ollama = makeProvider(
      "ollama",
      async function* (): AsyncGenerator<string> {
        calls.push("ollama");
        yield "local";
      },
    );
    const openai = makeProvider(
      "openai",
      async function* (): AsyncGenerator<string> {
        calls.push("openai");
        yield "cloud";
      },
    );

    const result = await executePrompt({
      prompt: "test",
      primary: ollama,
      primaryModel: "local-model",
      fallbackProvider: openai,
      fallbackModel: "gpt-4o-mini",
      forceCloudFirst: true,
      timeoutSeconds: 2,
      rateLimitRetries: 0,
    });

    expect(calls).toEqual(["openai"]);
    expect(result).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      fallbackUsed: true,
    });
  });
});
