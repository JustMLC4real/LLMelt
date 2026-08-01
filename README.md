<p align="center">
  <img src="./public/icon.png" width="128" height="128" alt="LLMelt logo">
</p>

<h1 align="center">LLMelt</h1>

<p align="center">
  <strong>Your AI accounts, coding agents and local models in one Windows workspace.</strong>
  <br>
  Chat with them, let them use real tools with your approval, and switch providers without switching apps.
</p>

<p align="center">
  <a href="https://github.com/JustMLC4real/LLMelt/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/JustMLC4real/LLMelt?display_name=tag&sort=semver&style=flat-square&color=7c5cff"></a>
  <img alt="Windows" src="https://img.shields.io/badge/platform-Windows-21a9e1?style=flat-square">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-43-47848f?style=flat-square">
  <img alt="React" src="https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=10151d">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/github/license/JustMLC4real/LLMelt?style=flat-square&color=38b2ac"></a>
</p>

<p align="center">
  <a href="https://github.com/JustMLC4real/LLMelt/releases/latest"><strong>Download for Windows</strong></a>
  ·
  <a href="./docs/README.md">Documentation</a>
  ·
  <a href="#safety-by-design">Safety</a>
  ·
  <a href="#development">Development</a>
</p>

---

LLMelt is a Windows desktop app for working with several AI providers through one consistent chat and agent interface. It can use a signed-in ChatGPT session, native coding CLIs, paid APIs and fully local Ollama models. Each conversation remembers its provider, model, project, permissions and tool history.

<p align="center">
  <img src="./docs/assets/readme/chat-demo.gif" width="100%" alt="Starting a new LLMelt chat with Claude Opus 4.6 through Antigravity CLI">
</p>

## Everything stays in one workflow

Start a conversation, pick the exact provider and model you want, and keep the prompt, tool activity and answer together.

| | What LLMelt adds |
|---|---|
| **One model picker** | Live provider catalogs instead of a hard-coded model list. Choose model, effort and speed where the provider exposes them. |
| **Real agent tools** | Read, create and edit project files, run commands, inspect diffs and keep tool activity beside the answer. |
| **Approval controls** | Ask for every action, automatically allow workspace-safe file work, or explicitly grant full access per chat. |
| **Automatic fallback** | Continue with the next configured model when a provider is exhausted or temporarily unavailable. Paid API fallback is opt-in. |
| **Usage dashboard** | Track context usage, token totals and provider quota windows when the provider exposes reliable machine-readable data. |
| **Projects and terminals** | Keep chats grouped by project and use resizable PowerShell terminals without leaving the app. |
| **Local-first option** | Ollama runs on your own machine and has no external provider quota. |

## A guided first start

The onboarding flow checks what is already installed, lets you choose what you actually want to use and opens official installers or login flows only after you ask it to.

<p align="center">
  <img src="./docs/assets/readme/tour.gif" width="100%" alt="Animated walkthrough of the LLMelt onboarding flow">
</p>

<details>
  <summary>View the full-resolution screenshots</summary>
  <br>
  <p align="center">
    <img src="./docs/assets/readme/provider-check.png" width="100%" alt="LLMelt detects installed providers during onboarding">
  </p>
  <p align="center">
    <img src="./docs/assets/readme/welcome.png" width="49%" alt="LLMelt welcome screen">
    <img src="./docs/assets/readme/providers.png" width="49%" alt="LLMelt provider onboarding screen">
  </p>
</details>

<sub>Screenshots are generated from a clean, isolated app profile with <code>npm run capture:readme</code>; no personal chats, credentials or settings are included.</sub>

## Supported providers

LLMelt does not pretend that every provider works the same way. It uses the closest supported integration for each one and keeps file, command and approval policy in the app.

