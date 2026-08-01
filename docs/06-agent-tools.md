# 6. Agent-tools: PC-toegang, approval, tool-loop, MCP & terminal

Met "PC-tools" aan kan de AI **echte bestanden lezen/maken/wijzigen** en **shell-commando's
uitvoeren** in de projectmap van de chat — altijd gegate door een goedkeuringsmodus. Dit is een
kernfeature; de per-bestand-goedkeuring (`ask`) mag niet stilletjes verdwijnen.

## 6.1 Aan/uit en de drie approval-modi

Globale agent-config: `agent.toolsEnabled` (aan/uit), `agent.mode`, `agent.defaultShell`,
`agent.workingDir`. Per chat kan `chat.agentMode` de globale modus overschrijven (kolom `agentMode`).
`getAgentConfig(chat)` (`ipc-handlers.ts:2042`) combineert beide.

De drie modi (`AgentApprovalMode`, getoond in `ChatInput.tsx` `AGENT_MODE_OPTIONS`):

| modus | gedrag |
|---|---|
| `ask` | Vraag **per** bestand-lezen/maken/wijzigen en per commando om goedkeuring (popup). |
| `auto-project` | Canoniek gecontroleerde **bestandstools binnen de projectmap** automatisch toestaan en zichtbaar loggen; vrije shellcommando's blijven vragen. |
| `full` | Geen approval-popups voor deze chat. Snel, maar riskant ("Volledige toegang"). |

De approval-UI zit in `App.tsx` als een echte wachtrij: main stuurt `agent:approvalRequest` met
`{ id, chatId, requestId, kind, command, cwd, path, label }`; de UI toont per aanvraag
Toestaan/Weigeren en stuurt het antwoord via `agent:approvalResponse` terug naar de wachtende
`requestAgentApproval`-promise. Buiten de popup klikken betekent **uitstellen**, niet weigeren:
de volgende aanvraag mag naar voren en de uitgestelde aanvraag blijft boven de composer van zijn
eigen chat staan. Na antwoorden volgt de volgende. `agent:getPendingApprovals` herstelt de wachtrij
na een renderer-reload; `agent:approvalResolved` verwijdert ook door Stop geannuleerde aanvragen.
Er is geen stille afwijzingstime-out.

## 6.2 Het tag-toolsysteem (huidige mechanisme)

Omdat niet elke provider native tools ondersteunt, gebruikt de app een **tag-gebaseerd** protocol:
als PC-tools aanstaan, wordt `AGENT_TOOL_INSTRUCTIONS` (`ipc-handlers.ts:2069`) aan de system-prompt
geplakt (`runAssistantForExistingChat`, `:751`). Het model wordt geïnstrueerd om **strikte tags** te
gebruiken i.p.v. proza of code-fences:

```
<file-read path="relative/path.txt"></file-read>
<run-command>de shell-opdracht</run-command>
<file-create path="relative/path.txt">korte bestandsinhoud</file-create>
<file-edit path="relative/path.txt" old="exacte oude tekst">korte nieuwe tekst</file-edit>
```

Voor langere broncode bestaat daarnaast de web-veilige externe-fencevorm. De tag bevat alleen de
marker `source="next-fence"`; de direct volgende Markdown-codefence is de payload. Daardoor blijft
Python-inspringing intact wanneer ChatGPT tekst uit zijn DOM teruggeeft:

````
<file-create path="relative/script.py" source="next-fence"></file-create>
```python
def main():
    print("klaar")
```
````

Regels die in de instructie staan (belangrijk voor gedrag):
- Broncode **altijd** via `<file-create>`/`<file-edit>` — nooit via shell here-strings/`echo`/
  `Set-Content` (quoting en inspringing raken kapot). Lange broncode gebruikt `source="next-fence"`;
  de oude inline vorm blijft voor korte inhoud ondersteund.
- De parser koppelt een externe fence alleen aan de onmiddellijk voorafgaande marker en verwijdert
  zowel marker als payload uit de zichtbare modeltekst. Een ontbrekende fence is ongeldige toolsyntax.
- Faalt een commando, dan **eerst het bestand fixen** met `<file-edit>`, niet hetzelfde commando
  ongewijzigd herhalen.
