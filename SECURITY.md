# Security Policy

SafeHarbor is an early prototype and is not yet a hardened parental-controls system. Do not rely on it as tamper-proof protection.

## Reporting Vulnerabilities

Until a private disclosure address is published, please avoid posting exploitable security details in public issues. Open a minimal issue that says you have a security report to share, without logs, tokens, child data, exploit steps, or private device details.

## Data Handling

- Do not commit local config files, tokens, captures, logs, reports, or exported child activity data.
- Treat browser history, page titles, URLs, selected text, and readable page text as sensitive.
- Prefer test fixtures with synthetic domains and synthetic page content.

## Current Security Boundaries

- The local server binds to `127.0.0.1`.
- Extension requests use a bearer token.
- Local files are written with owner-only file permissions where supported.
- A local administrator can eventually bypass or remove consumer parental controls. Future phases will improve tamper detection and recovery, but the project should continue to document this limitation clearly.

