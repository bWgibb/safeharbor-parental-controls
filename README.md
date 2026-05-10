# SafeHarbor

SafeHarbor is a local parental-controls MVP. It includes a Chrome extension, a localhost Node.js agent, a SQLite activity store, child/profile policy defaults, URL policy evaluation, browser blocking, local reporting, and optional Markdown debug/export captures.

The broader product roadmap is tracked in [ROADMAP.md](ROADMAP.md).

## Current Status

This repository now has a local controls MVP, not a finished parental-controls product. The next major work is a mobile-friendly parent dashboard, sync, alerts, Windows release validation, and stronger tamper detection.

## Project Layout

- `server/safeharbor-server.js` - localhost-only Node.js server
- `extension/` - Manifest V3 Chrome extension
- `scripts/install-windows.ps1` - registers the server to start at Windows login
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

The Windows installer creates a current-user scheduled task named `SafeHarbor` so the server starts at login. It binds only to `127.0.0.1`.

To uninstall the startup task:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Uninstall
```

## API

- `GET /health` - unauthenticated server health check
- `GET /status` - authenticated recent activity/config summary
- `GET /policy` - authenticated local profiles/devices/policy summary
- `POST /policy` - authenticated local policy update
- `POST /policy/evaluate` - authenticated URL policy evaluation and event logging
- `GET /reports/local` - authenticated SQLite-backed report summary
- `POST /events` - authenticated event ingestion for tamper signals or local events
- `POST /capture/page` - authenticated page capture
- `POST /capture/selection` - authenticated selected-text capture
- `POST /action` - authenticated future action hook
- `POST /token/rotate` - authenticated local token rotation

Authenticated requests use:

```http
Authorization: Bearer <local-token>
```

## Safety Defaults

- Server listens on `127.0.0.1` only.
- Page content is sent only after a user clicks the explicit debug/export capture action.
- Extension stores only the local server token.
- Activity/events are stored in SQLite for reporting and policy history.
- Full page text is not stored by default.
- A local admin can still disable or remove consumer controls. Stronger tamper resistance remains future work.

## Testing

Run syntax checks and automated tests:

```sh
npm run check
npm test
```

The tests cover the rule engine, SQLite event store, and a server smoke path that evaluates the default blocked domain.
