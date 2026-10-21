import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAndLog, type ShellRunner } from "../src/watch.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "agent-bridge-watch-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("watch process audit", () => {
  it("tees mocked process output and logs a redacted JSONL result", async () => {
    const directory = await createTemporaryDirectory();
    const logPath = path.join(directory, "audit.jsonl");
    const stdout = vi.fn();
    const stderr = vi.fn();
    const runner: ShellRunner = async (_command, options) => {
      options?.onStdout?.("test output\n");
      options?.onStderr?.("Error: request failed with token=private-value\n");
      return {
        stdout: "test output\n",
        stderr: "Error: request failed with token=private-value\n",
        exitCode: 1,
        durationMs: 45,
      };
    };

    const result = await runAndLog({
      command: "npm test",
      cwd: directory,
      logPath,
      maxLogBytes: 1_000_000,
      trigger: "manual",
      env: { API_TOKEN: "hidden-value", NODE_ENV: "test" },
      runner,
      stdout,
      stderr,
    });
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;

    expect(result.exitCode).toBe(1);
    expect(stdout).toHaveBeenCalledWith("test output\n");
    expect(stderr).toHaveBeenCalledWith(
      "Error: request failed with token=private-value\n",
    );
    expect(lines).toHaveLength(1);
    expect(entry).toMatchObject({
      command: "npm test",
      exitCode: 1,
      trigger: "manual",
      errorSummary: "Error: request failed with token=[REDACTED]",
      env: { API_TOKEN: "[REDACTED]", NODE_ENV: "test" },
    });
    expect(lines[0]).not.toContain("hidden-value");
    expect(lines[0]).not.toContain("private-value");
  });
});
