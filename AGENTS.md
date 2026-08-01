# AGENTS.md — instappunt voor AI-agents

Dit bestand is het startpunt voor elke AI (en mens) die aan **LLMelt** werkt.
Lees dit eerst, dan de mappen `docs/`. Alles is gegrond in de echte code; waar het
kan staan er `bestand:regel`-verwijzingen bij.

## Wat is dit?

Een **Electron desktop-app (Windows)** die meerdere AI-aanbieders in één chat-UI
samenbrengt: ChatGPT (browser-websessie), Codex CLI, Claude CLI, Google Gemini
(Developer API), Antigravity CLI, Ollama (lokaal) en een Remote/SSH-optie. Je kiest per
chat een model, praat ermee, en kunt de AI (met goedkeuring) **echte bestanden en
commando's op de PC** laten uitvoeren in een projectmap.

- Frontend: **React 19 + TypeScript + Vite**, state via **Zustand**.
- Backend (Electron main): **TypeScript**, data in Node's ingebouwde **SQLite** (`node:sqlite`).
- Taal van de UI en van commit-/codecommentaar: **Nederlands** (zie `src/i18n/`).

## Techniek in één oogopslag

| Laag | Technologie | Belangrijkste bestanden |
|---|---|---|
| Main-proces | Electron 43, TS | `electron/main.ts`, `electron/ipc-handlers.ts` |
| Preload-brug | contextBridge | `electron/preload.ts` |
| Renderer | React 19, Zustand, Vite | `src/main.tsx`, `src/components/*`, `src/stores/*` |
| Database | node:sqlite (WAL) | `electron/database.ts` |
| Providers | eigen adapters + SDK's | `electron/provider-adapters.ts` |
| ChatGPT-websessie | verborgen BrowserWindow | `electron/chatgpt-scraper.ts` |
| Agent-tools | tag-parser + approval | `electron/ipc-handlers.ts`, `src/components/agent-commands.ts` |
| MCP-control-plane | HTTP + MCP SDK | `electron/mcp-server.ts`, `src/components/mcp-tools.ts` |
| Build/release | electron-builder + updater | `package.json` (build), `scripts/*`, `electron/updater.ts` |

## Documentatie-index (`docs/`)

1. [`docs/01-architecture.md`](docs/01-architecture.md) — procesmodel, opstart, de complete levensloop van één chatbericht.
2. [`docs/02-data-model.md`](docs/02-data-model.md) — SQLite-schema, migraties, TypeScript-types, Zustand-stores & persistentie.
3. [`docs/03-ipc-api.md`](docs/03-ipc-api.md) — volledige IPC-kanaalreferentie (preload ↔ main).
4. [`docs/04-providers.md`](docs/04-providers.md) — de 7 providers, adapters, modeldiscovery, fallback-keten, credentials.
5. [`docs/05-chatgpt-websession.md`](docs/05-chatgpt-websession.md) — de ChatGPT-scraper (het meest complexe/fragiele deel).
6. [`docs/06-agent-tools.md`](docs/06-agent-tools.md) — tag-toolsysteem, approval-modi, directe commando-router, tool-loop, MCP-server, terminal.
7. [`docs/07-frontend.md`](docs/07-frontend.md) — React-componenten, stores, chat-UI, model-selector, onboarding, tray, i18n, styling.
8. [`docs/08-build-release.md`](docs/08-build-release.md) — bouwen, packagen, optioneel ondertekenen, auto-update via GitHub Releases, backups, versiebeleid.
9. [`docs/09-conventions.md`](docs/09-conventions.md) — codeconventies, harde regels en valkuilen die je móét kennen.

## Harde regels (lees `docs/09-conventions.md` voor het waarom)

- **Niet hardcoden.** Modellen, intelligentie-niveaus, service-tiers, effort-opties komen
  **live** van de provider (CLI-catalogus of `/backend-api/models`). Geen vaste allowlists.
- **Geen anti-bot/detectie-omzeiling** voor ChatGPT. Alleen legitieme betrouwbaarheids-debugging
  (blanco render vs echte blokkade classificeren + retry).
- **Nederlands** in UI-teksten, commits en commentaar.
- **Approval-popup per bestand/commando** is een kernfeature (modus `ask`). Niet stilletjes weghalen.
- Releases gaan **direct naar `main`** met een tag `vX.Y.Z`; daarna backup-bundle + publicatie naar de publieke GitHub Releases-pagina.

## Snelle commando's

```bash
npm run dev        # Vite + Electron in dev
npm test           # vitest (pure logica-, fresh-start- en securitymodules)
npm run build      # tsc && vite build
npm run package    # build + electron-builder (NSIS installer in release/)
npm run release    # package + gecontroleerde publicatie naar GitHub Releases
```
