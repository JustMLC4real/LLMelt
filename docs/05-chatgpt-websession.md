# 5. ChatGPT-websessie (`electron/chatgpt-scraper.ts`)

Dit is het meest complexe en meest fragiele deel van de app. Het laat je je **ChatGPT-abonnement**
(Plus/Team/Pro) gebruiken zonder API-key, door in een **verborgen Electron-browservenster** op
`chatgpt.com` in te loggen en de echte webinterface te bedienen.

> **Harde regel:** dit is géén anti-bot-/detectie-omzeiling. We bouwen nooit evasion. Alle
> De app maakt zelf geen conversation-POST, PoW of challenge-token; dat blijft volledig bij
> ChatGPT's eigen webclient. De meeste storingen zijn **tijdelijke
> blanco/gecrashte renders**, geen blokkades — classificeer + retry, niet "omzeilen". Zie [doc 9](09-conventions.md).

## 5.1 Waarom een verborgen venster?

Read-only `/backend-api/*`-requests voor sessie-, account- en modeldiscovery vereisen de
**Bearer access-token** van de ingelogde sessie (cookies alleen → 401). Het echte chatbericht gaat
uitsluitend via de composer van `chatgpt.com`; de pagina maakt zelf haar conversation-request.

Er zijn twee soorten verborgen vensters:
- een **worker/login-venster** voor het ophalen van de sessie, modellen en tokens;
- een **chat-venster** dat de composer/DOM gebruikt voor het daadwerkelijke stellen van een vraag.

## 5.2 Engine-status & stages

De scraper houdt een expliciete state-machine bij via `setEngineStage(stage, patch)` /
`setEngineStatus(...)` (`:113`). De renderer leest die via `auth.chatgptEngineStatus()` en toont
'm; bij een fout kan de gebruiker "ChatGPT herstellen" (opent een zichtbaar herstelvenster).
Stages die je in de logs tegenkomt:

```
idle → session-check → page-ready → composer-ready →
message-injected → send-clicked → stream-detected → response-complete
                                   (of: recovering / failed)
```

`debugLog(...)` is standaard uit. Alleen met `AI_SUPERAPP_DIAGNOSTICS=1` schrijft de app begrensde,
geredigeerde diagnostiek naar `chatgpt-debug.log` in Electron's gebruikerslogmap. Bekende tokens,
cookies, autorisatieheaders, API-keys en account-/gesprek-id's worden verwijderd. De gewone console
toont nooit ruwe streamframes of gesprek-URL's; bij een mismatch staat die detailinformatie alleen
geredigeerd in het opt-in log. Logs kunnen nog wel gebruikersinhoud bevatten en horen daarom nooit
in Git of een publiek foutrapport.

## 5.3 Modellen ophalen (`/backend-api/models`)

`listSessionModels()` doet een `apiGet('/backend-api/models')` (`:940`). De response bevat:
- `models[]` — de ruwe modelslugs met capabilities;
- `versions[]` — **ChatGPT's eigen modelkiezer**: elke entry is één regel in de Model-lijst
  ("GPT-5.6 Sol") met daarin de **intelligentie-presets** ("Direct", "Gemiddeld", "Hoog", "Pro"),
  elk met een `model_slug`, een `thinking_effort` en soms een `subtitle`.

We nemen `versions[]` **één-op-één** over in `ChatgptVersion` / `ChatgptIntelligencePreset`
(`types.ts:61`) i.p.v. modelnamen te parsen. Voordeel: de picker toont exact wat ChatGPT toont, en
interne varianten (Terra, Luna, CCA) lekken niet in de UI. Modellen zonder intelligentie-keuze
(zoals o3) hebben geen presets; dan valt de app terug op de eerste slug van de versie.

Bij een verse websessie kan de eerste niet-lege `/backend-api/models`-response nog een vorige
catalogusgeneratie bevatten. De renderer behandelt “niet leeg” daarom niet als definitief: vóór de
eerste bruikbare keuze volgt een cachevrije warm-upcall en daarna twee begrensde controles. Tijdens
die eerste controle kan geen stale keuze worden verzonden. `models[]` en `versions[]` worden
sequentieel uit dezelfde refresh gelezen en alleen hun live kruising is selecteerbaar; zo kan een
oude Direct-slug niet met nieuwere presets worden gecombineerd.

Werkruimte-accounts: zonder de header **`ChatGPT-Account-Id`** antwoordt de backend met een
misleidende 404 ("no access"). De scraper bepaalt het actieve workspace-account via
`/backend-api/accounts/check/v4-2023-04-27` en zet die header (`:406`, `:433`).

HTTP-431-mitigatie: als de cookie-jar te groot wordt, snoeit `pruneChatGptCookies` proactief
(`:210`) zodat requests niet op "headers too large" stuklopen.

## 5.4 Een vraag stellen — echte webinterface

`sendChatViaSession(options)` is het publieke instappunt. De app opent een tijdelijke chat met het
live gekozen model, vult de composer, klikt op versturen en observeert de response die ChatGPT's
eigen frontend ontvangt. Er bestaat geen directe conversation-POST-fallback in de app.

