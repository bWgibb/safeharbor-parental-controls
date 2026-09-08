# Onboard a Windows device

Use this procedure to connect one Windows child device to the SafeHarbor home hub.

The setup installs a local agent and a Chrome extension. The local agent applies policy and sends activity to the home hub.

Node.js runs the local agent on the Windows device. The Chrome extension sends each website check to this local agent.

## Before you start

Make sure that you have these items:

- The Windows device
- Access to the child's Windows account
- Google Chrome
- The SafeHarbor source folder on the Windows device
- Access to the SafeHarbor home-hub dashboard
- A connection to the home network

The current home-hub address is:

```text
http://192.168.1.218:43718
```

IMPORTANT: Run this procedure from the child's Windows account. SafeHarbor starts only when this account signs in.

## 1. Generate a pairing code

1. Open the home-hub dashboard:

   ```text
   http://192.168.1.218:43718/dashboard
   ```

2. If the dashboard shows a missing-token message, select **Options**.

3. Enter the parent token.

   To print the parent token again, run this command from a terminal on your main computer:

   ```sh
   ssh home-server 'SAFEHARBOR_HOME=/home/ben/.local/share/safeharbor /home/ben/.local/bin/node /home/ben/projects/safe-habour/server/safeharbor-server.js --show-token'
   ```

4. Select **Generate pairing code**.

5. Record the six-digit pairing code.

The pairing code expires after 15 minutes. The code can enroll one device.

## 2. Run the Windows installer

1. Sign in to the child's Windows account.

2. Copy the SafeHarbor source folder to the Windows device.

   This guide uses this temporary source location:

   ```text
   C:\SafeHarbor
   ```

3. Open Windows PowerShell.

4. Go to the SafeHarbor source folder:

   ```powershell
   Set-Location "C:\SafeHarbor"
   ```

5. Replace `123456` with the pairing code.

6. Replace `Child Laptop` with the device name.

7. Run the installer:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 `
     -InstallNode `
     -HubUrl "http://192.168.1.218:43718" `
     -PairingCode "123456" `
     -DeviceName "Child Laptop"
   ```

8. Approve the Windows prompt if Windows requests approval.

The installer does these tasks:

- Installs Node.js if Node.js is not present
- Copies SafeHarbor to `%LOCALAPPDATA%\SafeHarbor`
- Installs the required software packages
- Enrolls the device with the home hub
- Adds SafeHarbor to Windows startup
- Starts the local agent
- Confirms the first home-hub synchronization

Do not continue if the installer reports an error.

## 3. Record the installation results

The installer prints these values:

- Windows account
- Application folder
- Extension folder
- Configuration file
- Log folder
- Device ID
- Home-hub synchronization time
- Chrome server URL
- Chrome extension token

Confirm that the Windows account is the child's account.

Save the Chrome extension token temporarily. Do not send the token by email or chat.

## 4. Install the Chrome extension

1. Open Google Chrome.

2. Open this address:

   ```text
   chrome://extensions
   ```

3. Turn on **Developer mode**.

4. Select **Load unpacked**.

5. Paste this path into the address bar of the folder-selection window:

   ```text
   %LOCALAPPDATA%\SafeHarbor\extension
   ```

6. Select the `extension` folder.

7. Open the SafeHarbor extension details.

8. Open **Extension options**.

9. Enter this server URL:

   ```text
   http://127.0.0.1:43718
   ```

10. Enter the Chrome extension token from the installer.

11. Select **Save**.

12. Select **Check server**.

The options page must show a successful SafeHarbor check.

## 5. Test a blocked website

1. Open this website in Chrome:

   ```text
   https://example.com
   ```

2. Confirm that SafeHarbor shows its block page.

3. Open the home-hub dashboard on the parent device.

4. Wait up to 90 seconds.

5. Select **Refresh**.

6. Confirm that the new device is present.

7. Confirm that the blocked attempt is present.

## 6. Test startup after a restart

1. Restart the Windows device.

2. Sign in to the same child's account.

3. Wait one minute.

4. Open the SafeHarbor extension options.

5. Select **Check server**.

6. Open `https://example.com`.

7. Confirm that SafeHarbor blocks the website.

## Get the extension token again

Run this command from the child's Windows account:

```powershell
node "$env:LOCALAPPDATA\SafeHarbor\server\safeharbor-server.js" --show-token
```

## Reinstall SafeHarbor

Run the same installer command again.

If the device uses the same home hub, the installer keeps the current enrollment.

## Re-enroll a revoked device

1. Generate a new pairing code on the home hub.

2. Run the installer command again.

3. Add this option to the command:

   ```powershell
   -ForceEnroll
   ```

## Uninstall SafeHarbor startup

Run this command from the child's Windows account:

```powershell
powershell -ExecutionPolicy Bypass `
  -File "$env:LOCALAPPDATA\SafeHarbor\scripts\install-windows.ps1" `
  -Uninstall
```

This command stops the local agent and removes SafeHarbor from Windows startup.

The command does not remove the application files, configuration, or activity database.

## Troubleshooting

### The installer cannot find `winget`

Install Node.js 20 LTS or a later version. Run the SafeHarbor installer again.

### Port 43718 is in use

Close the program that uses port 43718. Run the installer again.

### The first home-hub synchronization fails

1. Confirm that the Windows device uses the home network.

2. Open this address on the Windows device:

   ```text
   http://192.168.1.218:43718/health
   ```

3. Confirm that the page shows `"ok": true`.

4. Generate a new pairing code if the old code expired.

5. Run the installer again.

### The Chrome server check fails

1. Confirm that the server URL is `http://127.0.0.1:43718`.

2. Get the extension token again.

3. Enter the new token in the SafeHarbor extension options.

4. Select **Save**.

5. Select **Check server**.

### Find the local log

Open this file:

```text
%USERPROFILE%\.safeharbor\local-agent\logs\server.log
```

## First-device observation log

Record each problem before you change the device configuration.

| Time | Procedure step | Expected result | Actual result | Error text or screenshot |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

Also record these details:

- Windows version
- Windows account type
- Chrome version
- Node.js version
- Installer startup method
- Device ID
