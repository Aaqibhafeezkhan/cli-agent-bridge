import chalk from "chalk";
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import ora from "ora";
import { ZodError } from "zod";
import {
  getConfigPath,
  loadConfig,
  maskSecret,
  resetConfig,
  setConfigValue,
  writeConfig,
  type Config,
} from "./config.js";
import { executePrompt } from "./executor.js";
import {
  OllamaProvider,
  OpenAIProvider,
  ProviderError,
} from "./providers/index.js";
import { runWatch } from "./watch.js";

interface ExecOptions {
  fallback?: boolean;
  primary?: "ollama" | "openai";
  model?: string;
  timeout?: number;
  json?: boolean;
  stream?: boolean;
}

interface WatchOptions {
  cmd?: string;
  paths?: string[];
  log?: string;
}

const ConfigKeys = new Set<keyof Config>([
  "primary",
  "fallback",
  "ollamaBaseUrl",
  "ollamaModel",
  "openaiBaseUrl",
  "openaiModel",
  "openaiApiKey",
  "timeoutSeconds",
  "rateLimitRetries",
  "logPath",
  "maxLogBytes",
]);

async function writeLine(
  stream: NodeJS.WriteStream,
  text: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

async function readPromptFromStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin)
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
  return chunks.join("").trimEnd();
}

function warnAboutPlaintextKey(
  config: Config,
  stderr: NodeJS.WriteStream,
): void {
  const keyFromEnvironment =
    process.env["OPENAI_API_KEY"] ?? process.env["AGENT_BRIDGE_OPENAI_API_KEY"];
  if (config.openaiApiKey && !keyFromEnvironment) {
    stderr.write(
      chalk.yellow(
        "Warning: an OpenAI key is loaded from a plaintext file. Prefer OPENAI_API_KEY in your shell.\n",
      ),
    );
  }
}

