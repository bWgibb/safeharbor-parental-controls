# SafeHarbor Roadmap

SafeHarbor is currently an early functional prototype: a Chrome extension talks to a localhost Node.js server, authenticates with a local token, and writes browser captures to local Markdown files. The next storage target is SQLite for structured local activity/events, with Markdown kept only for optional debug or export captures. The core parental-controls product still needs policy enforcement, accounts, parent dashboards, reporting, sync, alerts, and stronger tamper resistance.

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

Status: completed for the local MVP. Remaining Windows release validation continues in later deployment and tamper-resistance phases.

Phase 2 should produce a local, testable parental-controls MVP that works on macOS for development and is ready for Windows validation.

**Goal 2.1: Platform-Neutral Development Loop**
Outcome: core controls can be built and tested on macOS while Windows remains the primary deployment target.

Done:
- [x] The local agent, SQLite store, rule engine, API routes, reporting queries, and Chrome extension behavior run on macOS.
- [x] Windows-only behavior is isolated behind scripts or small platform modules.
- [x] GitHub Actions has at least one Windows runner job for checks and script validation.

**Goal 2.2: Local Data Model and SQLite Store**
Outcome: SafeHarbor has a structured local event store for policy history and reporting.

Done:
- [x] SQLite stores visits, blocks, policy decisions, override requests, tamper signals, device status, timestamps, domains, categories, child profile IDs, and device IDs.
- [x] Markdown output is only an optional debug/export path for manually triggered page or selection snapshots.
- [x] Full page text is not stored by default.
- [x] Database migrations or schema initialization are repeatable and covered by tests.

**Goal 2.3: Child Profiles and Local Policy**
Outcome: policies can be assigned to child profiles and evaluated locally.

Done:
- [x] A local profile model exists for at least one child profile and one managed device.
- [x] Policies support allow lists, block lists, schedules, categories, per-child rules, per-device rules, temporary overrides, and a default allow/block mode.
- [x] Policy files or database records are validated before use.
- [x] Invalid policy config fails clearly without crashing the agent.

**Goal 2.4: Rule Engine**
Outcome: URL and schedule decisions are deterministic, testable, and independent of browser UI code.

Done:
- [x] The rule engine accepts URL, timestamp, child profile, device, and policy inputs.
- [x] It returns allow/block decisions with rule IDs, reasons, and enough metadata for reporting.
- [x] Unit tests cover exact domain matches, subdomains, paths, schedules, overrides, default behavior, and conflict precedence.
- [x] Rule decisions do not require network access.

**Goal 2.5: Browser Enforcement**
Outcome: Chrome can enforce local policy decisions before or during navigation.

Done:
- [x] The extension checks URLs against the local policy path.
- [x] Blocked navigation shows a SafeHarbor block page with the reason and timestamp.
- [x] Allowed and blocked visits are logged to SQLite.
- [x] The extension handles missing server/token/policy states with clear parent-facing errors.
- [x] The current manual page/selection capture flow remains available only as an explicit debug/export action.

**Goal 2.6: Local Reporting**
Outcome: parents can inspect useful local activity without cloud sync.

Done:
- [x] `/status` or a local status page reads from SQLite.
- [x] Reports show recent activity, blocked attempts, top domains, category counts, schedule violations, and tamper signals where available.
- [x] Reporting queries avoid exposing full page text by default.
- [x] Report output is usable from the Chrome extension status page or local server page.

**Goal 2.7: Local Agent Robustness**
Outcome: the local server is reliable enough for regular test use.

Done:
- [x] Extension-to-server auth keeps localhost bearer-token auth and adds token rotation; stronger pairing remains a later hardening item.
- [x] Token rotation, config validation, structured logs, crash-safe startup, health checks, and clear error responses exist.
- [x] The Windows startup script and macOS/Linux start script target the current server entrypoint.
- [x] Startup and config behavior are covered by automated checks where practical.

## Phase 3: Parent Dashboard

Status: local dashboard MVP completed. Cloud-backed alert delivery remains future work.

- [x] Build a mobile-friendly parent dashboard.
- [x] Include child profile lists, device status, recent activity, blocked attempts, rules editor, schedules editor, alert preferences, and temporary allow/deny actions.
- [x] Add local reporting: daily summaries, top domains, blocked categories, estimated online time, schedule-violation counts, and privacy-preserving browsing detail.
- [ ] Add exportable reports.
- [ ] Add alerts by email first, then push notifications later.
- [ ] Alert on blocked attempts, tamper signals, offline agents, repeated risky searches/domains, and schedule violations.

## Phase 4: Accounts, Sync, and Deployment

- Status: local enrollment/sync foundation completed. Hosted accounts and cloud sync remain future work.

- [ ] Add parent account auth with secure sessions, password reset, optional MFA, and support for multiple parents or guardians.
- [x] Add local device enrollment with pairing codes, device names, child assignment, and last-seen status.
- [ ] Add device revocation and re-enrollment handling.
- [x] Add local sync endpoints so agents can pull policies and upload activity/events.
- [ ] Add cloud sync so agents pull policies, upload activity/events, cache while offline, handle conflicts, and apply versioned policy updates.
- Treat Windows as the release validation platform for installation, startup, filesystem permissions, Edge deployment, child-account behavior, and tamper-resistance flows.
- Support macOS as the fast development loop for server, extension, SQLite, rule-engine, dashboard, API, and reporting work.
- Add GitHub Actions Windows jobs for Node checks, tests, PowerShell syntax/script validation, packaging checks, and installer smoke tests where possible.

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
- Add CI for Node syntax checks, rule-engine unit tests, API integration tests, extension tests where practical, end-to-end browser tests for allow/block flows, release builds, and Windows runner validation.

## Testing Strategy

- macOS fast loop: run the localhost server, Chrome extension, SQLite event store, rule engine, parent dashboard, API routes, and reporting queries during daily development.
- Windows release loop: validate scheduled task or service behavior, installer scripts, filesystem permissions, Edge/Chrome deployment behavior, child-account behavior, tamper signals, and uninstall/re-enrollment flows.
- CI loop: run cross-platform Node checks and tests on macOS, Windows, and Linux where practical, with Windows-specific PowerShell and packaging checks before releases.
- Real-device loop: test on at least one Windows child-device profile before treating tamper resistance, startup behavior, or browser coverage as done.

## Recommended Build Order

1. Rename to SafeHarbor.
2. Add this roadmap.
3. Add a local SQLite event store.
4. Build the rule engine locally.
5. Add real blocking in the extension.
6. Add child profiles and policies.
7. Add local reporting from SQLite.
8. Add cross-platform CI with Windows runner coverage.
9. Add the cloud API and parent dashboard.
10. Add enrollment and sync.
11. Add alerts.
12. Harden tamper detection and deployment.