- Nooit beweren dat je iets maakte/las/uitvoerde zonder eerst de tag te sturen en echte "Tool
  output" terug te krijgen.
- De prompt vermeldt het echte hostplatform en de gekozen shell. Voor Windows PowerShell 5.1
  verbiedt hij Bash-syntaxis (`/dev/null`, `&&`, `||`) en gebruikt hij `python` plus
  `$LASTEXITCODE`. Een opdracht die zowel ANSI als kleurloze einduitvoer vraagt, krijgt vanaf het
  begin een `--plain`-/`NO_COLOR`-pad in plaats van herhaalde strip-commando's.

### Parsen & valideren (`src/components/agent-commands.ts`, puur + getest)
Alle tag-logica zit in dit **pure, geteste** module (zie `agent-commands.test.ts`):
- `parseAgentToolCalls(text)` → lijst `AgentToolCall` (`file-read`/`file-create`/`file-edit`/`command`).
- `validateFileToolPayload` / `normalizeFileToolPayload` — payload-checks/normalisatie.
- `detectDirectCommandSpec(input)` — herkent een **expliciet** PC-commando van de gebruiker.
- `detectToolIntentRequest(input, recent)` — schat of de gebruiker om een toolactie vraagt (guard).
- `needsToolComplianceRepair` / `buildToolRepairPrompt` — als het model proza gaf i.p.v. een tag,
  wordt het bijgestuurd met een reparatie-prompt.
- `hasUnparsedToolMarkup` / `buildToolSyntaxRepairPrompt` — ook een antwoord met een geldige én een
  kapotte tag wordt eerst hersteld. Reeds voltooide acties staan in de prompt en mogen niet worden
  herhaald; zo wordt een gedeeltelijk geparseerd antwoord niet stilletjes gedeeltelijk uitgevoerd.
- `stripAgentToolMarkup` — geldige en kapotte tagresten uit de weergegeven tekst halen. Een oud
  bericht dat uitsluitend uit kapotte toolsyntax bestaat, wordt niet als gewone modeltekst getoond.

## 6.3 De directe commando-router (deterministisch)

Vóór er ook maar een model wordt aangeroepen, checkt `sendUserMessageAndRunAssistant` (`:681`):
vroeg de gebruiker **expliciet** om een commando (`/run …`, "run … op mijn pc")? Zo ja én PC-tools
aan, dan draait dat commando **direct** via `runAgentCommand` in de projectmap — ongeacht het
gekozen model. Zo werkt het zelfs als ChatGPT zou weigeren. De output wordt als `Tool output:`-bericht
opgeslagen en de beurt is klaar.

## 6.4 De tool-loop (`runAgentToolLoop`, `:2125`)

Na een normale AI-beurt, als PC-tools aanstaan en het antwoord tool-tags bevat:

1. `parseAgentToolCalls(reply)` haalt de tags eruit.
2. Per tool: `requestAgentApproval(...)` (behalve canoniek interne bestandstools in `auto-project`, of alles in `full`).
3. `executeAgentToolCall(...)` (`:2474`) voert uit in `getEffectiveProjectPath(chat)`:
   - `file-read` → `executeAgentFileRead` (weigert binaire bestanden, `:2582`);
   - `file-create`/`file-edit` → schrijft/vervangt exact, met een diff-preview
     (`formatFileToolEditDiff`, `:2561`);
   - `command` → `runAgentCommand` in de gekozen shell.
4. De echte output gaat als `Tool output:`-bericht terug in de chat.
5. Het model mag **doorgaan** met die output als input (tot maximaal zes uitvoerende rondes), zodat
   het z'n taak afmaakt. Na iedere geslaagde batch volgt een completion-audit: als de gebruiker
   expliciet vraagt om beide/alle gemaakte scripts uit te voeren, controleert de host welke paden
   werkelijk in succesvolle commando's voorkwamen en vraagt alleen de ontbrekende uitvoering op.
   Vraagt de follow-up na ronde zes nog om nieuwe toolacties, dan worden die
   niet uitgevoerd: de chat toont expliciet hoeveel acties door de veiligheidsgrens zijn gestopt en
   bewaart de usage van dat laatste antwoord. `chat:refresh` laat de UI de nieuwe berichten herladen.
