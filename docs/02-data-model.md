# 2. Datamodel

Er zijn **drie** opslaglagen, elk met een eigen rol:

1. **SQLite** (`electron/database.ts`) — de bron van waarheid voor chats, berichten,
   bijlagen, verbruik, rate-limits, geheugens en prompt-presets. Bestand:
   `app.getPath('userData')/superapp.db`, WAL-modus, `foreign_keys = ON`.
2. **electron-store** (`electron/settings-store.ts`) — kleine key/value-config: instellingen,
   versleutelde credentials, MCP-config, agent-modus. Eén JSON-bestand in userData.
3. **Zustand + localStorage** (`src/stores/*`) — renderer-state; alleen een klein deel is
   persistent (laatste modelkeuze, concepten). De rest is transient en wordt bij opstart
   opnieuw uit de DB/main geladen.

## 2.1 SQLite-schema

Alle tabellen worden aangemaakt in `initDatabase()` (`database.ts:40`). Kolommen worden
nooit destructief gewijzigd; uitbreidingen gaan via **idempotente migraties**.

### `folders` — projecten/mappen
| kolom | type | betekenis |
|---|---|---|
| `id` | TEXT PK | uuid |
| `name` | TEXT | weergavenaam |
| `parentId` | TEXT | geneste map (optioneel) |
| `projectPath` | TEXT | werkmap voor chats in deze map (migratie `2026-06-28-project-context`) |
| `sortOrder` | INTEGER | volgorde in de zijbalk |
| `createdAt` | TEXT | ISO |

### `chats`
| kolom | type | betekenis |
|---|---|---|
| `id` | TEXT PK | uuid |
| `title` | TEXT | titel (auto-gegenereerd na 1e beurt) |
| `folderId` | TEXT | FK → `folders` (ON DELETE SET NULL) |
| `projectPath` | TEXT | werkmap specifiek voor deze chat |
| `systemPrompt` | TEXT | per-chat systeemprompt |
| `activeModelId` / `activeProvider` | TEXT | laatst gebruikte model in deze chat |
| `activeRunConfig` | TEXT (JSON) | bv. ChatGPT-inspanning, reasoning-effort |
| `agentMode` | TEXT | `ask` / `auto-project` / `full` — per-chat override van de globale modus |
| `createdAt` / `updatedAt` | TEXT | ISO |

### `messages`
| kolom | type | betekenis |
|---|---|---|
| `id` | TEXT PK | uuid |
| `chatId` | TEXT | FK → `chats` (ON DELETE CASCADE) |
| `role` | TEXT | `user` / `assistant` / `system` |
| `content` | TEXT | de tekst |
| `modelId` / `provider` | TEXT | welk model het antwoord gaf |
| `inputTokens` / `outputTokens` | INTEGER | verbruik |
| `fallbackFrom` | TEXT | als een fallback dit antwoord gaf: het oorspronkelijke model |
| `attachments` | TEXT (JSON) | lijst `AttachmentRef` |
| `runConfig` | TEXT (JSON) | run-instellingen op het moment van sturen |
| `toolRun` | TEXT (JSON) | uitvoering als `CommandRun`; native tools bewaren optioneel `toolName`, `toolKind` en `toolPath` voor providerneutrale bestandkaarten |
| `createdAt` | TEXT | ISO |

> **Tool-output-berichten** worden opgeslagen met `role='user'` en `content` beginnend met
> `Tool output:` (zodat het model ze als input ziet). De UI herkent ze via
> `isToolOutputMessage()` en toont ze visueel bij de AI-beurt, niet als jouw bericht.

