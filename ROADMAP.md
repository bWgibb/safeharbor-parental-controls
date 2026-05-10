# SafeHarbor Roadmap

SafeHarbor is currently an early functional prototype: a Chrome extension talks to a localhost Node.js server, authenticates with a local token, and writes browser captures to local Markdown files. The core parental-controls product still needs policy enforcement, accounts, parent dashboards, reporting, sync, alerts, and stronger tamper resistance.

## Phase 1: Product Foundation

Status: completed in the initial foundation pass. See [docs/FOUNDATION.md](docs/FOUNDATION.md).

- [x] Rename and package the current app as SafeHarbor.
- [x] Rename extension UI, manifest, package metadata, README, startup scripts, and scheduled task names.
- [x] Choose the suggested public repository name: `safeharbor-parental-controls`.
- [x] Add public repository hygiene: license, contribution notes, `.gitignore`, security policy, and no committed secrets.
- [x] Define the core model: parent accounts, child profiles, devices, browser extensions, policies, events, activity logs, and alerts.
- [x] Pick the architecture:
  - Local agent: runs on the child machine.
  - Browser extension: observes and enforces browser activity.
  - Cloud API: syncs policy, reports activity, and sends alerts.
  - Parent dashboard: web/mobile interface.
  - Optional native helper: stronger tamper resistance in later phases.

## Phase 2: Core Controls MVP

- Build a rule engine for allow lists, block lists, category rules, time schedules, per-child policies, per-device policies, temporary overrides, and default allow/block behavior.
- Add browser enforcement that can block matching URLs before page load where possible.
- Show a SafeHarbor block page with the rule reason and parent-approved override flow.
- Log blocked and allowed visits.
- Capture page metadata without storing excessive private content by default.
- Harden the local server with better extension-to-server auth, token rotation, config validation, structured logs, crash recovery, health checks, and automatic startup on Windows/macOS.

## Phase 3: Parent Dashboard

- Build a mobile-friendly parent dashboard.
- Include child profile lists, device status, recent activity, blocked attempts, rules editor, schedules editor, alert preferences, and temporary allow/deny actions.
- Add reporting: daily and weekly summaries, top domains, blocked categories, estimated online time, attempts outside schedule, exportable reports, and privacy controls for stored browsing detail.
- Add alerts by email first, then push notifications later.
- Alert on blocked attempts, tamper signals, offline agents, repeated risky searches/domains, and schedule violations.

## Phase 4: Accounts, Sync, and Deployment

- Add parent account auth with secure sessions, password reset, optional MFA, and support for multiple parents or guardians.
- Add device enrollment with pairing codes, device names, child assignment, last-seen status, revocation, and re-enrollment handling.
- Add cloud sync so agents pull policies, upload activity/events, cache while offline, handle conflicts, and apply versioned policy updates.

## Phase 5: Tamper Resistance

- Add basic tamper signals: extension disabled or uninstalled, local server stopped, agent not seen recently, token/config changed, stale policy, or missing browser permissions.
- Add stronger desktop protection with a native background service, OS login startup, watchdog restart, signed binaries eventually, and parent/admin uninstall token.
- Document the limitation that a local administrator can eventually bypass most consumer controls.
- Expand browser coverage from Chrome to Edge, then Firefox.
- Detect unsupported browsers.
- Consider OS-level DNS or proxy filtering later for broader coverage.

## Phase 6: Public Repo Readiness

- Add and maintain `SECURITY.md`, `LICENSE`, `CONTRIBUTING.md`, issue templates, GitHub Actions checks, and dependency scanning.
- Document the threat model and limitations honestly.
- Keep deployment secrets out of the repository.
- Add CI for Node syntax checks, rule-engine unit tests, API integration tests, extension tests where practical, end-to-end browser tests for allow/block flows, and release builds.

## Recommended Build Order

1. Rename to SafeHarbor.
2. Add this roadmap.
3. Build the rule engine locally.
4. Add real blocking in the extension.
5. Add child profiles and policies.
6. Add local reporting.
7. Add the cloud API and parent dashboard.
8. Add enrollment and sync.
9. Add alerts.
10. Harden tamper detection and deployment.
