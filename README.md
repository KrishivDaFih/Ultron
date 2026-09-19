# ULTRON — Sentinel Core

v1.0.1 — no system tray: closing the window quits.

Desktop assistant console. Electron, Windows x64.
Providers: **Groq**, OpenAI, Anthropic. Real machine control. No native modules.

---

## Install

Run `Ultron-Setup-1.0.1.exe`. It is a normal NSIS installer — choose the folder,
get a Start Menu entry and a desktop shortcut. Installs per-user, so no admin
prompt.

Windows SmartScreen will warn that the publisher is unknown. That is expected:
the installer is unsigned, because a code-signing certificate costs money and
you are the only user. Click **More info → Run anyway**.

## First run

1. Open Settings (⚙ in the titlebar, or the tray icon).
2. Pick a provider. **Groq** is the default — free tier, very fast.
   - Groq key: `console.groq.com` → API Keys (starts `gsk_`)
   - OpenAI key: `platform.openai.com` → API Keys
   - Anthropic key: `console.anthropic.com` → API Keys
3. Paste the key, press Tab so it saves.
4. Click **Fetch** next to Model. It asks the provider which models your key can
   actually use and fills the dropdown. Pick one.

Keys live in `%APPDATA%\Ultron\settings.json` in plain text, on your machine
only. Nothing is sent anywhere except the provider you chose.

## Controls

| Key | Does |
|---|---|
| `Ctrl+Shift+U` | Summon from anywhere, or minimise if focused (rebindable) |
| `Enter` | Transmit |
| `Shift+Enter` | Newline |
| `Esc` | Abort a running answer, or close a modal |
| `Ctrl+K` | Focus the input |

Closing the window quits Ultron — there is no tray icon and nothing left
running in the background. The global hotkey minimises the window rather than
hiding it, so the taskbar entry is always there to bring it back.

## Directive protocols

- **OBSERVE** — one to three sentences, nothing else.
- **ASSIST** — default. Full technical depth, comparisons before conclusions.
- **DISSECT** — answers, then attacks its own answer: assumptions, failure
  modes, the option you did not consider. Use this on real decisions.

## Machine access

With **Machine access** on, Ultron can act on this PC instead of guessing:

| Tool | Gated? |
|---|---|
| `system_info` — OS, CPU, RAM, GPU, disk | auto |
| `list_dir`, `read_file` | auto |
| `open_target` — URL, file, folder, app | auto |
| `screen_capture` | auto |
| `type_text`, `press_keys`, `mouse` | auto |
| `clipboard` read/write | auto |
| **`write_file`** | **asks first** |
| **`run_command`** — PowerShell | **asks first** |

The two destructive ones raise an amber authorisation panel showing the exact
payload and Ultron's stated reason. Deny is fed back as "do not retry, propose
something else". You can turn the prompts off in Settings; do not.

Everything is PowerShell and Electron built-ins — no native modules, so nothing
breaks on a Node or Windows update.

## Voice

Text-to-speech (Speak replies aloud) uses Windows SAPI and works.

Speech *input* and the wake word depend on a platform speech engine that
Electron usually cannot reach. If the mic never arms, that is why — the app
tells you plainly instead of pretending. Text input is unaffected.

## Building from source

```
npm install
npm start          # run it
npm run dist       # build Ultron-Setup-<version>.exe into dist/
```

On Windows this takes about a minute and needs nothing extra.

## Layout

```
src/main/main.js        window, tray, hotkey, agent loop, IPC
src/main/providers.js   Groq / OpenAI / Anthropic streaming + tool calls
src/main/tools.js       machine control, PowerShell-backed
src/main/store.js       settings.json + history.json
src/main/preload.js     context bridge
src/renderer/           HUD: core, telemetry, transcript, settings
build/make_assets.py    regenerates icon.ico and the installer art
```

Data folder: `%APPDATA%\Ultron` — `settings.json`, `history.json`, `captures/`.
