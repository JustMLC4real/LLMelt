# 4. Providers, adapters, discovery & fallback

Alle communicatie met AI-aanbieders zit in [`electron/provider-adapters.ts`](../electron/provider-adapters.ts)
(~2670 regels). De ChatGPT-websessie is groot genoeg voor een eigen bestand
([`chatgpt-scraper.ts`](../electron/chatgpt-scraper.ts), zie [doc 5](05-chatgpt-websession.md)).

## 4.1 Het `ProviderAdapter`-contract (`:62`)

```ts
interface ProviderAdapter {
  id: ProviderType;
  listModels(): Promise<AIModel[]>;                 // live catalogus-discovery
  validateCredential(secret?): Promise<ValidationResult>;
  sendChat(request: AdapterChatRequest): Promise<AdapterChatResult>; // streamt via onDelta
  countTokens(modelId, messages, systemPrompt?): Promise<number>;
  getRateLimitState(modelId?): Promise<RateLimitSnapshot>;
}
```

`createAdapters()` (`:2635`) bouwt één instantie per `ProviderType` en levert een
`Record<ProviderType, ProviderAdapter>`. `ipc-handlers.ts` gebruikt dit voor discovery
(`listModels`) en voor het versturen van een beurt (`sendChat`) binnen `executeWithFallback`.

`DEFAULT_CONTEXT` / `DEFAULT_OUTPUT` (`:71`/`:81`) geven per provider een **vangnet** voor
context-window/output als de catalogus het niet meldt — geen harde limiet, alleen een default.

### `sendChat`-streaming
`sendChat` krijgt o.a. `messages`, `systemPrompt`, `attachments`, `signal` (AbortSignal) en
callbacks `onDelta(text)` / `onStatus(text)`. De adapter roept `onDelta` aan zodra er tokens
binnenkomen; die worden 1-op-1 doorgestuurd als `chat:streamEvent` van type `delta`. De
retourwaarde bevat de volledige tekst + `TokenUsage`.

## 4.2 De 7 providers

