# Ronin Forge

A Windows desktop application for provisioning and configuring game server installations. Ronin Forge walks you through selecting a game, downloading the server files, and writing a ready-to-run configuration — then optionally exports the result directly into [Ronin Server Manager](https://github.com/t0xicVybez/Ronin-Server-Manager).

---

## Features

- **15 supported game servers** — Minecraft (Vanilla/Forge/Fabric), ARK SE/ASA, Space Engineers, Terraria, Valheim, Rust, Project Zomboid, 7 Days to Die, Conan Exiles, Palworld, V Rising, Satisfactory
- **Guided 6-step wizard** — select game → choose install path → configure → review → install → done
- **Automatic SteamCMD management** — downloads, initialises, and runs SteamCMD silently
- **Live install progress** — real-time progress bar and log output during download
- **Config file generation** — writes game-specific config files with your settings
- **RSM integration** — detects Ronin Server Manager and injects the server entry directly, or exports a portable JSON file
- **Cancellable installs** — AbortController signal propagated to every spawned subprocess
- **Frameless dark UI** — custom titlebar, purple/green GitHub-dark palette

---

## Supported Games

| Game | Method | Steam App ID | Approx. Size |
|---|---|---|---|
| Minecraft Java | Mojang API | — | 1 GB |
| Minecraft Forge | Forge Maven | — | 3 GB |
| Minecraft Fabric | Fabric Maven | — | 2 GB |
| ARK: Survival Evolved | SteamCMD | 376030 | 25 GB |
| ARK: Survival Ascended | SteamCMD | 2430930 | 60 GB |
| Space Engineers | SteamCMD | 298740 | 15 GB |
| Terraria | SteamCMD | 105600 | 1 GB |
| Valheim | SteamCMD | 896660 | 1 GB |
| Rust | SteamCMD | 258550 | 5 GB |
| Project Zomboid | SteamCMD | 108600 | 2 GB |
| 7 Days to Die | SteamCMD | 294420 | 10 GB |
| Conan Exiles | SteamCMD | 443030 | 50 GB |
| Palworld | SteamCMD | 2394010 | 5 GB |
| V Rising | SteamCMD | 1829350 | 2 GB |
| Satisfactory | SteamCMD | 1690800 | 5 GB |

All SteamCMD installs use anonymous login and require no Steam account.

---

## Requirements

- **Windows 10/11** (64-bit)
- **Node.js 18+** (for development)
- **Java** (required for Minecraft servers — select the path in the wizard)
- An active internet connection during installation

---

## Getting Started (Development)

```bash
git clone https://github.com/t0xicVybez/ronin-forge.git
cd ronin-forge
npm install
npm start
```

### Building a distributable

```bash
npm run dist
```

Produces an NSIS installer under `dist/`. The app is Windows-only.

---

## Project Structure

```
ronin-forge/
├── main.js                   # Electron main process — IPC handlers, installers, config writers
├── preload.js                # Context-isolated IPC bridge
├── public/
│   ├── index.html            # Wizard shell (6 steps)
│   ├── renderer.js           # Frontend state machine
│   ├── styles.css            # Dark theme styles
│   └── configs/
│       └── games.js          # All game definitions and RSM mappings
└── src/
    ├── downloader.js         # Axios stream downloader
    ├── steamcmd.js           # SteamCMD lifecycle management
    ├── minecraft-installer.js # Vanilla / Forge / Fabric installers
    └── rsm-integration.js    # Ronin Server Manager file integration
```

See [docs/architecture.md](docs/architecture.md) for a full walkthrough of the code flow.

---

## RSM Integration

When Ronin Server Manager is installed, Ronin Forge detects it automatically via its AppData directory and offers a one-click **Add to RSM** button on the completion screen. If RSM is not present, you can export the server entry as a JSON file and import it manually later.

RSM candidate paths checked (in order):
1. `%APPDATA%\Ronin-Server-Manager`
2. `%APPDATA%\Ronin Server Manager`
3. `%APPDATA%\ronin-server-manager`

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up your environment, add new games, and submit pull requests.

---

## License

MIT
