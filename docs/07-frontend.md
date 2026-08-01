# 7. Frontend (React 19 + Zustand)

Instap: `src/main.tsx` mount `<App/>` en initialiseert i18next. Er is **geen router**; de actieve
view wordt bepaald door `currentView` in de chat-store (`chat` / `settings` / `tokens` / `keyChecker`).

## 7.1 Componentenboom

```
App.tsx
├─ Titlebar.tsx            custom frameless titelbalk (min/max/close via windowControls)
├─ OnboardingGuide.tsx     eerste-keer-gids (apart scherm)
├─ app-layout
│  ├─ Sidebar.tsx          chats + mappen/projecten, nieuw gesprek, navigatie
│  ├─ main-content (view-transition, key=currentView)
│  │  ├─ ChatView.tsx      berichtenlijst + streaming + ChatInput
│  │  │  ├─ MessageBubble.tsx        één bericht (user rechts / AI links)
│  │  │  ├─ CommandRunActivity.tsx   live commando-/tool-kaarten
│  │  │  └─ ChatInput.tsx            composer + model/agent-controls
│  │  │     ├─ ModelSelector.tsx     de grote modelkiezer (per provider)
│  │  │     └─ SystemPromptEditor.tsx
│  │  ├─ Settings.tsx      alle instellingen (providers, agent, MCP, onboarding opnieuw)
│  │  ├─ TokenDashboard.tsx verbruik & rate-limits
│  │  └─ ApiKeyChecker.tsx  batch API-key-validatie
│  └─ TerminalPanel.tsx    xterm-terminals (togglebaar)
└─ approval-dialog         in-app goedkeuringswachtrij (agent:approvalRequest)
```

