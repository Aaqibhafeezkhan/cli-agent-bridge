import { watch as chokidarWatch } from "chokidar";
import path from "node:path";
import {
  appendAuditLog,
  redactEnvironment,
  summarizeErrorOutput,
} from "./utils/logger.js";
import {
  runShellCommand,
  type ShellCommandOptions,
  type ShellCommandResult,
} from "./executor.js";

/** A shell runner used by watch mode; injection keeps command execution testable. */
export type ShellRunner = (
  command: string,
  options?: ShellCommandOptions,
) => Promise<ShellCommandResult>;

/** Settings for one audited shell command. */
export interface RunAndLogOptions {
  command: string;
  logPath: string;
  maxLogBytes: number;
  cwd?: string;
  trigger: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  runner?: ShellRunner;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
}

/** Run a command, tee output, and append its structured result to the audit log. */
export async function runAndLog(
  options: RunAndLogOptions,
): Promise<ShellCommandResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const runner = options.runner ?? runShellCommand;
  const result = await runner(options.command, {
    cwd,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.stdout ? { onStdout: options.stdout } : {}),
    ...(options.stderr ? { onStderr: options.stderr } : {}),
  });
  await appendAuditLog(
    options.logPath,
    {
      timestamp: new Date().toISOString(),
      cwd,
      command: options.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      trigger: options.trigger,
      errorSummary: summarizeErrorOutput(result.stderr, result.exitCode),
      stderrTail: result.stderr,
      env: redactEnvironment(env),
    },
    options.maxLogBytes,
  );
  return result;
}

/** Run once or watch file globs and serialize debounced command reruns. */
export async function runWatch(options: {
  command: string;
  paths?: string[];
  logPath: string;
  maxLogBytes: number;
  cwd?: string;
  signal: AbortSignal;
  debounceMs?: number;
  runner?: ShellRunner;
}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const execute = async (trigger: string): Promise<number> => {
    try {
      const result = await runAndLog({
        command: options.command,
        logPath: options.logPath,
        maxLogBytes: options.maxLogBytes,
        cwd,
        trigger,
        signal: options.signal,
        ...(options.runner ? { runner: options.runner } : {}),
        stdout: (chunk) => process.stdout.write(chunk),
        stderr: (chunk) => process.stderr.write(chunk),
      });
      return result.exitCode;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Could not run or audit command: ${message}\n`);
      return 1;
    }
  };

  const patterns = options.paths ?? [];
  if (patterns.length === 0) return execute("manual");

  const watcher = chokidarWatch(patterns, { cwd, ignoreInitial: true });
  const debounceMs = options.debounceMs ?? 350;
  let timer: NodeJS.Timeout | undefined;
  let runQueue: Promise<void> = Promise.resolve();
  const enqueue = (trigger: string): void => {
    runQueue = runQueue.then(
      async () => {
        if (!options.signal.aborted) await execute(trigger);
      },
      async () => {
        if (!options.signal.aborted) await execute(trigger);
      },
    );
  };
  const schedule = (trigger: string): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => enqueue(trigger), debounceMs);
  };
  watcher.on("all", (event, filePath) =>
    schedule(`${event}: ${path.relative(cwd, path.resolve(cwd, filePath))}`),
  );
  watcher.on("error", (error) =>
    process.stderr.write(`Watch error: ${String(error)}\n`),
  );
  enqueue("initial");

  if (options.signal.aborted) {
    if (timer) clearTimeout(timer);
    await watcher.close();
    await runQueue;
    return 130;
  }
  await new Promise<void>((resolve) =>
    options.signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  if (timer) clearTimeout(timer);
  await watcher.close();
  await runQueue;
  return 130;
}