6. Bewaking tegen vastlopen: `isNoProgressRepeat`, `agentRoundSignature`, `isRepeatFailure`,
   `toolFailureFingerprint` (uit `agent-commands.ts`) stoppen eindeloze herhaling van dezelfde
   mislukte stap.

`ToolActivityPhase` (`types.ts:271`) drijft de live statuskaart: `planning` → `approval_pending` →
`approval_approved`/`denied` → `running` → `sending_output` → `summarizing`/`repairing` → `done`/`stopped`.
De gebruikersstatus voor `summarizing` heet **Model controleert resultaat**: deze fase mag nog een
ontbrekende toolactie aanvragen en is dus niet uitsluitend een tekstuele samenvatting.

## 6.5 Commando's uitvoeren (`runAgentCommand`, `:2845`)

- Shell genormaliseerd via `normalizeAgentShell` / `shellSpawnSpec` (`:2950`): `powershell`
  (default), `cmd`, of `pwsh`.
- Uitvoer wordt live gestreamd naar de UI (`agent:term` + `tool_run_*`-events) en als een
  `CommandRun` bewaard (status `running`/`completed`/`failed`/`denied`, stdout/stderr, exitCode,
  duur). Weergegeven met `CommandRunActivity.tsx`.
- Werkmap = de effectieve projectmap van de chat.

## 6.6 De MCP-control-plane (`electron/mcp-server.ts`)

Naast het interne tag-systeem draait de app optioneel een **lokale MCP-server** (Model Context
Protocol) zodat **externe** MCP-clients (bv. een andere AI-tool) gecontroleerd bij je workspaces
kunnen. Het is een loopback-only HTTP-server (`StreamableHTTPServerTransport`) met een via
`safeStorage` beschermd **owner-token** (uitsluitend `Authorization: Bearer`; geen querytoken).
Ook `/status` vereist authenticatie; bodies zijn maximaal 1 MB en er zijn maximaal 32 sessies.

Geregistreerde tools (`createProtocolServer`, `:255`), uitgevoerd door `executeMcpTool`
(`src/components/mcp-tools.ts`, puur + getest):

| tool | doel |
|---|---|
| `workspace.list` / `workspace.open` | goedgekeurde workspace-roots opsommen/inspecteren |
| `file.read` | UTF-8-bestand lezen (max bytes) |
| `file.create` | nieuw bestand (weigert overschrijven zonder `overwrite`) |
| `file.edit` | exacte tekstvervanging in bestaand bestand |
| `search.rg` | ripgrep-achtig zoeken (`path:line`) |
| `shell.run` | commando in een goedgekeurde root, met de app-approval-instellingen |

Beveiliging: alleen **`roots`** die in de app zijn goedgekeurd zijn bereikbaar
(`resolveWorkspacePath` voorkomt path-traversal), elke call gaat door dezelfde
approval-/shell-laag, en alles wordt gelogd (`mcp:call`-events + `mcp-debug.log`, laatste 100 in
`getCalls`). Config (`McpConfig`): `roots` (met `read`/`write`/`shell`-vlaggen), `port`
(default 8787), `host`, `ownerToken` (auto-gegenereerd), `tunnelUrl`.

## 6.7 Echte terminals (`electron/pty-terminal.ts`)

Los van agent-tools kan de gebruiker een **echte interactieve terminal** openen (`TerminalPanel.tsx`
+ `@xterm/xterm`). `node-pty` spawnt een PowerShell/cmd/pwsh in de projectmap; I/O loopt via
`terminal:*`-IPC. Sessies zijn eigenaar-gebonden, per renderer begrensd tot acht en worden
opgeruimd als het venster sluit.

## 6.8 Native Claude Code-tools (`electron/claude-native.ts`)

Voor **Claude CLI-modellen** (`claude-cli:`) draait de app niet het tag-systeem maar laat het
**Claude Code zélf** z'n tools (Read/Write/Edit/Bash/…) uitvoeren in de projectmap, mét behoud van
de per-tool approval-popup. Alleen actief als PC-tools aanstaan; anders blijft het gewone
platte-tekst `claude -p`-pad.

