# Lightfall

<div align="center">

**A beautiful liquid-glass music player that lives gracefully at the top of your desktop.**

![Electron](https://img.shields.io/badge/Electron-45.3.4-47848F?logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-All-0078D4?logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow.svg)

[Features](#features) • [Quick Start](#quick-start) • [How to Use](#how-to-use) • [Architecture](#architecture) • [Current Limitations](#current-limitations) • [Contributing](#contributing)

</div>

---

## Overview

**Lightfall** is a compact desktop music player built with Electron. It combines an animated Dynamic Island-style interface, a live refractive desktop backdrop, embedded artwork, keyboard controls, and useful battery awareness in one polished, always-on-top experience.

The interface stays minimal until you need it: hover over the top-edge island to reveal the full player, controls, progress, and artwork.

## Features

### Visual experience

- **Liquid-glass design** rendered with a custom WebGL shader
- **Live refractive backdrop** that reflects a captured view of the desktop
- **Dynamic expansion** with smooth, responsive hover animations
- **Compact mini-player** for discreet playback and progress tracking
- **System Manager tab** with live CPU and RAM usage, GPU model/driver details, ACPI temperature sensors, NVIDIA GPU temperature when available, and Lightfall process usage
- **Charging pop-ups** with clear power-state notifications
- **Camera activity pop-ups** when an app starts or stops using the webcam
- **Adaptive battery indicator** with charging status
- **Frameless, transparent, always-on-top window**

### Music playback

- Open and play multiple local audio files at once
- Full play, pause, previous, next, and close controls
- **Shuffle** for a fresh listening order
- **Repeat All** and **Repeat One** playback modes
- Session favorites with clear visual feedback
- Interactive waveform and mini progress bar
- Seek forward or backward by 5 seconds
- Automatic playlist progression
- Separate mini-player controls for quick access

### Supported formats

Lightfall uses the native HTML audio engine and supports the file types offered by the Electron file picker:

`MP3` · `M4A` · `M4B` · `MP4` · `FLAC` · `WAV` · `OGG` · `OPUS` · `AAC` · `WEBM`

> Native playback support can vary slightly with the installed system and audio codec.

### Metadata and artwork

- Reads embedded title and artist tags
- Displays embedded album artwork
- Supports artwork and metadata from:
  - **ID3** tags in MP3 files
  - **Vorbis comments** and picture blocks in FLAC files
  - **MP4 metadata** atoms in M4A, M4B, and MP4 files
- Uses a friendly filename fallback such as `Artist - Title` or `Local file`

### Desktop and system integration

- Windows battery level and charging-state integration
- Live Windows camera-use monitoring with application names and island notifications
- Power monitor notifications for AC/battery transitions
- Screen-centered, top-aligned window
- Windows content protection for the app window
- Precise click-region shaping on Windows and Linux
- Electron Forge packaging for Windows, Linux, and macOS targets

## How to Use

1. Launch **Lightfall**.
2. Click the album-art area or press **Ctrl+O**.
3. Select one or more local audio files.
4. Hover over the top island to expand it, then switch between **Music** and **Manager**.
5. Use the Music controls or keyboard shortcuts to manage playback; Manager metrics refresh while that tab is visible.

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+O` / `Cmd+O` | Open music files |
| `Space` | Play or pause |
| `Arrow Left` | Seek backward 5 seconds |
| `Arrow Right` | Seek forward 5 seconds |
| `Enter` / `Space` on album art | Open music files |
| `Arrow Left` / `Arrow Right` on progress | Seek in 5-second steps |

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer
- npm
- Windows 10/11 for the complete Windows-focused experience

### Install and run

```bash
npm install
npm start
```

### Package the app

```bash
npm run package
```

### Create distributable installers

```bash
npm run make
```

Electron Forge output is generated in the platform-specific `out/` directory.

## Architecture

```text
src/
├── main.js       # Electron lifecycle, window, IPC, metadata, battery, camera activity, capture
├── preload.js    # Secure context bridge for renderer APIs
├── index.html    # Player structure
├── index.css     # Dynamic Island and liquid-glass styling
└── index.js      # WebGL renderer, playback, controls, and interactions
```

### Core technologies

- **Electron** for the native desktop shell
- **Electron Forge** for development and distribution
- **Vanilla JavaScript** for a lightweight renderer
- **WebGL** for the live refractive visual effect
- **HTML5 Audio** for local playback
- **PowerShell / Electron powerMonitor** for Windows battery awareness

### Security boundaries

- Node integration is disabled in the renderer.
- The preload script exposes only a small, focused API.
- Music-file IPC is restricted to the main application window.
- Electron Fuses disable Node options, CLI inspection, and direct Node execution at runtime.
- Windows content protection helps prevent the app window from being captured by common capture tools.

## Current Limitations

Lightfall is a focused, local-first player. These boundaries keep the project lightweight and create clear opportunities for future growth.

| Area | Current state | Positive perspective |
|---|---|---|
| Library management | Files are loaded as a temporary session playlist | Fast, private listening with no library database required |
| Favorites | Stored in memory for the current session | Simple and private, with an ideal foundation for persistent storage |
| Persistence | Playlist and playback position reset after closing | A clean start every time the app launches |
| Battery status | Windows PowerShell reporting is the primary integration | Accurate status on Windows laptops, with graceful handling elsewhere |
| Platform UI | Window shaping is enabled for Windows and Linux | Core desktop behavior is portable, while the current polish is centered on Windows |
| Desktop backdrop | Captures the desktop periodically for the glass effect | Delivers a live effect while keeping WebGL processing contained |
| Metadata | Reads a selected set of embedded tags | Strong support for common MP3, FLAC, M4A, M4B, and MP4 formats |
| Audio formats | Depends on Electron/Chromium codec support | Covers many popular local formats without external dependencies |
| Content protection | Enables Windows screen protection | Provides stronger privacy on supported Windows systems |
| Networking | No streaming or online catalog | Fully local playback with no account or cloud dependency |

## Project Goals

- Keep the interface focused and visually distinctive.
- Protect user privacy with local-first playback.
- Use the smallest practical code and dependency surface.
- Make desktop interactions feel direct and tactile.
- Leave clear extension points for playlists, persistence, and richer metadata.

## Contributing

Contributions are welcome.

1. Fork the repository.
2. Create a feature branch.
3. Make a focused, tested change.
4. Open a pull request with screenshots or a short demo for visual changes.

Before opening a pull request, verify the player at minimum with:

- Multi-file selection
- Play, pause, previous, and next
- Shuffle and both repeat modes
- Progress seeking
- MP3, FLAC, or M4A metadata
- Window expansion and battery notifications

## License

This project declares the **MIT License** in `package.json`.

---

<div align="center">

**Lightfall — your music, reflected beautifully.**

</div>
