# SafeHarbor

SafeHarbor is a local parental-controls MVP. It includes a Chrome extension, a Node.js agent, a SQLite activity store, child/profile policy defaults, URL policy evaluation, browser blocking, a parent dashboard, local reporting, local multi-device hub sync, and optional Markdown debug/export captures.

The broader product roadmap is tracked in [ROADMAP.md](ROADMAP.md).

## Current Status

This repository now has a local controls MVP, not a finished parental-controls product. The local dashboard, reporting, exportable reports, alert records, device enrollment/revocation, Raspberry Pi/home-hub mode, idempotent local sync, and simulator tooling are in place. The next major work is hosted parent accounts, cloud sync, email/push delivery, Windows release validation, and stronger tamper detection.

## Project Layout

- `server/safeharbor-server.js` - Node.js local agent or home-hub server
- `extension/` - Manifest V3 Chrome extension
- `scripts/install-windows.ps1` - registers the server to start at Windows login
- `scripts/install-raspberry-pi.sh` - installs a systemd home-hub service on Raspberry Pi OS/Linux
- `scripts/start-macos.sh` - starts the server on macOS/Linux

## Local Development On Mac

1. Start the server:

   ```sh
   npm start
   ```

2. In another terminal, print the local token:

   ```sh
   npm run token
   ```

3. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.

4. Select the `extension` folder from this project.

5. Open the extension options page and set:

   - Server URL: `http://127.0.0.1:43718`
   - Token: the value from `npm run token`

6. Click the extension button and use **Send current page**.

7. Click **Dashboard** in the extension popup to open the local parent dashboard.

You can also use the server-hosted dashboard without loading the extension:

```text
http://127.0.0.1:43718/dashboard
```

Click **Options** on that page and paste the parent token from `npm run token`.

The default local policy blocks `example.com`, so you can test-drive blocking by visiting:

```text
https://example.com/
```

SQLite activity is written to:

```text
~/.safeharbor/local-agent/safeharbor.sqlite
```

Optional Markdown debug/export captures are written to:

```text
~/.safeharbor/local-agent/captures/
```

Override the local data directory with:

```sh
SAFEHARBOR_HOME=/path/to/data npm start
```

If the default port is already in use, start on another port:

```sh
PORT=43719 npm start
```

To bind the server to another interface for a home hub, set `SAFEHARBOR_HOST`. The default is still `127.0.0.1`.

```sh
SAFEHARBOR_HOST=0.0.0.0 PORT=43718 npm start
```

## Raspberry Pi Home Hub

The Raspberry Pi mode is for a home-network hub: the Pi hosts the parent dashboard, central SQLite database, policy source of truth, device enrollment, and aggregated reports. Child devices should still keep a local agent/cache for enforcement so blocking does not depend on the Pi or Wi-Fi being available.

The current home hub target used during development is:

```text
http://homeautomation.local:43718/dashboard
```

1. Install Node.js 20 LTS or newer on the Pi.

2. Copy this project folder to the Pi, for example:

   ```text
   /opt/safeharbor
   ```

   From a Mac development machine, one working copy command is:

   ```sh
   rsync -av --exclude node_modules --exclude .git ./ pi@homeautomation.local:~/safeharbor/
   ```

   Then on the Pi:

   ```sh
   sudo mkdir -p /opt/safeharbor
   sudo rsync -av ~/safeharbor/ /opt/safeharbor/
   sudo chown -R "$USER:$USER" /opt/safeharbor
   cd /opt/safeharbor
   ```

3. From the project folder, install the systemd service:

   ```sh
   ./scripts/install-raspberry-pi.sh
   ```

   The default service binds to `0.0.0.0:43718` and stores the central hub database in:

   ```text
   /var/lib/safeharbor/safeharbor.sqlite
   ```

4. Print the hub token:

   ```sh
   sudo -u "$USER" env SAFEHARBOR_HOME=/var/lib/safeharbor node server/safeharbor-server.js --show-token
   ```

   Print the legacy local-device token only for local smoke tests:

   ```sh
   sudo -u "$USER" env SAFEHARBOR_HOME=/var/lib/safeharbor node server/safeharbor-server.js --show-device-token
   ```

5. For parent dashboard access, open:

   ```text
   http://homeautomation.local:43718/dashboard
   ```

   Click **Options** and paste the parent token.

   If using the Chrome extension dashboard instead, set the extension options on the parent device to:

   - Server URL: `http://homeautomation.local:43718` or `http://<pi-lan-ip>:43718`
   - Token: the parent token

6. Open the dashboard. It will read from the Pi hub and show aggregated device/report data.

For a child device, prefer keeping the extension pointed at its local agent for enforcement:

```text
http://127.0.0.1:43718
```

Generate a pairing code from the dashboard, enroll the child device, and use the enrolled device token returned by `/devices/enroll`. Then run the local child agent with hub sync enabled:

```sh
SAFEHARBOR_HUB_URL=http://homeautomation.local:43718 \
SAFEHARBOR_HUB_TOKEN=<enrolled-device-token> \
npm start
```

With hub sync enabled, the child agent periodically pulls policy from the Pi and uploads local events into the central hub database. Device-scoped sync requires the token issued for that enrolled device, so revoking a device prevents it from syncing until it is re-enrolled.

To test the hub without Windows or a browser extension, run the simulator from another terminal:

