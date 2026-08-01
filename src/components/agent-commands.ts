const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat']);

const SAFE_SINGLE_WORD_COMMANDS = new Set([
  'date',
  'dir',
  'git',
  'hostname',
  'ipconfig',
  'ls',
  'node',
  'npm',
  'pip',
  'pwd',
  'py',
  'python',
  'time',
  'ver',
  'whoami',
]);

const AMBIGUOUS_NATURAL_COMMANDS = new Set([
  't',
  "'t",
  'it',
  'dit',
  'dat',
  'deze',
  'that',
  'this',
  'command',
  'commando',
]);

export type AgentShell = 'powershell' | 'cmd' | 'pwsh';

export type AgentToolCall =
  | { type: 'command'; command: string; shell?: AgentShell }
  | { type: 'file-read'; path: string }
  | { type: 'file-create'; path: string; content: string; overwrite: boolean }
  | { type: 'file-edit'; path: string; oldText: string; newText: string; replaceAll: boolean };

export interface ToolComplianceCheck {
  userInput: string;
  reply: string;
  toolCalls?: AgentToolCall[];
  recentMessages?: Array<{ role: string; content: string }>;
}

export interface FileToolPayloadValidation {
  ok: boolean;
  message?: string;
}

export interface FileToolPayloadNormalization {
  call: Extract<AgentToolCall, { type: 'file-create' | 'file-edit' }>;
  changed: boolean;
  message?: string;
}

export interface ToolRepairResult {
  text: string;
  run?: {
    command?: string;
    shell?: string;
    cwd?: string;
    status?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
  };
}

export interface CommandDependencySkip {
  skip: boolean;
  path?: string;
  message?: string;
}

export type AgentToolLoopContinuation =
  | { action: 'complete'; pendingCount: 0; executePending: false }
  | { action: 'continue'; pendingCount: number; executePending: true }
  | { action: 'stop-limit'; pendingCount: number; executePending: false; message: string };

// De follow-up na de laatste toegestane ronde mag nog een eindantwoord geven,
// maar nooit stilletjes een nieuwe batch side-effects laten verdwijnen. Deze pure
// beslissing houdt de rondegrens in IPC en de regressietests exact gelijk.
export function decideAgentToolLoopContinuation(
  roundIndex: number,
  maxRounds: number,
  pendingCalls: AgentToolCall[] | number,
): AgentToolLoopContinuation {
  const safeMaxRounds = Math.max(1, Math.floor(Number(maxRounds) || 1));
  const pendingCount = Array.isArray(pendingCalls)
    ? pendingCalls.length
    : Math.max(0, Math.floor(Number(pendingCalls) || 0));
  if (!pendingCount) return { action: 'complete', pendingCount: 0, executePending: false };
  if (roundIndex + 1 < safeMaxRounds) {
    return { action: 'continue', pendingCount, executePending: true };
  }
  return {
    action: 'stop-limit',
    pendingCount,
    executePending: false,
    message: [
      `Uitvoering gedeeltelijk afgerond: de veiligheidsgrens van ${safeMaxRounds} toolrondes is bereikt.`,
      `Het model vroeg nog ${pendingCount} toolactie${pendingCount === 1 ? '' : 's'}; ${pendingCount === 1 ? 'die is' : 'die zijn'} niet uitgevoerd.`,
    ].join(' '),
  };
}

export function parseRunCommands(text: string): string[] {
  return parseAgentToolCalls(text)
    .filter((call): call is Extract<AgentToolCall, { type: 'command' }> => call.type === 'command')
    .map((call) => call.command);
}

