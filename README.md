# SafeHarbor

SafeHarbor is an early parental-controls prototype. Today it includes a Chrome extension and a localhost Node.js server that authenticate with a local token, receive browser page or selection captures, and write timestamped Markdown files locally.

The broader product roadmap is tracked in [ROADMAP.md](ROADMAP.md).

## Current Status

This repository is a foundation, not a complete parental-controls product yet. The next major work is to add child profiles, policy rules, browser blocking, reporting, a mobile-friendly parent dashboard, sync, alerts, and stronger tamper detection.

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

Captures are written to:

```text
~/.safeharbor/local-agent/captures/
```

Override the local data directory with:

```sh
SAFEHARBOR_HOME=/path/to/data npm start
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
- `POST /capture/page` - authenticated page capture
- `POST /capture/selection` - authenticated selected-text capture
- `POST /action` - authenticated future action hook

Authenticated requests use:

```http
Authorization: Bearer <local-token>
```

## Safety Defaults

- Server listens on `127.0.0.1` only.
- Page content is sent only after a user clicks the extension.
- Extension stores only the local server token.
- Captures are local Markdown files unless later integration code is added.
- No real browser blocking, parent dashboard, account system, cloud sync, or tamper resistance exists yet.
