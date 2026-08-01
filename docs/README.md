# LLMelt — documentatie

Volledige, uitgebreide referentie van de codebase. Bedoeld zodat elke AI (en mens)
**exact** snapt hoe alles werkt. Begin bij [`../AGENTS.md`](../AGENTS.md) voor de
korte oriëntatie; hieronder de diepe hoofdstukken.

| # | Document | Waarover |
|---|---|---|
| 1 | [Architectuur](01-architecture.md) | Procesmodel, opstartvolgorde, de levensloop van één chatbericht van klik tot antwoord. |
| 2 | [Datamodel](02-data-model.md) | SQLite-schema + migraties, alle TypeScript-types, Zustand-stores en wat er wél/niet persistent is. |
| 3 | [IPC-API](03-ipc-api.md) | Elk IPC-kanaal tussen renderer en main, met argumenten en retourwaarden. |
| 4 | [Providers](04-providers.md) | De 7 aanbieders, hun adapters, modeldiscovery, credential-opslag en de fallback-keten. |
| 5 | [ChatGPT-websessie](05-chatgpt-websession.md) | De verborgen-browser-scraper: login, modellen, de twee transports, verificatie van het antwoordmodel. |
| 6 | [Agent-tools](06-agent-tools.md) | Het tag-toolsysteem, approval-modi, directe commando-router, de tool-loop, de MCP-server en de terminal. |
| 7 | [Frontend](07-frontend.md) | React-componenten, de chat-view, model-selector, onboarding, Windows-tray, i18n en styling. |
| 8 | [Build & release](08-build-release.md) | Bouwen, packagen, icoon/versie-embedding, auto-update via GitHub Releases, backup-bundles, versiebeleid. |
| 9 | [Conventies & valkuilen](09-conventions.md) | Harde regels, bekende valkuilen en de "waarom"-context die je moet kennen voor je iets wijzigt. |

## Kaart van de repo

```
LLMelt/
├─ AGENTS.md                 # AI-instappunt (korte oriëntatie)
├─ docs/                     # deze documentatie
├─ package.json              # scripts, deps, electron-builder "build"-config
├─ vite.config.ts            # Vite + vite-plugin-electron
├─ scripts/
│  ├─ gen-icon.mjs           # PNG → .ico
│  └─ publish-update.mjs     # gecontroleerde GitHub Release-publicatie
├─ electron/                 # MAIN-proces (Node/Electron, TypeScript)
│  ├─ main.ts                # app-lifecycle, venster, tray, single-instance
│  ├─ ipc-handlers.ts        # ~3250 rgls: alle IPC + chat-orkestratie + agent-tools
│  ├─ provider-adapters.ts   # ~2670 rgls: één adapter per provider
│  ├─ chatgpt-scraper.ts     # ~2270 rgls: ChatGPT-websessie via verborgen venster
│  ├─ mcp-server.ts          # lokale MCP-control-plane (HTTP)
│  ├─ database.ts            # SQLite-init + migraties
│  ├─ credential-store.ts    # versleutelde secrets (safeStorage)
│  ├─ settings-store.ts      # electron-store singleton
│  ├─ pty-terminal.ts        # echte terminals via node-pty
│  ├─ updater.ts             # electron-updater (GitHub Releases)
│  ├─ codex-cli-discovery.ts # nieuwste gebundelde codex.exe vinden
│  └─ app-events.ts          # kleine event-bus (voorkomt circulaire import)
└─ src/                      # RENDERER (React 19, TypeScript)
   ├─ main.tsx               # React-mount + i18n-init
   ├─ providers/types.ts     # de gedeelde type-bijbel (~490 rgls)
   ├─ stores/                # Zustand: chat-store, provider-store, profile-store, update-store
   ├─ i18n/                  # i18next + nl.json / en.json
   ├─ index.css              # alle styling (één bestand, CSS-variabelen)
   └─ components/            # UI + pure logica-modules (met *.test.ts)
```

## Hoe je dit leest

- **Snel iets vinden?** Ga via het IPC-kanaal ([doc 3](03-ipc-api.md)) — dat is de
  ruggengraat tussen UI en backend en wijst je naar de juiste functie.
- **Een provider aanpassen?** [doc 4](04-providers.md) (+ [doc 5](05-chatgpt-websession.md) voor ChatGPT).
- **Iets met bestanden/commando's laten uitvoeren?** [doc 6](06-agent-tools.md).
- **Voor je iets verandert:** lees [doc 9](09-conventions.md) — daar staan de valkuilen
  die anderen (en eerdere AI-sessies) al hebben geraakt.
