import { execaCommand } from "execa";
import {
  classifyProviderError,
  ProviderError,
  type Provider,
  type ProviderErrorKind,
} from "./providers/types.js";

/** Result of a completed provider request. */
export interface ExecutionResult {
  text: string;
  provider: string;
  model: string;
  fallbackUsed: boolean;
}

/** Inputs for the provider fallback engine. */
export interface ExecutePromptOptions {
  prompt: string;
  primary: Provider;
  primaryModel: string;
  fallbackProvider?: Provider;
  fallbackModel?: string;
  fallbackEnabled?: boolean;
  forceCloudFirst?: boolean;
  timeoutSeconds: number;
  rateLimitRetries: number;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void | Promise<void>;
  onFallback?: (info: {
    error: ProviderError;
    from: Provider;
    to: Provider;
    model: string;
    partialOutput: boolean;
  }) => void | Promise<void>;
  onRetry?: (info: {
    provider: Provider;
    attempt: number;
    delayMs: number;
  }) => void | Promise<void>;
}

/** Process output streamed by the shell command wrapper. */
export interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/** Options for a shell process, including output callbacks used to tee live output. */
export interface ShellCommandOptions {
  cwd?: string;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

const FallbackKinds = new Set<ProviderErrorKind>([
  "context_overflow",
  "connection_refused",
  "timeout",
  "server_error",
]);

/** Return whether a provider failure is eligible for automatic switching. */
export function shouldFallback(error: ProviderError): boolean {
  return FallbackKinds.has(error.kind);
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function runProvider(
  provider: Provider,
  model: string,
  options: ExecutePromptOptions,
  accumulated: { text: string },
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new DOMException("Provider request timed out", "TimeoutError"),
        ),
      options.timeoutSeconds * 1000,
    );
    try {
      for await (const chunk of provider.complete(
        { model, messages: [{ role: "user", content: options.prompt }] },
        { signal: controller.signal },
      )) {
        accumulated.text += chunk;
        await options.onChunk?.(chunk);
      }
      return;
    } catch (error) {
      const normalized = classifyProviderError(provider.name, error);
      if (
        normalized.kind === "rate_limited" &&
        attempt < options.rateLimitRetries
      ) {
        const delayMs = Math.min(
          normalized.retryAfterMs ?? 250 * 2 ** attempt,
          8_000,
        );
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        await options.onRetry?.({ provider, attempt: attempt + 1, delayMs });
        await wait(delayMs, options.signal);
        continue;
      }
      throw normalized;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Execute a prompt and switch providers only for eligible failures. */
export async function executePrompt(
  options: ExecutePromptOptions,
): Promise<ExecutionResult> {
  const alternate = options.fallbackProvider;
  const startWithCloud =
    options.forceCloudFirst && alternate?.name === "openai";
  const firstProvider =
    startWithCloud && alternate ? alternate : options.primary;
  const firstModel =
    firstProvider === options.primary
      ? options.primaryModel
      : (options.fallbackModel ?? options.primaryModel);
  const accumulated = { text: "" };

  try {
    await runProvider(firstProvider, firstModel, options, accumulated);
    return {
      text: accumulated.text,
      provider: firstProvider.name,
      model: firstModel,
      fallbackUsed: firstProvider !== options.primary,
    };
  } catch (error) {
    const normalized = classifyProviderError(firstProvider.name, error);
    if (options.signal?.aborted) throw options.signal.reason ?? normalized;
    if (
      !alternate ||
      options.fallbackEnabled === false ||
      !shouldFallback(normalized)
    )
      throw normalized;
    const target =
      firstProvider === options.primary ? alternate : options.primary;
    const targetModel =
      target === options.primary
        ? options.primaryModel
        : (options.fallbackModel ?? options.primaryModel);
    await options.onFallback?.({
      error: normalized,
      from: firstProvider,
      to: target,
      model: targetModel,
      partialOutput: accumulated.text.length > 0,
    });
    await runProvider(target, targetModel, options, accumulated);
    return {
      text: accumulated.text,
      provider: target.name,
      model: targetModel,
      fallbackUsed: true,
    };
  }
}

/** Run a shell command while teeing and collecting both output streams. */
export async function runShellCommand(
  command: string,
  options: ShellCommandOptions = {},
): Promise<ShellCommandResult> {
  const startedAt = performance.now();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode = 1;
  try {
    const child = execaCommand(command, {
      shell: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.signal ? { cancelSignal: options.signal } : {}),
      reject: false,
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdoutChunks.push(text);
      options.onStdout?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      options.onStderr?.(text);
    });
    const result = await child;
    exitCode = result.exitCode ?? (options.signal?.aborted ? 130 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.signal?.aborted) {
      stderrChunks.push(`${message}\n`);
      options.onStderr?.(`${message}\n`);
    }
    exitCode = options.signal?.aborted ? 130 : 1;
  }
  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode,
    durationMs: performance.now() - startedAt,
  };
}
