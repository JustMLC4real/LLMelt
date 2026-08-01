# 1. Architectuur

## 1.1 Procesmodel

LLMelt is een standaard Electron-app met drie werelden, strikt gescheiden door
`contextIsolation: true` en `nodeIntegration: false`:

```
┌─────────────────────────── MAIN-proces (Node.js) ───────────────────────────┐
│ electron/main.ts        app-lifecycle, hoofdvenster, tray, single-instance    │
│ electron/ipc-handlers.ts alle ipcMain.handle/on + chat-orkestratie + tools    │
│ electron/provider-adapters.ts  praat met SDK's/CLI's/HTTP per provider        │
│ electron/chatgpt-scraper.ts    verborgen BrowserWindow's naar chatgpt.com      │
│ electron/database.ts    SQLite (node:sqlite, WAL)                              │
│ electron/mcp-server.ts  lokale HTTP MCP-server (control-plane)                 │
│ electron/pty-terminal.ts node-pty terminals                                    │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                     │  ipcMain.handle(...)  ◄─ invoke
                                     │  webContents.send(...) ─► on(...)
┌───────────────────────────── PRELOAD (brug) ─────────────────────────────────┐
│ electron/preload.ts   exposeInMainWorld('electronAPI', {...})                  │
│   → één getypte façade; renderer raakt Node NOOIT direct aan                   │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                     │  window.electronAPI.*
┌────────────────────────────── RENDERER (React) ──────────────────────────────┐
│ src/main.tsx → App.tsx → Sidebar / ChatView / Settings / TokenDashboard …     │
│ state: Zustand stores (chat-store, provider-store, profile-store, update-store)│
└──────────────────────────────────────────────────────────────────────────────┘
```

**Kernregel:** de renderer heeft geen Node-toegang. Alles wat het bestandssysteem,
processen, netwerk-naar-providers of de database raakt, gebeurt in het main-proces en
is bereikbaar via een IPC-kanaal dat in `preload.ts` wordt geëxposeerd. Wil je een
nieuwe backend-capability toevoegen, dan is de keten altijd:
`ipc-handlers.ts` (handler) → `preload.ts` (façade-methode) → component/store (aanroep).

## 1.2 Tech-stack en waarom

