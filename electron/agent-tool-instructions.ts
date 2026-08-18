import type { AgentShell } from '../src/components/agent-commands';
import type { UiLanguage } from '../src/providers/types';
import { localizedText } from '../src/i18n/language';

const AGENT_TOOL_INSTRUCTIONS_EN = [
  '',
  'IMPORTANT - TOOL ACCESS: You are running inside LLMelt. This host can execute',
  'approved project tools for you after the user approves them. If the user asks you to',
  'read, inspect, create, write, build, run, test, edit, or modify a local file/app/script, use only',
  'these strict tags and then stop.',
  'Read an existing project/workspace text file:',
  '<file-read path="relative/path.txt"></file-read>',
  'Run a shell command:',
  '<run-command>the shell command</run-command>',
  'Create a new file:',
  '<file-create path="relative/path.txt">file contents</file-create>',
  'Edit an existing file by exact replacement:',
  '<file-edit path="relative/path.txt" old="exact old text">new text</file-edit>',
  'To write SOURCE CODE (Python, JS, …), use an empty marker followed immediately by one fenced code block:',
  '<file-create path="relative/script.py" source="next-fence"></file-create>',
  '```python',
  'def example():',
  '    return "indentation is preserved"',
  '```',
  'The host reads that next code block as raw file content and removes the fence. This external',
  'source block is required for source code because browser rendering can collapse indentation',
  'inside a custom tag. Keep ordinary non-source text inline in <file-create>/<file-edit>.',
  'NEVER write file contents via',
  'shell here-strings, echo, or Set-Content piping (e.g. @\'..\'@ | Set-Content): quoting and',
  'indentation get mangled and the script breaks. Create the file with <file-create>, then',
  'run it in a SEPARATE <run-command> (e.g. <run-command>python hello.py</run-command>).',
  'Never put a Markdown code fence inside the opening and closing tool tag. For source code it must',
  'come immediately AFTER the closed tag and the marker must contain source="next-fence".',
  'If a command fails, FIX the file with <file-edit> before re-running — do not re-run the',
  'same failing command unchanged.',
  'Never rely on bare code blocks or loose prose for tool execution. The host sends the',
  'real tool output back into the chat so you can continue.',
  'For requests to see, read, inspect, open, or check a local file path, emitting prose is',
  'NOT enough: emit a file-read tag. The host will return the real file content if allowed.',
  'For create/write/build requests, emitting only prose or a code block is NOT enough:',
  'you must emit a file-create or file-edit tag, even if the user did not ask to run it yet.',
  'Never say you created, edited, ran, tested, or saw output from local tools unless you',
  'first emitted the strict tool tags and then received Tool output from the host.',
  'Do not add pause/read-host/input prompts or other interactive waits to scripts unless',
  'the user explicitly asks for an interactive script.',
  'If a user requests both ANSI/color output and a final output without color codes, design the',
  'script with a deterministic --plain (or equivalent NO_COLOR) mode from the start and run that',
  'mode for the captured plain output. Do not repeatedly rerun successful scripts through different',
  'ANSI-stripping pipelines.',
].join('\n');

const AGENT_TOOL_INSTRUCTIONS_NL = [
  '',
  'BELANGRIJK - TOOLTOEGANG: Je draait binnen LLMelt. Deze host kan na goedkeuring',
  'door de gebruiker projecttools voor je uitvoeren. Als de gebruiker vraagt een lokaal',
  'bestand, app of script te lezen, inspecteren, maken, schrijven, bouwen, draaien, testen,',
  'bewerken of wijzigen, gebruik dan uitsluitend deze strikte tags en stop daarna.',
  'Lees een bestaand tekstbestand in het project/de werkmap:',
  '<file-read path="relatief/pad.txt"></file-read>',
  'Voer een shellcommando uit:',
  '<run-command>het shellcommando</run-command>',
  'Maak een nieuw bestand:',
  '<file-create path="relatief/pad.txt">bestandsinhoud</file-create>',
  'Bewerk een bestaand bestand door exacte vervanging:',
  '<file-edit path="relatief/pad.txt" old="exacte oude tekst">nieuwe tekst</file-edit>',
  'Gebruik voor BRONCODE (Python, JS, …) een lege marker die direct wordt gevolgd door één codeblok:',
  '<file-create path="relatief/script.py" source="next-fence"></file-create>',
  '```python',
  'def voorbeeld():',
  '    return "inspringing blijft behouden"',
  '```',
  'De host leest dat volgende codeblok als ruwe bestandsinhoud en verwijdert de fences. Dit externe',
  'bronblok is verplicht voor broncode, omdat browserweergave inspringing binnen een aangepaste tag',
  'kan samenvouwen. Houd gewone tekst inline in <file-create>/<file-edit>.',
  'Schrijf bestandsinhoud NOOIT via shell-here-strings, echo of Set-Content-piping: quoting en',
  'inspringing raken beschadigd. Maak het bestand met <file-create> en voer het daarna uit in een',
  'APARTE <run-command> (bijvoorbeeld <run-command>python hello.py</run-command>).',
  'Plaats nooit een Markdown-codefence tussen de openings- en sluittag. Voor broncode moet het',
  'codeblok direct NA de gesloten tag staan en moet de marker source="next-fence" bevatten.',
  'Als een commando faalt, HERSTEL eerst het bestand met <file-edit> voordat je opnieuw uitvoert;',
  'herhaal hetzelfde falende commando niet ongewijzigd.',
  'Vertrouw voor tooluitvoering nooit op losse tekst of gewone codeblokken. De host stuurt de echte',
  'tooluitvoer terug naar de chat, waarna je verder kunt.',
  'Als de gebruiker vraagt een lokaal bestandspad te zien, lezen, inspecteren, openen of controleren,',
  'is uitleg niet genoeg: geef een file-read-tag. De host retourneert na toestemming de echte inhoud.',
  'Bij maak-/schrijf-/bouwopdrachten is alleen uitleg of een codeblok niet genoeg: geef altijd een',
  'file-create- of file-edit-tag, ook als de gebruiker nog niet om uitvoering vroeg.',
  'Zeg nooit dat je lokale tools hebt gebruikt of uitvoer hebt gezien voordat je strikte tooltags hebt',
  'gegeven en echte Tool output van de host hebt ontvangen.',
  'Voeg geen pause/input/wachtprompt toe tenzij de gebruiker expliciet een interactief script vraagt.',
  'Als de gebruiker zowel ANSI-/kleuruitvoer als definitieve uitvoer zonder kleurcodes vraagt, ontwerp',
  'het script vanaf het begin met een deterministische --plain-modus (of NO_COLOR) en voer die modus',
  'uit voor de vastgelegde platte uitvoer. Herhaal geslaagde scripts niet via verschillende filters.',
].join('\n');

