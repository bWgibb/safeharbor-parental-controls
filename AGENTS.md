# SafeHarbor Agent Notes

## Current Deployment

- Raspberry Pi home hub hostname: `homeserver` (resolved by the router's LAN DNS; mDNS is not used, so `.local` names do not resolve).
- Hub dashboard URL: `http://homeserver:43718/dashboard`
- The Pi is a shared home server running other services. Keep SafeHarbor changes scoped to its own user, paths, and port.
- Project staging path on Pi: `~/safeharbor` in the deploy user's home
- Service path on Pi: `/opt/safeharbor`
- Hub data path: `/var/lib/safeharbor` (owned by system user `safeharbor`, mode 750)
- Hub service name: `safeharbor-hub`, running as system user `safeharbor`
- LAN-only firewall: `safeharbor-hub-firewall.service` loads `/etc/safeharbor/hub-firewall.nft`, an nftables table that only allows tcp/43718 from the home LAN subnet and loopback.
- Keep host-specific details (SSH users, IPs, account names) out of this public repo.

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
sudo -u safeharbor env SAFEHARBOR_HOME=/var/lib/safeharbor node /opt/safeharbor/server/safeharbor-server.js --show-token
sudo -u safeharbor env SAFEHARBOR_HOME=/var/lib/safeharbor node /opt/safeharbor/server/safeharbor-server.js --show-device-token
```

## Pi Deploy Workflow

From the Mac repo:

```sh
rsync -av --exclude node_modules --exclude .git ./ <pi-user>@homeserver:~/safeharbor/
```

From the Windows repo (Git Bash), ship the committed tree without CRLF conversion:

```sh
git -c core.autocrlf=false archive --format=tar HEAD | /c/Windows/System32/OpenSSH/ssh.exe <pi-user>@homeserver 'rm -rf ~/safeharbor && mkdir -p ~/safeharbor && tar -x -C ~/safeharbor'
```

On the Pi:

```sh
sudo mkdir -p /opt/safeharbor
sudo rsync -a --delete --exclude node_modules ~/safeharbor/ /opt/safeharbor/
sudo chown -R "$USER:$USER" /opt/safeharbor
cd /opt/safeharbor
SAFEHARBOR_USER=safeharbor SAFEHARBOR_GROUP=safeharbor ./scripts/install-raspberry-pi.sh
```

Check service:

```sh
sudo systemctl status safeharbor-hub
sudo journalctl -u safeharbor-hub -f
```

## Simulator

Use this from the Mac repo to populate/test the Pi hub without Windows or browser install:

```sh
SAFEHARBOR_SERVER_URL=http://homeserver:43718 \
SAFEHARBOR_TOKEN=<parent-token> \
npm run simulate
```

Duplicate/idempotency check:

```sh
SAFEHARBOR_SERVER_URL=http://homeserver:43718 \
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

Enroll a child agent against the hub with:

```sh
npm run enroll-device -- --hub http://homeserver:43718 --code <pairing-code> --name "Child Laptop"
```

This persists the enrolled device ID and device-scoped hub token in the local SafeHarbor config so browser events are attributed to the enrolled device during hub sync.

## Open Work

- Validate real Raspberry Pi service install end to end after each deploy.
- Validate real Chrome/Edge extension loading when browser access is available.
- Validate Windows scheduled task and child-account behavior when Windows access is available.
- Add real email/push delivery later; current alert delivery writes local `.eml` files.