Ondersteunend: `AutoModePanel.tsx` (twee AI's die elkaar prompten), `FallbackChain.tsx`
(fallback-volgorde bewerken), `UpdatePanel.tsx` (updater-UI), `ConfirmDialog.tsx`, `ui.tsx`
(gedeelde UI-primitives: `IconButton`, `SelectField`, `ProviderBadge`, `QuotaBadge`, `FlipText`),
`ProviderAvatarIcon.tsx` (de merk-logo's per provider).

## 7.2 Pure logica-modules (met tests)

De niet-triviale logica staat in **pure, geteste** modules naast de componenten, zodat ze los van
React getest kunnen worden (`vitest`, met coveragegate):

| module | doel |
|---|---|
| `model-utils.ts` | alle label-/parse-/groepeer-logica voor de modelkiezer (per provider) |
| `agent-commands.ts` | tag-parsing, validatie, reparatie-prompts (zie [doc 6](06-agent-tools.md)) |
| `command-run-utils.ts` | live tool-run/-activity-state, render-items voor de chat |
| `line-diff.ts` | begrensde regel-diff voor providerneutrale bestandskaarten |
| `command-presets.ts` | slash-commando's (`/doel`, `/reset`, presets) |
| `mcp-tools.ts` | MCP-tool-definities + `executeMcpTool` (gedeeld met main) |
| `chatgpt-diagnostics.ts` | classificatie van ChatGPT-fouten |
| `chat-run-state.ts` | request-, status- en streamstate per chat, inclusief request-routing |
| `approval-queue.ts` | popupvolgorde, uitstellen en approvals per chat |
| `serial-task-queue.ts` | annuleerbare FIFO voor een gedeelde providerresource |
| `chat-scope.ts` | late async-resultaten, tijdelijke lijsten en status-id's strikt per chat |
| `codex-utils.ts` | Codex-specifieke helpers |
| `new-chat.ts` | lokaal concept starten, bij eerste actie materialiseren + `lastUsedFolderId()` |
| `draft-chat.ts` | pure helpers voor verborgen conceptgesprekken per project |
| `panel-resize.ts` | begrenzen en berekenen van zijbalk-/terminalbreedtes |
| `onboarding-launch.ts` | event + settings-keys om de gids (opnieuw) te starten |
| `composer-focus.ts` | `requestComposerFocus()` — event om de invoer te focussen |

> **Belangrijk patroon:** wil je logica die de UI stuurt, zet 'm hier (puur) neer en schrijf een
> test, niet in de component. De componenten zijn dun.

## 7.3 De composer (`ChatInput.tsx`)

Het hart van de interactie (~686 regels). Bevat:
- `handleSend` (`:217`) — zie de [levensloop](01-architecture.md#14-de-levensloop-van-één-chatbericht-end-to-end).
- **Concepten:** `Nieuw gesprek` maakt eerst uitsluitend een lokale `draftChat`. Die staat niet in
  SQLite, sidebar of tray. `messageDrafts[chatId]` bewaart de getypte tekst en een tweede klik op
  `Nieuw gesprek` (of de project-plus) keert terug naar hetzelfde concept. Pas vlak voor het eerste
  verzonden bericht of de eerste Auto Mode-run materialiseert `ensureChatMaterialized` dezelfde
  client-id in SQLite en verschijnt de rij in de sidebar. Bij een open project ligt de zichtbare
  selectie uitsluitend op de actieve chatrij. Alleen wanneer die chats door dichtklappen verborgen
  zijn, neemt de projectkop de neutraal-grijze actieve stijl over.
- **Bijlagen:** pending bijlagen staan in `attachmentsByChat`; wisselen, versturen of verwijderen
  verandert uitsluitend de bijlagen van die chat.
- **Typen tijdens genereren:** de textarea blijft bewerkbaar terwijl een provider streamt en bewaart
  nieuwe tekst als concept. Alleen opnieuw versturen blijft geblokkeerd zolang `Stop` actief is.
- **Gelijktijdige chats:** alleen de huidige `chatRuns[chatId]` bepaalt `Stop`, status en inputslot.
  Een andere chat kan dus een eigen beurt starten en de Sidebar toont per lopende chat een spinner.
- **Late refreshes:** iedere DB-response draagt de aangevraagde `chatId` naar
  `setMessagesForChat`; de store beslist pas bij het toepassen of die chat nog actief is.
- **Uitgestelde approval:** buiten de approval-popup klikken parkeert de vraag boven de composer van
  de juiste chat; Toestaan/Weigeren blijft daar beschikbaar zonder de aanvraag als geweigerd te zien.
- **Auto-resize textarea:** een `useLayoutEffect` op `input` (niet in `onChange`) zet de hoogte,
  zodat de textarea meegroeit **én terugkrimpt** bij typen, wissen én na versturen. `useLayoutEffect`
  meet vóór de paint → geen sprong tijdens typen.
- **Model-chip + agent-chip:** toont het actieve model (incl. ChatGPT-inspanning) en de PC-toegang-modus
  (`ask`/`auto-project`/`full` of "PC-tools uit"), met per-chat override via het access-menu.
- **Run settings:** reasoning-effort/service-tier (Codex) + command-presets.
- **Context-meter:** `tokens.getContextUsage` toont de context-vulling.
- **Code-splitting:** Settings, Terminal, onboarding, keychecker en tokendashboard laden als aparte chunks.
  De navigatiechunks worden tijdens browser-idle alvast opgehaald (zonder componenten te mounten),
  zodat de eerste viewwissel de echte pagina animeert en geen tijdelijke laadtekst toont.

## 7.4 Berichtweergave (`MessageBubble.tsx`)

- Root-class bepaalt de layout: `is-user` (jouw eigen bericht — **rechts, in een bubbel**),
  `is-assistant` (AI — **links, geen achtergrond**) of `tool-output-message` (tool-output, hoort
  visueel bij de AI-beurt). Een door Auto Mode gemaakte opdracht behoudt onder water `role: user`
  zodat het antwoordmodel haar als instructie ontvangt, maar `runConfig.autoModePrompt` rendert haar
  links met het icoon/model van de prompter en het label **Auto Mode prompt**.
- `CopyButton` — icoon dat kort een vinkje wordt na kopiëren; hover-only zichtbaar en voor de
  actieve beurt pas beschikbaar nadat de provider/tool-loop volledig klaar is.
- Markdown via `react-markdown` + `remark-gfm`; code-blokken krijgen een taal-label + kopieerknop.
- ChatGPT-herstel: bij een herstel-hint verschijnt een "ChatGPT herstellen"-knop
  (→ `chatgptEngineReset` + `chatgptOpenWindow`).
- `formatModelBadge` toont voor ChatGPT het gekozen preset-label ("GPT-5.6 Sol · Hoog"), voor Codex
  het model + effort, anders de model-id.

**Layout-detail (recent):** AI- en tool-berichten krijgen in `index.css` een rechter-goot
(`padding-right: calc(32px + var(--space-3))`) zodat hun tekst/code-bubbels op precies dezelfde
rechterlijn eindigen als jouw eigen (rechts uitgelijnde) berichten.

## 7.5 De modelkiezer (`ModelSelector.tsx` + `model-utils.ts`)

Per provider een eigen indeling, allemaal gevoed door de **live** catalogus:
- **ChatGPT:** Model (`versions[]`) × Intelligentie-preset (Direct/Gemiddeld/Hoog/Pro), exact zoals
  ChatGPT's eigen UI. Alleen live modellen met `providerSurface: 'subscription-web'` en `canChat`
  komen in deze kaart; er is geen hardcoded modelallowlist. Een actieve websessie geldt voor de
  onboarding pas als gebruiksklaar wanneer ook de live webcatalogus aanwezig is. Als die endpoint
  direct na login nog leeg of al niet-leeg maar verouderd is, synchroniseert `App.tsx` hem vóór de
  eerste keuze cachevrij en daarna automatisch met begrensde wachttijden. Modellen en presets moeten
  uit dezelfde snapshot komen; tijdens de eerste controle is verzenden uitgeschakeld. Elke nieuw
  geopende modelkiezer doet bij een ontbrekende catalogus bovendien direct een cachevrije poging.
- **Codex:** model × reasoning-effort × service/speed-tier (live uit de CLI-catalogus). De picker
  toont providerwaarden afzonderlijk; als een model zowel `max` als `ultra` meldt, zijn dat dus
  twee keuzes (`Max` en `Ultra`) en wordt niets samengevoegd.
  Een verse CLI kan eerst zijn ingebouwde catalogus teruggeven terwijl de accountcatalogus opwarmt;
  vóór de automatische standaardkeuze volgt daarom één cachevrije refresh en daarna twee korte
  achtergrondcontroles. Dit vervangt de vroegere noodzaak om zelf op `Modellen vernieuwen` te klikken.
  Op het lege beginscherm is de verbindingsstip groen wanneer de loginprobe slaagt **of** de app
  al een geldige live Codex-catalogus heeft. Tijdens de eerste probe is hij oranje; rood verschijnt
  pas na een afgeronde controle zonder login en zonder catalogus. Een tijdelijk account-/credit-
  probleem bij het uitvoeren maakt een gezonde lokale CLI-detectie dus niet ten onrechte rood.
- **Claude CLI:** familie × versie; families in vaste **weergavevolgorde** `['Fable','Opus','Sonnet','Haiku']`
  (`CLAUDE_FAMILY_ORDER`) — dit is enkel presentatievolgorde, geen hardcoded catalogus.
- **Antigravity:** provider × model × modus, ook wanneer de live CLI-catalogus hyphen-slugs in
  plaats van menselijke displaynamen teruggeeft.
- **Auto Mode:** gebruikt per rol dezelfde opgesplitste dropdowns als de hoofdselector:
  provideroppervlak plus de live toepasselijke velden (bijvoorbeeld Codex Model/Variant/
  Inspanning/Snelheid, Claude Familie/Versie/Inspanning, Gemini Familie/Versie/Variant en
  Antigravity Familie/Model/Modus). Er bestaat geen tweede vaste modellenlijst. Auto Mode
  toont apart wanneer de prompter schrijft, het antwoordmodel reageert, de volgende ronde wacht
  of een fout is opgetreden. De configuratie is een overlay boven de bestaande chat; na `Start`
  sluit die overlay en verhuist de live fase, ronde, promptpreview en pauze/stop naar een compacte
  statusbalk direct boven de composer. De chat blijft dus tijdens de hele run zichtbaar en bruikbaar.
  ChatGPT-versies en intelligentieniveaus komen uit dezelfde live `versions[]`-catalogus; niveaus
  die de provider als niet beschikbaar meldt of waarvan het backing model ontbreekt worden niet als
  selecteerbare combinatie getoond. Een versiewissel kiest atomair het eerste geldige niveau.
- Elke samengestelde kaart (Codex, ChatGPT) onthoudt z'n eigen laatste keuze (`lastCodexRef`/
  `lastChatgptRef` in de chat-store).

Systeemprompt, Auto Mode en Terminal zijn expliciete werkpanelen. De Auto Mode-configuratie sluit
na een geslaagde start; de run zelf blijft zichtbaar in de compacte composerstatus. Een ander
werkpaneel openen sluit het huidige paneel. Dezelfde werkpaneelknop, de eigen X of Escape sluit;
een klik in de chat doet dat bewust niet. De sidebar en terminal hebben toegankelijke
sleep-/toetsenbord-separators en bewaren hun gekozen breedte lokaal.

De automatische gesprekstitel start meteen nadat het eerste userbericht is opgeslagen, parallel
aan de providerbeurt. **Ollama is de enige AI-provider voor titels**; ChatGPT wordt hiervoor nooit
aangeroepen. Oude opgeslagen waarden `auto` en `gpt` migreren naar `ollama`. De keuzelijst bevat
daarom alleen `Ollama`, `Eenvoudig (geen AI)` en `Uit`. Als Ollama of een lokaal titelmodel ontbreekt,
toont hetzelfde instellingenblok de vereiste modelnaam en één expliciete installatieknop. Die gebruikt
op Windows het officiële Ollama-installatiescript en downloadt daarna het lichte bootstrapmodel
`qwen3:1.7b` via de lokale `/api/pull`-stream; als er al modellen staan, kiest de app dynamisch het
kleinste algemene model uit de live catalogus. Dit bootstrapmodel is dus geen modellen-allowlist.
Een mislukte AI-oproep kopieert nooit stilletjes het eerste bericht als titel: na de hoofdbeurt volgt
een nieuwe Ollama-poging en tot die tijd blijft de standaardtitel staan. Alleen de expliciete
instelling `Eenvoudig (geen AI)` gebruikt de eerste tekens van het bericht. Auto Mode start dit al
met het ingevulde doel; zonder doel gebeurt het zodra de prompter de eerste concrete prompt heeft gemaakt.

## 7.6 Onboarding (`OnboardingGuide.tsx`)

Eerste keer openen → een **apart** welkomstscherm (niet over de app heen). Het:
- legt uit dat installatie nooit stil gebeurt en **detecteert per service** via de provider-store;
- houdt in `onboarding-utils.ts` `unknown`/`found`/`absent` apart van `ready`: een gevonden CLI kan
  immers nog een accountlogin nodig hebben;
- vraagt wat de gebruiker wil gebruiken en doorloopt daarna één zichtbare configuratiestap per
  gekozen provider;
- opent voor Codex, Claude en Antigravity de officiële Windows-installer wanneer de CLI ontbreekt,
  of rechtstreeks het loginvenster wanneer de CLI al bestaat. Het echte gedetecteerde pad staat in
  de stap en wordt na login opnieuw gecontroleerd;
- opent voor ChatGPT de eigen websessie-login, valideert een Gemini API-sleutel vóór opslag en
  installeert Ollama alleen na de expliciete knop via het officiële Windows-script; de server wordt
  gestart en het bootstrapmodel wordt met echte downloadvoortgang opgehaald;
- sluit af met een aparte optionele Python-stap. Een WindowsApps-alias telt alleen als hij werkelijk
  `Python x.y` retourneert; anders installeert de expliciete knop de officiële Python Install Manager,
  configureert hem en installeert non-interactief de nieuwste stabiele Python 3;
- biedt bij elke stap `Controleer opnieuw` en `Later afronden`; installers worden nooit zonder een
  expliciete klik gestart;
- monteert elk scherm en iedere providerstap met een eigen sleutel en korte fade/slide-animatie.
  `prefers-reduced-motion` schakelt die beweging volledig uit.

De fresh-start-logica is met een leeg providersnapshot én een echte lege SQLite-database in
geïsoleerde tijdelijke profielpaden getest; de tests lezen of wissen geen echte gebruikersdata.
Antwoorden blijven in `onboarding.services` staan.
Herstartbaar via Settings (`requestOnboarding()` → `ONBOARDING_LAUNCH_EVENT`). Voltooiing in
`settings['onboarding.completedAt']`. StrictMode-valkuil: de `cancelled`-ref moet bij mount gereset
worden (anders verwerkt de detectie niets) — zie [doc 9](09-conventions.md).

### Ollama-modelbeheer in Instellingen

De uitgeklapte Ollama-kaart bevat `OllamaModelManager.tsx`:
- een filterbare, dropdownachtige lijst van werkelijk geïnstalleerde modellen, inclusief grootte,
  quantisatie, context en live capabilities;
- zoeken in de officiële Ollama-bibliotheek, waarna een resultaat zijn concrete varianten met
  grootte/context toont;
- een exacte-modelnaamveld als fallback wanneer de publieke zoekpagina verandert of offline is;
- echte downloadvoortgang, snelheid en annuleren;
- expliciet verwijderen met bevestiging en herstel van een eventueel ongeldig geworden actief model;
- een fresh-installstatus die een onbereikbare lokale runtime opvangt en pas na de knop van de
  gebruiker de bestaande officiële runtime-installer start.

Zoeken in de online bibliotheek blijft beschikbaar wanneer de lokale server ontbreekt; downloaden
wordt dan uitgeschakeld totdat Ollama klaar is. Een fout in de online zoekpagina maakt het beheer van
bestaande modellen of de exacte-modelnaamroute niet onbruikbaar.

## 7.7 Windows-tray (renderer ↔ `main.ts`)

De renderer houdt het tray-menu **1-op-1** gelijk aan de zijbalk: `App.tsx` pusht bij elke wijziging
de exacte chat-lijst (met mapnaam) via `tray.setChats(...)`. `main.ts` bouwt daaruit het menu:
- "LLMelt openen";
- "Start nieuw gesprek" → `tray:openChat('__new__')` → `startNewChat(lastUsedFolderId())` (echt een
  gesprek in de laatst gebruikte map);
- "Recente gesprekken": 3 recente + een "Meer… (n)"-submenu voor de rest;
- projectnaam als prefix: `[Projectnaam] Titel` (Electron-tray kan `\t` niet rechts uitlijnen).

## 7.8 i18n & styling

- **i18n:** `react-i18next`; teksten in `src/i18n/locales/nl.json` (primair) en `en.json`. Gebruik
  `t('key')` in componenten. Nieuwe UI-tekst → key toevoegen in beide locales.
- **Styling:** alles in één `src/index.css` met CSS-variabelen (`--space-*`, kleuren, radii). Geen
  CSS-in-JS/utility-framework. Frameless venster met donker thema (`backgroundColor #0a0e1a`).
  Animaties via CSS (`view-transition`, `chat-switch-fade`, `messageSlideIn`, `motion-panel`).

## 7.9 De beurt als één geheel (turn-rendering)

Een assistent-**beurt** (tekst-segmenten + tool-kaarten) wordt visueel gegroepeerd tot één
samenhangend blok — voor **alle** providers (Claude native, GPT/Codex tag-laag). Zo voelen native
Claude, ChatGPT-sub en Codex consistent.

**Volgorde (chronologisch).** `buildMessageRenderItems` (`command-run-utils.ts`) ordent berichten op
`createdAt` en hangt de toolgroep direct ná het vaste intent-anker (`anchorMessageId`). Native
providers en de tag-route gebruiken dezelfde structuur: intent-bericht → toolkaarten → één
slotantwoord. Tussentijdse providertekst wordt niet tussen de runs gerenderd; zie
[doc 6.8](06-agent-tools.md#gegroepeerde-native-beurt-één-intent-kaarten-één-slotantwoord).

**Eén avatar per beurt.** `ChatView` berekent `continuationFlags`: het **eerste** assistent-item na
een gebruikersbericht is de kop (avatar + model-badge + tijd); alle volgende items van dezelfde beurt
zijn een **continuation** (`MessageBubble` `continuation`-prop → `.message.is-continuation`:
avatar-spacer i.p.v. avatar, geen kop, strak eronder via een negatieve marge). Zo lezen tekst +
kaarten als één beurt.

**Kopieer-knop.** `hideActions` verbergt de kopieer-knop-regel als het volgende render-item een
tool-groep is (anders duwt die lege regel de kaart omlaag — GPT's tool-intent-bericht heeft dat niet
omdat `isToolIntentMessage` de knop al weglaat). Kopiëren loopt in Electron via de vertrouwde
`clipboard:writeText`-IPC; `navigator.clipboard` is alleen fallback voor de losse Vite-preview.
De vink verschijnt uitsluitend nadat de write echt is geslaagd.

**Acties uitklappen.** Een toolgroep is ingeklapt uitsluitend de ene samenvattingsregel, bijvoorbeeld
“Maakte 1 bestand en voerde 1 opdracht uit”. Openen/sluiten animeert met een begrensde CSS-reveal.
Binnen de open groep staan de uitgevoerde commando-/toolstappen eerst; de gezamenlijke sectie
“Bestanden bewerkt” staat onderaan. Per bestand opent daar alleen de gewijzigde regels van die beurt
(of de inhoud bij maken/lezen), met dezelfde component voor alle providers.

**Gedeelde streaming-indicator.** Tijdens streamen toont de kop van de lopende beurt een
shimmer-status i.p.v. de tijd (`MessageBubble` `liveStatus`, gevoed door `visibleStreamingStatusBase`
+ verstreken seconden), en valt terug op de tijd bij `done`. Native toolbeurten gebruiken hiervoor
het vaste intent-anker; hun definitieve providertekst verschijnt pas na de kaarten. Voor een antwoord
zonder tools rendert de gewone providerkop dezelfde compacte status. `nativeStreamId` in
`chatRuns[chatId]` voorkomt ondertussen een tweede zwevende statusbubbel.

Model-only fasen zoals plannen, herstellen en “Model vat samen” blijven tijdelijke tekst in deze
kop. Ze worden niet als blijvende toolstap in de uitklapgroep gezet en verdwijnen dus bij `done`,
terwijl de echte uitgevoerde acties en bestandsdiffs behouden blijven.

## 7.10 Token-dashboard en fallbackquota

Het dashboard scheidt drie dingen die niet door elkaar mogen lopen: cumulatief lokaal
`usage_events`-verbruik, de actuele contextvulling van de geopende chat en providerquota. De
quota-tabel toont per bucket bronnauwkeurigheid, venster, verbruik/resterend en reset. `App.tsx`
ververst de providerbronnen bij opstart en daarna periodiek; handmatig vernieuwen blijft mogelijk.
Dezelfde snapshots voeden `QuotaBadge` in modelkiezer en fallbackinstellingen.

Elke chat heeft een eigen `activeRequestId` in `chatRuns`. Main voegt aan elk stream-event de
oorspronkelijke `chatId` toe; `ChatView` accepteert het event alleen voor die chat/request-combinatie
(of een expliciet `auto-prompter-*`/`auto-responder-*`-verzoek). Daardoor kan een laat event geen
oude shimmer activeren en kan een antwoord bij wisselen niet in het zichtbare gesprek belanden.

**Nieuwe stream-events hiervoor:** `assistant_start` (voeg leeg segment-bericht toe →
`startNativeAssistant`) en `assistant_delta` (`{messageId, delta}` → `appendNativeAssistant`),
afgehandeld in `ChatView`'s stream-listener naast `tool_run_*`.
