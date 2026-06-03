# Adding a New Game

This is a step-by-step reference for adding a new game server to Ronin Forge. The full process requires editing two files: `public/configs/games.js` and `main.js`.

---

## Before You Start

You need:

1. The **Steam dedicated server App ID** — find it on SteamDB or the game's official server docs.
2. The **executable path** relative to the install directory (e.g. `MyGame\Binaries\Win64\MyServer.exe`).
3. The **launch arguments** the server needs.
4. Whether the server has a **config file** that must be written before it can start.

Confirm the dedicated server supports anonymous SteamCMD login. Most free dedicated server tools do. If the game requires a purchased copy (Steam account login), the current anonymous-only SteamCMD client cannot install it without additional work.

---

## Step 1 — Research the server binary

Install the server manually via SteamCMD once to confirm the install layout:

```
steamcmd +force_install_dir C:\TestInstall +login anonymous +app_update <appId> validate +quit
```

Then find:
- The main server executable path
- What arguments it accepts (`--help` or official docs)
- Whether it reads a config file (and where it expects it)
- Whether it has RCON or another remote management port

---

## Step 2 — Add the game definition

Open [public/configs/games.js](../public/configs/games.js) and add a new entry to the `window.GAMES` array before the closing `];`.

### Minimal template (args-only game)

```js
{
    id: 'my-game',
    displayName: 'My Game',
    description: 'One-line description for the game card',
    icon: '🎮',
    color: '#336699',
    diskGB: 5,
    steamAppId: '123456',
    downloadMethod: 'steamcmd',
    form: [
        { id: 'serverName', label: 'Server Name', type: 'text', placeholder: 'My Server', required: true },
        { id: 'port',       label: 'Game Port',   type: 'number', default: 7777 },
        { id: 'maxPlayers', label: 'Max Players', type: 'number', default: 16, min: 1, max: 64 },
        { id: 'serverPass', label: 'Password',    type: 'password', placeholder: 'Leave blank for public' },
    ],
    rsm: {
        type: 'my-game',
        category: 'DIRECT_CONSOLE',
        playerListCommand: null,
        path:       (f, dir) => `${dir}\\MyGameServer.exe`,
        workingDir: (f, dir) => dir,
        args:       (f, dir) => `-port ${f.port || 7777} -maxplayers ${f.maxPlayers || 16}`,
        apiPort:    (f) => '',
        apiPass:    (f) => '',
        logPath:    (f, dir) => `${dir}\\logs`,
    }
},
```

### Form field reference

| Property | Required | Notes |
|---|---|---|
| `id` | yes | Used as the `formData` key. Must be unique within the game's form array. |
| `label` | yes | Shown above the input. |
| `type` | yes | See types below. |
| `required` | no | Shows `*` label and blocks progression if empty. |
| `placeholder` | no | Input placeholder text (`text`/`password`/`file-picker` only). |
| `hint` | no | Small text below the field (e.g. where to get a license key). |
| `default` | no | Pre-filled value (`number` and `select` only). |
| `min` / `max` | no | Numeric bounds (`number` type only). |
| `options` | yes (select) | Array of string options. First is selected unless `default` is set. |
| `fetchKey` | yes (select-async) | Key for async data loader. Only `minecraft-versions` and `forge-versions` are built in. |
| `dependsOn` | no | Another field ID. Used by `forge-versions` to reload when `mcVersion` changes. |

#### Field types

- **`text`** — plain text input
- **`password`** — masked input
- **`number`** — numeric input with `default`, `min`, `max`
- **`select`** — dropdown from `options` array
- **`file-picker`** — text field + Browse button (opens OS file dialog)
- **`select-async`** — dropdown populated asynchronously by `fetchKey`

### RSM mapping reference

All `rsm` values can be a static string/value or a function with signature:

```js
(formData, installDir, installerResult) => string
```

| Field | Purpose |
|---|---|
| `type` | Game type string stored in RSM's servers.json |
| `category` | `DIRECT_CONSOLE` (exe) or `POWERSHELL_BRIDGE` (.bat or indirect launch) |
| `playerListCommand` | RCON/console command RSM issues to count players, or `null` |
| `path` | Absolute path to the server executable |
| `workingDir` | Working directory for the process |
| `args` | Launch arguments string |
| `apiPort` | RCON/Telnet port, or `''` if not applicable |
| `apiPass` | RCON/Telnet password, or `''` |
| `logPath` | Path to log file or directory, or `''` |

---

## Step 3 — Route the install in `main.js`

Open [main.js](../main.js) and find the `performInstall` function. Add a `case` for your game ID:

```js
case 'my-game':
    await steam.installApp('123456', installDir, onProgress, onLog, signal);
    return {};
```

The return value becomes `installerResult` in the renderer (accessible in RSM `rsm` functions as the third argument). Return `{}` for SteamCMD games — there is nothing meaningful to return.

---

## Step 4 — Write a config file (if needed)

If the game requires a config file to exist before it will start, add it to `writeGameConfig` in `main.js`:

```js
if (gameId === 'my-game') {
    writeMyGameConfig(installDir, formData);
}
```

Then add the writer function. Keep it simple — generate only the fields the game actually requires:

```js
function writeMyGameConfig(installDir, f) {
    const cfg = [
        `[Server]`,
        `Name=${f.serverName || 'My Server'}`,
        `Password=${f.serverPass || ''}`,
        `Port=${f.port || 7777}`,
        `MaxPlayers=${f.maxPlayers || 16}`,
    ].join('\n');

    fs.writeFileSync(path.join(installDir, 'server.ini'), cfg, 'utf8');
}
```

For XML configs follow the pattern in `writeSEConfig` or `write7DTDConfig` in `main.js`.

---

## Step 5 — Test

1. Run `npm start`
2. Select your game from the grid
3. Fill in the form fields
4. Complete the install wizard end-to-end
5. Verify the server launches from the install directory with the generated args

If the game needs RSM integration tested, export the JSON and check that the fields are correct before importing into RSM.

---

## Common Patterns

### Game with separate RCON port

```js
form: [
    { id: 'port',         label: 'Game Port',   type: 'number', default: 27015 },
    { id: 'rconPort',     label: 'RCON Port',   type: 'number', default: 27025 },
    { id: 'rconPassword', label: 'RCON Password', type: 'password', required: true },
],
rsm: {
    apiPort: (f) => String(f.rconPort || 27025),
    apiPass: (f) => f.rconPassword || '',
}
```

### Game launched via batch file

```js
rsm: {
    category: 'POWERSHELL_BRIDGE',
    path: (f, dir) => `${dir}\\StartServer.bat`,
    workingDir: (f, dir) => dir,
    args: (f, dir) => `-servername "${f.serverName}"`,
}
```

### Nested executable path

```js
rsm: {
    path: (f, dir) => `${dir}\\GameServer\\Binaries\\Win64\\GameServer.exe`,
    workingDir: (f, dir) => `${dir}\\GameServer\\Binaries\\Win64`,
}
```
