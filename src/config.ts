import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

/** Fully validated runtime configuration. */
export interface Config {
  primary: "ollama" | "openai";
  fallback: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiApiKey?: string | undefined;
  timeoutSeconds: number;
  rateLimitRetries: number;
  logPath: string;
  maxLogBytes: number;
}

/** Values supplied by command-line flags, which take precedence over every other source. */
export type ConfigOverrides = Partial<Config>;

/** Inputs that make configuration loading deterministic in tests and embedded use. */
export interface LoadConfigOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: ConfigOverrides;
}

const ConfigSchema = z.object({
  primary: z.enum(["ollama", "openai"]).default("ollama"),
  fallback: z.boolean().default(true),
  ollamaBaseUrl: z.string().url().default("http://localhost:11434"),
  ollamaModel: z.string().min(1).default("llama3.2"),
  openaiBaseUrl: z.string().url().default("https://api.openai.com/v1"),
  openaiModel: z.string().min(1).default("gpt-4o-mini"),
  openaiApiKey: z.string().optional(),
  timeoutSeconds: z.number().positive().max(3600).default(120),
  rateLimitRetries: z.number().int().min(0).max(8).default(2),
  logPath: z.string().min(1).default(".agent-bridge.log"),
  maxLogBytes: z.number().int().positive().default(5_000_000),
});

type ConfigFile = { [Key in keyof Config]?: Config[Key] | undefined };
const NumericConfigKeys = new Set([
  "timeoutSeconds",
  "rateLimitRetries",
  "maxLogBytes",
]);

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return undefined;
}

function environmentConfig(env: NodeJS.ProcessEnv): ConfigFile {
  const number = (value: string | undefined): number | undefined => {
    if (value === undefined || value.trim() === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const primaryValue = env["AGENT_BRIDGE_PRIMARY"];
  const primary =
    primaryValue === "openai" || primaryValue === "ollama"
      ? primaryValue
      : undefined;
  const fallback = parseBoolean(env["AGENT_BRIDGE_FALLBACK"]);
  const ollamaBaseUrl = env["AGENT_BRIDGE_OLLAMA_BASE_URL"];
  const ollamaModel = env["AGENT_BRIDGE_OLLAMA_MODEL"];
  const openaiBaseUrl = env["AGENT_BRIDGE_OPENAI_BASE_URL"];
  const openaiModel = env["AGENT_BRIDGE_OPENAI_MODEL"];
  const openaiApiKey =
    env["OPENAI_API_KEY"] ?? env["AGENT_BRIDGE_OPENAI_API_KEY"];
  const timeoutSeconds = number(env["AGENT_BRIDGE_TIMEOUT"]);
  const rateLimitRetries = number(env["AGENT_BRIDGE_RATE_LIMIT_RETRIES"]);
  const logPath = env["AGENT_BRIDGE_LOG"];
  const maxLogBytes = number(env["AGENT_BRIDGE_MAX_LOG_BYTES"]);
  return {
    ...(primary !== undefined ? { primary } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
    ...(ollamaBaseUrl !== undefined ? { ollamaBaseUrl } : {}),
    ...(ollamaModel !== undefined ? { ollamaModel } : {}),
    ...(openaiBaseUrl !== undefined ? { openaiBaseUrl } : {}),
    ...(openaiModel !== undefined ? { openaiModel } : {}),
    ...(openaiApiKey !== undefined ? { openaiApiKey } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(rateLimitRetries !== undefined ? { rateLimitRetries } : {}),
    ...(logPath !== undefined ? { logPath } : {}),
    ...(maxLogBytes !== undefined ? { maxLogBytes } : {}),
  };
}

async function readJsonConfig(filePath: string): Promise<ConfigFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return z.record(z.unknown()).parse(parsed) as ConfigFile;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {};
    throw new Error(
      `Could not read config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Return the location of the user's persistent configuration file. */
export function getConfigPath(home = os.homedir()): string {
  return path.join(home, ".config", "agent-bridge", "config.json");
}

/** Load and validate settings using CLI, process environment, cwd .env, user config, then defaults. */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<Config> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  const processEnvironment = options.env ?? process.env;
  const dotEnvPath = path.join(cwd, ".env");
  let dotEnv: NodeJS.ProcessEnv = {};
  try {
    dotEnv = dotenv.parse(await readFile(dotEnvPath));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const persistent = await readJsonConfig(getConfigPath(home));
  const mergedEnvironment = { ...dotEnv, ...processEnvironment };
  return ConfigSchema.parse({
    ...persistent,
    ...environmentConfig(mergedEnvironment),
    ...options.overrides,
  });
}

/** Persist one validated setting while enforcing private file permissions. */
export async function writeConfig(
  values: ConfigFile,
  home = os.homedir(),
): Promise<string> {
  const filePath = getConfigPath(home);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await readJsonConfig(filePath);
  const validated = ConfigSchema.parse({ ...existing, ...values });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
  return filePath;
}

/** Remove persisted values so the next load uses environment variables and defaults. */
export async function resetConfig(home = os.homedir()): Promise<void> {
  const filePath = getConfigPath(home);
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
}

/** Validate and persist one setting supplied as a command-line string. */
export async function setConfigValue(
  key: string,
  rawValue: string,
  home = os.homedir(),
): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(ConfigSchema.shape, key)) {
    throw new Error(`Unknown setting: ${key}`);
  }
  let value: unknown = rawValue;
  if (NumericConfigKeys.has(key)) {
    value = Number(rawValue);
    if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
  } else if (key === "fallback") {
    const parsed = parseBoolean(rawValue);
    if (parsed === undefined) throw new Error("fallback must be true or false");
    value = parsed;
  }
  const values = ConfigSchema.partial().parse({ [key]: value });
  await writeConfig(values, home);
}

/** Mask a credential while retaining only its final four characters. */
export function maskSecret(secret: string | undefined): string | undefined {
  if (secret === undefined) return undefined;
  if (secret.length <= 4) return "*".repeat(secret.length);
  return `${"*".repeat(Math.max(4, secret.length - 4))}${secret.slice(-4)}`;
}
