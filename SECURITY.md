# Security policy

## Supported versions

Security fixes are currently provided for the latest release on the `main` branch. Once stable releases are available, this section will identify supported release lines.

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues. Use GitHub's private vulnerability reporting for this repository when it is enabled. Otherwise, contact the maintainers privately through the email address on the GitHub profile that owns the repository. Include the affected version, reproduction steps, and impact. Avoid including real credentials; use test values.

We will acknowledge reports as soon as practical, investigate privately, and coordinate a fix and disclosure with the reporter.

## Security-sensitive behavior

- Prefer `OPENAI_API_KEY` in the environment; config-file keys are plaintext and trigger a warning.
- Config and audit log files are created with owner-only permissions where supported.
- `watch --cmd` executes the supplied shell command in the current working directory. Only run commands you trust.
- Audit logs redact common key, token, password, authorization, and credential formats, but should still be treated as local diagnostic data.