async function execPrompt(
  promptArgument: string | undefined,
  options: ExecOptions,
  signal: AbortSignal,
): Promise<number> {
  let prompt = promptArgument;
  if (prompt === undefined && !process.stdin.isTTY)
    prompt = await readPromptFromStdin();
  if (!prompt?.trim()) {
    process.stderr.write(
      "Provide a prompt as an argument or pipe it on stdin.\n",
    );
    return 2;
  }

  let config: Config;
  try {
    config = await loadConfig({
      overrides: {
        ...(options.primary ? { primary: options.primary } : {}),
        ...(options.timeout !== undefined
          ? { timeoutSeconds: options.timeout }
          : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${chalk.red(`Configuration error: ${message}`)}\n`);
    return 2;
  }
  warnAboutPlaintextKey(config, process.stderr);

  const primaryName = options.primary ?? config.primary;
  const ollama = new OllamaProvider({
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaModel,
  });
  const openai = new OpenAIProvider({
    baseUrl: config.openaiBaseUrl,
    model: config.openaiModel,
    ...(config.openaiApiKey ? { apiKey: config.openaiApiKey } : {}),
  });
  const primary = primaryName === "ollama" ? ollama : openai;
  const fallbackProvider = primaryName === "ollama" ? openai : ollama;
  const primaryModel =
    options.model ??
    (primaryName === "ollama" ? config.ollamaModel : config.openaiModel);
  const fallbackModel =
    primaryName === "ollama" ? config.openaiModel : config.ollamaModel;
  const canSpin =
    process.stdout.isTTY === true &&
    process.stderr.isTTY === true &&
    !("NO_COLOR" in process.env);
  const spinner = ora({
    text: `Waiting for ${primary.name} (${primaryModel})...`,
    stream: process.stderr,
    isEnabled: canSpin,
  });
  const useStream = options.stream !== false && options.json !== true;
  let outputStarted = false;
  spinner.start();

  try {
    const result = await executePrompt({
      prompt,
      primary,
      primaryModel,
      fallbackProvider,
      fallbackModel,
      fallbackEnabled: config.fallback,
      forceCloudFirst: options.fallback === true,
      timeoutSeconds: config.timeoutSeconds,
      rateLimitRetries: config.rateLimitRetries,
      signal,
      onChunk: async (chunk) => {
        if (!useStream) return;
        if (!outputStarted) {
          outputStarted = true;
          spinner.stop();
        }
        await writeLine(process.stdout, chunk);
      },
      onRetry: ({ provider, attempt, delayMs }) => {
        spinner.stop();
        process.stderr.write(
          chalk.yellow(
            `⚠ ${provider.name} rate limited; retry ${attempt} in ${delayMs} ms.\n`,
          ),
        );
        spinner.start();
      },
      onFallback: ({ error, from, to, model, partialOutput }) => {
        spinner.stop();
        const partial = partialOutput ? " after partial output" : "";
        const status = `⚠ primary (${from.name}) failed: ${error.kind}${partial} → falling back to ${to.name} (${model})`;
        process.stderr.write(`${chalk.yellow(status)}\n`);
        spinner.text = `Waiting for ${to.name} (${model})...`;
        spinner.start();
      },
    });
    spinner.stop();

    if (options.json) {
      await writeLine(process.stdout, `${JSON.stringify(result)}\n`);
    } else if (!useStream) {
      await writeLine(
        process.stdout,
        `${result.text}${result.text.endsWith("\n") || result.text.length === 0 ? "" : "\n"}`,
      );
    } else if (result.text.length > 0 && !result.text.endsWith("\n")) {
      await writeLine(process.stdout, "\n");
    }
    return 0;
  } catch (error) {
    spinner.stop();
    if (signal.aborted) {
      process.stderr.write("Interrupted.\n");
      return 130;
    }
    if (error instanceof ZodError) {
      process.stderr.write(
        `${chalk.red(`Configuration error: ${error.message}`)}\n`,
      );
      return 2;
    }
    const message =
      error instanceof ProviderError
        ? `${error.provider}: ${error.kind}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    process.stderr.write(`${chalk.red(`Request failed: ${message}`)}\n`);
    return 1;
  }
}

async function configCommand(
  action: "set" | "get" | "list" | "path" | "reset" | "init",
  args: string[],
): Promise<number> {
  try {
    if (action === "path") {
      process.stdout.write(`${getConfigPath()}\n`);
      return 0;
    }
    if (action === "reset") {
      await resetConfig();
      process.stdout.write("Configuration reset.\n");
      return 0;
    }
    if (action === "set") {
      const [key, value] = args;
      if (!key || value === undefined || !ConfigKeys.has(key as keyof Config)) {
        process.stderr.write(
          "Use config set <key> <value> with a known setting name.\n",
        );
        return 2;
      }
      await setConfigValue(key, value);
      if (key === "openaiApiKey") {
        process.stderr.write(
          chalk.yellow(
            "Warning: this stores the API key in plaintext; prefer OPENAI_API_KEY in your shell.\n",
          ),
        );
      }
      process.stdout.write(`Updated ${key}.\n`);
      return 0;
    }
    if (action === "get") {
      const [key] = args;
      if (!key || !ConfigKeys.has(key as keyof Config)) {
        process.stderr.write(
          "Use config get <key> with a known setting name.\n",
        );
        return 2;
      }
      const config = await loadConfig();
      warnAboutPlaintextKey(config, process.stderr);
      const value = config[key as keyof Config];
      const displayed =
        key === "openaiApiKey"
          ? (maskSecret(typeof value === "string" ? value : undefined) ??
            "not set")
          : String(value);
      process.stdout.write(`${displayed}\n`);
      return 0;
    }
    if (action === "list") {
      const config = await loadConfig();
      warnAboutPlaintextKey(config, process.stderr);
      const displayed = {
        ...config,
        ...(config.openaiApiKey
          ? { openaiApiKey: maskSecret(config.openaiApiKey) }
          : {}),
      };
      process.stdout.write(`${JSON.stringify(displayed, null, 2)}\n`);
      return 0;
    }

    if (!process.stdin.isTTY) {
      process.stderr.write("config init requires an interactive terminal.\n");
      return 2;
    }
    const current = await loadConfig();
    const terminal = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      const answer = async (
        label: string,
        fallback: string,
      ): Promise<string> => {
        const raw = await terminal.question(`${label} [${fallback}]: `);
        return raw.trim() || fallback;
      };
      const primaryText = await answer(
        "Primary provider (ollama/openai)",
        current.primary,
      );
      const primary =
        primaryText === "openai"
          ? "openai"
          : primaryText === "ollama"
            ? "ollama"
            : undefined;
      if (!primary)
        throw new Error("Primary provider must be ollama or openai");
      const ollamaModel = await answer("Ollama model", current.ollamaModel);
      const openaiModel = await answer("OpenAI model", current.openaiModel);
      const openaiBaseUrl = await answer(
        "OpenAI-compatible base URL",
        current.openaiBaseUrl,
      );
      const timeoutSeconds = Number(
        await answer("Timeout in seconds", String(current.timeoutSeconds)),
      );
      const fallbackText = await answer(
        "Automatic fallback enabled (true/false)",
        String(current.fallback),
      );
      const fallback =
        fallbackText === "true"
          ? true
          : fallbackText === "false"
            ? false
            : undefined;
      if (fallback === undefined)
        throw new Error("Fallback must be true or false");
      await writeConfig({
        primary,
        ollamaModel,
        openaiModel,
        openaiBaseUrl,
        timeoutSeconds,
        fallback,
      });
      process.stdout.write(
        `Configuration saved to ${getConfigPath()}.\nSet OPENAI_API_KEY in your shell to enable OpenAI requests.\n`,
      );
      return 0;
    } finally {
      terminal.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${chalk.red(`Configuration error: ${message}`)}\n`);
    return 2;
  }
}

/** Run the CLI and return its documented process exit code. */
export async function main(argv: string[] = process.argv): Promise<number> {
  const controller = new AbortController();
  const interrupt = (): void =>
    controller.abort(new DOMException("Interrupted", "AbortError"));
  process.once("SIGINT", interrupt);
  const program = new Command();
  let commandExitCode = 0;
  program
    .name("cli-agent-bridge")
    .description(
      "Run prompts against local Ollama with OpenAI fallback and audit shell activity.",
    )
    .version("0.1.0")
    .showHelpAfterError()
    .configureOutput({
      writeOut: (text) => process.stdout.write(text),
      writeErr: (text) => process.stderr.write(text),
    })
    .exitOverride();

  program
    .command("exec")
    .description("Send a prompt to a provider and stream its response")
    .argument("[prompt]", "prompt text; reads stdin when piped")
    .option(
      "--fallback",
      "start with OpenAI, then use the primary provider if needed",
    )
    .addOption(
      new Option("--primary <name>", "primary provider").choices([
        "ollama",
        "openai",
      ]),
    )
    .option("--model <model>", "override the selected provider model")
    .option("--timeout <seconds>", "request timeout in seconds", (value) => {
      const timeout = Number(value);
      if (!Number.isFinite(timeout) || timeout <= 0)
        throw new InvalidArgumentError("timeout must be a positive number");
      return timeout;
    })
    .option("--json", "write the final response and provider metadata as JSON")
    .option("--no-stream", "buffer the response before writing it")
    .action(async (prompt: string | undefined, options: ExecOptions) => {
      commandExitCode = await execPrompt(prompt, options, controller.signal);
    });

  const config = program
    .command("config")
    .description("Read and manage persistent configuration");
  config
    .command("set")
    .description("Set one configuration value")
    .argument("<key>")
    .argument("<value>")
    .action(async (key: string, value: string) => {
      commandExitCode = await configCommand("set", [key, value]);
    });
  config
    .command("get")
    .description("Get one configuration value")
    .argument("<key>")
    .action(async (key: string) => {
      commandExitCode = await configCommand("get", [key]);
    });
  config
    .command("list")
    .description("List effective settings with secrets masked")
    .action(async () => {
      commandExitCode = await configCommand("list", []);
    });
  config
    .command("path")
    .description("Print the persistent configuration path")
    .action(async () => {
      commandExitCode = await configCommand("path", []);
    });
  config
    .command("reset")
    .description("Remove persistent configuration")
    .action(async () => {
      commandExitCode = await configCommand("reset", []);
    });
  config
    .command("init")
    .description("Interactively create configuration")
    .action(async () => {
      commandExitCode = await configCommand("init", []);
    });

  program
    .command("watch")
    .description(
      "Run a shell command once or rerun it when watched paths change",
    )
    .option("--cmd <command>", "shell command to run")
    .option(
      "--paths <glob...>",
      "watch globs and rerun the command when files change",
    )
    .option("--log <file>", "JSONL audit log path")
    .action(async (options: WatchOptions) => {
      if (!options.cmd && !options.paths?.length) {
        process.stderr.write(
          "Use watch --cmd <command> or watch --paths <glob...>.\n",
        );
        commandExitCode = 2;
        return;
      }
      try {
        const loaded = await loadConfig();
        commandExitCode = await runWatch({
          command: options.cmd ?? "npm test",
          ...(options.paths ? { paths: options.paths } : {}),
          logPath: options.log ?? loaded.logPath,
          maxLogBytes: loaded.maxLogBytes,
          signal: controller.signal,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${chalk.red(`Watch failed: ${message}`)}\n`);
        commandExitCode = controller.signal.aborted ? 130 : 1;
      }
    });

  try {
    await program.parseAsync(argv);
    return controller.signal.aborted ? 130 : commandExitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    if (controller.signal.aborted) return 130;
    process.stderr.write(
      `${chalk.red(error instanceof Error ? error.message : String(error))}\n`,
    );
    return error instanceof ZodError ? 2 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}

export * from "./config.js";
export * from "./executor.js";
export * from "./providers/index.js";
export * from "./utils/logger.js";
export * from "./watch.js";