export function agentToolInstructions(language: UiLanguage = 'en') {
  return localizedText(language, AGENT_TOOL_INSTRUCTIONS_NL, AGENT_TOOL_INSTRUCTIONS_EN);
}

// Compatibiliteit voor bestaande tests en externe imports. Nieuwe runtimecode
// kiest expliciet de taal via agentToolInstructions().
export const AGENT_TOOL_INSTRUCTIONS = AGENT_TOOL_INSTRUCTIONS_EN;

/**
 * Vertelt een model welk commandoformaat de app werkelijk uitvoert. De shell komt
 * uit de gebruikersinstelling; er wordt dus niets uit de modelnaam afgeleid.
 */
export function agentToolEnvironmentInstructions(
  shell: AgentShell,
  platform: NodeJS.Platform = process.platform,
  language: UiLanguage = 'en',
) {
  if (language === 'nl') return agentToolEnvironmentInstructionsNl(shell, platform);
  const host = platform === 'win32'
    ? 'The host operating system is Windows.'
    : `The host operating system is ${platform}.`;
  const common = [
    '',
    'IMPORTANT - COMMAND ENVIRONMENT:',
    host,
    `The selected command shell is ${shell}.`,
    'Every command starts in the active project/workspace directory.',
    'Use one non-interactive command per <run-command> tag and wait for its real output.',
  ];

  if (platform !== 'win32') return common.join('\n');
  if (shell === 'cmd') {
    return [
      ...common,
      'Write commands for cmd.exe. Do not use Bash syntax, /dev/null, or PowerShell variables/cmdlets.',
      'For Python, prefer the Windows command "python"; only use "py" after the host confirms it exists.',
    ].join('\n');
  }
  if (shell === 'pwsh') {
    return [
      ...common,
      'Write commands for PowerShell 7 (pwsh). Do not use Bash paths such as /dev/null.',
      'For Python, prefer the Windows command "python"; only use "py" after the host confirms it exists.',
    ].join('\n');
  }
  return [
    ...common,
    'Write commands for Windows PowerShell 5.1 compatibility.',
    'Never use Bash syntax, /dev/null, or the operators && and ||.',
    'Use ; plus an explicit $LASTEXITCODE check when sequential success is required, and use Out-Null or $null for discarded output.',
    'For Python, prefer the Windows command "python"; only use "py" after the host confirms it exists. Do not assume "python3" exists.',
  ].join('\n');
}

function agentToolEnvironmentInstructionsNl(shell: AgentShell, platform: NodeJS.Platform) {
  const host = platform === 'win32'
    ? 'Het besturingssysteem van de host is Windows.'
    : `Het besturingssysteem van de host is ${platform}.`;
  const common = [
    '',
    'BELANGRIJK - COMMANDO-OMGEVING:',
    host,
    `De gekozen commandoshell is ${shell}.`,
    'Elk commando start in de actieve project-/werkmap.',
    'Gebruik één niet-interactief commando per <run-command>-tag en wacht op de echte uitvoer.',
  ];
  if (platform !== 'win32') return common.join('\n');
  if (shell === 'cmd') {
    return [
      ...common,
      'Schrijf commando’s voor cmd.exe. Gebruik geen Bash-syntax, /dev/null of PowerShell-variabelen/cmdlets.',
      'Gebruik voor Python bij voorkeur "python"; gebruik "py" pas nadat de host heeft bevestigd dat het bestaat.',
    ].join('\n');
  }
  if (shell === 'pwsh') {
    return [
      ...common,
      'Schrijf commando’s voor PowerShell 7 (pwsh). Gebruik geen Bash-paden zoals /dev/null.',
      'Gebruik voor Python bij voorkeur "python"; gebruik "py" pas nadat de host heeft bevestigd dat het bestaat.',
    ].join('\n');
  }
  return [
    ...common,
    'Schrijf commando’s die compatibel zijn met Windows PowerShell 5.1.',
    'Gebruik nooit Bash-syntax, /dev/null of de operators && en ||.',
    'Gebruik ; met een expliciete $LASTEXITCODE-controle als opeenvolgend succes vereist is; gebruik Out-Null of $null om uitvoer weg te gooien.',
    'Gebruik voor Python bij voorkeur "python"; gebruik "py" pas nadat de host het bestaan bevestigt. Neem niet aan dat "python3" bestaat.',
  ].join('\n');
}
