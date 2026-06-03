# Contributing to Ronin Forge

Thanks for your interest in contributing. This document covers how to set up the project, how the codebase is structured, and how to add new game server support.

---

## Development Setup

### Prerequisites

- Node.js 18 or later
- npm 9 or later
- Windows 10/11 (the app targets Windows; Linux/macOS are not supported)
- Git

### Install and run

```bash
git clone https://github.com/t0xicVybez/ronin-forge.git
cd ronin-forge
npm install
npm start
```

Electron launches immediately with hot-reload not enabled — restart `npm start` after any change to `main.js`, `preload.js`, or files under `src/`. Changes to `public/` (renderer files) take effect on page reload (`Ctrl+R` in the Electron window with DevTools open).

### Open DevTools

In the running app press `Ctrl+Shift+I`, or add this line temporarily to `createWindow()` in [main.js](main.js):

```js
mainWindow.webContents.openDevTools();
```

### Build a distributable

```bash
npm run dist
```

Output goes to `dist/` (excluded from git). Uses `electron-builder` with an NSIS target.

---

## Project Structure

```
ronin-forge/
├── main.js                    Electron main process
├── preload.js                 IPC whitelist bridge (context isolation)
├── package.json
├── public/
│   ├── index.html             Wizard HTML shell (6 steps, no framework)
│   ├── renderer.js            Frontend state machine
│   ├── styles.css             Dark theme CSS
│   └── configs/
│       └── games.js           Game definitions — THE file to edit when adding a game
└── src/
    ├── downloader.js          Axios stream downloader with progress callback
    ├── steamcmd.js            SteamCMD auto-download, init, and app_update runner
    ├── minecraft-installer.js Vanilla / Forge / Fabric installers
    └── rsm-integration.js     Ronin Server Manager servers.json integration
```

### IPC architecture

```
renderer.js  ──api.invoke()──►  preload.js whitelist  ──ipcMain.handle()──►  main.js
             ◄─result──────────                        ◄─return value─────
             ──api.send()───►   preload.js whitelist  ──ipcMain.on()──────►  main.js

main.js sends back real-time events:
  install-progress  { stage, percent, message }
  install-log       string line
```

`preload.js` enforces a channel whitelist for all three directions. Any new IPC channel must be added there or it will be silently dropped.

---

## Adding a New Game

Adding a game requires changes in two places: `games.js` (game definition) and `main.js` (install routing and optional config writer). No other files need editing.

### Step 1 — Add the game definition to `games.js`

Open [public/configs/games.js](public/configs/games.js) and append an entry to the `window.GAMES` array. Use this template:

```js
{
    id: 'my-game',                      // unique kebab-case ID
    displayName: 'My Game',
    description: 'Short description shown on the card',
    icon: '🎮',                         // single emoji
    color: '#336699',                   // card accent color
    diskGB: 5,                          // shown as "~5 GB" in the wizard
    steamAppId: '123456',               // Steam dedicated server app ID
    downloadMethod: 'steamcmd',         // always 'steamcmd' for new Steam games
    form: [
        // Each entry becomes a form field in Step 2 of the wizard.
        // Supported types: text, password, number, select, file-picker, select-async
        { id: 'serverName', label: 'Server Name', type: 'text', placeholder: 'My Server', required: true },
        { id: 'port',       label: 'Game Port',   type: 'number', default: 7777 },
    ],
    rsm: {
        // These values become the server entry written to RSM's servers.json.
        // All fields accept a plain value OR a function (formData, installDir, installerResult) => value.
        type: 'my-game',
        category: 'DIRECT_CONSOLE',         // or 'POWERSHELL_BRIDGE' for .bat / indirect launches
        playerListCommand: null,            // RCON command RSM uses to list players, or null
        path:       (f, dir) => `${dir}\\MyGameServer.exe`,
        workingDir: (f, dir) => dir,
        args:       (f, dir) => `-port ${f.port || 7777}`,
        apiPort:    (f) => String(f.port || 7777),
        apiPass:    (f) => '',
        logPath:    (f, dir) => `${dir}\\logs`,
    }
},
```

#### Form field types

| type | Notes |
|---|---|
| `text` | Plain text input. Use `placeholder` and optionally `hint` (shown below the field). |
| `password` | Masked input. |
| `number` | Numeric input. Supports `default`, `min`, `max`. |
| `select` | Dropdown. Requires `options: [...]` array. Supports `default`. |
| `file-picker` | Text + Browse button. Opens a file dialog. |
| `select-async` | Dropdown populated at runtime via `fetchKey`. Currently only `minecraft-versions` and `forge-versions` are wired. |

#### RSM categories

| category | When to use |
|---|---|
| `DIRECT_CONSOLE` | `path` is an `.exe` that runs in its own console (most games) |
| `POWERSHELL_BRIDGE` | `path` is a `.bat`/`.cmd` or requires PowerShell to wrap the launch (ARK, Space Engineers, Project Zomboid) |

### Step 2 — Route the install in `main.js`

Open [main.js](main.js) and find the `performInstall` switch. Add a case for your game ID:

```js
case 'my-game':
    await steam.installApp('123456', installDir, onProgress, onLog, signal);
    return {};
```

If the game requires a config file generated after download, also add a block to `writeGameConfig`:

```js
if (gameId === 'my-game') {
    writeMyGameConfig(installDir, formData);
}
```

Then implement the writer function in `main.js`:

```js
function writeMyGameConfig(installDir, f) {
    const cfg = `[Server]\nName=${f.serverName}\nPort=${f.port || 7777}\n`;
    fs.writeFileSync(path.join(installDir, 'server.ini'), cfg, 'utf8');
}
```

### Step 3 — Done

Restart the app with `npm start`. The game appears on the selection grid immediately.

---

## Code Style

- No TypeScript — plain Node.js / browser JS
- No framework in the renderer — vanilla DOM with `document.createElement`
- No comments explaining *what* code does — names should be self-explanatory; comments are only for non-obvious *why*
- `const` by default, `let` only when reassigned
- Template literals for multi-line strings (config file content, XML)
- `async/await` throughout — no raw `.then()` chains
- Errors surface as `{ success: false, error: message }` objects back to the renderer

---

## Pull Request Guidelines

1. Keep PRs focused — one feature or fix per PR
2. If adding a game, include the `games.js` definition and `main.js` routing in the same PR
3. Test the full install wizard for your change before opening a PR
4. PR title format: `feat: add <GameName> server support` or `fix: <short description>`

---

## Reporting Issues

Open an issue on GitHub with:
- OS version
- What you were doing when the problem occurred
- The install log output (shown in Step 5 of the wizard) if relevant