| Provider | Connection | Agent tools | Usage / limits |
|---|---|---|---|
| **ChatGPT** | Signed-in ChatGPT web session; no API key required | LLMelt tool loop | Runtime limit detection; ChatGPT does not expose a supported subscription counter |
| **OpenAI API** | API key | LLMelt tool loop | API usage returned by the provider where available |
| **Codex** | Native Codex CLI login | Native Codex tools and app approvals | Live Codex account rate-limit windows |
| **Claude** | Claude Code CLI or Anthropic API | Native Claude tools and app approvals | CLI statusline windows when Claude exposes them |
| **Gemini** | Gemini Developer API key + Google Cloud project | Native function calling and app approvals | Cloud quota and monitoring data |
| **Antigravity** | Antigravity CLI | Native CLI hooks and app approvals | Statusline data where exposed; runtime limit detection otherwise |
| **Ollama** | Local Ollama server | Native function calling for compatible models | Local model; no provider subscription quota |
| **Remote** | SSH to your own Ollama host | Remote model execution | Depends on your remote host |

Provider accounts, subscriptions and API charges are not included with LLMelt.

## Safety by design

Giving an AI access to a real project is powerful, so the permission boundary is visible and configurable:

- **Ask mode** requests approval for each file or command action. Clicking outside an approval postpones it instead of silently denying it.
- **Workspace mode** automatically allows validated file operations inside the selected project while commands still require approval.
- **Full access** is explicit, per chat and clearly marked as risky.
- Renderer code runs with Electron sandboxing and context isolation; external links open outside the privileged app window.
- API keys and remote credentials are protected with Electron `safeStorage` / Windows DPAPI.
- File paths and shell requests pass through the central validation and approval layer, including native provider tools.

Read the implementation details in [Agent tools and approvals](./docs/06-agent-tools.md) and [Provider integrations](./docs/04-providers.md).

## Install

1. Download the newest `LLMelt-Setup-*.exe` from [GitHub Releases](https://github.com/JustMLC4real/LLMelt/releases/latest).
2. Run the installer and start LLMelt.
3. Let the onboarding guide detect your existing accounts, CLIs and local models.
4. Select only the providers you want to connect.

> [!IMPORTANT]
> Current Windows builds are not code-signed. Windows SmartScreen may therefore show an "Unknown publisher" warning. Verify that the installer comes from this repository's Releases page before running it.

Updates are downloaded from this repository's GitHub Releases and installed only after you choose to install the ready update.

## How it fits together

```mermaid
flowchart LR
    UI["React chat UI"] --> Main["Electron main process"]
    Main --> Policy["Projects, approvals and tool events"]
    Main --> Web["ChatGPT web session"]
    Main --> CLI["Codex · Claude · Antigravity CLIs"]
    Main --> API["OpenAI · Anthropic · Gemini APIs"]
    Main --> Local["Local or remote Ollama"]
    Policy --> Files["Files · commands · diffs · terminal"]
```

- **Desktop:** Electron 43
- **UI:** React 19, TypeScript, Vite and Zustand
- **Data:** Node's built-in SQLite with WAL
- **Providers:** provider-specific adapters behind one shared streaming contract
- **Release:** electron-builder and GitHub Releases

The full code-oriented tour starts at [AGENTS.md](./AGENTS.md). The documentation index is in [docs/README.md](./docs/README.md).

## Development

Requirements: Windows, Node.js 24 and npm.

```powershell
git clone https://github.com/JustMLC4real/LLMelt.git
cd LLMelt
npm ci
npm run dev
```

Useful checks:

```powershell
npm run lint             # ESLint
npm test                 # logic, fresh-start and security tests
npm run build            # TypeScript + Vite build
npm run package          # Windows NSIS installer
npm run capture:readme   # refresh the safe README screenshots
npm run capture:readme:chat # record the live Antigravity chat demo (uses account quota)
```

The live provider tests are opt-in because they may use local accounts or paid API quota. See [Build and release](./docs/08-build-release.md) before publishing a version.

## Current scope

- Windows is the supported desktop platform today.
- Provider features depend on the provider's current CLI, account and API capabilities.
- LLMelt is an independent project and is not affiliated with OpenAI, Anthropic, Google or Ollama.

## License

[MIT](./LICENSE) © Justin Laponder