// Normalize a shell command so trivial whitespace/case differences count as "the same"
// command when deciding whether the agent loop is making progress.
export function normalizeAgentCommand(command: string): string {
  return (command || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// No-progress guard for the agent tool loop: returns true when this round ONLY repeats
// command(s) already run and changes no files. Re-running an unchanged command that keeps
// failing won't help (the "run run run" loop), so the caller should stop.
export function isNoProgressRepeat(toolCalls: AgentToolCall[], executedCommands: Set<string>): boolean {
  const commandCalls = toolCalls.filter((call): call is Extract<AgentToolCall, { type: 'command' }> => call.type === 'command');
  if (!commandCalls.length) return false;
  const hasFileWrite = toolCalls.some((call) => call.type === 'file-create' || call.type === 'file-edit');
  if (hasFileWrite) return false;
  return commandCalls.every((call) => executedCommands.has(normalizeAgentCommand(call.command)));
}

// Stable signature of a round's tool calls. If two rounds share a signature the model is
// repeating itself verbatim (e.g. a no-op file-edit whose old= text never matches, plus a
// re-run of the same failing command) — that never converges, so the loop must stop. This
// catches loops that isNoProgressRepeat misses because a (no-op) file-write is present.
export function agentRoundSignature(toolCalls: AgentToolCall[]): string {
  return toolCalls
    .map((call) => {
      if (call.type === 'command') return `cmd:${normalizeAgentCommand(call.command)}`;
      if (call.type === 'file-read') return `read:${call.path}`;
      if (call.type === 'file-create') return `create:${call.path}\n${call.content}`;
      return `edit:${call.path}\n${call.oldText}\n=>\n${call.newText}`;
    })
    .join('');
}

export function hasFailedCommandRun(results: ToolRepairResult[]): boolean {
  return results.some((result) => {
    const run = result.run;
    if (!run) return false;
    if (run.status === 'failed' || run.status === 'denied') return true;
    return typeof run.exitCode === 'number' && run.exitCode !== 0;
  });
}

export function hasSuccessfulCommandRun(results: ToolRepairResult[]): boolean {
  return results.some((result) => {
    const run = result.run;
    return !!run && run.status === 'completed' && run.exitCode === 0;
  });
}

export function hasFailedToolResult(results: ToolRepairResult[]): boolean {
  return hasFailedCommandRun(results)
    || results.some((result) => /\[(?:error|invalid file payload|geen wijziging)\]/i.test(result.text || ''));
}

export function toolFailureFingerprint(results: ToolRepairResult[]): string {
  return results
    .filter((result) => result.run?.status === 'failed'
      || (typeof result.run?.exitCode === 'number' && result.run.exitCode !== 0)
      || /\[(?:error|invalid file payload|geen wijziging)\]/i.test(result.text || ''))
    .map((result) => normalizeFailureText(result.text || ''))
    .filter(Boolean)
    .join('\n---\n');
}

export function isRepeatFailure(seen: Set<string>, fingerprint: string): boolean {
  const key = fingerprint.trim();
  if (!key) return false;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}

export function isFailedFileToolResult(text: string): boolean {
  return /\[(?:error|invalid file payload|geen wijziging)\]/i.test(text || '');
}

export function fileToolPathFromResult(text: string): string | null {
  const match = (text || '').match(/^(?:file-read|file-create|file-edit)\s+([^\r\n]+)/i);
  return match ? normalizeToolPath(match[1]) : null;
}

export function shouldSkipCommandForFailedFileTool(command: string, failedFilePaths: Set<string>): CommandDependencySkip {
  const referenced = commandReferencedPaths(command);
  const hit = referenced.find((item) => failedFilePaths.has(item));
  if (!hit) return { skip: false };
  return {
    skip: true,
    path: hit,
    message: `Command overgeslagen omdat de file-tool voor ${hit} faalde; eerst het bestand herstellen/schrijven.`,
  };
}

export function validateModelCommand(command: string): FileToolPayloadValidation {
  const text = command || '';
  if (/@['"][\s\S]*?['"]@\s*\|\s*(?:Set-Content|Out-File)|(?:Set-Content|Out-File)\b|(?:^|\s)(?:cat|type)\s*>|(?:^|\s)>{1,2}\s*[^&|;\r\n]+\.(?:py|js|jsx|ts|tsx|json|html|css|bat|cmd|ps1|sh)\b/i.test(text)) {
    return {
      ok: false,
      message: 'Model-commands mogen geen bestanden schrijven via shell redirection, here-strings, Set-Content of Out-File. Gebruik file-create/file-edit en daarna een apart run-command.',
    };
  }
  return { ok: true };
}

export function buildToolFailureRepairPrompt(results: ToolRepairResult[]): string {
  const report = results
    .map((result, index) => {
      const run = result.run;
      const status = run
        ? [
          `command=${run.command || '(unknown)'}`,
          `shell=${run.shell || '(unknown)'}`,
          `cwd=${run.cwd || '(unknown)'}`,
          `status=${run.status || '(unknown)'}`,
          `exitCode=${run.exitCode ?? 'null'}`,
        ].join(' ')
        : 'file/tool result';
      return [
        `--- tool result ${index + 1} (${status}) ---`,
        clipForRepairPrompt(result.text || ''),
      ].join('\n');
    })
    .join('\n\n');

  return [
    'De vorige LLMelt tool-run is NIET afgerond met succes.',
    'Je mag pas zeggen dat het gelukt is na een echte tool-run met exit code 0.',
    '',
    'Geef nu ALLEEN strict tool-tags om de fout te herstellen en opnieuw te runnen.',
    'Gebruik <file-edit> of <file-create overwrite="true"> voor de fix en daarna <run-command> om opnieuw te testen.',
    'Geen uitleg en geen verzonnen output.',
    '',
    'Toegestane tags:',
    '<file-read path="relative/path.ext"></file-read>',
    '<file-create path="relative/path.ext" overwrite="true">inhoud voor gewone tekst</file-create>',
    '<file-create path="relative/script.py" overwrite="true" source="next-fence"></file-create> gevolgd door één fenced broncodeblok',
    '<file-edit path="relative/path.ext" old="exact old text">nieuwe inhoud</file-edit>',
    '<run-command>commando</run-command>',
    '',
    'Als je dit niet veilig kunt herstellen, antwoord exact met: NO_FIX',
    '',
    'Echte tool-output:',
    report,
  ].join('\n');
}

export function buildToolSuccessSummaryPrompt(
  results: ToolRepairResult[],
  audit: { missingExecutionPaths?: string[]; verifiedAllRequestedExecutions?: boolean } = {},
): string {
  const hasSuccessfulRun = results.some((result) => (
    result.run?.status === 'completed'
    && (result.run.exitCode === 0 || result.run.exitCode == null)
  ));
  const report = results
    .map((result, index) => {
      const run = result.run;
      const status = run
        ? [
          `command=${run.command || '(unknown)'}`,
          `shell=${run.shell || '(unknown)'}`,
          `cwd=${run.cwd || '(unknown)'}`,
          `status=${run.status || '(unknown)'}`,
          `exitCode=${run.exitCode ?? 'null'}`,
        ].join(' ')
        : 'file/tool result';
      return [
        `--- tool result ${index + 1} (${status}) ---`,
        clipForRepairPrompt(result.text || ''),
      ].join('\n');
    })
    .join('\n\n');

  return [
    hasSuccessfulRun
      ? 'De LLMelt toolbatch bevat een echte geslaagde command-run met exit code 0.'
      : 'De LLMelt toolbatch is verwerkt, maar deze batch bevat geen bewezen geslaagde command-run.',
    ...(audit.missingExecutionPaths?.length ? [
      `HOST-BEWIJSCONTROLE: deze gemaakte/gewijzigde uitvoerbare bestanden zijn nog niet aangetroffen in een geslaagde command-run: ${audit.missingExecutionPaths.join(', ')}.`,
      'Vat nu NIET samen. Geef strict <run-command>-tags om ieder genoemd bestand echt uit te voeren of testen.',
    ] : []),
    ...(audit.verifiedAllRequestedExecutions ? [
      'HOST-BEWIJSCONTROLE: alle expliciet gevraagde gemaakte/gewijzigde uitvoerbare bestanden hebben een geslaagde command-run.',
      'Voer geen nieuwe of equivalente toolactie uit. Geef nu uitsluitend de korte eind-samenvatting.',
    ] : []),
    'Controleer eerst de VOLLEDIGE oorspronkelijke gebruikersopdracht tegen alle echte tool-output in het gesprek.',
    'Als nog een gevraagde bestandsactie, run, test of controle ontbreekt of niet met echte output is bewezen:',
    '- geef ALLEEN de nog ontbrekende strict tool-tag(s) terug;',
    '- herhaal geen actie die al met succes is uitgevoerd;',
    '- gebruik voor broncode een lege source="next-fence" file-marker plus direct daarna één fenced broncodeblok.',
    'Als de volledige opdracht wel aantoonbaar klaar is, geef dan een korte, gewone samenvatting:',
    'maximaal 120 woorden en maximaal 6 korte bullets.',
    'Noem alleen het resultaat, de relevante bestandsnamen en eventuele resterende waarschuwingen.',
    'Plak GEEN volledige code, bestandsinhoud, diff of terminaluitvoer; die staan al in de uitklapbare toolkaarten.',
    'Herhaal de opdracht van de gebruiker niet en beschrijf niet stap voor stap wat al zichtbaar is.',
    'In de samenvatting geef je GEEN nieuwe tool-tags terug en zeg je niet dat je nog iets gaat uitvoeren.',
    '',
    'Echte tool-output:',
    report,
  ].join('\n');
}

const DIRECTLY_RUNNABLE_SOURCE_EXTENSIONS = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.ps1', '.cmd', '.bat', '.sh', '.rb', '.php', '.jar', '.exe',
]);

/**
 * Controleert alleen opdrachten die expliciet álle/beide gemaakte scripts willen
 * uitvoeren. Zo wordt een gewone build/test-suite niet onterecht vervangen door
 * losse runs per bronbestand.
 */
export function missingRequestedFileExecutions(
  userInput: string,
  changedPaths: Iterable<string>,
  successfulCommands: Iterable<string>,
) {
  if (!requestRequiresEveryFileExecution(userInput)) return [];

  const commands = [...successfulCommands].map((command) => command.replace(/\\/g, '/').toLowerCase());
  return [...new Set([...changedPaths]
    .map((filePath) => filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase())
    .filter((filePath) => DIRECTLY_RUNNABLE_SOURCE_EXTENSIONS.has(extensionOf(filePath))))]
    .filter((filePath) => {
      const basename = filePath.split('/').pop() || filePath;
      const extension = extensionOf(filePath);
      return !commands.some((command) => (
        command.includes(filePath)
        || command.includes(basename)
        || (!!extension && command.includes(`*${extension}`))
      ));
    });
}

export function requestRequiresEveryFileExecution(userInput: string) {
  const request = normalizeNaturalText(userInput);
  const asksForExecution = /\b(?:run|runs|test|tests|execute|executed|uitvoer|uitvoeren|draai|draaien|start|voer)\b/.test(request);
  const asksForEveryFile = /\b(?:allebei|beide|alle|elk|elke|ieder|iedere|both|all|each|every)\b/.test(request);
  return asksForExecution && asksForEveryFile;
}

/** Toolkaarten bevatten code en output al volledig; voorkom een tweede enorme kopie in de chat. */
export function compactToolSummaryForDisplay(value: string, maxChars = 1_800) {
  const withoutLargeFences = String(value || '').replace(/```([^\r\n`]*)\r?\n([\s\S]*?)```/g, (block, language, body) => {
    if (body.length <= 500) return block;
    const label = String(language || '').trim();
    return `_Volledige ${label ? `${label}-code` : 'code'} staat in de bestandskaart hierboven._`;
  });
  if (withoutLargeFences.length <= maxChars) return withoutLargeFences.trim();
  const head = withoutLargeFences.slice(0, maxChars);
  const boundary = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('. '));
  const clipped = head.slice(0, boundary >= maxChars * 0.6 ? boundary + 1 : maxChars).trimEnd();
  return `${clipped}\n\n_[Samenvatting ingekort; volledige details staan in de toolkaarten.]_`;
}

export function validateFileToolPayload(call: Extract<AgentToolCall, { type: 'file-create' | 'file-edit' }>): FileToolPayloadValidation {
  const filePath = call.path || '';
  const ext = extensionOf(filePath);
  const content = call.type === 'file-create' ? call.content : call.newText;
  if (!isSourceLikeExtension(ext)) return { ok: true };

  if (!isMarkdownExtension(ext) && /(^|\r?\n)\s*```/.test(content)) {
    return { ok: false, message: 'Source-bestand bevat Markdown code fences (```); geef alleen rauwe bestandsinhoud in de file-tool.' };
  }

  if (ext === '.py') {
    if (content.charCodeAt(0) === 0xfeff) {
      return { ok: false, message: 'Python-bestand begint met een BOM; schrijf UTF-8 zonder BOM.' };
    }
    if (/\bif\s+name\s*==\s*["']main["']\s*:/i.test(content)) {
      return { ok: false, message: 'Python main guard is kapot: gebruik if __name__ == "__main__":' };
    }
    const invalidBlock = findInvalidPythonBlock(content);
    if (invalidBlock) return { ok: false, message: invalidBlock };
  }

  return { ok: true };
}

