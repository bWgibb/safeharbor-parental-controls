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
- Activity log: normalized event history used for reporting and parent review.
- Alert: a parent-facing notification generated from important events or repeated patterns.

## Architecture Direction

- Local agent first: keep the current localhost Node.js server as the development foundation.
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

## Near-Term Build Target

The next milestone should turn the current capture prototype into a local controls MVP:

1. Add child profiles and a local policy file.
2. Implement a testable rule engine.
3. Add URL matching and block decisions in the extension.
4. Replace user-triggered capture as the primary flow with passive policy enforcement events.
5. Keep reporting local until the cloud sync model is ready.

