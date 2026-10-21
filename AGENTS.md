# Contributor instructions

This repository builds `cli-agent-bridge`, an MIT-licensed terminal CLI for local Ollama prompts, one OpenAI-compatible fallback, and audited shell activity.

## Required conventions

- Target Node.js 20 or later. Keep the package ESM and use TypeScript strict mode, `noUncheckedIndexedAccess`, and no `any`.
- Add JSDoc to every exported symbol. Comments should explain why a choice exists rather than restate the code.
- Use native `fetch` for provider HTTP. Do not add provider SDKs or runtime dependencies outside commander, chalk, ora, execa, chokidar, dotenv, and zod without an explicit project decision.
- Keep output pipe-safe: generated response text goes to stdout; status and spinner output go to stderr. Never show spinners for piped output or when `NO_COLOR` is set.
- Keep configuration precedence as CLI flags, environment variables, cwd `.env`, user config at `~/.config/agent-bridge/config.json`, then defaults. Mask API keys except their last four characters and write config with mode `0600`.
- Normalize provider failures to the typed error categories. Fall back for context overflow, refused connections, timeouts, and server errors; retry rate limits before deciding; never fall back on authentication errors.
- Redact sensitive values before writing audit JSONL. Preserve the log fields and size rotation behavior.
- Add focused tests for changed behavior. Mock provider `fetch` and inject process runners so tests do not depend on live services.
- Update README, CHANGELOG, and configuration references when commands, flags, or behavior change.
- Use Conventional Commit messages and keep each planned phase in its own commit.

## Required checks

Run these before a phase commit:

```sh
npm run lint
npm run typecheck
npm run test
npm run build
```
