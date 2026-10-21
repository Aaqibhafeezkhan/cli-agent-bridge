import { appendFile, chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

function isSensitiveName(name: string): boolean {
  return /(?:^|[_-])(?:[A-Z0-9]*_)?(?:API_)?KEY(?:[_-]|$)|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|SESSION|IDENTITY|PASSPHRASE/i.test(
    name,
  );
}

/** One shell invocation recorded in the audit log. */
export interface AuditEntry {
  timestamp: string;
  cwd: string;
  command: string;
  exitCode: number;
  durationMs: number;
  trigger: string;
  errorSummary: string;
  stderrTail: string;
  env: Record<string, string>;
}

/** Remove credential-like values from free-form text before it reaches a log. */
export function redactText(value: string): string {
  return value
    .replace(
      /(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,"']+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s,"']+/gi, "Bearer [REDACTED]")
    .replace(
      /([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_.-]*)\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9_-]{12,})\b/g,
      "[REDACTED]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[REDACTED]",
    );
}

/** Return environment values with secret-bearing variable names fully masked. */
export function redactEnvironment(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    redacted[key] = isSensitiveName(key) ? "[REDACTED]" : redactText(value);
  }
  return redacted;
}

function tail(value: string, cap: number): string {
  const clean = redactText(value.replaceAll("\r", ""));
  return clean.length > cap ? clean.slice(-cap) : clean;
}

/** Serialize an audit entry as one sanitized JSON object without a trailing newline. */
export function formatAuditEntry(entry: AuditEntry): string {
  const safeEnvironment: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.env)) {
    safeEnvironment[key] = isSensitiveName(key)
      ? "[REDACTED]"
      : redactText(value);
  }
  return JSON.stringify({
    timestamp: entry.timestamp,
    cwd: redactText(entry.cwd),
    command: redactText(entry.command),
    exitCode: entry.exitCode,
    durationMs: Math.max(0, Math.round(entry.durationMs)),
    trigger: redactText(entry.trigger),
    errorSummary: redactText(entry.errorSummary),
    stderrTail: tail(entry.stderrTail, 4_000),
    env: safeEnvironment,
  });
}

/** Append a JSONL entry, rotating the prior log to `.1` when the size limit is reached. */
export async function appendAuditLog(
  filePath: string,
  entry: AuditEntry,
  maxBytes: number,
): Promise<void> {
  const destination = path.resolve(filePath);
  const line = `${formatAuditEntry(entry)}\n`;
  await mkdir(path.dirname(destination), { recursive: true });
  let currentSize = 0;
  try {
    currentSize = (await stat(destination)).size;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  if (currentSize > 0 && currentSize + Buffer.byteLength(line) > maxBytes) {
    const rotatedPath = `${destination}.1`;
    await rm(rotatedPath, { force: true });
    await rename(destination, rotatedPath);
  }
  await appendFile(destination, line, { encoding: "utf8", mode: 0o600 });
  await chmod(destination, 0o600);
}

/** Extract a short error summary from stderr or report a nonzero process status. */
export function summarizeErrorOutput(stderr: string, exitCode: number): string {
  const clean = stderr.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const lines = clean.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    /\b(?:error|panic)\s*:|\btraceback\b|\bfatal error\b|\bstack[- ]trace\b|^\s*at\s+.+:\d+(?::\d+)?\)?\s*$/i.test(
      line,
    ),
  );
  if (start >= 0)
    return tail(
      lines
        .slice(start, start + 5)
        .join("\n")
        .trim(),
      500,
    );
  if (exitCode !== 0) return `Process exited with code ${exitCode}`;
  return "";
}
