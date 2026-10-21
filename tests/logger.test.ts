import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendAuditLog,
  formatAuditEntry,
  redactEnvironment,
  summarizeErrorOutput,
  type AuditEntry,
} from "../src/utils/logger.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-log-"));
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

function sampleEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: "2026-10-22T08:00:00.000Z",
    cwd: "/tmp/project",
    command: "npm test",
    exitCode: 1,
    durationMs: 12.7,
    trigger: "manual",
    errorSummary: "Error: request failed",
    stderrTail: "Error: request failed",
    env: { OPENAI_API_KEY: "sk-test-secret-key-123456", NODE_ENV: "test" },
    ...overrides,
  };
}

describe("JSONL logger", () => {
  it("formats sanitized structured log fields and redacts credentials", () => {
    const formatted = formatAuditEntry(
      sampleEntry({
        command: "curl --header 'Authorization: Bearer abcdef123456789'",
        stderrTail: `Error: API_KEY=sk-test-secret-key-123456\n${"x".repeat(4_100)}`,
      }),
    );
    const parsed: unknown = JSON.parse(formatted);
    const record = parsed as Record<string, unknown>;

    expect(record).toMatchObject({
      timestamp: "2026-10-22T08:00:00.000Z",
      command: "curl --header 'Authorization: [REDACTED]'",
      exitCode: 1,
      durationMs: 13,
    });
    expect((record["env"] as Record<string, string>)["OPENAI_API_KEY"]).toBe(
      "[REDACTED]",
    );
    expect((record["stderrTail"] as string).length).toBeLessThanOrEqual(4_000);
    expect(formatted).not.toContain("secret-key");
  });

  it("redacts environment variable values and credential-like values", () => {
    expect(
      redactEnvironment({
        API_TOKEN: "token-value",
        AWS_ACCESS_KEY_ID: "AKIA1234567890123456",
        CODEX_SESSION_ID: "session-value",
        SAFE_VALUE: "Bearer abcdef123456789",
      }),
    ).toEqual({
      API_TOKEN: "[REDACTED]",
      AWS_ACCESS_KEY_ID: "[REDACTED]",
      CODEX_SESSION_ID: "[REDACTED]",
      SAFE_VALUE: "Bearer [REDACTED]",
    });
  });

  it("summarizes common stack and panic traces and nonzero exits", () => {
    expect(
      summarizeErrorOutput(
        'Traceback (most recent call last):\n  File "x.py"',
        1,
      ),
    ).toContain("Traceback");
    expect(summarizeErrorOutput("panic: failure", 1)).toBe("panic: failure");
    expect(summarizeErrorOutput("", 17)).toBe("Process exited with code 17");
    expect(summarizeErrorOutput("normal output", 0)).toBe("");
  });

  it("writes one JSON object per line and rotates at the configured size", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = path.join(directory, ".agent-bridge.log");
    await appendAuditLog(filePath, sampleEntry(), 1);
    await appendAuditLog(
      filePath,
      sampleEntry({ trigger: "change: src/main.ts" }),
      1,
    );

    const active = (await readFile(filePath, "utf8")).trim().split("\n");
    const rotated = (await readFile(`${filePath}.1`, "utf8"))
      .trim()
      .split("\n");
    expect(active).toHaveLength(1);
    expect(rotated).toHaveLength(1);
    expect(JSON.parse(active[0] ?? "{}")).toMatchObject({
      trigger: "change: src/main.ts",
    });
    expect(JSON.parse(rotated[0] ?? "{}")).toMatchObject({ trigger: "manual" });
  });
});
