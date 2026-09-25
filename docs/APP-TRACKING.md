# App Tracking Design (Windows)

Status: proposed. Nothing in this document is implemented yet.

## Problem

SafeHarbor only sees web navigation in browsers that have the extension loaded. Desktop apps and games (for example Minecraft, the Roblox player, Discord, Steam games) are invisible: they produce no events, cannot be blocked, and do not count toward any time limit.

## Goals

- Report which apps a monitored Windows account uses, and for how long, per device and per child profile.
- Let parents block specific apps or app categories, on a schedule or after a daily time limit.
- Keep working offline, like browser enforcement: rules come from the last synced policy, and events queue locally and sync to the hub later.
- Monitor only the child accounts that are enrolled. The parent's own Windows account is never observed.
- Reuse the existing event pipeline: local SQLite store, `/events`, device-token hub sync, reports, and alerts.

## Non-goals

- Keystroke logging, screenshots, screen recording, message content, or file content. We record which app was used and for how long, and nothing about what was done inside it.
- Concealing the process from the operating system. See [Visibility vs. tamper resistance](#visibility-vs-tamper-resistance).
- Controlling a child who has local administrator rights. Anyone with admin rights can remove any consumer control.
- macOS and Linux app tracking. Windows is the deployment target; the design keeps the platform-specific parts small so another platform can be added later.

## Visibility vs. tamper resistance

"Hidden" here means **no window, console, or tray icon**, and nothing the child sees during normal use. It does **not** mean hiding from Task Manager, the services list, or antivirus. Concealing a process (injecting into other processes, rootkit-style hooks, masquerading as a system binary) is malware behaviour: antivirus flags it, it breaks on Windows updates, and it is not needed.

What stops a standard (non-admin) child account from turning monitoring off is **Windows permissions**:

| Child tries to... | Stopped by |
|---|---|
| End the monitor process | It runs as a Windows service under `LocalSystem`. A standard user cannot stop, disable, or kill it. |
| Delete or edit the program | It is installed under `C:\Program Files\SafeHarbor`, which is read-only for standard users. |
| Read tokens or edit the local policy or history | Data lives in `C:\ProgramData\SafeHarbor`, restricted to SYSTEM and Administrators. |
| Kill the in-session helper (see below) | The service restarts it within seconds and records a `tamper_signal`. |
| Uninstall | Requires admin rights plus the parent token. |

The monitor still shows up in Task Manager as "SafeHarbor Monitor". The recommended default is to tell the child that app use is monitored. That is both fairer and more effective as a deterrent than trying to go unnoticed.

## Architecture

```
 Session 0 (SYSTEM)                               Child's session (runs as the child)
+-----------------------------------+           +----------------------------------+
| SafeHarbor Monitor (Windows svc)  |  named    | Session helper (no window)       |
|  - process start/stop watcher     |<--pipe--->|  - foreground window -> PID       |
|  - session aggregator             |  (ACL'd)  |  - idle time (GetLastInputInfo)   |
|  - app policy evaluation          |           |  - block/limit notifications      |
|  - enforcement (close/terminate)  |           +----------------------------------+
|  - supervises helper + Node agent |
+-----------------+-----------------+
                  | HTTP 127.0.0.1:43718 (device token)
+-----------------v-----------------+
| Node local agent (existing)       |--- hub sync (existing, per-device token) ---> Pi hub
|  SQLite events, policy, /events   |
+-----------------------------------+
```

There are two processes because Windows splits the work between sessions:

- **Service (session 0, `LocalSystem`).** It can see every process and its owner, can end processes, and cannot be stopped by the child. However, it cannot see the child's desktop: in session 0, `GetForegroundWindow` and `GetLastInputInfo` do not report on the interactive user.
- **Session helper (the child's session, running as the child).** It can see which window is in front and how long the user has been idle. It has no UI except short notifications. The service starts it into the monitored user's session (`WTSQueryUserToken` + `CreateProcessAsUser`) at logon and whenever it disappears.

**Which accounts are monitored:** the service keeps a list of monitored Windows account SIDs, set at install time. Each SID maps to the enrolled device and child profile. Sessions belonging to any other account are ignored completely: no helper is started and their processes are not recorded. This is how the parent account stays unmonitored.

**Language:** the service and helper should be a small .NET 8 worker service. Its advantages are native Win32 and WTS APIs, a single-file publish, and code signing later. The Node agent stays responsible for policy, storage, and sync, so the rule engine and hub protocol do not need to be rewritten.

## Identifying apps

For each process the monitor collects:

- image path and exe name
- file version info: `ProductName`, `FileDescription`, `CompanyName`
- Authenticode signer, when present
- the MSIX/Store package family name, when present

Apps are matched against an **app catalogue** in the policy. Matchers are ANDed within an entry and ORed across entries:

| Matcher | Example use |
|---|---|
| `exe` | `RobloxPlayerBeta.exe`, `Discord.exe` |
| `pathContains` | `\steamapps\common\`, so that any Steam game counts |
| `packageFamily` | Store/MSIX apps |
| `publisher` | Signer or `CompanyName`, e.g. every app from one studio |
| `titlePattern` | Needed when the exe is generic, e.g. Minecraft Java Edition runs as `javaw.exe` |

Catalogue entries for popular apps ship as defaults and must be verified on a real machine. Exe names change between versions, and launchers often start a separate game process.

**Known pitfalls:**

- **UWP apps** are hosted by `ApplicationFrameHost.exe`. To find the real app, look at the host's child `CoreWindow`.
- **Launchers:** the Minecraft Launcher, Steam and Epic start other processes. Time should be attributed to the game process, not the launcher.
- **Controller play:** `GetLastInputInfo` does not count XInput controllers, so someone playing with a controller looks idle. Treat a full-screen foreground app in the `games` category as active.
- **Unknown apps:** an unmatched process is still reported by exe and product name, under the category `uncategorized`.

## Events

App events use the existing `events` table and `/events` endpoint. They add an `app_id` column (added with the store's existing `ensureColumn` migration pattern) so reports can group without parsing JSON.

### `app_session`

One event per foreground session. A session ends when the app loses focus, exits, or goes idle for more than 5 minutes. Long sessions also emit a checkpoint every 5 minutes, so the dashboard is close to live and a crash loses at most 5 minutes.

```json
{
  "type": "app_session",
  "timestamp": "2026-09-25T20:28:10.000Z",
  "app_id": "minecraft",
  "title": "Minecraft",
  "category": "games",
  "source": "app-monitor",
  "metadata": {
    "exe": "Minecraft.Windows.exe",
    "publisher": "Microsoft Corporation",
    "startedAt": "2026-09-25T20:28:10.000Z",
    "endedAt": "2026-09-25T20:33:10.000Z",
    "activeSeconds": 287,
    "idleSeconds": 13,
    "final": false,
    "sessionId": "b3f1...",
    "chunk": 3
  }
}
```

`event_key` is set to `<deviceId>:app:<sessionId>:<chunk>`, which keeps the existing idempotent hub sync correct across retries.

### `app_decision`

Recorded when a rule matches a process start or a running app. It uses the same `decision`, `rule_id` and `reason` fields as `visit_decision`, so blocked apps appear next to blocked sites.

### `tamper_signal`

These signals use new `metadata.signal` values:

| Signal | Meaning |
|---|---|
| `app_helper_stopped` | The session helper was killed or crashed. |
| `app_monitor_stopped` | The Node agent saw no heartbeat from the service. |
| `app_monitor_gap` | Hours with no samples while a monitored user was signed in. |

**Privacy defaults:**

- Window titles are **not** stored. They can contain chat names, document names and search terms. `titlePattern` rules are evaluated on the device and the title is then discarded.
- Parents can turn on title recording per app. This is off by default.

## Policy

The policy gains an optional, additive `apps` block. Older agents ignore it, and validation rejects malformed entries the same way it does for domain rules.

```json
"apps": {
  "defaultAction": "allow",
  "catalog": {
    "minecraft": {
      "name": "Minecraft",
      "category": "games",
      "match": [
        { "exe": "Minecraft.Windows.exe" },
        { "exe": "javaw.exe", "titlePattern": "^Minecraft" }
      ]
    },
    "roblox": { "name": "Roblox", "category": "games", "match": [{ "exe": "RobloxPlayerBeta.exe" }] }
  },
  "allowedApps": [],
  "blockedApps": [{ "id": "block-roblox", "app": "roblox", "reason": "Not allowed" }],
  "blockedCategories": [],
  "schedules": [
    { "id": "school-nights", "apps": ["category:games"], "days": ["sun", "mon", "tue", "wed", "thu"],
      "start": "21:00", "end": "07:00", "action": "block" }
  ],
  "dailyLimits": [{ "id": "games-2h", "apps": ["category:games"], "minutes": 120 }],
  "temporaryOverrides": []
}
```

A new pure function, `evaluateApp({ app, timestamp, policy, usageToday })`, sits next to `evaluatePolicy` in `server/lib/policy-engine.js`. It uses the same precedence as web rules:

1. temporary overrides
2. allowed apps
3. blocked apps
4. blocked categories
5. schedules
6. daily limits
7. default action

It returns the same decision shape as web rules. It needs no network access, so it can be unit-tested anywhere.

Daily limits are counted on the device from its local `app_session` events. Days are split in the profile's time zone, using the existing `report-time.js` day boundaries, so limits keep working while the hub is unreachable.

## Enforcement

1. **On process start**, the service asks the agent for a decision. If the answer is block, it proceeds to steps 2 and 3.
2. **The app is asked to close politely.** The helper sends `WM_CLOSE` to the app's main window and shows "Minecraft is blocked right now: School nights". This lets a game save.
3. **After a 30-second grace period**, the service ends the process tree. It records an `app_decision` block.
4. **Before a limit or schedule starts**, the helper shows warnings at 10, 5 and 1 minutes.
5. **Some processes are never touched:** Windows system processes, `explorer.exe`, security software, SafeHarbor itself, and anything under `C:\Windows`. The catalogue cannot override this list.

**Repeated block attempts** raise the existing `repeated_block` alert.

## Dashboard and reports

- **New "Apps" panel:** top apps by active minutes (today and last 7 days), per device and per profile. It also shows the current app for online devices and a blocked-app attempts table.
- **Alerts:** `app_limit_reached` (informational), repeated blocked-app attempts, and `app_monitor_stopped`.
- **Exports:** app events are included in the existing JSON/CSV exports.

## Delivery plan

**M1: Reporting only, inside the existing per-user agent.** Estimate: about 2–3 days.
- Build a small Windows-only probe that reports the foreground process and idle time every 10 seconds.
- The probe is started without a window by the existing Node agent, which already runs as the child at logon.
- Session aggregation, `app_session` events, and the dashboard Apps panel are included.
- The child can still stop it (the same exposure as the agent today), but reporting works end to end on the current deployment.

**M2: App policy and enforcement.** Estimate: about 3–4 days.
- This milestone covers:
  - the `apps` policy block and its validation
  - `evaluateApp`, with unit tests
  - closing blocked apps, notifications, and daily limits
- Still running inside the per-user agent.

**M3: Tamper-resistant service.** Estimate: about 1–2 weeks. This is the existing Phase 5 "native background service" item.
- A .NET `SafeHarbor Monitor` service runs as `LocalSystem`, plus the session helper.
- The service supervises the Node agent. The agent's data and tokens move to `C:\ProgramData\SafeHarbor` with restricted permissions. This also closes today's gaps where the child can stop the agent or read its local tokens.
- The installer needs a one-time admin install. Uninstalling requires the parent token.

## Testing

- **Unit tests (any OS):** `evaluateApp` precedence, catalogue matching, daily-limit math across midnight and DST, and the session aggregator fed synthetic foreground and idle samples.
- **Windows CI job:** run the probe once, validate its JSON output, and install then uninstall the service on the Windows runner.
- **Manual Windows checklist:**
  - launch a matched game, an unmatched app, and a UWP app, and check that each is attributed correctly
  - check controller play and time counted while idle
  - kill the helper and check that it restarts and a tamper signal is recorded
  - sign out during a session and check that the final session is flushed
  - play while the hub is offline and check that events sync afterwards
  - sign in to the parent account and check that nothing is recorded

## Open questions

1. Report-only first (M1), or go straight to blocking and limits?
2. Which apps and categories need limits, and how many minutes per day?
3. Should window titles ever be recorded, or never?
4. Is a one-time admin install on the family PC acceptable for M3?
5. Should the child see a small "app use is monitored" notice on sign-in?
