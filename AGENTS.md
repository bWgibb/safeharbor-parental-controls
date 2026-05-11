# SafeHarbor Agent Notes

## Current Deployment

- Raspberry Pi home hub hostname: `homeautomation.local`
- Hub dashboard URL: `http://homeautomation.local:43718/dashboard`
- Pi deployment user used so far: `pi`
- Project staging path on Pi: `/home/pi/safeharbor`
- Intended service path on Pi: `/opt/safeharbor`
- Hub data path: `/var/lib/safeharbor`
- Hub service name: `safeharbor-hub`

## Architecture Direction

- Keep browser enforcement local on each child device.
- Use the Raspberry Pi as the home hub for parent dashboard, policy source of truth, central SQLite reporting, alerts, backups, enrollment, and multi-device aggregation.
- Child devices should sync to the hub with their enrolled per-device token, but still enforce the last known policy locally.
- Do not expose port `43718` to the internet. Use LAN-only access for now.

## Token Scopes

- Parent token: `npm run token`
  - Use for dashboard/admin actions: `/status`, reports, exports, backups, policy edits, enrollment code creation, device revocation, alert resolution.
- Device token: returned by `/devices/enroll`
  - Use only for that enrolled device's child-agent operations: policy pull, event upload, heartbeat, URL evaluation, tamper/event ingestion.
  - `npm run device-token` prints the legacy local-device token for local smoke tests.

On the Pi, print the parent token and legacy local-device token with:

```sh
sudo -u "$USER" env SAFEHARBOR_HOME=/var/lib/safeharbor node /opt/safeharbor/server/safeharbor-server.js --show-token
sudo -u "$USER" env SAFEHARBOR_HOME=/var/lib/safeharbor node /opt/safeharbor/server/safeharbor-server.js --show-device-token
```

## Pi Deploy Workflow

From the Mac repo:

```sh
rsync -av --exclude node_modules --exclude .git ./ pi@homeautomation.local:~/safeharbor/
```

On the Pi:

```sh
sudo mkdir -p /opt/safeharbor
sudo rsync -av ~/safeharbor/ /opt/safeharbor/
sudo chown -R "$USER:$USER" /opt/safeharbor
cd /opt/safeharbor
./scripts/install-raspberry-pi.sh
```

Check service:

```sh
sudo systemctl status safeharbor-hub
sudo journalctl -u safeharbor-hub -f
```

## Simulator

Use this from the Mac repo to populate/test the Pi hub without Windows or browser install:

```sh
SAFEHARBOR_SERVER_URL=http://homeautomation.local:43718 \
SAFEHARBOR_TOKEN=<parent-token> \
npm run simulate
```

Duplicate/idempotency check:

```sh
SAFEHARBOR_SERVER_URL=http://homeautomation.local:43718 \
SAFEHARBOR_TOKEN=<parent-token> \
npm run simulate -- --duplicate
```

## Development Checks

Run before handing off changes:

```sh
npm run check
npm test
sh -n scripts/install-raspberry-pi.sh
```

Current test coverage includes rule engine behavior, SQLite/event-store behavior, server smoke paths, auth scope checks, exports, alerts, revocation, sync timeout handling, and a headless hub-plus-child-agent sync process.

## Open Work

- Validate real Raspberry Pi service install end to end after each deploy.
- Validate real Chrome/Edge extension loading when browser access is available.
- Validate Windows scheduled task and child-account behavior when Windows access is available.
- Add real email/push delivery later; current alert delivery writes local `.eml` files.