De webroute heeft bewust één verborgen `chatWindow` en één DOM-streambuffer. Daarom serialiseert
`sendChatViaSession` de opdrachten met `createSerialTaskQueue`: een tweede ChatGPT-chat toont eerst
“Wacht op de actieve ChatGPT-websessie” en bestuurt het venster pas als de vorige klaar is. Zonder
die FIFO-grens konden twee gelijktijdige chats hetzelfde browserantwoord lezen en onder beide
`chatId`'s opslaan. Stoppen terwijl een opdracht wacht verwijdert die taak uit de uitvoering; andere
providers blijven onafhankelijk parallel werken.

### A. Directe/instant antwoorden → SSE
Voor niet-reasoning antwoorden gebruikt de webclient doorgaans **Server-Sent Events**. De app
observeert de deltas uit de response van de pagina en geeft ze via `onDelta` door.

### B. Reasoning-antwoorden → WebSocket na `stream_handoff`
Voor reasoning-modellen kan ChatGPT na een **`stream_handoff`**-frame een tweede verbinding
gebruiken (`subscribe_ws_topic` of `resume_sse_endpoint`; de site kiest). De app leest zowel de
zichtbare DOM als de door de echte pagina ontvangen streammetadata om model en voortgang te tonen.

De route is altijd: composer zoeken → eventuele bestanden via de echte file-input koppelen → tekst
invoeren → verzenden → op de webresponse wachten. Stages `composer-ready` → `message-injected` →
`send-clicked` markeren dit. Challenge- of requirementslogica wordt nooit door de app nagebouwd.

## 5.5 Verifiëren welk model écht antwoordde

De gebruiker wil zeker weten dat het gekozen model ook het antwoordende model is. De scraper vangt
de metadata van de conversation-response (`captureMetadata`, `:1205`) en leest daaruit de
`model_slug` die ChatGPT gebruikte. Door de gekozen slug met de gebruikte slug te vergelijken
ontstaat een verificatie-uitkomst (o.a. **EXACT**, **FAMILY**, **MISMATCH**, **REQUEST-OK/‑MISMATCH**,
**UNKNOWN**). `response-complete` zet `lastModel` op de daadwerkelijk gebruikte slug (`:1283`).

Historische bug (opgelost): een hardcoded `gpt-5-instant` bestond niet meer, waardoor ChatGPT
stilletjes `gpt-5-5` gebruikte (MISMATCH). De fix: `pickTitleModelSlug()` en de picker gebruiken de
**live** modellijst — nooit een vaste slug.

## 5.6 Betrouwbaarheid: blanco vs echte blokkade

De meeste "mislukkingen" zijn tijdelijke lege of gecrashte renders van het verborgen venster, niet
een blokkade. De scraper:
- luistert op `render-process-gone` / `unresponsive` (`:262`, `:287`, `:292`) en herstelt het venster;
- classificeert een lege composer/lege respons als **herstelbaar** (retry met nieuwe render) i.p.v.
  als "geblokkeerd";
- past alleen een cooldown toe bij een echte "unusual activity"-melding (`:1480`).

De juiste reactie op falen is dus: **classificeren en opnieuw renderen/proberen**, en dat eerlijk in
de engine-status tonen — niet detectie omzeilen.

## 5.7 Login & herstel-IPC

| IPC | doel |
|---|---|
| `auth:chatgptBrowserLogin` | opent het login-venster op chatgpt.com |
| `auth:chatgptBrowserLogout` | wist de sessie |
| `auth:chatgptSessionStatus` | `{ active: boolean }` — is de websessie bruikbaar? |
| `auth:chatgptEngineStatus` | de volledige stage/status van de engine |
| `auth:chatgptEngineReset` | reset de engine (bij vastlopen) |
| `auth:chatgptOpenWindow` | opent een zichtbaar venster voor handmatig herstel |

De renderer koppelt "ChatGPT herstellen" (in `MessageBubble` bij een herstel-hint) aan
`chatgptEngineReset()` + `chatgptOpenWindow()`.

## 5.8 Waar je op moet letten bij wijzigingen
- ChatGPT verandert regelmatig endpoints/veldnamen. Verifieer tegen de **echte** response. Zet voor
  tijdelijke lokale diagnostiek `AI_SUPERAPP_DIAGNOSTICS=1` en lees de geredigeerde log in
  Electron's gebruikerslogmap — niet uit het hoofd.
- De optionele account-selftest vereist `CG_SELFTEST=1` én `CG_SELFTEST_MODEL=<live slug>` en
  verbruikt één bericht; gebruik hem alleen bewust.
- Voeg nooit vaste modelslugs of vaste presets toe; alles komt uit `models[]`/`versions[]`.
- Reasoning vs direct = twee transports; test beide als je aan de stream-lezer komt.
- Nooit `chatgpt-debug.log` committen; ook geredigeerde logs kunnen gebruikersinhoud bevatten.