> **Segment-berichten (native providers):** één native toolbeurt levert **meerdere** rijen op —
> een assistent-`Message` per tekst-segment (soms een leeg leidend segment als kop/anker) plus een
> `Tool output:`-rij per tool, met een oplopende `createdAt` en de tool `anchorMessageId` op het
> segment ervóór. De frontend groepeert die weer tot één beurt (zie
> [doc 7.9](07-frontend.md#79-de-beurt-als-één-geheel-turn-rendering)). Ga er dus niet vanuit dat
> één beurt = één assistent-bericht.

### `attachments`
Bestandsbijlagen (tekst/afbeelding/pdf/binair). Bevat `textContent` (uitgelezen tekst),
`base64Content` (alleen legacy; wordt gemigreerd), `tokenEstimate`, `path`, `mimeType`, `kind`. Nieuwe
afbeeldingen staan als beheerd bestand onder `userData/attachments` en worden alleen tijdens de
gekozen modelcontext naar base64 geladen. Gekoppeld aan
chat en (na verzenden) aan een `messageId`. Migratie `2026-06-06-core-stabilization`.

### `usage_events`
Eén rij per antwoord met `inputTokens`, `outputTokens`, `totalTokens`, `cachedTokens`,
`reasoningTokens`. Voedt het Token-dashboard (`getTokenDashboard`, `ipc-handlers.ts:1796`).

### `provider_limits`
Bekende rate-limits per provider/model: `requestsLimit/Remaining`, `tokensLimit/Remaining`,
`resetRequestsAt/resetTokensAt`, `retryAfterMs`, `limitScope`, `displayState`. Wordt gevuld
uit HTTP-response-headers (`readOpenAIRateLimit`, `readAnthropicRateLimit` in
`provider-adapters.ts`) en gelezen door het dashboard. Unieke index op `(provider, modelId)`.

### `provider_quota_snapshots`
Providerneutrale momentopnamen van abonnements-, account- en projectquota. Een snapshot bevat
bron, nauwkeurigheid (`live`/`delayed`/`unavailable`/`local`), observatie- en verloopmoment en
een JSON-lijst van onafhankelijke buckets. Zo kunnen bijvoorbeeld Codex 5 uur + 7 dagen en
Gemini requests + tokens naast elkaar bestaan. Collectorrefreshes vervangen oude
collectorbuckets; een nog actieve runtime-429 blijft apart bewaard.

### `turn_execution_actions`
Duurzame uitvoeringsledger per logische beurt (`turnId`). Elke native toolactie bewaart provider,
tool-id, een canonieke inputsignatuur en status (`requested`/`approved`/`completed`/`uncertain`/...).
Bij providerfallback blokkeert de app reeds voltooide exacte acties; aangevraagde acties waarvan
de uitkomst na een providercrash onbekend is moeten eerst read-only worden gecontroleerd.

### `prompt_presets`
Herbruikbare systeemprompts (`name`, `content`, `isDefault`).

### `memories`
Persistente context die aan elke prompt kan worden toegevoegd. `type` = `global`/`project`/`chat`,
optioneel `scopeId`, met `maxTokens` en `enabled`. Samengesteld in `assemblePromptContext`.

### `schema_migrations`
Bijhouden welke migraties al draaiden. Een migratie draait één keer, in een transactie
(`runMigration`, `database.ts:31`). Toevoegen van een kolom = `addColumnIfMissing` (idempotent).
**Nieuwe migratie toevoegen:** geef 'm een uniek datum-id en zet 'm onderaan `initDatabase`.

## 2.2 De TypeScript-typebijbel (`src/providers/types.ts`)

Dit bestand (~490 regels) is de gedeelde waarheid tussen main en renderer. Belangrijkste:

- **`ProviderType`** — `openai | anthropic | google | ollama | codex | antigravity | remote`.
  Let op: `openai` dekt zowel de ChatGPT-websessie als de OpenAI-API; `anthropic` = Claude
  (API of CLI); `google` = Gemini (API of CLI). `ProviderAccountId` voegt `chatgpt` toe.
- **`AIModel`** — één regel in de modelkiezer. Bevat capabilities (vision/files/streaming),
  `contextWindow`, `source` (`api`/`cli`/`local`/…), `executionMode` (`chat`/`agent`/`connector`),
  `catalogPriority` (door de provider opgegeven volgorde) en ChatGPT-specifieke velden
  (`chatgptThinkingEfforts`, `chatgptWorkMode`, …). **Niets hiervan is hardcoded** — het komt
  uit de live catalogus.
- **`ChatgptVersion` / `ChatgptIntelligencePreset`** — ChatGPT's eigen modelkiezer, één-op-één
  overgenomen uit `/backend-api/models` (`versions[]`). Zie [doc 5](05-chatgpt-websession.md).
- **`ModelRef` / `ModelRunConfig`** — welke provider+model+instellingen voor een beurt
  (reasoning-effort, service-tier, ChatGPT-inspanning, command-preset).
- **`Message` / `Chat` / `Folder` / `AttachmentRef` / `CommandRun` / `MemoryEntry`** — spiegelen
  de SQLite-rijen (met JSON-velden als string).
- **`ChatStreamEvent` / `ToolActivityPhase`** — het streaming-contract (zie [doc 1.5](01-architecture.md#15-streaming-events-het-chatstreamevent-contract)).
- **`FallbackConfig` / `AutoModeConfig`** — fallback-keten en auto-mode. Betaalde API-routes
  vereisen per fallback-item expliciet `allowPaidApi=true`.
- **`TokenDashboard` / `ProviderQuotaSnapshot` / `QuotaBucket` / `RateLimitSnapshot` /
  `UsageEvent`** — lokaal tokenverbruik, actuele context en providerquota zijn gescheiden.
- **`PROVIDER_INFO`** (`:432`) — statische presentatie (naam, kleur, icon-code, auth-methodes)
  per provider. Dit is UI-metadata, geen modelcatalogus.

## 2.3 Zustand-stores

### `chat-store.ts` (`useChatStore`)
Houdt chats, berichten, mappen, geheugens, UI-state en **modelselectie** vast.
- **Persistentie:** `partialize` bewaart ALLEEN `activeModelId/Provider/RunConfig`,
  `lastChatgptRef`, `lastCodexRef` en `messageDrafts`. De systeemprompt komt per chat uit SQLite en
  staat bewust niet meer globaal in localStorage.
  De rest (chats/messages/streaming) is transient en komt bij opstart uit de DB.
- **`setCurrentChat`** herstelt per chat het opgeslagen model + runConfig, maar wist geen
  berichten als je de chat die al open is opnieuw selecteert (anders blijft 'ie blanco).
- **`messageDrafts`** — onverzonden invoer per chat, zodat je concept blijft bij wisselen.
- **Berichten toepassen:** async DB-resultaten lopen altijd via `setMessagesForChat(chatId, …)`.
  De store vergelijkt de `chatId` atomair met de actieve chat, zodat een late refresh van chat A
  nooit de zichtbare berichten van chat B kan overschrijven.
- **`chatRuns`** — transient request-, status-, streamtekst- en native-segmentstate per `chatId`.
  Daardoor kunnen verschillende chats tegelijk werken zonder elkaars `Stop`, shimmer of antwoord
  over te nemen; `requestId` blijft aan de oorspronkelijke chat gekoppeld.
- **Live tool-runs/activities** — transient state voor de commando-kaarten tijdens uitvoering,
  bijgewerkt via helpers uit `command-run-utils.ts`.
- **`lastCodexRef` / `lastChatgptRef`** — elke samengestelde kaart (Codex, ChatGPT) onthoudt
  z'n eigen laatste keuze, los van welke nu actief is.

### `provider-store.ts` (`useProviderStore`)
Houdt modellen, provider-health, auth-status, account-status, tokenverbruik, cooldowns,
fallback-config en de ChatGPT-versies/sessiestatus vast.
- **`modelsByProvider`** wordt per provider gezet (`setProviderModels`) en `models` is de
  afgeplatte lijst in vaste `PROVIDER_ORDER` (`provider-store.ts:66`).
- **Last-known-good:** `setProviderModels(..., preserveExistingOnEmpty=true)` gooit een lege
  nieuwe lijst NIET over een bestaande — zo blijft de picker gevuld terwijl discovery draait.
- **`chatgptSessionActive`** (`undefined` = nog niet gecheckt) is los van de modellenlijst:
  de lijst blijft als cache staan ná uitloggen; alleen deze vlag zegt of ChatGPT écht bruikbaar
  is. Zie `chatgptWebSessionUsable()` in `model-utils.ts`.
- **Persist-migratie v2** (`:181`): eenmalig de oude Codex-cache purgen (van vóór de
  CLI-fingerprint), zodat alleen catalogi van de huidige CLI-resolver blijven staan.

### `profile-store.ts` / `update-store.ts`
Klein: gebruikersavatar (data-URL) en de globale updater-status/-versie voor de badge.

## 2.4 Wat is persistent en wat niet?

| Data | Waar | Overleeft herstart? |
|---|---|---|
| Chats, berichten, bijlagen, verbruik | SQLite | Ja (bron van waarheid) |
| Instellingen, credentials, MCP-config, agent-modus | electron-store | Ja |
| Laatste modelkeuze + runConfig, concepten | localStorage (zustand) | Ja |
| Modellenlijst, ChatGPT-versies (cache) | localStorage (zustand) | Ja (als last-known-good) |
| Streaming-tekst, live tool-runs, huidige berichtenlijst | zustand (transient) | Nee (opnieuw uit DB) |
