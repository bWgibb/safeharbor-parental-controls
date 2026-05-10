# SafeHarbor Foundation

This document captures the phase 1 product foundation so future implementation work has a stable reference.

## Core Product Model

- Parent account: the adult account that manages children, policies, devices, reports, and alerts.
- Child profile: the person receiving policies. Policies should attach primarily to profiles, then apply across assigned devices.
- Device: a managed computer, phone, or tablet with enrollment state, assigned child profile, platform, hostname, last-seen status, and agent version.
- Browser extension: the browser-level observer and enforcement surface for URL/page controls.
- Local agent: the localhost service that stores local config, receives extension events, applies local policy support, and syncs with the cloud later.
- Policy: a versioned set of rules, schedules, category decisions, override rules, and defaults.
- Event: a timestamped fact from a device or extension, such as page allowed, page blocked, override requested, agent started, extension disabled, or policy applied.
- Activity log: normalized event history used for reporting and parent review. Store this in SQLite by default.
- Alert: a parent-facing notification generated from important events or repeated patterns.

## Architecture Direction

- Local agent first: keep the current localhost Node.js server as the development foundation.
- Windows target, macOS development loop: build core behavior so it can run and be tested on macOS, then validate Windows-specific installation, startup, permissions, Edge/Chrome deployment, child-account behavior, and tamper resistance on Windows.
- Browser enforcement first: Chrome is the first target, with Edge and Firefox later.
- Cloud API later: sync policies down and activity up after local policy enforcement is useful.
- Parent dashboard: build as a responsive web app that works well on mobile before considering native mobile apps.
- Native helper later: add stronger service installation, watchdog, and tamper detection after the policy model is stable.

## Phase 1 Decisions

- Product name: SafeHarbor.
- Suggested public repository name: `safeharbor-parental-controls`.
- Local default data directory: `~/.safeharbor/local-agent`.
- Local override environment variable: `SAFEHARBOR_HOME`.
- Current server entrypoint: `server/safeharbor-server.js`.
- Current browser extension: Manifest V3 Chrome extension in `extension/`.
- Current trust model: localhost-only server plus bearer token between extension and server.
- Storage direction: use SQLite for structured local activity/events. Keep Markdown only as an optional debug/export format for manually triggered snapshots.
- Testing direction: use macOS for fast local development and Windows for release validation. Add GitHub Actions Windows coverage as soon as script and packaging behavior become important.

## Near-Term Build Target

The next milestone should turn the current capture prototype into a local controls MVP:

1. Establish the platform-neutral development loop.
2. Add the local SQLite event store. Completed in Phase 2.
3. Add child profiles and local policy. Completed in Phase 2.
4. Implement the testable rule engine. Completed in Phase 2.
5. Add browser enforcement. Completed in Phase 2.
6. Add local reporting. Completed in Phase 2.
7. Harden the local agent for local MVP testing. Completed in Phase 2.

The detailed Phase 2 goal structure and acceptance criteria live in [ROADMAP.md](../ROADMAP.md).

## Storage Policy

- Use SQLite as the source of truth for local events and reporting.
- Store URLs, domains, timestamps, profile/device identifiers, policy decision IDs, categories, and alert/tamper signals as structured data.
- Do not store full page text by default. Full content should require an explicit feature decision and privacy review.
- Keep Markdown for optional debug bundles, parent-requested exports, or manually triggered page/selection snapshots.

## Testing Policy

- Keep local agent, SQLite store, rule engine, API routes, reporting queries, dashboard, and Chrome extension behavior portable enough to test on macOS.
- Validate Windows scheduled tasks or services, installer behavior, filesystem permissions, Edge/Chrome policy deployment, child-account behavior, tamper signals, and uninstall/re-enrollment on Windows.
- Use GitHub Actions Windows runners for repeatable checks before relying on a real Windows device for final validation.