| `ProviderType` | Dekt | Transport(s) | Auth |
|---|---|---|---|
| `openai` | OpenAI-API **én** ChatGPT-abonnement | `openai` SDK (API) / verborgen browser (websessie) | API-key of browser-login |
| `anthropic` | Claude | `@anthropic-ai/sdk` (API) / `claude` CLI | API-key of CLI-login |
| `google` | Gemini | directe Developer API (REST + SSE) | API-key |
| `codex` | Codex CLI (OpenAI's agent) | `codex` CLI als child-process | CLI-login |
| `antigravity` | Antigravity CLI | `antigravity` CLI | CLI / statusline |
| `ollama` | Lokale modellen | Ollama HTTP (localhost) | geen |
| `remote` | Eigen LLM via SSH | `ssh2` | handmatig (SSH-config) |

### `openai` — `OpenAIAdapter` (`:542`)
- **`listModels`**: haalt de OpenAI-API-catalogus (als er een key is) én, als de ChatGPT-websessie
  actief is, de sessiemodellen via `chatgptScraper.listSessionModels()` (`:571`). ChatGPT-modellen
  krijgen een `chatgpt:`-prefix in hun `id` en `limitScope: 'account'`.
- **`sendChat`** (`:655`): als `modelId` met `chatgpt:` begint → `chatgptScraper.sendChatViaSession(...)`;
  anders de OpenAI-API via de `openai` SDK. Rate-limits worden uit de response-headers gelezen
  (`readOpenAIRateLimit`, `:181`).

### `anthropic` — `AnthropicAdapter` (`:768`)
- Twee paden: de **Anthropic-API** (`@anthropic-ai/sdk`) met een key, of de **`claude` CLI**
  (`ClaudeCliAdapter`, `:1496`) via `claude`-child-process. `listModels` combineert beide
  (`:772`); `sendChat` (`:904`) kiest het pad op basis van beschikbaarheid.
- Rate-limits uit headers via `readAnthropicRateLimit` (`:209`).
- CLI-detectie omvat zowel npm-shims als de native Windows-installatie in
  `%USERPROFILE%/.local/bin`. Login wordt niet afgeleid uit alleen het bestaan van de binary:
  `claude auth status` moet slagen. Instellingen toont, net als Codex en Antigravity, zowel het
  werkelijk gevonden executable-pad als een optionele handmatige pad-overrule.
- Met PC-tools uit draait de print-route expliciet in `plan` + `safe-mode` zonder sessiepersistentie;
  gebruikershooks of een lokale Claude-config mogen zo niet buiten de app om bestanden wijzigen.

### `google` — `GoogleAdapter` (`:1071`)
- Uitsluitend de directe **Gemini Developer API** met een in de app opgeslagen API-key.
  `listModels` haalt live alle modellen op die `generateContent` ondersteunen; `sendChat` gebruikt
  rechtstreeks `streamGenerateContent` via SSE.
- Gemini-familiemodellen krijgen native function calling. `gemini-api-native.ts` biedt de gedeelde
  app-tools aan, bewaart function-call-id's en thought signatures en stuurt toolresultaten in een
  vervolgronde terug. Uitvoering en approvals blijven in `ipc-handlers.ts`; de API krijgt dus geen
  ongecontroleerde toegang tot bestanden of de shell.
- Google-accountgebruik voor persoonlijke Free/AI Pro/AI Ultra-abonnementen loopt afzonderlijk
  via Antigravity; de Google-provider zelf is volledig API-only.

### `codex` — `CodexAdapter` (`:1752`)
- Draait de **`codex` CLI** als agent (`runCodexAgent`, `:2378`). Modellen (`executionMode: 'agent'`)
  komen uitsluitend uit de actuele CLI-catalogus; een oude opgeslagen modellenlijst is nooit een
  fallback. `visibility: "list"` bepaalt exact wat zichtbaar is. Een `upgrade`-hint blijft alleen een
  advies en verbergt dus geen model dat de officiële Codex-kiezer nog aanbiedt.
  `cli-discovery.ts` vergelijkt zowel `%LOCALAPPDATA%/OpenAI/Codex/bin` als
  `%LOCALAPPDATA%/Programs/OpenAI/Codex/bin`, inclusief versie-/hashmappen, en kiest de nieuwste
  desktopbinary vóór een verouderd opgeslagen top-level pad. Een bewust ingesteld extern pad blijft
  wel leidend. De live catalogus wordt alleen kort in geheugen gecachet en niet over appstarts heen.
  Op een verse installatie kan `codex debug models` al een niet-lege ingebouwde snapshot geven terwijl
  de accountcatalogus nog wordt bijgewerkt. `App.tsx` doet daarom vóór de eerste automatische keuze een
  cachevrije warm-upcall en daarna nog twee begrensde achtergrondcontroles. Een expliciete
  `refreshModels('codex')` wist eveneens de geheugencache; geen modelnaam wordt geraden.
  Service-/speed-tiers komen live uit `service_tiers` +
  `additional_speed_tiers` (`codexServiceTiers`, `:122`). Reasoning-efforts worden eveneens exact
  per model overgenomen; `max` en `ultra` blijven twee afzonderlijke keuzes als de catalogus beide meldt.
- De installatie/login-knop gebruikt de officiële Windows-standalone-installer en start daarna
  `codex login`; bestaande installaties gaan rechtstreeks naar die login. De onboarding hercontroleert
  `codex login status` zonder app-herstart. De preflight zet daarbij alleen tijdelijk
  `-c service_tier="fast"`: zo kan een verouderde waarde in de gebruikersconfig de detectie niet
  breken. Er wordt bewust geen versie-afhankelijke `--ignore-user-config`-vlag gebruikt.
- Met PC-tools aan draait Codex native als `codex mcp-server` (`electron/codex-native.ts`); MCP-
  elicitation wordt naar de app-approvalpopup vertaald en exec/patch-events verschijnen live.
- Met PC-tools uit gebruikt `codex exec` een lege tijdelijke werkmap, `read-only`, `--ephemeral` en
  negeert het gebruikersconfig/projectregels. Daardoor kan een lokale Codex-config de appmodus niet
  stilletjes veranderen in een schrijvende agent.
- Loginstatus, CLI-detectie en uitvoerquota zijn afzonderlijke signalen. Een geldige `codex login
  status` en live modelcatalogus betekenen dat de lokale verbinding werkt; een latere melding zoals
  `workspace is out of credits` is een extern account-/workspacequotum en geen installatiefout.

### `antigravity` — `AntigravityAdapter` (`:2023`)
- **`antigravity` CLI**. Kan modellen leveren en een statusline-state uitlezen
  (`readAntigravityStatuslineState`, `ipc-handlers.ts`). Native tools worden met officiële
  PreToolUse/PostToolUse-hooks door de app-approvalinstellingen gegate (`antigravity-native.ts`).
- `agy models` blijft de bron van waarheid. De UI splitst zowel oude displaynamen als recente
  slugs (`gemini-3.6-flash-medium`, `claude-opus-4-6-thinking`) alleen voor de presentatie op in
  provider, model en stand; de originele live waarde gaat ongewijzigd terug naar `--model`.
- Een officiële `Stop`-hook houdt de beurt maximaal twee herstelrondes open wanneer na toolgebruik
  nog geen eindtekst of PostToolUse-bevestiging bestaat. Als printmodus daarna toch sluit, herstelt
  de runner eerst een echt eindantwoord uit het transcript. Ontbreekt dat ook, dan eindigt de kaart
  als gedeeltelijk/mislukt met een feitelijke waarschuwing in plaats van eeuwig `running` te blijven
  of een generieke providercrash te tonen.
- Omdat `agy --print` geen interactieve permissionkaart kan tonen, slaat de runner alleen die
  interne CLI-promptlaag over. De officiële `PreToolUse`-hook blijft de app-popup/modus afdwingen;
  echte allow- en deny-integratieruns bewaken dat een toegestane write uitvoert en een geweigerde
  write geen bestand maakt.
- Instellingen gebruikt dezelfde gedetecteerd-pad/handmatig-pad-indeling als Codex en Claude en kan,
  als `agy` ontbreekt, de officiële Windows-installer openen; een bestaande installatie wordt
  rechtstreeks geopend voor de accountlogin.

### `ollama` — `OllamaAdapter` (`:1615`)
- Lokale Ollama-server (default `http://localhost:11434`). `listModels` vraagt de geïnstalleerde
  modellen op en haalt hun `capabilities` live via `/api/show`; health = of de server bereikbaar is.
  Modellen met capability `tools` gebruiken bij een aantoonbare bestands-/commando-opdracht de
  native `/api/chat` function-call-loop en dezelfde gevalideerde bestands-/shelltools en approvals
  als de rest van de app. Bij gewone chatvragen worden bewust geen tooldeclaraties meegestuurd.
  Gewone chat zet `think:false`, verwerkt de NDJSON-stream inclusief een laatste regel zonder newline
  en accepteert alleen een afgesloten `done:true`-respons. Geen auth. `qwen3:1.7b` is live
  geverifieerd voor korte Nederlandse titels en gewone chat; dat bewijst het chatpad, niet de
  kwaliteit voor complexe agenttaken. Daarvoor blijft een groter model met live capability `tools`
  de aangewezen keuze.

- Instellingen heeft daarnaast volledig lokaal modelbeheer. Geïnstalleerde modellen komen uit
  `/api/tags`; formaat, familie, quantisatie, context en capabilities worden met begrensde parallelle
  `/api/show`-calls verrijkt. Downloaden en verwijderen gebruiken rechtstreeks `/api/pull` en
  `/api/delete` — nooit een nagebootste CLI of shellcommando.
- Ontbreekt Ollama op Windows, dan downloadt de onboarding rechtstreeks de vaste officiële
  `https://ollama.com/download/OllamaSetup.exe` met gemeten bytes, snelheid en percentage. Voor
  uitvoering moet Authenticode `Valid` zijn en moet de ondertekenaar `Ollama Inc.` zijn. De app
  gebruikt bewust geen `irm ... | iex`-download-cradle en schakelt Windows Defender nooit uit.
- Een registry-401 bij een publiek model activeert een best-effort klokcontrole tegen de
  `Date`-header van `https://ollama.com/`. Bij relevante afwijking meldt de onboarding concreet
  hoeveel de Windows-klok voor- of achterloopt en hoe de gebruiker die synchroniseert; de app
  wijzigt de systeemklok nooit zelf.
- Nieuwe modellen worden gezocht op de officiële server-rendered `ollama.com/search`- en
  tagpagina's. Omdat Ollama hiervoor geen gedocumenteerde catalogus-JSON-API aanbiedt, blijft een
  veld voor een exacte modelnaam altijd beschikbaar als stabiele fallback. Alleen vaste
  `https://ollama.com`-paden zijn toegestaan; modelnamen worden vóór elk lokaal verzoek gevalideerd.
- Na installeren of verwijderen worden zowel de adaptercatalogus als de rendererproviderlijst
  ververst. Als het verwijderde model actief was, kiest de app een ander werkelijk verbonden model
  en slaat die keuze ook bij een gematerialiseerde chat op.

### `remote` — `RemoteAdapter` (`:2178`)
- Verbindt via **SSH** (`ssh2`) met een eigen machine die Ollama draait. Wachtwoord/private key
  staan versleuteld in `safeStorage`; de eerste hostkey wordt TOFU-gepind. Bij een legitieme
  hostkeywissel kan de gebruiker de opgeslagen vingerafdruk expliciet in Instellingen wissen.
- `ollama list` ontdekt de remote modellen live; een niet-nul exitcode of stderr wordt niet als
  succesvol antwoord behandeld.

## 4.3 Modeldiscovery (algemeen principe)

**Niets in de modelkiezer is hardcoded.** Elke `listModels()` haalt de catalogus live op
(API-endpoint, CLI-`--json`-output of Ollama-HTTP). De renderer laadt ze parallel bij opstart
(`App.tsx` `loadData`) en toont ze meteen als **last-known-good** (gecachet in de provider-store),
terwijl verse discovery op de achtergrond draait.

CLI-catalogi worden gecachet met een **fingerprint** van de executable
(`executableFingerprint`, `:499`) via `cachedCliResult` (`:252`), zodat een dure CLI-aanroep niet
elke keer opnieuw hoeft, maar wél opnieuw draait als de CLI wijzigt.

## 4.4 Credentials (`electron/credential-store.ts`)

- Secrets worden versleuteld met **Electron `safeStorage`** (OS-keychain/DPAPI) en als base64
  in electron-store bewaard onder `credentials.<provider>` (`saveCredential`, `:53`).
- `getApiKey` via IPC geeft **altijd `null`** terug: keys worden nooit naar de renderer teruggelezen.
- Lokale providers (`ollama`, `codex`, `antigravity`) gelden als "geauthenticeerd" zonder key
  (methode `cli`/`none`).
- Legacy `keys.<provider>`-waarden worden bij eerste toegang gemigreerd naar het nieuwe formaat.
- **Browser-sessie-login is uitgeschakeld in stable v1** voor de generieke providers (foutlabel in
  `getCredentialStatuses`, `:128`) — ChatGPT gebruikt z'n eigen websessie-pad, niet dit.

## 4.5 De fallback-keten (`executeWithFallback`, `ipc-handlers.ts:977`)

Als een beurt mislukt op een herstelbare manier, schuift de app automatisch door naar het volgende
model — zodat een chat niet stukloopt op één rate-limit.

1. `preflightModel(modelRef)` (`:1306`) checkt vooraf of de gekozen providerroute beschikbaar is.
   `chatgpt:*` controleert hierbij uitsluitend de ChatGPT-websessie; de OpenAI-API-keyvalidator
   hoort alleen bij echte API-modellen en mag een abonnementsmodel nooit blokkeren.
2. De adapter `sendChat` draait. Faalt hij, dan classificeert `classifyProviderError` (`:2647`)
   de fout tot een `FallbackReason`: `rate_limit`, `context_exceeded`, `auth_failed`, `network`,
   `cancelled`, `provider_error`.
3. Bij `rate_limit`, `context_exceeded`, `auth_failed` of `network` wordt het volgende model uit
   `fallbackCandidates` geprobeerd; `cancelled` en gewone provider-/toolfouten schakelen niet stil door.
   de UI krijgt een `model_switch`-event en het uiteindelijke antwoord onthoudt `fallbackFrom`.
   Een bekende actuele **live** cooldown wordt vooraf overgeslagen. Vertraagde Cloud Monitoring-data
   blokkeert nooit preventief; een echte runtime-429 wel.
4. De keten komt uit `getFallbackConfig` (`:1328`); is die leeg, dan kiest
   `selectDefaultFallbackModels` (`:1396`) verstandige defaults uit de ontdekte modellen.
5. `autoSwitchEnabled` (in `FallbackConfig`) zet het hele mechanisme aan/uit.

Betaalde API-oppervlakken (Gemini Developer API, OpenAI/Anthropic API en Remote) worden alleen
gebruikt als de gebruiker dat per ketenitem expliciet bevestigt. Een fallback na gedeeltelijke
native tooluitvoering gebruikt dezelfde `requestId` en de duurzame `turn_execution_actions`-ledger:
voltooide exacte acties worden geblokkeerd, onzekere acties moeten eerst read-only worden geverifieerd
en nieuwe mutaties doorlopen opnieuw de normale approval.

Automatisch doorschakelen staat standaard uit. Legacyconfiguraties uit oudere versies die dit zonder
expliciete bevestiging aan hadden staan worden bij het lezen veilig uitgeschakeld. De gebruiker moet
de schakelaar in Instellingen bewust opslaan; daarna wordt `autoSwitchConfirmed` bewaard. Een
mislukte fallback bewaart bovendien `fallbackFrom`, zodat de herkomst diagnostisch zichtbaar blijft.

> **Dit is de "auto-fallback chain"-feature.** "Fallback weg" van de gebruiker betekent *stop met
> hardcoden*, **niet** deze keten verwijderen. Zie [doc 9](09-conventions.md).

## 4.6 Quota per provider

- **Codex CLI:** `codex app-server` via `account/rateLimits/read`; levert echte primaire en
  secundaire accountvensters en resetmomenten.
- **Claude CLI:** officiële statusline-payload (`rate_limits.five_hour` en `seven_day`). LLMelt
  ketent een bestaande statusregel en bewaart alleen plan/model/quota.
- **Antigravity CLI:** dezelfde veilige statusline-bridge. De officiële payload publiceert niet in
  elke versie machineleesbaar quota; in dat geval toont LLMelt eerlijk “niet beschikbaar” en
  schakelt het pas door na een echte limietfout.
- **Gemini Developer API:** verplicht dezelfde API-key aan een Google Cloud-project koppelen.
  API Keys API en Cloud Resource Manager valideren dat de sleutel echt bij dit project hoort.
  Service Usage levert de ingestelde effectieve limieten; Cloud Monitoring levert dynamisch de
  actieve `.../limit`- en `.../usage`-reeksen per model. Deze cijfers kunnen volgens Google circa
  150 seconden achterlopen en zijn daarom informatief, niet preventief blokkerend.
- **ChatGPT-websessie:** geen ondersteunde machineleesbare abonnementsteller; runtime-limietfouten
  worden wel als live cooldown opgeslagen.
- **Ollama:** lokaal, dus geen extern providerquotum.

## 4.7 Een provider toevoegen/wijzigen (recept)
1. Voeg (indien nodig) een waarde toe aan `ProviderType` + `PROVIDER_INFO` (`types.ts`).
2. Schrijf/pas een adapter-klasse aan die `ProviderAdapter` implementeert; registreer 'm in
   `createAdapters()`.
3. `listModels()` moet de catalogus **live** ophalen (geen vaste lijst). Gebruik `cachedCliResult`
   voor dure CLI-calls.
4. `sendChat()` moet streamen via `onDelta` en een `AbortSignal` respecteren.
5. Voeg discovery toe aan de opstart-load in `App.tsx` als de provider een eigen kaart heeft.
