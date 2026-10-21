# Contributing

Thanks for helping improve cli-agent-bridge. Please open an issue for a large change before investing in its implementation.

## Development setup

- Use Node.js 20 or 22 and npm.
- Install dependencies with `npm ci`.
- Keep the package ESM and TypeScript strict. Avoid `any` and keep exported APIs documented with JSDoc.
- Use native `fetch` for HTTP; runtime dependencies are limited to the packages listed in `package.json`.

## Before opening a pull request

Run the full local checks:

```sh
npm run lint
npm run typecheck
npm run test
npm run build
```

Add or update unit tests for behavior changes. Provider tests should mock `fetch`; process tests should inject or mock the runner rather than depending on external services.

## Pull requests

- Keep changes focused and explain the user-visible behavior and any tradeoffs.
- Update README, configuration docs, and CHANGELOG when behavior or options change.
- Use Conventional Commit messages such as `feat: add provider timeout` or `fix: redact bearer tokens`.
- Do not commit API keys, generated logs, or local config files.
- Ensure CI passes on both supported Node.js versions.

By submitting a contribution, you agree that it may be distributed under this repository's MIT license.
