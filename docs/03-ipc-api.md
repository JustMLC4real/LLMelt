# 3. IPC-API (renderer ↔ main)

Dit is de ruggengraat. De renderer roept nooit Node direct aan; alles loopt via
`window.electronAPI.*`, gedefinieerd in [`electron/preload.ts`](../electron/preload.ts) en
afgehandeld in [`electron/ipc-handlers.ts`](../electron/ipc-handlers.ts) (plus `mcp-server.ts`,
`pty-terminal.ts`, `updater.ts`).

Twee richtingen:
- **`ipcRenderer.invoke(channel, …)` ↔ `ipcMain.handle(channel, …)`** — request/response (Promise).
- **`webContents.send(channel, payload)` → `ipcRenderer.on(channel, …)`** — push van main naar renderer;
  in de preload verpakt als `onX(callback)` die een unsubscribe-functie teruggeeft.

Hieronder per namespace, met het main-handler-regelnummer in `ipc-handlers.ts` tenzij anders vermeld.

## 3.1 `chat` — berichten & streaming
| preload | kanaal | main | doel |
|---|---|---|---|
| `chat.sendMessage(request)` | `chat:sendMessage` | `:278` | Start een beurt (zie [doc 1.4](01-architecture.md#14-de-levensloop-van-één-chatbericht-end-to-end)). |
| `chat.cancel(requestId?)` | `chat:cancel` | `:286` | Breek een lopende beurt af (`cancelRequest`). |
| `chat.stopGeneration()` | `chat:stopGeneration` | `:287` | Alias die alle actieve requests afbreekt. |
| `chat.onStreamEvent(cb)` | `chat:streamEvent` (push) | — | Alle `ChatStreamEvent`'s (delta/status/usage/done/…). |
| `chat.onStreamChunk(cb)` | `chat:streamChunk` (push) | — | Ruwe delta-chunks (legacy pad). |
| `chat.onRefresh(cb)` | `chat:refresh` (push) | — | "Herlaad de berichten van deze chat" (na tool-loop). |
| `chat.onTitleGenerating(cb)` / `chat.onTitleUpdated(cb)` | `chat:titleGenerating` / `chat:titleUpdated` (push) | — | Auto-titel-status en -resultaat; start naast de eerste providerbeurt. |
| `chat.getTitleOllamaStatus()` | `chat:getTitleOllamaStatus` | — | Controleert of de lokale Ollama-runtime en een geschikt geïnstalleerd titelmodel beschikbaar zijn. |
| `chat.installTitleOllama()` | `chat:installTitleOllama` | — | Expliciete gebruikersactie: installeert zo nodig Ollama via het officiële Windows-script en downloadt daarna het geadviseerde titelmodel via `/api/pull`. |
| `chat.onTitleOllamaSetupProgress(cb)` | `chat:titleOllamaSetupProgress` (push) | — | Officiële installerfase, echt runtime-/modeldownloadpercentage en waar beschikbaar bytes/totaal/snelheid. Na gereed worden URL, providerstatus en modellen direct vernieuwd. |

De onboarding gebruikt daarnaast de providerneutrale runtimefaçade:

| preload | kanaal | main | doel |
|---|---|---|---|
| `runtime.getStatus(runtime)` | `runtime:getStatus` | — | Valideert `ollama` of `python`; een pad alleen telt niet, de runtime moet echt antwoorden. |
| `runtime.install(runtime)` | `runtime:install` | — | Alleen na een expliciete UI-klik: officiële Ollama-installer + modelpull, of de officiële Python Install Manager + stabiele Python 3. |
| `runtime.onSetupProgress(cb)` | `runtime:setupProgress` (push) | — | Providerneutrale fase, percentage, bytes/totaal en snelheid voor de onboarding. |

Het volledige lokale modelbeheer gebruikt een eigen beperkte Ollama-namespace:

| preload | kanaal | doel |
|---|---|---|
| `ollama.listInstalled()` | `ollama:listInstalled` | Leest `/api/tags` en verrijkt elk lokaal model best-effort met `/api/show`; een onbereikbare server wordt als `online:false` teruggegeven, niet als renderercrash. |
| `ollama.searchLibrary(query)` | `ollama:searchLibrary` | Doorzoekt uitsluitend `https://ollama.com/search`; de renderer kan geen willekeurige URL meegeven. |
| `ollama.listLibraryTags(path)` | `ollama:listLibraryTags` | Leest de downloadbare varianten van één gevalideerd officieel bibliotheekpad. |
| `ollama.pullModel(model)` | `ollama:pullModel` | Valideert de exacte modelnaam en streamt de officiële `/api/pull`; er kan per model maar één download tegelijk lopen. |
| `ollama.cancelPull(model)` | `ollama:cancelPull` | Breekt de bijbehorende `AbortController` af. |
| `ollama.deleteModel(model)` | `ollama:deleteModel` | Verwijdert expliciet via `/api/delete`; een lopende download moet eerst worden geannuleerd. |
| `ollama.openLibrary(query?)` | `ollama:openLibrary` | Opent alleen de vaste officiële Ollama-origin in de externe browser. |
| `ollama.onPullProgress(cb)` | `ollama:modelPullProgress` (push) | Fase, percentage, bytes, totaal en gemiddelde downloadsnelheid. |

## 3.2 `providers` — modellen, health, accounts
| preload | kanaal | main | doel |
|---|---|---|---|
| `providers.listAll()` | `providers:listAll` | `:171` | Provider-metadata + status. |
| `providers.refreshModels(providerId?)` | `providers:refreshModels` | `:173` | Wis de korte adaptercache en forceer opnieuw discovery van één provider of alle catalogi. |
| `providers.listModels(providerId?)` | `providers:listModels` | `:174` | Modellen (per provider of alles). |
| `providers.getHealth()` | `providers:getHealth` | `:177` | `online`/`offline`/`limited` per provider. |
| `providers.getAccountStatuses()` | `providers:getAccountStatuses` | `:178` | Rijke account-kaarten (plan, exe-pad, statuslabel). |
| `providers.chatgptVersions()` | `providers:chatgptVersions` | `:387` | ChatGPT's eigen modelkiezer (`versions[]`). |
| `providers.openAccountSurface(provider)` | `providers:openAccountSurface` | `:179` | Open de login/websurface van een provider. |

## 3.3 `auth` — credentials & sessies
| preload | kanaal | main | doel |
|---|---|---|---|
| `auth.saveCredential(provider, secret, method)` | `auth:saveCredential` | `:181` | Versleuteld opslaan (safeStorage). |
| `auth.setApiKey(provider, key)` | `auth:setApiKey` | `:187` | API-key opslaan. |
| `auth.getApiKey(provider)` | `auth:getApiKey` | `:193` | **Geeft altijd `null`** — keys worden nooit teruggelezen naar de UI. |
| `auth.removeApiKey(provider)` | `auth:removeApiKey` | `:194` | Credential wissen. |
| `auth.testCredential(provider, secret?)` / `auth.testConnection(provider)` | `auth:testCredential` / `auth:testConnection` | `:198` / `:202` | Sleutel/verbinding valideren. |
| `auth.getStatus()` / `auth.getAuthStatus()` | `auth:getStatus` | `:207` | `CredentialStatus` per provider. |
| `auth.browserLogin(provider)` | `auth:browserLogin` | `:209` | Generieke browser-login. |
| `auth.chatgptBrowserLogin()` / `…Logout()` / `…SessionStatus()` | `auth:chatgpt*` | `:220`+ | ChatGPT-websessie beheren. |
| `auth.chatgptEngineStatus()` / `…EngineReset()` / `…OpenWindow()` | `auth:chatgptEngine*` | `:235`+ | Scraper-engine status/herstel/venster. |
| `auth.claudeCliLogin()` | `auth:claudeCliLogin` | `:322` | Opent de gevonden Claude CLI; ontbreekt die, dan start de officiële native Windows-installatie en daarna de login. |
| `auth.codexCliLogin()` | `auth:codexCliLogin` | `:329` | Opent `codex login`; ontbreekt Codex, dan start eerst de officiële Windows-standalone-installer. |
| `auth.antigravityCliLogin()` | `auth:antigravityCliLogin` | `:329` | Zelfde install/open-flow voor de officiële Antigravity CLI. |

## 3.4 `db` — directe database-toegang (`registerDbHandlers`, `:406`)
| preload | kanaal | doel |
|---|---|---|
| `db.getChats()` / `db.getChat(id)` | `db:getChats` / `db:getChat` | Chats ophalen. |
| `db.createChat(title, folderId?, id?)` | `db:createChat` | Materialiseer een lokaal concept; de optionele gevalideerde client-id blijft gelijk. |
| `db.updateChat(id, data)` / `db.deleteChat(id)` | `db:updateChat` / `db:deleteChat` | Wijzigen/verwijderen (delete cascade't berichten). |
| `db.getMessages(chatId)` / `db.addMessage(msg)` / `db.deleteMessage(id)` | `db:getMessages`/`addMessage`/`deleteMessage` | Berichten. |
| `db.getFolders()` / `createFolder` / `updateFolder` / `deleteFolder` | `db:*Folder*` | Mappen (delete wist ook de chats erin). |
| `db.getMemory(type?, scopeId?)` / `addMemory` / `updateMemory` / `deleteMemory` | `db:*Memory*` | Geheugens. |
| `db.getPresets()` / `savePreset` / `deletePreset` | `db:*Preset*` | Prompt-presets. |

> Na wijzigingen die de zijbalk/tray raken, roept main `notifyChatsChanged()` aan
> (`app-events.ts`) → het tray-menu ververst.

## 3.5 `tokens` — verbruik & limieten
| preload | kanaal | main | doel |
|---|---|---|---|
| `tokens.getDashboard(chatId?)` | `tokens:getDashboard` | `:291` | Volledig `TokenDashboard`. |
| `tokens.getContextUsage(chatId, modelRef?)` | `tokens:getContextUsage` | `:293` | Context-vulling voor de meter in de composer. |
| `tokens.getRateLimits()` | `tokens:getRateLimits` | `:294` | Opgeslagen `RateLimitSnapshot`'s. |
| `tokens.getQuotas()` / `refreshQuotas()` | `tokens:getQuotas` / `tokens:refreshQuotas` | — | Opgeslagen providerquota lezen of alle officiële bronnen vernieuwen. |
| `tokens.onUsageUpdate(cb)` | `tokens:usageUpdate` (push) | — | Live verbruik-updates. |

### Verplichte Gemini-quota en CLI-statusregels
| preload | kanaal | doel |
|---|---|---|
| `geminiQuota.getStatus(validate?)` | `geminiQuota:getStatus` | Controleert API-key, Cloud-project, OAuth-scopes, Service Usage en Cloud Monitoring. |
| `geminiQuota.configure(projectId, clientId)` / `connect()` / `disconnect()` | `geminiQuota:*` | Verplichte read-only Google Cloud-koppeling beheren. |
| `quotaBridge.ensure(provider)` / `restore(provider)` | `quotaBridge:*` | Claude/Antigravity-statusregel veilig ketenen of de gebruikersconfig herstellen. |

Alle IPC-registraties lopen via `createTrustedIpcMain`: alleen het geregistreerde hoofdvenster én
de verwachte Vite-origin/productie-HTML mogen een kanaal aanroepen. Een externe navigatie behoudt
daarmee nooit IPC-rechten.

## 3.6 `fallback` — automatische modelketen
| preload | kanaal | main | doel |
|---|---|---|---|
| `fallback.getConfig()` / `setConfig(config)` | `fallback:getConfig` / `setConfig` | `:296` | Keten + auto-switch aan/uit, inclusief expliciete toestemming per betaalde API-route. |
| `fallback.setOrder(order)` / `setEnabled(enabled)` | `fallback:setOrder` / `setEnabled` | `:298` | Volgorde/aan-uit los. |
| `fallback.onSwitch(cb)` | `fallback:switch` (push) | — | UI-notificatie bij een switch. |

## 3.7 `autoMode` — twee AI's die elkaar prompten
| preload | kanaal | main | doel |
|---|---|---|---|
| `autoMode.start(config)` | `auto:start` | `:315` | Start de prompter↔responder-loop (`runAutoModeLoop`, `:2969`). |
| `autoMode.pause()` / `resume()` / `stop()` | `auto:pause`/`resume`/`stop` | `:339`+ | Bediening. |
| `autoMode.getStatus()` | `auto:getStatus` | `:359` | Huidige `AutoModeState`, inclusief `chatId`, fase, promptpreview en eventuele fout. |
| `autoMode.onIteration(cb)` | `auto:iteration` (push) | — | Voortgang per fase (`prompter`/`responder`/`waiting`); `App` blijft luisteren als het paneel dicht is. |

## 3.8 `agent` — PC-toegang & approval
| preload | kanaal | main | doel |
|---|---|---|---|
| `agent.getConfig()` | `agent:getConfig` | `:362` | `{ mode, workingDir, toolsEnabled, defaultShell }`. |
| `agent.setConfig(config)` | `agent:setConfig` | `:363` | Globale agent-instellingen. |
| `agent.runCommand(command, options?)` | `agent:runCommand` | `:364` | Handmatig een commando draaien. |
| `agent.getPendingApprovals()` | `agent:getPendingApprovals` | `:367` | Nog onbeantwoorde approvals herstellen na een renderer-reload. |
| `agent.respondApproval(id, approved)` | `agent:approvalResponse` | `:368` | Antwoord op een approval-popup. |
| `agent.onApprovalRequest(cb)` | `agent:approvalRequest` (push) | — | Vraag met `chatId`/`requestId` om goedkeuring (bestand/commando). |
| `agent.onApprovalResolved(cb)` | `agent:approvalResolved` (push) | — | Verwijder een beantwoorde of door Stop geannuleerde aanvraag uit de UI-wachtrij. |
| `agent.onTerminal(cb)` | `agent:term` (push) | — | Live shell-uitvoer (cmd/out/err/exit). |

## 3.9 `terminal` — echte pty-shells (`pty-terminal.ts`)
| preload | kanaal | doel |
|---|---|---|
| `terminal.listShells()` | `terminal:listShells` | Beschikbare shells (PowerShell/cmd/pwsh). |
| `terminal.create(options?)` | `terminal:create` | Nieuwe pty-sessie (`node-pty`). |
| `terminal.write(id, data)` / `resize(id, cols, rows)` / `kill(id)` | `terminal:*` | Bediening. |
| `terminal.onData(cb)` / `onExit(cb)` | `terminal:data` / `terminal:exit` (push) | Stream & exit. |

## 3.10 `mcp` — lokale control-plane (`mcp-server.ts`)
| preload | kanaal | doel |
|---|---|---|
| `mcp.getConfig()` / `setConfig(config)` | `mcp:getConfig` / `setConfig` | Roots, poort, owner-token. |
| `mcp.start()` / `stop()` / `getStatus()` | `mcp:start`/`stop`/`getStatus` | HTTP-server bedienen. |
| `mcp.getCalls()` | `mcp:getCalls` | Laatste 100 tool-calls (audit). |
| `mcp.onCall(cb)` | `mcp:call` (push) | Live tool-call-log. |

## 3.11 Overige namespaces
- **`clipboard`** — `clipboard.writeText(text)` → `clipboard:writeText`; schrijft via Electron's
  native clipboard nadat de tekst is begrensd en het renderer-frame door de centrale IPC-gate is vertrouwd.
- **`keys`** — batch-validatie van API-keys (`keys:validateBatch/validateKeys`, push `keys:validationResult`).
- **`settings`** — `settings.get/set/getAll` → een renderer-allowlist in electron-store;
  `settings.resetSshFingerprint()` wist alleen de pin van de ingestelde SSH-host. Credentials en
  interne owner-tokens worden nooit aan `getAll` teruggegeven.
- **`files`** — bestandsimport en werkmap: `selectAndImport`, `selectFiles`, `selectDirectory`,
  `getDefaultWorkspace`, `readFile` (`:383`+).
- **`updater`** — `getStatus/check/download/install`, push `updater:status` (zie [doc 8](08-build-release.md)).
- **`windowControls`** — `minimize/maximizeToggle/close/isMaximized`, push `window:maximizeChanged`.
- **`tray`** — `tray.setChats(chats)` (renderer → main, houdt het tray-menu 1-op-1 gelijk aan de
  zijbalk) en `tray.onOpenChat(cb)` (`__new__` = start nieuw gesprek).

## 3.12 Een nieuw kanaal toevoegen (recept)
1. Schrijf de handler in `ipc-handlers.ts` (of de juiste module) met `ipcMain.handle('ns:naam', …)`.
2. Voeg een methode toe aan `electronAPI` in `preload.ts` (`ipcRenderer.invoke('ns:naam', …)`).
3. Roep 'm aan via `window.electronAPI.ns.naam(...)` in een component/store.
4. Push-events: `win.webContents.send('ns:event', payload)` in main + een `onEvent(cb)` in preload
   die een unsubscribe teruggeeft. Vergeet niet op te ruimen in de `useEffect`-cleanup.
