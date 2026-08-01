# 9. Conventies, harde regels & valkuilen

Lees dit vóór je iets wijzigt. Veel hiervan is met bloed, zweet en eerdere AI-sessies geleerd.

## 9.1 Harde regels (niet-onderhandelbaar)

### Niet hardcoden
Modellen, ChatGPT-intelligentie-presets, reasoning-efforts en service-/speed-tiers komen **altijd
live** van de provider (CLI-`--json`, API-catalogus, of `/backend-api/models`). **Geen** vaste
allowlists van modelnamen of presets. Vaste labels/volgordes voor *presentatie* mogen wel (bv.
`CLAUDE_FAMILY_ORDER` bepaalt alleen de weergavevolgorde, niet welke modellen bestaan).

> **"Fallback weg" ≠ de fallback-keten verwijderen.** Als de gebruiker "fallback weg" zegt, bedoelt
> hij *stop met hardcoden / stop met een hardgecodeerde terugval*. De **auto-fallback-chain-feature**
> (doc 4.5) blijft. Verwar deze twee nooit.

### Geen ChatGPT-detectie-omzeiling
Bouw **nooit** anti-bot-/evasion-technieken voor de ChatGPT-websessie. Alleen legitieme
betrouwbaarheids-debugging: de meeste storingen zijn **tijdelijke blanco/gecrashte renders**, geen
blokkades. De juiste aanpak is **classificeren + retry/opnieuw renderen**, en dat eerlijk in de
engine-status tonen. Conversation-POSTs, PoW en challenge-tokens blijven volledig bij ChatGPT's
eigen webclient; bouw die niet na in de app. (Zie [doc 5](05-chatgpt-websession.md).)

### Nederlands
UI-teksten, commit-berichten en codecommentaar zijn in het **Nederlands**. Nieuwe UI-strings via
`t('key')` met een key in `nl.json` én `en.json`.

### De approval-popup is een kernfeature
De per-bestand/-commando-goedkeuring in modus `ask` mag niet stilletjes verdwijnen. PC-toegang is
echt gate-t: `full` = geen popups (bewuste keuze), `auto-project` = bestandstools auto binnen de
canoniek gecontroleerde map maar vrije shellcommando's blijven vragen, `ask` =
vraag alles. Een eerdere observatie "de agent draait altijd toch" bleek **modelkwaliteit** +
validatie-vóór-de-popup, niet dat de approval niet werkt — de approval-enforcement werkt wél.
Buiten de popup klikken is **uitstellen**, nooit impliciet weigeren. De aanvraag blijft gekoppeld aan
`chatId`/`requestId`, verschijnt boven de juiste composer en verdwijnt alleen na een expliciet
antwoord, Stop/annulering of het sluiten van het venster.

## 9.2 Bekende valkuilen (met oplossing)

### React StrictMode dubbel-mount
StrictMode doet mount → cleanup → mount. Een `cancelled`-ref die in cleanup op `true` wordt gezet en
**niet** bij mount wordt gereset, maakt dat de tweede mount alles negeert (bug in de onboarding:
"0 van 6", detectie verwerkte niets). **Oplossing:** reset `cancelled.current = false` bij mount.

### Chat opnieuw selecteren wist de berichten
`setCurrentChat` mag de berichtenlijst **niet** legen als je de chat die al open is opnieuw kiest —
anders vuurt de reload-effect (gekoppeld aan `currentChatId`) niet en blijft de chat blanco. Er zit
een expliciete guard voor in `chat-store.ts:142`.

### Lege modellijst niet over de cache heen
`setProviderModels(..., preserveExistingOnEmpty=true)` (default) gooit een **lege** verse lijst niet
over een bestaande — zo blijft de picker gevuld (last-known-good) terwijl discovery draait. De
modellenlijst blijft ook staan ná uitloggen; gebruik daarom `chatgptSessionActive` (niet de
lijstlengte) om te bepalen of ChatGPT écht bruikbaar is (`chatgptWebSessionUsable`).

### Niet-leeg betekent bij eerste start nog niet stabiel
Codex en ChatGPT kunnen tijdens het opwarmen een geldige maar verouderde niet-lege snapshot leveren.
Accepteer de eerste lijst dus wel als tijdelijke weergave, maar maak er nog geen verzendbare
standaardkeuze van. De eerste keuze volgt pas na een cachevrije warm-uprefresh; ChatGPT-`models[]` en
`versions[]` moeten bovendien uit dezelfde refresh komen en op modelslug kruisen. Handmatig
`refreshModels(provider)` moet de adaptercache echt invalideren.

### Electron-tray lijnt `\t` niet rechts uit
Een tab-teken in een tray-menu-label rendert als een zichtbaar pijltje, niet als rechts-uitlijning.
Gebruik een prefix (`[Project] Titel`), geen kolom-uitlijning. (`main.ts:128`.)

