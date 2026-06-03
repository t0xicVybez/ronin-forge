# Architecture

Ronin Forge is an Electron application with a hard process boundary between the main process (Node.js, full OS access) and the renderer process (browser sandbox). All privileged work happens in the main process; the renderer only renders UI and triggers actions via IPC.

---

## Process Diagram

```
┌─────────────────────────────────────────────┐
│  Renderer (browser sandbox)                 │
│  public/index.html  ◄──► public/renderer.js │
│  public/configs/games.js  (window.GAMES)    │
└──────────────┬──────────────────────────────┘
               │  contextBridge / ipcRenderer
               │  (channel whitelist in preload.js)
┌──────────────▼──────────────────────────────┐
│  Main Process (Node.js)                     │
│  main.js — ipcMain handlers                 │
│  ├── src/steamcmd.js                        │
│  ├── src/minecraft-installer.js             │
│  └── src/rsm-integration.js                 │
└─────────────────────────────────────────────┘
```

---

## IPC Channels

### Renderer → Main (invoke, bidirectional)

| Channel | Payload | Returns |
|---|---|---|
| `select-folder` | `{ title?, defaultPath? }` | `string \| null` |
| `select-file` | `{ title?, filters? }` | `string \| null` |
| `open-folder` | `folderPath: string` | `void` |
| `check-rsm-installed` | — | `boolean` |
| `get-minecraft-versions` | — | `string[]` |
| `get-forge-versions` | `mcVersion: string` | `{ id, label }[]` |
| `find-java` | — | `string[]` (absolute paths to java.exe) |
| `start-install` | `{ gameId, installDir, formData }` | `{ success, installerResult?, error?, cancelled? }` |
| `write-to-rsm` | `serverEntry` | `{ success }` |
| `export-server-json` | `serverEntry` | `{ success, exportPath? }` |

### Renderer → Main (send, one-way)

| Channel | Payload |
|---|---|
| `window-minimize` | — |
| `window-close` | — |
| `cancel-install` | — |

### Main → Renderer (send, one-way)

| Channel | Payload | Purpose |
|---|---|---|
| `install-progress` | `{ stage, percent, message }` | Updates progress bar |
| `install-log` | `string` | Appends to the install log textarea |

---

## Install Flow

```
renderer: api.invoke('start-install', { gameId, installDir, formData })
  │
  ▼
main.js: ipcMain.handle('start-install')
  │  creates AbortController, wires cancel-install listener
  │
  ├─► performInstall(gameId, ...) — switch on gameId
  │     ├── Minecraft → minecraft-installer.js (installVanilla / installForge / installFabric)
  │     └── SteamCMD games → steamcmd.js (installApp)
  │
  ├─► writeGameConfig(gameId, ...) — writes game-specific config files
  │     ├── Minecraft    → server.properties (via minecraft-installer.js)
  │     ├── ARK          → GameUserSettings.ini
  │     ├── Space Eng.   → SpaceEngineers-Dedicated.cfg (XML)
  │     └── 7 Days to Die → serverconfig.xml
  │
  └─► returns { success: true, installerResult }
        │
        ▼
renderer: showComplete() — presents RSM / JSON export options
```

---

## SteamCMD Lifecycle

`src/steamcmd.js` is self-managing:

1. **ensureSteamCMD** — checks for `steamcmd.exe` in `%LOCALAPPDATA%\RoninForge\SteamCMD`. If missing, downloads `steamcmd.zip` from the official Valve CDN, extracts it, and runs `+quit` once to let SteamCMD self-update.
2. **installApp(appId, dir, ...)** — calls `steamcmd.exe +force_install_dir <dir> +login anonymous +app_update <appId> validate +quit`. Parses stdout for state codes and progress percentages to emit `install-progress` events.
3. **AbortController** — the `signal` parameter is wired to `proc.kill('SIGKILL')` so the user can cancel mid-download.

SteamCMD exit code 7 ("already up to date") is treated as success.

---

## Minecraft Installer

`src/minecraft-installer.js` handles three variants:

| Variant | Source | Java required |
|---|---|---|
| Vanilla | `piston-meta.mojang.com` — version manifest → server.jar URL | Yes (to run) |
| Forge | `files.minecraftforge.net` Maven — downloads installer jar, spawns Java to run it | Yes (to install and run) |
| Fabric | `meta.fabricmc.net` — fetches installer version, runs `java -jar fabric-installer.jar server -mcversion <v> -downloadMinecraft` | Yes (to install and run) |

All three write `eula.txt` with `eula=true` and call `writeServerProperties()` (from `main.js`) to produce `server.properties`.

---

## RSM Integration

`src/rsm-integration.js` checks three AppData path candidates for Ronin Server Manager's user data directory (handling different productName values across RSM versions). It reads `servers.json`, upserts the new entry by `id`, and writes it back. If RSM is not installed, the entry can be exported as a standalone JSON file via `export-server-json`.

The server entry schema (as written to `servers.json`):

```json
{
    "id": "1717890000000",
    "name": "My Server",
    "type": "minecraft",
    "category": "DIRECT_CONSOLE",
    "path": "C:\\Servers\\mc\\java.exe",
    "workingDir": "C:\\Servers\\mc",
    "args": "-Xmx4G -Xms4G -jar server.jar nogui",
    "playerListCommand": "list",
    "apiPort": "25575",
    "apiPass": "rconpassword",
    "logPath": "C:\\Servers\\mc\\logs",
    "status": "Offline",
    "pid": null,
    "logs": ""
}
```

---

## Game Definition Schema (`games.js`)

Each entry in `window.GAMES` describes everything Ronin Forge needs to install and configure a game:

```
{
    id            string       — unique kebab-case identifier, used as the routing key in main.js
    displayName   string       — shown in the UI
    description   string       — shown on the game card
    icon          string       — emoji
    color         string       — hex card accent
    diskGB        number       — displayed disk estimate
    steamAppId    string?      — Steam app ID (omitted for Minecraft)
    downloadMethod string      — 'steamcmd' | 'minecraft-vanilla' | 'minecraft-forge' | 'minecraft-fabric'
    form          FieldDef[]   — drives the dynamic config form in Step 2
    rsm           RsmMapping   — drives the RSM entry built in renderer.js buildRSMEntry()
}
```

`rsm` fields accept either a static value or a function `(formData, installDir, installerResult) => value`, evaluated in the renderer at completion time.