**Empirisch bevestigd** tegen `claude` v2.1.202 (de vlag staat niet in `--help` maar ís geregistreerd):
- `--permission-prompt-tool mcp__<srv>__approval_prompt` gate't **elke** tool.
- Contract — **in:** `{ tool_name, input, tool_use_id }`; **uit:** text-content met JSON
  `{ behavior: "allow", updatedInput }` of `{ behavior: "deny", message }`.
- Werkt alleen in een **schone env** (zonder `CLAUDECODE`/`CLAUDE_CODE_*`/`ANTHROPIC_BASE_URL`;
  `claude-native.ts` strip't die defensief — in de losse Electron-app staan ze sowieso niet).
- `--output-format stream-json --verbose` levert de events (`system/init`, `assistant`, `user`, `result`).

**Hosting van de permissie-tool** (`runClaudeNative`):
1. Een piepkleine **stdio-MCP-brug** (naar `userData` geschreven, uitgevoerd via `process.execPath`
   + `ELECTRON_RUN_AS_NODE=1`) wordt door `claude` gespawnd via `--mcp-config` — doorgegeven als
   **bestand**, niet inline (anders vermangelt cmd.exe de JSON-accolades).
2. Bij elke tool doet de brug een **HTTP-hop** naar een **in-proces beslis-endpoint** (localhost +
   token) dat `runClaudeNative` host.
3. Dat endpoint roept `requestPermission` aan → in `ipc-handlers.ts` gemapt naar de bestaande
   `requestAgentApproval` (dezelfde popup, maar **`silent`**: geen activiteit-feed) → `{allow}` → `{behavior}`.

> **Windows-valkuil (spawn EINVAL):** `claude` is meestal `claude.cmd`; Node's `spawn` weigert een
> `.cmd`/`.bat` direct (EINVAL sinds een security-fix) → draai via `cmd.exe /d /s /c claude.cmd …`
> (zelfde patroon als `runProcess`). De env wordt defensief gestript (`CLAUDECODE`/`CLAUDE_CODE_*`/
> `ANTHROPIC_BASE_URL`) zodat `--permission-prompt-tool` wél gate't.

**Approval-mapping:** `ask` → `--permission-mode default`, elke tool via de popup ·
`auto-project` laat alleen canoniek interne bestandstools automatisch door; shelltools blijven via
`requestAgentApproval` vragen. `full` gebruikt bovendien
`--permission-mode bypassPermissions` gebruikt (de brug wordt dan niet eens geraadpleegd).

**Integratie** (`runAssistantForExistingChat`, gate via `isNativeToolModel`): bij een native provider
worden `AGENT_TOOL_INSTRUCTIONS`, de intent-guard, `runAgentToolLoop` én de **directe-commando-router**
(`detectDirectCommandSpec`) overgeslagen — anders zou "run …" gekaapt worden vóór Claude het ziet.
Projectmap (`getEffectiveProjectPath`) + `agentMode` + `requestPermission` + `onNativeDelta` +
`onToolActivity` gaan via `executeWithFallback` → `AdapterChatRequest` → `ClaudeCliAdapter.sendChat`
→ `runClaudeNative`.

### Gegroepeerde native beurt (één intent, kaarten, één slotantwoord)

Een native beurt heeft bewust dezelfde vaste vorm als de tag-route:
**kort intent-anker → alle toolkaarten → één slotantwoord**. Providertekst wordt tijdens toolrondes
wel gebufferd, maar tussentijdse narratie wordt niet als losse chatberichten tussen de kaarten gezet.
Daardoor kan een antwoord nooit meer door edits en runs heen lopen.

- **Eén intent-anker:** zodra de eerste native tool start, maakt de IPC-laag één standaardbericht
  (`Ik voer de gevraagde toolstappen uit.`). Alle tools uit die beurt gebruiken hetzelfde
  `anchorMessageId`.
- **Alle tools als kaart:** `onNativeToolActivity` toont Write/Edit/Read/Glob/Grep/Bash enzovoort via
  `tool_run_started` → `tool_run_finished`, met stabiele `run.id = <provider>-<tool_use_id>`.
  `CommandRun` bewaart providerneutraal `toolName`/`toolKind`/`toolPath`; succesvolle file-tools
  gebruiken daardoor voor elke provider dezelfde bestands- en diffkaart.
- **Alleen de laatste providertekst:** na de laatste tool kiest `finalNativeAssistantText` uitsluitend
  het laatste niet-lege tekstsegment als slotantwoord. Het komt met een latere `createdAt` altijd
  onder de toolgroep te staan. De systeeminstructie vraagt maximaal zes bullets en verbiedt het
  opnieuw opnemen van volledige code, diffs of terminaluitvoer.
- **Deduplicatie:** meerdere create/edit-pogingen voor hetzelfde genormaliseerde pad blijven als
  historische pogingen beschikbaar, maar de zichtbare lijst toont slechts de laatste succesvolle
  versie per bestand. Hoofdletters en `/` versus `\` maken daarbij geen dubbele regel.
- **Begrensde lus:** Gemini heeft maximaal acht en Ollama maximaal twaalf uitvoerende rondes;
  beide krijgen daarna een afzonderlijke toolvrije eindronde. De generieke tag-lus heeft maximaal
  zes uitvoerende rondes.
  Zo kan een model niet eindeloos hetzelfde bestand herschrijven en kost het eindantwoord geen
  uitvoeringsslot.

Gebruik voor live tools altijd het **`tool_run_*`**-kanaal. `tool_activity` heeft geen betrouwbaar
anker en kan daardoor aan een oudere beurt worden geplakt.

## 6.9 Native Codex-tools (`electron/codex-native.ts`)

Codex draait als **MCP-server over stdio** (`codex mcp-server`); LLMelt is de MCP-client en
roept de ingebouwde `codex`-tool aan met prompt, projectmap, model, sandbox en approval-policy.

- Tekst komt token-voor-token via `codex/event` → `agent_message_content_delta`.
- Commando's en patches komen via `exec_command_begin/end` en `patch_apply_begin/end`.
- Codex vraagt in `ask` toestemming met `elicitation/create`; de app antwoordt met Codex' eigen
  `{decision:"approved"|"denied"}`-contract.
- `ask` gebruikt `danger-full-access + untrusted`: de popup gate elke actie, terwijl de volledige
  Windows-omgeving/PATH beschikbaar blijft. `auto-project` gebruikt `workspace-write + untrusted`;
  `full` gebruikt `danger-full-access + never`.
- Reasoning effort en service tier gaan als live cataloguswaarden in de Codex-config mee.

## 6.10 Native Gemini API-tools (`electron/gemini-api-native.ts`)

De Google-provider blijft API-only, maar gebruikt bij Gemini-modellen het officiële function-
callingprotocol van `streamGenerateContent`:

1. De app stuurt de vier gedeelde declarations `read_file`, `write_file`, `edit_file` en
   `run_command` mee; er is geen vaste modelallowlist, alleen de live ontdekte Gemini-familie.
2. Gemini retourneert `functionCall`-parts. De runner bewaart die parts exact, inclusief call-id en
   `thoughtSignature`, en toont ze als dezelfde chronologische toolkaarten als andere providers.
3. `executeNativeTool` voert de call uit via de centrale padvalidatie en `requestAgentApproval`.
   Daardoor gelden `ask`, `auto-project` en `full` ongewijzigd.
4. Resultaten gaan als `functionResponse`-parts met dezelfde call-id terug. Parallelle calls gaan
   samen in één user-content. Fouten bevatten naast `ok:false` ook een expliciete foutcode,
   hersteladvies en retry-status, zodat een mislukte run niet als gewone uitvoer wordt behandeld.
5. De runner bewaart call-signatures en de laatste bestandsmutatie. Een identieke call zonder
   voortgang wordt niet opnieuw uitgevoerd; na twee volledig stilstaande rondes stopt de app de
   tool-loop gecontroleerd. Een reparerende `write_file`/`edit_file` maakt een nieuwe test van
   hetzelfde commando wel weer mogelijk.
6. Er zijn maximaal acht uitvoerende toolrondes, maar die cap is niet langer ook de
   eindantwoordronde. Daarna volgt altijd nog één request met function calling op `NONE`, waarin
   Gemini eerlijk samenvat wat werkelijk gelukt en mislukt is. Ook na een providerfout ná een
   uitgevoerde tool wordt niet naar een andere provider overgeschakeld (dat zou side-effects
   verdubbelen), maar wordt deze veilige afsluitroute gebruikt.
7. `finishReason` en `promptFeedback.blockReason` worden vóór uitvoering gecontroleerd. Calls uit
   een afgekapt, misvormd of geblokkeerd antwoord draaien nooit. Een lege/geblokkeerde respons
   wordt zichtbaar als onvoltooide taak gerapporteerd en nooit als leeg succes opgeslagen.

Live geverifieerd met Gemini 3.5 Flash: een echte `read_file`-call las een testbestand in de
standaardwerkmap en het vervolgrondantwoord rapporteerde exact de gelezen inhoud.

## 6.11 Native Ollama-tools (`electron/ollama-native.ts`)

Ollama is geen zelfstandige coding-CLI. De app gebruikt daarom het officiële function-calling-
protocol van `POST /api/chat`:

1. `listModels` vraagt per lokaal model `/api/show`; alleen de live capability `tools` kan
   het native pad activeren (geen modelallowlist). Daarnaast moet `detectToolIntentRequest`
   vaststellen dat de actuele vraag echt een lokale bestands- of commandoactie verlangt.
   Een begroeting of kennisvraag blijft daardoor een gewone toolvrije chatbeurt.
2. De app biedt `read_file`, `write_file`, `edit_file` en `run_command` als functions aan.
3. Toolcalls worden door `executeNativeTool` vertaald naar de bestaande gevalideerde app-tools;
   path-containment, bestandspayloadvalidatie, shellkeuze en approvals blijven dus centraal.
4. Toolresultaten gaan als gestructureerde JSON in `role:"tool"` terug: naast `ok` en `output`
   krijgen fouten een foutcode, retry-status en hersteladvies. ANSI/controlcodes worden verwijderd
   en modeloutput wordt begrensd; de volledige ruwe uitvoer blijft wel zichtbaar in de toolkaart.
5. De runner bewaart thinking, gestreamde call-id's en call-signatures. Dubbele streamdelen en een
   identieke actie binnen dezelfde bestandsversie worden nooit tweemaal uitgevoerd. Een geslaagde
   `write_file`/`edit_file` start een nieuwe mutation-epoch, zodat een testcommando na een echte
   reparatie wel opnieuw mag draaien.
6. Alleen een volledig afgesloten NDJSON-stream (`done:true`) mag tools uitvoeren; provider-errors,
   afgebroken streams en `done_reason`-waarden voor afkapping worden eerst veilig afgehandeld. Ook
   de laatste NDJSON-regel zonder newline wordt verwerkt.
7. Na maximaal twaalf uitvoerende rondes volgt een dertiende request zonder `tools` voor een eerlijk
   eindantwoord. Een providerfout ná een uitgevoerde tool start geen andere provider opnieuw, omdat
   dat bestands- of commandoside-effects zou kunnen verdubbelen; de lokale toolvrije afsluitroute
   bewaart in plaats daarvan de reeds uitgevoerde resultaten.
8. Een harde completion gate bewaakt expliciete opdrachten als “maak twee scripts en voer ze
   allebei uit”: finaliseren kan pas na twee verschillende geslaagde `write_file`-resultaten en
   succesvolle runs van beide paden. Identieke writes worden niet opnieuw uitgevoerd; na een
   mislukte exacte edit mag één gecachte herlezing het model wel helpen repareren.
9. Op Windows worden Unix-heredocs/`tee`/`/dev/null` vóór uitvoering als herstelbare protocolfout
   teruggestuurd. Een ontbrekende `pwsh.exe` valt in de centrale executor terug op Windows PowerShell.
10. Een native provider die toch `A && B` aanlevert voor Windows PowerShell 5.1 wordt
    providerneutraal genormaliseerd naar een voorwaardelijke PowerShell-keten. Operators binnen
    aanhalingstekens blijven ongemoeid; `cmd`, `pwsh` en niet-Windows-platforms worden niet herschreven.

Live geverifieerd op een RTX 4060 Laptop 8 GB: `qwen3:8b` (Q4_K_M, 5,2 GB) retourneert echte
`message.tool_calls`, maakt twee ANSI/animatiescripts, voert beide uit en repareert een bestaand
Pythonbestand. `qwen2.5-coder:7b` en het multimodale `qwen3.5:9b` adverteren ook `tools`, maar bleken
in deze meerstaps-smoke minder betrouwbaar. Capability-detectie activeert dus het native pad;
modelkwaliteit blijft bepalen hoe goed een gekozen lokaal model plant.

## 6.12 Native Antigravity-tools (`electron/antigravity-native.ts`)

`agy --print` heeft geen ACP-callback, maar Antigravity biedt officiële JSON-hooks. De runner voegt
voor de duur van één beurt een unieke entry toe aan `<project>/.agents/hooks.json` en herstelt
daarna de oorspronkelijke bytes (of verwijdert het nieuw aangemaakte bestand/mapje):

- `PreToolUse` ontvangt `{toolCall:{name,args}, stepIdx, conversationId, ...}` en stuurt dit via
  een getokende localhost-bridge naar Electron. De hook retourneert `allow` of `deny` op basis van
  de app-popup/modus; daardoor kan de native tool niet vóór de beslissing draaien.
- `PostToolUse` levert status/fout terug; de runner koppelt die aan dezelfde stabiele toolkaart en
  leest best-effort de uitvoer uit Antigravity's `transcript.jsonl`.
- De brug draait via `process.execPath + ELECTRON_RUN_AS_NODE`; paden staan in env-vars zodat
  Windows-shellquoting geen executable met spaties vermangelt.
- `auto-project` start daarnaast met `--sandbox`; alle modi gebruiken `--mode accept-edits` zodat
  goedgekeurde wijzigingen de echte projectmap raken. Printmodus krijgt ook
  `--dangerously-skip-permissions`: daarin bestaat geen interactieve TUI voor Antigravity's tweede
  permissionprompt. Dit omzeilt niet de app-goedkeuring, want de tijdelijke `PreToolUse`-hook blijft
  vóór iedere tool autoritatief; een `deny` blokkeert de tool ook met deze vlag.
- Hookmutaties zijn procesbreed geserialiseerd, zodat twee gelijktijdige Antigravity-beurten
  elkaars bestaande `hooks.json` nooit overschrijven.

Een recoveryrecord in `userData` verwijdert of herstelt een tijdelijke Antigravity-hook na een
app-/machinecrash. Lange Windows-prompts gaan via een tijdelijk UTF-8-bestand in plaats van de
beperkte commandline.

`npm run test:antigravity` draait de opt-in live integraties tegen de lokaal gevonden `agy`: een
write/read-smoke, de volledige tweebestands ANSI-skylineopdracht, reparatie + uitvoering van een
bestaand kapot Pythonbestand en een deny-controle. De test kiest lichte/zware standen uit de live
`agy models`-uitvoer en bevat dus geen productie-allowlist of bevroren modelnaam.

## 6.13 Gedeelde native laag (`electron/native-tools.ts`)

Alle runners emitten `NativeToolActivity` en gebruiken waar nodig `NativePermissionHandler` en/of
`NativeToolExecutor`. Gemini en Ollama delen bovendien `NATIVE_APP_TOOL_DECLARATIONS`.
`nativeToolInputProtocolError` weigert vóór approval/uitvoering lege commando's en file-tools met
lege paden, `.`/`..`, wildcards of een map waar een bestand wordt vereist. De fout gaat terug naar
het model als herstelbare protocolfeedback en verschijnt niet als een mislukte echte PC-actie.
`ipc-handlers.ts` vertaalt de providerneutrale events eenmaal naar de segment-beurt, live
`tool_run_*`-kaarten, approvals en persistente `Tool output:`-berichten. De renderer herkent eerst de
gestandaardiseerde `file-read`/`file-create`/`file-edit`-output (met preview/diff) en valt voor CLI's
zonder zo'n preview terug op de providerneutrale metadata.