### `ChatGPT-Account-Id`-header
Zonder deze header antwoordt de backend voor workspace-resources met een **misleidende 404** ("no
access"). Zet 'm altijd op basis van het actieve account (`chatgpt-scraper.ts:433`).

### Reasoning vs direct = twee transports
Directe antwoorden komen via SSE; reasoning-antwoorden via een **WebSocket** ná een `stream_handoff`
(SSE zit ge-escaped in `encoded_item`). Test **beide** als je aan de stream-lezer komt.

### Tool-output zijn `role='user'`-berichten
Tool-output wordt opgeslagen als `role='user'` met `content` beginnend met `Tool output:` (zodat het
model ze als input ziet). De UI herkent ze via `isToolOutputMessage()` en toont ze bij de AI-beurt.
Behandel ze niet als "gebruikersbericht" in nieuwe logica.

### Nooit `chatgpt-debug.log` committen
Diagnostiek is opt-in en verwijdert bekende geheimen, account-/gesprek-id's en UUID-achtige
provideridentifiers; ruwe streamframes komen nooit in de gewone console. De log kan nog
gebruikersinhoud bevatten en hoort in Electron's gebruikerslogmap, nooit in Git.

## 9.3 Codestijl & structuur

- **Houd componenten dun.** Niet-triviale logica gaat in een **pure module** naast de component
  (`*-utils.ts`, `agent-commands.ts`, `model-utils.ts`, …) mét een `*.test.ts`. Zo is het testbaar
  zonder React en blijft de UI overzichtelijk.
- **Nieuwe backend-capability = 3 stappen:** handler in `ipc-handlers.ts` → façade in `preload.ts`
  → aanroep in component/store. De renderer raakt Node nooit direct aan.
- **DB-migraties** zijn idempotent en draaien één keer; nieuwe migratie onderaan `initDatabase` met
  een uniek datum-id (`database.ts`).
- **Streaming** loopt over één kanaal (`chat:streamEvent`) met getypte events; voeg nieuwe
  voortgang toe als een nieuw `ChatStreamEvent.type`, niet als een los kanaal.
- **Lopende beurten zijn per chat.** Houd request-id, status, streamingtekst, native segmenten en
  Stop nooit als globale rendererstate. Elk backend-event draagt de oorspronkelijke `chatId`.
- **Async chatdata wordt bij het toepassen gevalideerd.** Een controle vóór `await`/`.then()` is
  onvoldoende: gebruik `setMessagesForChat(chatId, data)` of vergelijk na de await opnieuw. Ook
  pending bijlagen, drafts, Auto Mode-status en meervoudige titelstatus blijven per chat gescheiden.
- **Een gedeelde providerresource moet serieel.** De ChatGPT-websessie heeft één BrowserWindow en
  één DOM-streambuffer; alleen die route gebruikt daarom een annuleerbare FIFO. Parallel besturen
  kan inhoud correct routeren maar tóch het verkeerde providerantwoord opleveren.
- **Commentaar** legt het *waarom* uit (vaak een valkuil), niet het *wat*. Match de omringende stijl.

## 9.4 Omgeving (Windows)

- Primaire shell is **PowerShell**; de agent-terminal ondersteunt `powershell`/`cmd`/`pwsh`
  (`pty-terminal.ts`). Default agent-shell = PowerShell.
- Codex-executable: kies de **nieuwste** gebundelde versie
  (`%LOCALAPPDATA%/OpenAI/Codex/bin/<versie>/codex.exe`) zodat de catalogus matcht met de losse
  Codex-app (`codex-cli-discovery.ts`).
- Standaard-werkmap: `Documents/LLMelt` voor nieuwe installaties
  (`ensureDefaultWorkspacePath`); een bestaande `Documents/AI Superapp` blijft als legacywerkmap
  werken zodat gebruikersbestanden niet worden verplaatst.
- De zichtbare/package-naam is `LLMelt`, maar `appId`, `%APPDATA%/ai-superapp`,
  `AI_SUPERAPP_*`-omgevingsvariabelen en bestaande event-/opslagsleutels zijn bewuste
  compatibiliteits-ID's. Hernoem die alleen met een expliciete migratie.
- Voor een echte lokale first-run-smoketest mag de devbuild met
  `AI_SUPERAPP_TEST_USER_DATA_DIR=<lege tijdelijke map>` worden gestart. Dit werkt bewust alleen
  wanneer Electron niet packaged is en houdt de echte database, keys en browsersessie onaangeraakt.

## 9.5 Release-discipline

- Bump de versie op **één** plek (`package.json`).
- Commit direct op `main` met titel `LLMelt <versie>` + tag `v<versie>`.
- Bouw, maak een **git-bundle-backup**, publiceer naar GitHub Releases, en **verifieer** remote (versie +
  sha512 + HTTP 200). Zie [doc 8](08-build-release.md).
- Houd GitHub schoon: alleen broncode + deze docs, geen scratch-bestanden.

## 9.6 Native provider-tools & turn-rendering (valkuilen)

**Native tools zijn gebouwd voor Claude, Codex, Antigravity, Gemini en tool-capabele Ollama-
modellen** (`electron/*-native.ts` + `electron/native-tools.ts` + de segment-beurt in
`ipc-handlers.ts`). Zie [doc 6.8–6.13](06-agent-tools.md#68-native-claude-code-tools-electronclaude-nativets) en
[doc 7.9](07-frontend.md#79-de-beurt-als-één-geheel-turn-rendering). Valkuilen die je moet kennen:

- **`.cmd` spawn EINVAL (Windows):** routeer elke provider-`.cmd`/`.bat` via de gedeelde
  `cliSpawnSpec` (`cmd.exe /d /s /c` met ontsnapte argumenten), niet direct. Geef de
  `--mcp-config` als **bestand** door (inline JSON wordt door cmd.exe vermangeld).
- **Geen project-CLI-kaping:** los kale namen alleen via `where`/`which` op; accepteer niet toevallig
  een `codex.cmd`, `claude.cmd` of `agy.cmd` uit de actieve projectmap. Sla WindowsApps-aliaspaden
  over als ze geen echt startbaar executable zijn.
- **Schone env:** strip `CLAUDECODE`/`CLAUDE_CODE_*`/`ANTHROPIC_BASE_URL` bij het spawnen — anders
  honoreert `claude` het `--permission-prompt-tool` niet (het denkt dat 'ie een SDK-child is).
- **Codex-elicitation is afwijkend:** antwoord met `{decision:"approved"|"denied"}`, niet met het
  standaard MCP-elicitation-object.
- **Antigravity-hooks tijdelijk mergen:** herstel bestaande `.agents/hooks.json` byte-voor-byte en
  serialiseer gelijktijdige mutaties. Op Windows gaan executable-/scriptpaden via env-vars.
- **Antigravity print-permissions:** `--dangerously-skip-permissions` is alleen toegestaan in de
  native runner mét actieve tijdelijke `PreToolUse`-gate. Verwijder of omzeil die hook nooit; de
  allow/deny-integratietest moet beide kanten blijven bewijzen.
- **Ollama-capability live:** alleen `/api/show.capabilities` bepaalt of `tools` beschikbaar is;
  geen vaste lijst met modelnamen.
- **Ollama-modelbeheer gebruikt HTTP, geen shell:** `/api/tags`, `/api/show`, `/api/pull` en
  `/api/delete` zijn autoritatief. De publieke bibliotheekzoeker mag alleen de vaste
  `https://ollama.com`-origin lezen en moet altijd een exacte-modelnaamfallback houden, omdat daar
  geen gedocumenteerde catalogus-JSON-API voor bestaat.
- **Gemini thought signatures bewaren:** stuur model-parts met `functionCall`, call-id en
  `thoughtSignature` ongewijzigd terug vóór de bijbehorende `functionResponse`.
- **Live tools → `tool_run_*`, nooit `tool_activity`:** dat laatste plakt zonder anker aan een vorige
  groep → re-highlight-geflikker.
- **Native beurt heeft één anker:** alle tools ankeren aan hetzelfde korte intent-bericht; alleen het
  laatste niet-lege providersegment wordt daarna als slotantwoord opgeslagen. Render nooit
  tussentijdse modelnarratie tussen edits en runs.
- **Bestanden per pad dedupliceren:** normaliseer hoofdletters en separators en toon per beurt alleen
  de laatste succesvolle create/edit als actuele kaart; oudere varianten horen onder eerdere pogingen.
- **Toon álle tools** (Write/Edit/Read/Bash/…), niet alleen Bash — anders zie je bij "maak een
  bestand" (Write) niks.
- **Turn = één geheel:** groepeer consecutieve assistent-items met één avatar (`continuation`), voor
  álle providers. De streaming-status hoort in de kop (`liveStatus`), niet als aparte regel.
- **`full`-modus = geen popup** (bypassPermissions, bewust). Approval-popup zie je alleen in `ask`.

## 9.7 Bekende providerbeperkingen

- **Antigravity-tekst** komt in `--print` per blok/eindantwoord; toolcalls zelf zijn wel live via hooks.
- **Gemini is API-only:** de Google-provider gebruikt uitsluitend de Developer API-key;
  Google-accounttoegang blijft een afzonderlijke Antigravity-route.