```sh
SAFEHARBOR_SERVER_URL=http://homeautomation.local:43718 \
SAFEHARBOR_TOKEN=<parent-token> \
npm run simulate
```

To verify idempotent sync handling, run:

```sh
SAFEHARBOR_SERVER_URL=http://homeautomation.local:43718 \
SAFEHARBOR_TOKEN=<parent-token> \
npm run simulate -- --duplicate
```

Useful service commands:

```sh
sudo systemctl status safeharbor-hub
sudo journalctl -u safeharbor-hub -f
sudo systemctl restart safeharbor-hub
./scripts/install-raspberry-pi.sh --uninstall
```

Keep the hub port private to the home LAN. Do not port-forward it to the internet. This LAN mode uses bearer-token auth over HTTP; use a VPN such as Tailscale/WireGuard or add HTTPS before remote access.

## Windows Laptop Deployment

1. Install Node.js 20 LTS or newer on the Windows laptop.

2. Copy this project folder to the laptop, for example:

   ```text
   C:\SafeHarbor
   ```

3. Open PowerShell in the project folder and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
   ```

4. Print the token:

   ```powershell
   node .\server\safeharbor-server.js --show-token
   ```

5. In Chrome on the laptop, load the `extension` folder as an unpacked extension and paste that token into the extension options page.

The Windows installer creates a current-user scheduled task named `SafeHarbor` so the server starts at login. It binds to `127.0.0.1` unless `SAFEHARBOR_HOST` is set.

To uninstall the startup task:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Uninstall
```

## API

- `GET /health` - unauthenticated server health check
- `GET /status` - authenticated recent activity/config summary
- `GET /dashboard` - browser dashboard served directly by the local server or Pi hub
- `GET /policy` - authenticated local profiles/devices/policy summary
- `POST /policy` - authenticated local policy update
- `GET /policy/export.json` - authenticated policy export
- `POST /policy/import` - authenticated policy import
- `POST /policy/evaluate` - authenticated URL policy evaluation and event logging
- `GET /reports/local` - authenticated SQLite-backed report summary
- `GET /reports/export.csv` - authenticated CSV event export
- `GET /reports/export.json` - authenticated JSON event export
- `GET /backup/safeharbor.sqlite` - authenticated SQLite backup download
- `POST /events` - authenticated event ingestion for tamper signals or local events
- `GET /alerts` - authenticated open alert list
- `POST /alerts/resolve` - authenticated alert resolution
- `GET /devices/sync-status` - authenticated per-device sync status
- `POST /capture/page` - authenticated page capture
- `POST /capture/selection` - authenticated selected-text capture
- `POST /action` - authenticated future action hook
- `POST /token/rotate` - authenticated local token rotation

Authenticated requests use:

```http
Authorization: Bearer <local-token>
```

There are two local token scopes:

- Parent token: printed by `npm run token`; required for dashboard, policy edits, reports, exports, backups, revocation, and token rotation.
- Device token: issued during device enrollment and allowed only for that device's child-agent operations such as policy pull, heartbeat, event upload, local URL evaluation, and tamper/event ingestion. `npm run device-token` prints the legacy local-device token for local smoke tests.

## Safety Defaults

- Server listens on `127.0.0.1` by default. Raspberry Pi/home-hub mode must be enabled explicitly with `SAFEHARBOR_HOST`.
- Page content is sent only after a user clicks the explicit debug/export capture action.
- Extension stores only the local server token.
- Activity/events are stored in SQLite for reporting and policy history.
- Full page text is not stored by default.
- A local admin can still disable or remove consumer controls. Stronger tamper resistance remains future work.

## Parent Dashboard

The extension dashboard can:

- Show child profile and local device status.
- Generate short-lived device pairing codes.
- Show total, allowed, blocked, estimated online minutes, and tamper counts.
- Edit the local default allow/block mode.
- Add and remove allow-list and block-list domains.
- Toggle blocked categories.
- Add schedules and temporary overrides.
- Save local alert preferences.
- Review blocked attempts, top domains, daily summaries, and recent activity.
- Filter reports by profile, device, and date.
- Export reports as CSV/JSON.
- Export/import policy JSON.
- Download SQLite backups.
- Resolve local alert records.

## Local Sync and Enrollment

The Phase 4 local foundation adds:

- `POST /enrollment/code` to generate a short-lived pairing code.
- `POST /devices/enroll` to enroll a device with a valid pairing code.
- `POST /devices/heartbeat` to refresh device status.
- `POST /devices/revoke` to revoke a device until it is re-enrolled.
- `GET /sync/policy` to pull the current policy for a device.
- `POST /sync/events` to upload event batches into the central SQLite database.

These APIs support the Raspberry Pi/home-hub model and act as the local test-drive shape for the future cloud sync model. Event sync is idempotent when child agents include a per-device local event ID. Real parent accounts, hosted sync, and remote email/push delivery are still future work.

Child agents can sync to a hub with:

- `SAFEHARBOR_HUB_URL` - hub URL, for example `http://safeharbor.local:43718`
- `SAFEHARBOR_HUB_TOKEN` - enrolled device token from `/devices/enroll`
- `SAFEHARBOR_HUB_SYNC_INTERVAL_MS` - optional interval, default `60000`
- `SAFEHARBOR_DEVICE_ID` - optional local device ID override

## Testing

Run syntax checks and automated tests:

```sh
npm run check
npm test
```

The tests cover the rule engine, SQLite event store, and a server smoke path that evaluates the default blocked domain.
