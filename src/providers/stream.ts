import { classifyProviderError, type ProviderError } from "./types.js";

/** Internal transport settings for parsing text chunks from a response body. */
export interface StreamOptions {
  provider: string;
  response: Response;
  signal?: AbortSignal;
  parseLine: (line: string) => string | undefined;
}

/** Read complete protocol lines while preserving provider errors and cancellation. */
export async function* readTextStream(
  options: StreamOptions,
): AsyncGenerator<string> {
  const reader = options.response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (options.signal?.aborted)
        throw (
          options.signal.reason ?? new DOMException("Aborted", "AbortError")
        );
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const text = options.parseLine(line);
        if (text !== undefined && text !== "") yield text;
      }
      if (chunk.done) break;
    }
    if (buffer.trim() !== "") {
      const text = options.parseLine(buffer);
      if (text !== undefined && text !== "") yield text;
    }
  } catch (error) {
    throw classifyProviderError(
      options.provider,
      error,
    ) satisfies ProviderError;
  } finally {
    reader.releaseLock();
  }
}