export function normalizeFileToolPayload(call: Extract<AgentToolCall, { type: 'file-create' | 'file-edit' }>): FileToolPayloadNormalization {
  const ext = extensionOf(call.path || '');
  if (!isSourceLikeExtension(ext) || isMarkdownExtension(ext)) {
    return { call, changed: false };
  }

  const content = call.type === 'file-create' ? call.content : call.newText;
  const normalized = normalizeSourcePayloadContent(content, ext);
  if (normalized.content === content) {
    return { call, changed: false };
  }

  const normalizedCall = call.type === 'file-create'
    ? { ...call, content: normalized.content }
    : { ...call, newText: normalized.content };
  return {
    call: normalizedCall,
    changed: true,
    message: normalized.message,
  };
}

function stripParsedAgentToolMarkup(text: string): string {
  return (text || '')
    .replace(/<file-create\b(?=[^>]*\bsource\s*=\s*["']next-fence["'])[^>]*>\s*<\/file-create>[ \t]*(?:\r?\n[ \t]*)+```[^\r\n`]*\r?\n[\s\S]*?\r?\n```/gi, '')
    .replace(/<file-edit\b(?=[^>]*\bsource\s*=\s*["']next-fence["'])[^>]*>\s*<\/file-edit>[ \t]*(?:\r?\n[ \t]*)+```[^\r\n`]*\r?\n[\s\S]*?\r?\n```/gi, '')
    .replace(/<file-read\b[^>]*(?:\/>|>[\s\S]*?<\/file-read>)/gi, '')
    .replace(/<file-create\b[^>]*>[\s\S]*?<\/file-create>/gi, '')
    .replace(/<file-edit\b[^>]*>[\s\S]*?<\/file-edit>/gi, '')
    .replace(/<run-command>[\s\S]*?<\/run-command>/gi, '');
}

export function stripAgentToolMarkup(text: string): string {
  return stripParsedAgentToolMarkup(text)
    // Een overgebleven openingstag is per definitie niet geparseerd. Verberg vanaf
    // daar de kapotte modelsyntax, zodat die nooit als gewone chattekst verschijnt.
    .replace(/<(?:run-command|file-read|file-create|file-edit)\b[\s\S]*$/gi, '')
    .replace(/<\/(?:run-command|file-read|file-create|file-edit)[^>\r\n]*(?:>|$)/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseAgentToolCalls(text: string, options: { includeShellFences?: boolean } = {}): AgentToolCall[] {
  const includeShellFences = options.includeShellFences !== false;
  const out: Array<{ index: number; call: AgentToolCall }> = [];
  const tagRe = /<run-command>([\s\S]*?)<\/run-command>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) {
    const cmd = m[1].trim();
    if (cmd) out.push({ index: m.index, call: { type: 'command', command: cmd } });
  }

  const readRe = /<file-read\b([^>]*?)(?:\/>|>[\s\S]*?<\/file-read>)/gi;
  while ((m = readRe.exec(text))) {
    const attrs = parseTagAttributes(m[1] || '');
    const filePath = attrs.path?.trim();
    if (!filePath) continue;
    out.push({ index: m.index, call: { type: 'file-read', path: filePath } });
  }

  if (includeShellFences) {
    const fenceRe = /```([\w+#.-]+)[ \t]*\r?\n([\s\S]*?)```/g;
    while ((m = fenceRe.exec(text))) {
      const lang = (m[1] || '').toLowerCase();
      const cmd = m[2].trim();
      if (cmd && SHELL_LANGS.has(lang)) out.push({ index: m.index, call: { type: 'command', command: cmd } });
    }
  }

  const createRe = /<file-create\b([^>]*)>([\s\S]*?)<\/file-create>/gi;
  while ((m = createRe.exec(text))) {
    const attrs = parseTagAttributes(m[1] || '');
    const filePath = attrs.path?.trim();
    if (!filePath) continue;
    const externalSource = attrs.source === 'next-fence'
      ? readFollowingSourceFence(text, m.index + m[0].length)
      : null;
    if (attrs.source === 'next-fence' && !externalSource) continue;
    out.push({
      index: m.index,
      call: {
        type: 'file-create',
        path: filePath,
        content: externalSource?.content ?? decodeEntities(m[2] || ''),
        overwrite: isTruthyAttr(attrs.overwrite),
      },
    });
  }

  const editRe = /<file-edit\b([^>]*)>([\s\S]*?)<\/file-edit>/gi;
  while ((m = editRe.exec(text))) {
    const attrs = parseTagAttributes(m[1] || '');
    const filePath = attrs.path?.trim();
    const oldText = attrs.old;
    if (!filePath || oldText === undefined) continue;
    const externalSource = attrs.source === 'next-fence'
      ? readFollowingSourceFence(text, m.index + m[0].length)
      : null;
    if (attrs.source === 'next-fence' && !externalSource) continue;
    out.push({
      index: m.index,
      call: {
        type: 'file-edit',
        path: filePath,
        oldText,
        newText: externalSource?.content ?? decodeEntities(m[2] || ''),
        replaceAll: isTruthyAttr(attrs.replaceAll || attrs.replace_all),
      },
    });
  }

  return out.sort((a, b) => a.index - b.index).map((entry) => entry.call);
}

function readFollowingSourceFence(text: string, offset: number): { content: string } | null {
  const match = text.slice(offset).match(
    /^[ \t]*(?:\r?\n[ \t]*)+```[^\r\n`]*[ \t]*\r?\n([\s\S]*?)\r?\n```/,
  );
  return match ? { content: decodeEntities(match[1] || '') } : null;
}

export function detectDirectCommand(input: string): string | null {
  return detectDirectCommandSpec(input)?.command || null;
}

export function detectDirectCommandSpec(input: string): { command: string; shell?: AgentShell } | null {
  const text = (input || '').trim();
  if (!text) return null;

  const slash = text.match(/^\/(run|cmd|exec|shell|ps|powershell|pwsh)\s+([\s\S]+)$/i);
  if (slash) {
    const command = cleanCommand(slash[2], { explicit: true });
    if (!command) return null;
    return { command, shell: shellForSlash(slash[1]) };
  }

  const verb = text.match(/^(?:run|draai|voer\s+uit|execute|exec)\b[:\s]+([\s\S]+)$/i);
  if (!verb) return null;

  let cmd = verb[1].trim();
  cmd = cmd.replace(/\s+op\s+(?:mijn|m'?n|de|deze|'t)\s+(?:pc|computer|machine|laptop)\b.*$/i, '').trim();
  cmd = cmd.replace(/\s+on\s+(?:my|the|this)\s+(?:pc|computer|machine|laptop)\b.*$/i, '').trim();
  cmd = cmd.replace(/\s+en\s+(?:vertel|geef|toon|laat\s+zien)\b.*$/i, '').trim();
  const command = cleanCommand(cmd, { explicit: false });
  return command ? { command } : null;
}

export function detectToolIntentRequest(input: string, recentMessages: Array<{ role: string; content: string }> = []): boolean {
  const text = normalizeNaturalText(input);
  if (!text) return false;
  if (detectDirectCommandSpec(input)) return true;

  if (/\b(?:je\s+hebt|het\s+is|dit\s+is)\s+(?:(?:he)?t\s+)?niet\s+echt\s+(?:uitgevoerd|gedraaid|gerund|gemaakt|geschreven)\b/.test(text)) {
    return true;
  }

  if (/\b(?:doe|voer|run|draai)\s+(?:het|dit|dat|deze)\s+(?:nu\s+)?(?:echt|lokaal|op\s+(?:mijn|mn)\s+pc)\b/.test(text)) {
    return true;
  }

  const asksReadFile = /\b(?:zie|zien|lees|lezen|open|ophalen|bekijk|bekijken|check|inspecteer|inspecteren|inhoud|wat\s+staat)\b/.test(text)
    || /\b(?:die|deze|dit)\s+(?:file|bestand)\b/.test(text);
  if (asksReadFile && hasLocalPathLike(input)) return true;

  if (/\b(?:leg\s+uit|uitleg|verklaar|wat\s+is|hoe\s+werkt|hoe\s+kan\s+ik)\b/.test(text)) {
    return false;
  }

  const asksCreate = /\b(?:maak|maken|schrijf|schrijven|bouw|bouwen|zet|create|write|build|genereer|genereren)\b/.test(text);
  const asksRun = /\b(?:run|runt|draai|draaien|execute|exec|voer\s+uit|uitvoeren|uitgevoerd|start|testen|test)\b/.test(text);
  const toolSubject = /\b(?:script|scriptje|bestand|file|python|py|bat|cmd|powershell|programma|programmaatje|tool|app|code|html|css|json|javascript|typescript)\b/.test(text)
    || /\.[a-z0-9]{1,8}\b/.test(text);
  const asksCreateArtifact = asksCreate && toolSubject;
  if (asksCreateArtifact) return true;
  if (asksCreate && asksRun && toolSubject) return true;

  const asksModifyCode = /\b(?:maak|pas|wijzig|fix|verbeter|breid|uitbreiden|uitgebreider|update)\b[\s\S]{0,80}\b(?:code|script|bestand|file|python|py|programma)\b/.test(text)
    || /\b(?:code|script|bestand|file|python|py|programma)\b[\s\S]{0,80}\b(?:uitgebreider|aanpassen|wijzigen|fixen|verbeteren|updaten)\b/.test(text);
  if (asksModifyCode && recentMessages.slice(-12).some((message) => {
    const content = message.content || '';
    return content.startsWith('Tool output:')
      || content.startsWith('Command output:')
      || /<run-command>|<file-read|<file-create|<file-edit/i.test(content)
      || detectToolExecutionClaim(content);
  })) {
    return true;
  }

  const asksLocal = /\b(?:op\s+(?:mijn|mn)\s+(?:pc|computer|laptop)|lokaal|hier)\b/.test(text);
  if (asksRun && asksLocal) return true;

  if (/^(?:run|draai|voer\s+uit|execute|start|test)(?:\s+(?:het|dit|dat|deze|m|hem|script|bestand|file))?$/.test(text)) {
    return recentMessages.slice(-8).some((message) => {
      if (message.role !== 'assistant') return false;
      return detectToolExecutionClaim(message.content) || /<file-read|<file-create|<file-edit|<run-command>/i.test(message.content);
    });
  }

  if (/\b(?:doe\s+dat(?:\s+nog\s+eens)?(?:\s+voor\s+(?:me|mij))?|maak\s+dat)\b/.test(text)) {
    return recentMessages.slice(-6).some((message) => {
      if (message.role !== 'assistant') return false;
      const content = normalizeNaturalText(message.content);
      return detectToolExecutionClaim(content) || /<run-command>|<file-read|<file-create|<file-edit/.test(message.content);
    });
  }

  return false;
}

export function detectToolExecutionClaim(reply: string): boolean {
  const text = normalizeNaturalText(reply);
  if (!text) return false;
  if (/\b(?:ik\s+kan|kan\s+niet|niet\s+daadwerkelijk|geen\s+toegang|cannot|can't|can\s+not)\b/.test(text)) {
    return false;
  }

  return /\b(?:ik\s+heb|heb)\b[\s\S]{0,120}\b(?:gemaakt|aangemaakt|geschreven|uitgevoerd|gerund|gedraaid|getest)\b/.test(text)
    || /\b(?:meteen|zojuist|net)\b[\s\S]{0,100}\b(?:uitgevoerd|gerund|gedraaid|gemaakt|geschreven|getest)\b/.test(text)
    || /\b(?:voor\s+je|voor\s+jullie|voor\s+u)\b[\s\S]{0,100}\b(?:gemaakt|aangemaakt|geschreven|uitgevoerd|gerund|gedraaid|getest)\b/.test(text)
    || /\b(?:de\s+uitvoer\s+was|de\s+output\s+was|als\s+alles\s+goed\s+gaat\s+zie\s+je|je\s+ziet\s+gewoon)\b/.test(text)
    || /\b(?:gelukt|klaar)\b[\s\S]{0,80}\b(?:uitgevoerd|gerund|gedraaid|gemaakt|geschreven)\b/.test(text);
}

export function needsToolComplianceRepair(check: ToolComplianceCheck): boolean {
  const toolCalls = check.toolCalls ?? parseAgentToolCalls(check.reply, { includeShellFences: false });
  if (hasUnparsedToolMarkup(check.reply)) return true;
  if (toolCalls.length) return false;
  return detectToolIntentRequest(check.userInput, check.recentMessages);
}

export function hasUnparsedToolMarkup(reply: string): boolean {
  const text = reply || '';
  if (!/<\/?(?:run-command|file-read|file-create|file-edit)(?:\b|_)/i.test(text)) return false;
  const remaining = stripParsedAgentToolMarkup(text);
  return /<\/?(?:run-command|file-read|file-create|file-edit)\b/i.test(remaining)
    || /<\/(?:run-command|file-read|file-create|file-edit)[^>\r\n]*(?:>|$)/i.test(remaining);
}

export function buildToolRepairPrompt(check: { userInput: string; badReply: string }): string {
  return [
    'Je vorige antwoord claimde of suggereerde lokale uitvoering, maar gaf geen geldige LLMelt tool-tags.',
    'Geef nu ALLEEN de benodigde strict tags terug. Geen uitleg en geen output verzinnen.',
    '',
    'Toegestane tags:',
    '<file-read path="relative/path.ext"></file-read>',
    '<file-create path="relative/path.ext">inhoud voor gewone tekst</file-create>',
    '<file-create path="relative/script.py" source="next-fence"></file-create> gevolgd door één fenced broncodeblok',
    '<file-edit path="relative/path.ext" old="exact old text">nieuwe inhoud</file-edit>',
    '<run-command>commando</run-command>',
    '',
    'Als de gebruiker vraagt om een bestaand lokaal/projectbestand te zien, lezen of openen, gebruik file-read.',
    'Als de gebruiker vraagt om iets te maken/schrijven/bouwen, gebruik minimaal een file-create of file-edit tag.',
    'Als de gebruiker vraagt om te runnen/testen/uitvoeren, voeg daarna ook een run-command tag toe.',
    '',
    'Als er echt geen lokale tool-actie nodig is, antwoord exact met: NO_TOOLS',
    '',
    'Oorspronkelijke gebruikersvraag:',
    check.userInput.trim(),
    '',
    'Je vorige antwoord:',
    check.badReply.trim(),
  ].join('\n');
}

export function buildToolSyntaxRepairPrompt(check: { badReply: string; completedResults?: ToolRepairResult[] }): string {
  const completed = (check.completedResults || [])
    .map((result, index) => `--- afgeronde actie ${index + 1} ---\n${clipForRepairPrompt(result.text || '')}`)
    .join('\n\n');
  return [
    'Je vorige antwoord bevatte een onvolledige of kapotte LLMelt tool-tag.',
    'Geef ALLEEN dezelfde nog bedoelde toolactie(s) opnieuw met exact geldige tags.',
    'Herhaal geen acties die hieronder al als afgerond staan. Geen uitleg.',
    '',
    'Toegestane tags:',
    '<file-read path="relative/path.ext"></file-read>',
    '<file-create path="relative/path.ext" overwrite="true">inhoud voor gewone tekst</file-create>',
    '<file-create path="relative/script.py" overwrite="true" source="next-fence"></file-create> gevolgd door één fenced broncodeblok',
    '<file-edit path="relative/path.ext" old="exact old text">nieuwe inhoud</file-edit>',
    '<run-command>commando</run-command>',
    '',
    'Als er geen onafgeronde toolactie bedoeld was, antwoord exact met: NO_TOOLS',
    ...(completed ? ['', 'Reeds afgerond:', completed] : []),
    '',
    'Kapotte modeluitvoer:',
    check.badReply.trim(),
  ].join('\n');
}

export function isNoFixReply(reply: string): boolean {
  return /^\s*NO_FIX\s*$/i.test(reply || '');
}

function cleanCommand(raw: string, options: { explicit: boolean }): string | null {
  let cmd = (raw || '').trim();
  const fence = cmd.match(/^```(?:[\w+#.-]*)\r?\n([\s\S]*?)```$/);
  if (fence) cmd = fence[1].trim();
  else if (cmd.startsWith('`') && cmd.endsWith('`')) cmd = cmd.slice(1, -1).trim();

  if (!options.explicit && !isPlausibleNaturalCommand(cmd)) return null;
  return cmd || null;
}

function isPlausibleNaturalCommand(cmd: string): boolean {
  const normalized = cmd.trim();
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  if (AMBIGUOUS_NATURAL_COMMANDS.has(lower)) return false;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) return true;

  const single = tokens[0] || '';
  const singleLower = single.toLowerCase();
  if (SAFE_SINGLE_WORD_COMMANDS.has(singleLower)) return true;
  if (single.length < 3) return false;

  return /[\\/:*.=-]/.test(single);
}

function normalizeNaturalText(input: string): string {
  return (input || '')
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}_./\\:\-+="'`\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasLocalPathLike(input: string): boolean {
  const text = input || '';
  return /[a-z]:[\\/][^\r\n"'`]+/i.test(text)
    || /\\\\[^\\/\s]+[\\/][^\r\n"'`]+/.test(text)
    || /(?:^|[\s"'`])(?:\.{1,2}[\\/])?[^\s"'`]+\.(?:txt|md|mdx|csv|json|yml|yaml|toml|xml|env|log|py|js|jsx|ts|tsx|html|css|scss|sass|bat|cmd|ps1|sh|java|cs|go|rs|php|rb)(?:$|[\s"'`,;:.!?])/i.test(text);
}

function clipForRepairPrompt(text: string): string {
  const clean = (text || '').trim();
  if (clean.length <= 12000) return clean;
  return `${clean.slice(0, 12000)}\n...[truncated ${clean.length - 12000} chars]`;
}

function normalizeFailureText(text: string): string {
  return (text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[a-z]:\\users\\[^\\\n]+/gi, '<user>')
    .replace(/C:\\\\Users\\\\[^\\\n]+/gi, '<user>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 2000);
}

function extensionOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const name = normalized.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function normalizeToolPath(filePath: string): string {
  return (filePath || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^[.][\\/]/, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function commandReferencedPaths(command: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[\s"'`])((?:\.?[\\/])?[\w .@()#-]+\.(?:py|js|jsx|ts|tsx|json|html|css|bat|cmd|ps1|sh|md))(?:$|[\s"'`;])/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command || ''))) {
    const normalized = normalizeToolPath(match[1]);
    if (normalized) out.add(normalized);
  }
  return [...out];
}

function isMarkdownExtension(ext: string): boolean {
  return ext === '.md' || ext === '.markdown' || ext === '.mdx';
}

function isSourceLikeExtension(ext: string): boolean {
  return new Set([
    '.py',
    '.js',
    '.jsx',
    '.ts',
    '.tsx',
    '.json',
    '.html',
    '.css',
    '.scss',
    '.sass',
    '.vue',
    '.svelte',
    '.java',
    '.cs',
    '.go',
    '.rs',
    '.php',
    '.rb',
    '.sh',
    '.ps1',
    '.bat',
    '.cmd',
  ]).has(ext) || isMarkdownExtension(ext);
}

function findInvalidPythonBlock(content: string): string | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(\s*)(?:def\s+[A-Za-z_]\w*\s*\([^)]*\)|class\s+[A-Za-z_]\w*(?:\([^)]*\))?|if\b.+|elif\b.+|else|for\b.+|while\b.+|with\b.+|try|except\b.*|finally|async\s+def\s+[A-Za-z_]\w*\s*\([^)]*\))\s*:\s*(?:#.*)?$/);
    if (!match) continue;

    const baseIndent = match[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next.trim() || next.trim().startsWith('#')) continue;
      const nextIndent = (next.match(/^\s*/) || [''])[0].length;
      if (nextIndent <= baseIndent) {
        return `Python block op regel ${i + 1} heeft geen ingesprongen body.`;
      }
      break;
    }
  }
  return null;
}

function unwrapSingleMarkdownFence(content: string): string | null {
  const match = (content || '').match(/^\s*```[\w+#.-]*[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  return match ? match[1] : null;
}

function stripStandaloneMarkdownFenceLines(content: string): string | null {
  const text = content || '';
  if (!/(^|\r?\n)\s*```/.test(text)) return null;
  const stripped = text
    .replace(/^\s*```[\w+#.-]*[ \t]*\r?\n/gm, '')
    .replace(/^\s*```[ \t]*\r?\n?/gm, '');
  return stripped === text ? null : stripped;
}

function normalizeSourcePayloadContent(content: string, ext: string): { content: string; message: string } {
  const messages: string[] = [];
  let next = content || '';
  const unfenced = unwrapSingleMarkdownFence(next) ?? stripStandaloneMarkdownFenceLines(next);
  if (unfenced !== null && unfenced !== next) {
    next = unfenced;
    messages.push('Markdown code fence automatisch verwijderd');
  }

  if (ext === '.py') {
    const python = normalizePythonPayload(next);
    if (python.content !== next) {
      next = python.content;
      messages.push(...python.messages);
    }
  }

  return {
    content: next,
    message: `${messages.join('; ') || 'Broncode automatisch genormaliseerd'}; broncode is als ruwe bestandsinhoud opgeslagen.`,
  };
}

function normalizePythonPayload(content: string): { content: string; messages: string[] } {
  const messages: string[] = [];
  let next = content || '';

  const fixedMainGuard = next.replace(
    /^(\s*)if\s+(?:name|__name)\s*==\s*["']main["']\s*:/gm,
    '$1if __name__ == "__main__":',
  );
  if (fixedMainGuard !== next) {
    next = fixedMainGuard;
    messages.push('Python main guard gecorrigeerd');
  }

  const repairedDanglingMain = repairDanglingPythonMainGuard(next);
  if (repairedDanglingMain !== next) {
    next = repairedDanglingMain;
    messages.push('afgebroken Python main guard aangevuld');
  }

  const indented = repairTopLevelPythonIndentLoss(next);
  if (indented !== next) {
    next = indented;
    messages.push('verloren Python-inspringing hersteld');
  }

  return { content: next, messages };
}

function repairDanglingPythonMainGuard(content: string): string {
  if (!/^\s*if\s+__name\s*$/m.test(content || '')) return content;
  const functionName = (content.match(/^def\s+([A-Za-z_]\w*)\s*\(/m) || [])[1];
  if (!functionName) return content;
  return content.replace(/^\s*if\s+__name\s*$/m, `if __name__ == "__main__":\n    ${functionName}()`);
}

function repairTopLevelPythonIndentLoss(content: string): string {
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^def\s+[A-Za-z_]\w*\s*\([^)]*\)\s*:\s*(?:#.*)?$/.test(line)) continue;
    const bodyStart = nextSignificantLineIndex(lines, i + 1);
    if (bodyStart < 0) continue;
    if (indentOf(lines[bodyStart]) > 0) continue;

    let end = lines.length;
    for (let j = bodyStart; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (!trimmed) continue;
      if (j > bodyStart && indentOf(lines[j]) === 0 && /^(?:def\s+|class\s+|if\s+__name__\s*==\s*["']__main__["']\s*:)/.test(trimmed)) {
        end = j;
        break;
      }
    }

    for (let j = bodyStart; j < end; j++) {
      if (!lines[j].trim()) continue;
      lines[j] = `    ${lines[j]}`;
      changed = true;
    }
    i = end - 1;
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!/^if\s+__name__\s*==\s*["']__main__["']\s*:\s*(?:#.*)?$/.test(trimmed) || indentOf(lines[i]) !== 0) continue;
    const bodyStart = nextSignificantLineIndex(lines, i + 1);
    if (bodyStart < 0 || indentOf(lines[bodyStart]) > 0) continue;
    lines[bodyStart] = `    ${lines[bodyStart]}`;
    changed = true;
  }

  return changed ? lines.join('\n') : content;
}

function nextSignificantLineIndex(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (trimmed && !trimmed.startsWith('#')) return index;
  }
  return -1;
}

function indentOf(line: string): number {
  return (line.match(/^\s*/) || [''])[0].length;
}

function parseTagAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(raw))) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function isTruthyAttr(value: string | undefined): boolean {
  return /^(1|true|yes|ja)$/i.test(String(value || '').trim());
}

function shellForSlash(value: string): AgentShell | undefined {
  const normalized = value.toLowerCase();
  if (normalized === 'cmd') return 'cmd';
  if (normalized === 'ps' || normalized === 'powershell') return 'powershell';
  if (normalized === 'pwsh') return 'pwsh';
  return undefined;
}