- **Electron 43** — desktop-app met systeemtoegang (bestanden, CLI's, tray, auto-update).
- **Vite 6 + `vite-plugin-electron`** — bouwt tegelijk de renderer (`dist/`) en de
  main/preload-bundles (`dist-electron/`). Zie `vite.config.ts`.
- **React 19 + TypeScript** — UI. Geen router; view-switch via `currentView` in de store.
- **Zustand 5** — globale state met `persist`-middleware naar `localStorage`.
- **node:sqlite** — de ingebouwde synchrone SQLite van Node 24/Electron (WAL-modus), zonder losse native ABI-addon.
- **electron-store** — kleine key/value-config (settings, credentials, MCP-config).
- **Provider-SDK's en HTTP** — `openai`, `@anthropic-ai/sdk` en directe Gemini REST/SSE-calls;
  CLI's worden als child-process aangeroepen (`codex`, `claude`, `antigravity`).
- **node-pty + @xterm/xterm** — echte interactieve terminals in de UI.
- **electron-updater** — auto-update via de publieke GitHub Releases-pagina van `JustMLC4real/LLMelt`.

## 1.3 Opstartvolgorde (`electron/main.ts`)

`app.whenReady()` doet, in volgorde (`main.ts:260`):

1. `Menu.setApplicationMenu(null)` — geen standaard menubalk (frameless venster).
2. `initDatabase()` — opent/migreert `superapp.db` in `app.getPath('userData')`.
3. `registerIpcHandlers(ipcMain)` — registreert álle IPC-handlers (`ipc-handlers.ts:160`).
4. `registerWindowControls()` — minimize/maximize/close voor de custom titelbalk.
5. `registerUpdater(ipcMain, () => mainWindow)` — updater-events + auto-check.
6. `createWindow()` — het frameless hoofdvenster (1400×900, `backgroundColor #0a0e1a`).
7. `createTray()` — systeemtray-icoon + contextmenu.
8. `runChatgptModelSelfTest()` — no-op tenzij `CG_SELFTEST=1` én een slug uit de live catalogus in
   `CG_SELFTEST_MODEL` staan (diagnose-hook die één accountbericht verbruikt).

Andere details:
- **Hardware-acceleratie blijft standaard aan.** Alleen met
  `AI_SUPERAPP_SOFTWARE_RENDERING=1` schakelt de app expliciet over op software-rendering voor
  machines waarop de verborgen ChatGPT-renderer anders crasht.
- **Single-instance lock**: een tweede start focust het bestaande venster (`main.ts:247`).
- **Sluiten = naar tray**: `mainWindow.on('close')` doet `preventDefault()` + `hide()`;
  de app blijft in de tray draaien (`main.ts:58`). Echt afsluiten via tray → "Afsluiten".

## 1.4 De levensloop van één chatbericht (end-to-end)

Dit is de belangrijkste flow van de app. Volg 'm helemaal.

### Renderer-kant (`src/components/ChatInput.tsx` → `handleSend`, regel 217)
1. Gebruiker typt en drukt Enter. `handleSend()` maakt een `requestId` (`crypto.randomUUID()`).
2. Slash-commando's (`/doel`, `/reset`, presets) worden eerst afgehandeld via
   `parseCommandInput` / `applyCommandPreset` (`command-presets.ts`).
3. Er wordt een **optimistisch** user-bericht aan de store toegevoegd (`addMessage`) zodat
   het meteen zichtbaar is; input wordt geleegd; in `chatRuns[chatId]` start een eigen stream.
4. `window.electronAPI.chat.onStreamEvent(...)` wordt geabonneerd — dit ontvangt álle
   voortgangs-events voor deze `requestId`.
5. `window.electronAPI.chat.sendMessage({ requestId, chatId, modelRef, input, attachmentIds, systemPrompt })`.

### Main-kant (`electron/ipc-handlers.ts`)
6. Handler `chat:sendMessage` (`:278`) roept `sendUserMessageAndRunAssistant(win, request)` (`:637`).
7. Het user-bericht wordt in SQLite opgeslagen (`insertMessage`), bijlagen gekoppeld, en
   een `message_saved`-event + `status`-event gestuurd.
8. **Directe commando-router** (`:681`): als agent-tools aanstaan én de invoer een expliciet
   PC-commando is (`detectDirectCommandSpec`, bv. `/run …`), wordt dat meteen uitgevoerd via
   `runAgentCommand` in de projectmap — ongeacht welk model gekozen is. Output wordt als
   `Tool output:`-bericht opgeslagen en de beurt is klaar.
9. Anders → `runAssistantForExistingChat(win, {...})` (`:734`):
   - `assemblePromptContext(chat)` bouwt de system-prompt (chat-systemprompt + geheugens + runtime-metadata).
   - Als agent-tools aanstaan wordt `AGENT_TOOL_INSTRUCTIONS` (`:2069`) aan de system-prompt geplakt.
   - `executeWithFallback(...)` (`:977`) kiest het model, doet een preflight, en roept de
     juiste **provider-adapter** aan; bij rate-limit, contextoverschrijding, auth- of netwerkfout
     schuift hij door naar het volgende model in de ingeschakelde **fallback-keten**.
   - De adapter streamt tokens terug via `onDelta` → `sendStreamEvent(type:'delta')`.
10. Na het antwoord: als agent-tools aanstaan en het antwoord tool-tags bevat, draait
    `runAgentToolLoop` (`:2125`): parse tags → per stap approval → uitvoeren in de projectmap →
    output terug in de chat → model laten doorgaan (met een cap).
11. Verbruik wordt opgeslagen (`recordUsage`) en rate-limits (`recordRateLimit`).
12. Ten slotte een `done`-event (of `error`-event) voor deze `requestId`.

### Terug in de renderer
13. De `onStreamEvent`-callback verwerkt elk event uitsluitend in `chatRuns[event.chatId]`:
    `delta` → streamtekst van die chat, `status`/`tool_activity` → eigen statusregel,
    `usage` → tokenteller en `model_switch` → het model van die run bijwerken. Bij `done`
    worden de berichten van die chat uit de DB gehaald en wordt alleen die run verwijderd.

**Belangrijk:** tijdens het streamen toont de UI de transient state uit `chatRuns[chatId]`; bij
`done` wordt de bron van waarheid de **database** (via `db:getMessages`). Zo overleeft een
chat een herstart en blijft alles consistent. Meerdere chats kunnen tegelijk lopen; wisselen verplaatst
nooit request-id, status, native segmenten of streamingtekst naar het andere gesprek. Een late
DB-response wordt bovendien genegeerd als intussen een andere chat openstaat.

## 1.5 Streaming-events (het `ChatStreamEvent`-contract)

Eén kanaal `chat:streamEvent` draagt alle voortgang. Types (zie `src/providers/types.ts:234`):

| type | betekenis |
|---|---|
| `message_saved` | een bericht (user/assistant/tool) is in de DB gezet |
| `status` | menselijke statusregel ("ChatGPT denkt", "Bijlagen uploaden") |
| `delta` | stukje tekst van het antwoord (append, zwevende streaming-bubbel) |
| `assistant_start` | native provider: voeg een leeg assistent-segment-bericht toe (turn-anker) |
| `assistant_delta` | native provider: append tekst aan een specifiek segment (`messageId`, `delta`) |
| `usage` | tokenverbruik voor dit antwoord |
| `model_switch` | fallback schakelde naar een ander model (`from`/`to`) |
| `tool_run_started` / `tool_run_output` / `tool_run_finished` | live tool-/commando-uitvoer (`run`, `anchorMessageId`) |
| `tool_activity` | fase van een agent-toolstap (`phase`, `label`, `tone`) |
| `done` | beurt klaar |
| `error` | beurt mislukt (`error`-tekst) |

## 1.6 Waar "de projectmap" vandaan komt

Veel acties (agent-tools, terminal, directe commando's) draaien in een **werkmap**. Die
wordt per chat bepaald door `getEffectiveProjectPath(chat)` (`ipc-handlers.ts:1647`):

1. de `projectPath` van de map/folder waar de chat in zit, anders
2. de `projectPath` van de chat zelf, anders
3. `ensureDefaultWorkspacePath()` → `Documents/LLMelt` voor nieuwe installaties; een bestaande
   legacywerkmap `Documents/AI Superapp` blijft gebruikt zodat bestanden niet onverwacht verhuizen.

Zo weet de AI (en de terminal) altijd in welke map hij werkt, per chat instelbaar.
