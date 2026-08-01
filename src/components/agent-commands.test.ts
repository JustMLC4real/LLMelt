import { describe, expect, it } from 'vitest';
import {
  agentRoundSignature,
  buildToolFailureRepairPrompt,
  buildToolRepairPrompt,
  buildToolSuccessSummaryPrompt,
  compactToolSummaryForDisplay,
  buildToolSyntaxRepairPrompt,
  decideAgentToolLoopContinuation,
  detectDirectCommand,
  detectDirectCommandSpec,
  detectToolExecutionClaim,
  detectToolIntentRequest,
  fileToolPathFromResult,
  hasUnparsedToolMarkup,
  hasFailedCommandRun,
  hasFailedToolResult,
  hasSuccessfulCommandRun,
  isFailedFileToolResult,
  isNoProgressRepeat,
  isNoFixReply,
  isRepeatFailure,
  needsToolComplianceRepair,
  normalizeFileToolPayload,
  normalizeAgentCommand,
  missingRequestedFileExecutions,
  requestRequiresEveryFileExecution,
  parseAgentToolCalls,
  parseRunCommands,
  shouldSkipCommandForFailedFileTool,
  stripAgentToolMarkup,
  toolFailureFingerprint,
  validateModelCommand,
  validateFileToolPayload,
} from './agent-commands';

describe('parseRunCommands', () => {
  it('extracts explicit run-command tags', () => {
    expect(parseRunCommands('<run-command>echo hallo</run-command>')).toEqual(['echo hallo']);
  });

  it('extracts shell-tagged fenced code blocks', () => {
    expect(parseRunCommands('```powershell\nGet-Location\n```')).toEqual(['Get-Location']);
    expect(parseRunCommands('```bash\necho hello\n```')).toEqual(['echo hello']);
  });

  it('ignores bare output fences', () => {
    expect(parseRunCommands('```\nhallo\n```')).toEqual([]);
    expect(parseRunCommands('```text\nhallo\n```')).toEqual([]);
  });

  it('does not treat stray backticks from a prior answer as a new command', () => {
    const reply = 'De output is:\n\n```\nhallo\n``\n\n```';
    expect(parseRunCommands(reply)).toEqual([]);
  });
});

describe('parseAgentToolCalls', () => {
  it('extracts strict file-create tags', () => {
    expect(parseAgentToolCalls('<file-create path="src/hello.txt">hello &amp; bye</file-create>')).toEqual([
      { type: 'file-create', path: 'src/hello.txt', content: 'hello & bye', overwrite: false },
    ]);
  });

  it('extracts strict file-edit tags', () => {
    expect(parseAgentToolCalls('<file-edit path="src/hello.txt" old="hello">hallo</file-edit>')).toEqual([
      { type: 'file-edit', path: 'src/hello.txt', oldText: 'hello', newText: 'hallo', replaceAll: false },
    ]);
  });

  it('extracts strict file-read tags', () => {
    expect(parseAgentToolCalls('<file-read path="docs/notes.txt"></file-read>')).toEqual([
      { type: 'file-read', path: 'docs/notes.txt' },
    ]);
    expect(parseAgentToolCalls('<file-read path="C:\\Users\\Justin\\Documents\\LLMelt\\sss.txt" />')).toEqual([
      { type: 'file-read', path: 'C:\\Users\\Justin\\Documents\\LLMelt\\sss.txt' },
    ]);
  });

  it('ignores malformed file tags', () => {
    expect(parseAgentToolCalls('<file-create>hello</file-create>')).toEqual([]);
    expect(parseAgentToolCalls('<file-edit path="a.txt">new</file-edit>')).toEqual([]);
    expect(parseAgentToolCalls('<file-read></file-read>')).toEqual([]);
  });

  it('keeps tool calls in text order', () => {
    expect(parseAgentToolCalls('<file-create path="a.txt">a</file-create>\n<run-command>npm test</run-command>')).toEqual([
      { type: 'file-create', path: 'a.txt', content: 'a', overwrite: false },
      { type: 'command', command: 'npm test' },
    ]);
  });

  it('can ignore shell fences for strict model tool loops', () => {
    expect(parseAgentToolCalls('```bash\nnpm test\n```', { includeShellFences: false })).toEqual([]);
    expect(parseAgentToolCalls('<run-command>npm test</run-command>', { includeShellFences: false })).toEqual([
      { type: 'command', command: 'npm test' },
    ]);
  });

  it('merkt een kapotte command-tag naast een geldige file-tag als onvolledig aan', () => {
    const reply = '<file-create path="gekte.py">print("hi")</file-create>\n<run-command>python gekte.py</run-command_';
    expect(parseAgentToolCalls(reply, { includeShellFences: false })).toEqual([
      { type: 'file-create', path: 'gekte.py', content: 'print("hi")', overwrite: false },
    ]);
    expect(hasUnparsedToolMarkup(reply)).toBe(true);
    expect(needsToolComplianceRepair({
      userInput: 'maak een python script en run het',
      reply,
      toolCalls: parseAgentToolCalls(reply, { includeShellFences: false }),
    })).toBe(true);
  });
});

describe('decideAgentToolLoopContinuation', () => {
  it('gaat vóór de veiligheidsgrens door met pending toolcalls', () => {
    expect(decideAgentToolLoopContinuation(4, 6, 1)).toEqual({
      action: 'continue',
      pendingCount: 1,
      executePending: true,
    });
  });

  it('stopt op de laatste ronde en meldt alle niet-uitgevoerde acties', () => {
    const decision = decideAgentToolLoopContinuation(5, 6, 2);

    expect(decision).toMatchObject({
      action: 'stop-limit',
      pendingCount: 2,
      executePending: false,
    });
    expect(decision.action === 'stop-limit' && decision.message).toContain('2 toolacties');
    expect(decision.action === 'stop-limit' && decision.message).toContain('niet uitgevoerd');
  });

  it('laat op de laatste ronde een normaal eindantwoord voltooien', () => {
    expect(decideAgentToolLoopContinuation(5, 6, 0)).toEqual({
      action: 'complete',
      pendingCount: 0,
      executePending: false,
    });
  });

  it('herkent een strict tag op de rondegrens als niet-uitvoerbare pending actie', () => {
    const calls = parseAgentToolCalls('<run-command>python x.py</run-command>', { includeShellFences: false });
    expect(decideAgentToolLoopContinuation(5, 6, calls)).toMatchObject({
      action: 'stop-limit',
      pendingCount: 1,
      executePending: false,
    });
  });

  it('behandelt een herstelde syntax-tag op de grens hetzelfde als een directe tag', () => {
    const malformed = '<run-command>python x.py</run-command_';
    expect(hasUnparsedToolMarkup(malformed)).toBe(true);
    const repaired = parseAgentToolCalls('<run-command>python x.py</run-command>', { includeShellFences: false });
    const decision = decideAgentToolLoopContinuation(5, 6, repaired);
    expect(decision.action).toBe('stop-limit');
    expect(decision.executePending).toBe(false);
  });
});

describe('stripAgentToolMarkup', () => {
  it('removes strict tool tags from assistant display text', () => {
    const reply = [
      'Ik maak het bestand.',
      '<file-create path="hello.bat">@echo off\necho hi</file-create>',
      '<run-command>hello.bat</run-command>',
      'Daarna vat ik de output samen.',
    ].join('\n');

    expect(stripAgentToolMarkup(reply)).toBe('Ik maak het bestand.\n\nDaarna vat ik de output samen.');
  });

  it('returns an empty string when the reply is only tool calls', () => {
    expect(stripAgentToolMarkup('<run-command>npm test</run-command>')).toBe('');
    expect(stripAgentToolMarkup('<file-read path="a.txt"></file-read>')).toBe('');
  });

  it('laat kapotte tool-tags nooit als gewone chattekst zien', () => {
    expect(stripAgentToolMarkup('Ik ga hem draaien.\n<run-command>python gekte.py</run-command_'))
      .toBe('Ik ga hem draaien.');
  });
});

describe('detectDirectCommand', () => {
  it('detects slash forms', () => {
    expect(detectDirectCommand('/run echo hello')).toBe('echo hello');
    expect(detectDirectCommand('/exec npm test')).toBe('npm test');
    expect(detectDirectCommand('/run t')).toBe('t');
  });

  it('detects explicit shell slash forms', () => {
    expect(detectDirectCommandSpec('/cmd dir')).toEqual({ command: 'dir', shell: 'cmd' });
    expect(detectDirectCommandSpec('/ps Get-Location')).toEqual({ command: 'Get-Location', shell: 'powershell' });
    expect(detectDirectCommandSpec('/pwsh $PSVersionTable.PSVersion')).toEqual({ command: '$PSVersionTable.PSVersion', shell: 'pwsh' });
    expect(detectDirectCommandSpec('/run npm test')).toEqual({ command: 'npm test', shell: undefined });
  });

  it('detects natural "run/draai/voer uit … op mijn pc"', () => {
    expect(detectDirectCommand('run echo hello op mijn pc')).toBe('echo hello');
    expect(detectDirectCommand('draai dir op mn pc')).toBe('dir');
    expect(detectDirectCommand('voer uit: npm run build')).toBe('npm run build');
    expect(detectDirectCommand('run echo hallo op MIJN pc en vertel me de output')).toBe('echo hallo');
  });

  it('unwraps backticks/fences around the command', () => {
    expect(detectDirectCommand('draai `dir`')).toBe('dir');
    expect(detectDirectCommand('/run ```bash\necho hi\n```')).toBe('echo hi');
  });

  it('returns null for normal chat messages', () => {
    expect(detectDirectCommand('wat is de output van echo?')).toBeNull();
    expect(detectDirectCommand('leg uit hoe echo werkt')).toBeNull();
    expect(detectDirectCommand('')).toBeNull();
  });

  it('does not execute ambiguous tiny natural-language commands', () => {
    expect(detectDirectCommand('run t op mn pc')).toBeNull();
    expect(detectDirectCommand("draai 't op mijn pc")).toBeNull();
    expect(detectDirectCommand('execute it on my pc')).toBeNull();
  });
});

describe('isNoProgressRepeat (run-run-run loop guard)', () => {
  const cmd = (command: string) => ({ type: 'command' as const, command });
  const file = () => ({ type: 'file-create' as const, path: 'a.py', content: 'x', overwrite: false });

  it('stops when the round only repeats an already-run command', () => {
    const seen = new Set([normalizeAgentCommand('python hello.py')]);
    expect(isNoProgressRepeat([cmd('python  hello.py')], seen)).toBe(true);
  });

  it('allows a command that has not run yet', () => {
    const seen = new Set([normalizeAgentCommand('python hello.py')]);
    expect(isNoProgressRepeat([cmd('python other.py')], seen)).toBe(false);
  });

  it('allows re-running a command when a file is also being changed', () => {
    const seen = new Set([normalizeAgentCommand('python hello.py')]);
    expect(isNoProgressRepeat([file(), cmd('python hello.py')], seen)).toBe(false);
  });

  it('does not stop when there are no command calls', () => {
    expect(isNoProgressRepeat([file()], new Set())).toBe(false);
    expect(isNoProgressRepeat([], new Set())).toBe(false);
  });

  it('flags an identical round (no-op file-edit + same command) as a repeat via signature', () => {
    const round = parseAgentToolCalls(
      '<file-edit path="hello.py" old="x">y</file-edit>\n<run-command>python hello.py</run-command>',
      { includeShellFences: false },
    );
    const seen = new Set<string>();
    seen.add(agentRoundSignature(round));
    // Same round again → already seen → caller stops even though a (no-op) file-edit is present.
    expect(seen.has(agentRoundSignature(round))).toBe(true);
    // isNoProgressRepeat alone would MISS this (a file-write is present).
    expect(isNoProgressRepeat(round, new Set([normalizeAgentCommand('python hello.py')]))).toBe(false);
  });

  it('gives different signatures to different rounds', () => {
    const a = parseAgentToolCalls('<run-command>python a.py</run-command>', { includeShellFences: false });
    const b = parseAgentToolCalls('<run-command>python b.py</run-command>', { includeShellFences: false });
    expect(agentRoundSignature(a)).not.toBe(agentRoundSignature(b));
  });
});

describe('file-create preserves indentation', () => {
  it('keeps Python indentation verbatim through parsing', () => {
    const reply = '<file-create path="hello.py">\ndef begroeting():\n    naam = "Justin"\n    print(naam)\n</file-create>';
    const calls = parseAgentToolCalls(reply, { includeShellFences: false });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.type).toBe('file-create');
    if (call.type === 'file-create') {
      expect(call.content).toContain('    naam = "Justin"');
      expect(call.content).toContain('    print(naam)');
    }
  });
});

describe('file tool payload validation', () => {
  it('rejects markdown fences in source files before writing', () => {
    const result = validateFileToolPayload({
      type: 'file-create',
      path: 'bad.py',
      content: 'def main():\n\n```python\nprint("hi")\n```',
      overwrite: false,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/code fences/i);
  });

  it('allows markdown fences in markdown files', () => {
    expect(validateFileToolPayload({
      type: 'file-create',
      path: 'README.md',
      content: '```python\nprint("hi")\n```',
      overwrite: false,
    })).toEqual({ ok: true });
  });

  it('normalizes a single wrapping code fence before source validation', () => {
    const normalized = normalizeFileToolPayload({
      type: 'file-create',
      path: 'hello.py',
      content: '```python\nprint("hi")\n```',
      overwrite: false,
    });

    expect(normalized.changed).toBe(true);
    expect(normalized.message).toMatch(/automatisch verwijderd/i);
    expect(normalized.call).toMatchObject({
      type: 'file-create',
      path: 'hello.py',
      content: 'print("hi")',
    });
    expect(validateFileToolPayload(normalized.call).ok).toBe(true);
  });

  it('normalizes standalone fence lines embedded in source content', () => {
    const normalized = normalizeFileToolPayload({
      type: 'file-create',
      path: 'hello.py',
      content: 'print("start")\n\n```python\nprint("inside")\n```\n\nprint("done")',
      overwrite: false,
    });

    expect(normalized.changed).toBe(true);
    expect(normalized.call.type).toBe('file-create');
    if (normalized.call.type === 'file-create') {
      expect(normalized.call.content).not.toContain('```');
      expect(normalized.call.content).toContain('print("start")');
      expect(normalized.call.content).toContain('print("inside")');
      expect(normalized.call.content).toContain('print("done")');
    }
    expect(validateFileToolPayload(normalized.call).ok).toBe(true);
  });

  it('repairs common ChatGPT web Python indentation loss after fence normalization', () => {
    const normalized = normalizeFileToolPayload({
      type: 'file-create',
      path: 'bad.py',
      content: 'def main():\n\n```python\nprint("hi")\n```',
      overwrite: false,
    });

    expect(normalized.changed).toBe(true);
    const validation = validateFileToolPayload(normalized.call);
    expect(validation.ok).toBe(true);
    if (normalized.call.type === 'file-create') {
      expect(normalized.call.content).toContain('def main():\n    print("hi")');
    }
  });

  it('repairs real ChatGPT web-style Python payload before approval', () => {
    const normalized = normalizeFileToolPayload({
      type: 'file-create',
      path: 'hello_uitgebreid_fixed.py',
      content: [
        'import time',
        '',
        'def begroeting():',
        '',
        'naam = "Justin"',
        '',
        '```',
        'print("=" * 35)',
        'print(" Python Demo ")',
        'print("=" * 35)',
        '',
        'for i in range(3):',
        '    print(f"Hallo {naam}! ({i + 1}/3)")',
        '    time.sleep(0.5)',
        '',
        'print("-" * 35)',
        'print("Klaar, hellloo vanuit Python!")',
        '```',
        '',
        'if name == "main":',
        'begroeting()',
      ].join('\n'),
      overwrite: true,
    });

    expect(normalized.changed).toBe(true);
    expect(validateFileToolPayload(normalized.call).ok).toBe(true);
    if (normalized.call.type === 'file-create') {
      expect(normalized.call.content).not.toContain('```');
      expect(normalized.call.content).toContain('    naam = "Justin"');
      expect(normalized.call.content).toContain('        print(f"Hallo {naam}! ({i + 1}/3)")');
      expect(normalized.call.content).toContain('if __name__ == "__main__":\n    begroeting()');
    }
  });

  it('normalizes file-edit replacement content too', () => {
    const normalized = normalizeFileToolPayload({
      type: 'file-edit',
      path: 'hello.py',
      oldText: 'print("old")',
      newText: '\n```python\nprint("new")\n```\n',
      replaceAll: false,
    });

    expect(normalized.changed).toBe(true);
    expect(normalized.call).toMatchObject({
      type: 'file-edit',
      newText: 'print("new")',
    });
    expect(validateFileToolPayload(normalized.call).ok).toBe(true);
  });

  it('does not strip fenced markdown files', () => {
    const call = {
      type: 'file-create' as const,
      path: 'README.md',
      content: '```python\nprint("hi")\n```',
      overwrite: false,
    };

    expect(normalizeFileToolPayload(call)).toEqual({ call, changed: false });
  });

  it('rejects a broken Python main guard', () => {
    const result = validateFileToolPayload({
      type: 'file-create',
      path: 'hello.py',
      content: 'if name == "main":\n    print("hi")',
      overwrite: false,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/__name__/);
  });

  it('rejects an unindented Python function body', () => {
    const result = validateFileToolPayload({
      type: 'file-create',
      path: 'hello.py',
      content: 'def greet():\n\nprint("hi")',
      overwrite: false,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/ingesprongen body/i);
  });

  it('rejects an unindented Python loop body', () => {
    const result = validateFileToolPayload({
      type: 'file-create',
      path: 'hello.py',
      content: 'for i in range(3):\nprint(i)',
      overwrite: false,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/ingesprongen body/i);
  });

  it('validates file-edit replacement text too', () => {
    const result = validateFileToolPayload({
      type: 'file-edit',
      path: 'hello.py',
      oldText: 'x',
      newText: '```python\nprint("hi")\n```',
      replaceAll: false,
    });

    expect(result.ok).toBe(false);
  });
});

describe('tool failure repair helpers', () => {
  it('vervangt enorme herhaalde code in een toolsamenvatting door een verwijzing naar de kaart', () => {
    const summary = compactToolSummaryForDisplay(`Klaar.\n\n\`\`\`python\n${'print("regel")\n'.repeat(80)}\`\`\`\n\nGetest.`);
    expect(summary).toContain('Volledige python-code staat in de bestandskaart hierboven');
    expect(summary).toContain('Getest.');
    expect(summary).not.toContain('print("regel")');
  });

  it('detects failed command runs from exit code/status', () => {
    expect(hasFailedCommandRun([
      { text: '$ python bad.py\nIndentationError', run: { command: 'python bad.py', status: 'failed', exitCode: 1 } },
    ])).toBe(true);
    expect(hasFailedCommandRun([
      { text: '$ python bad.py\n[geweigerd door gebruiker]', run: { command: 'python bad.py', status: 'denied', exitCode: null } },
    ])).toBe(true);
    expect(hasFailedCommandRun([
      { text: '$ python ok.py\nhi', run: { command: 'python ok.py', status: 'completed', exitCode: 0 } },
    ])).toBe(false);
  });

  it('detects successful command runs and builds a no-more-tools summary prompt', () => {
    const results = [
      { text: 'file-create simpel.py\ncreated simpel.py (69 chars)' },
      { text: '$ python .\\simpel.py\nHallo vanuit Python!', run: { command: 'python .\\simpel.py', status: 'completed', exitCode: 0 } },
    ];

    expect(hasSuccessfulCommandRun(results)).toBe(true);
    const prompt = buildToolSuccessSummaryPrompt(results);
    expect(prompt).toContain('exit code 0');
    expect(prompt).toMatch(/volledige oorspronkelijke gebruikersopdracht/i);
    expect(prompt).toContain('nog ontbrekende strict tool-tag(s)');
    expect(prompt).toContain('herhaal geen actie die al met succes is uitgevoerd');
    expect(prompt).toContain('maximaal 120 woorden');
    expect(prompt).toContain('Plak GEEN volledige code');
    expect(prompt).toContain('uitklapbare toolkaarten');
    expect(prompt).toContain('Hallo vanuit Python!');
  });

  it('laat na alleen een bestandsactie expliciet controleren of een run nog ontbreekt', () => {
    const prompt = buildToolSuccessSummaryPrompt([
      { text: 'file-create demo.py\ncreated demo.py (42 chars)' },
    ]);
    expect(prompt).toContain('geen bewezen geslaagde command-run');
    expect(prompt).toContain('nog ontbrekende strict tool-tag(s)');
  });

  it('vindt bij een expliciete beide-run opdracht het nog niet uitgevoerde script', () => {
    expect(missingRequestedFileExecutions(
      'Maak twee Python-scripts en voer ze allebei uit.',
      ['neon.py', 'sunset.py'],
      ['python neon.py'],
    )).toEqual(['sunset.py']);

    const prompt = buildToolSuccessSummaryPrompt([], { missingExecutionPaths: ['sunset.py'] });
    expect(prompt).toContain('HOST-BEWIJSCONTROLE');
    expect(prompt).toContain('sunset.py');
    expect(prompt).toContain('Vat nu NIET samen');
  });

  it('legt geen per-bestandseis op aan een gewone projecttest', () => {
    expect(missingRequestedFileExecutions(
      'Pas deze bestanden aan en voer npm test uit.',
      ['src/a.ts', 'src/b.ts'],
      ['npm test'],
    )).toEqual([]);
  });

  it('dwingt een eindantwoord af zodra de expliciete beide-run eis bewezen is', () => {
    expect(requestRequiresEveryFileExecution('Voer ze allebei uit.')).toBe(true);
    const prompt = buildToolSuccessSummaryPrompt([], { verifiedAllRequestedExecutions: true });
    expect(prompt).toContain('alle expliciet gevraagde');
    expect(prompt).toContain('geen nieuwe of equivalente toolactie');
    expect(prompt).toContain('korte eind-samenvatting');
  });

  it('treats invalid file payload output as a failed tool result', () => {
    expect(hasFailedToolResult([
      { text: 'file-create bad.py\n[invalid file payload] Source-bestand bevat Markdown code fences' },
    ])).toBe(true);
  });

  it('builds a strict failed-run repair prompt', () => {
    const prompt = buildToolFailureRepairPrompt([
      { text: '$ python bad.py\nIndentationError: expected an indented block', run: { command: 'python bad.py', status: 'failed', exitCode: 1, stderr: 'IndentationError' } },
    ]);

    expect(prompt).toContain('exit code 0');
    expect(prompt).toContain('<file-edit path="relative/path.ext" old="exact old text">');
    expect(prompt).toContain('<run-command>commando</run-command>');
    expect(prompt).toContain('NO_FIX');
  });

  it('recognizes explicit NO_FIX replies', () => {
    expect(isNoFixReply('NO_FIX')).toBe(true);
    expect(isNoFixReply(' no_fix ')).toBe(true);
    expect(isNoFixReply('NO_TOOLS')).toBe(false);
  });

  it('fingerprints repeated failures and detects repeats', () => {
    const results = [
      { text: 'file-create bad.py\n[invalid file payload] Source-bestand bevat Markdown code fences' },
      { text: 'run python .\\bad.py\n[error] Command overgeslagen omdat de file-tool voor bad.py faalde' },
    ];
    const fp = toolFailureFingerprint(results);
    const seen = new Set<string>();

    expect(fp).toContain('invalid file payload');
    expect(isRepeatFailure(seen, fp)).toBe(false);
    expect(isRepeatFailure(seen, fp)).toBe(true);
  });

  it('extracts failed file-tool paths and skips dependent commands', () => {
    const text = 'file-create hello_uitgebreid_fixed.py\n[invalid file payload] Source-bestand bevat Markdown code fences';
    expect(isFailedFileToolResult(text)).toBe(true);
    expect(fileToolPathFromResult(text)).toBe('hello_uitgebreid_fixed.py');
    expect(shouldSkipCommandForFailedFileTool('python .\\hello_uitgebreid_fixed.py', new Set(['hello_uitgebreid_fixed.py']))).toMatchObject({
      skip: true,
      path: 'hello_uitgebreid_fixed.py',
    });
    expect(shouldSkipCommandForFailedFileTool('python .\\other.py', new Set(['hello_uitgebreid_fixed.py'])).skip).toBe(false);
  });

  it('still detects an invalid file payload so dependent commands are skipped', () => {
    const text = 'file-create bad.py\n[invalid file payload] Source-bestand bevat Markdown code fences';
    expect(isFailedFileToolResult(text)).toBe(true);
    expect(fileToolPathFromResult(text)).toBe('bad.py');
  });

  it('rejects model commands that try to write files via shell tricks', () => {
    expect(validateModelCommand("@'\nprint('hi')\n'@ | Set-Content hello.py; python hello.py").ok).toBe(false);
    expect(validateModelCommand('echo hi > hello.py').ok).toBe(false);
    expect(validateModelCommand('python hello.py')).toEqual({ ok: true });
  });
});

describe('tool compliance guard', () => {
  it('detects natural create-and-run tool intent', () => {
    expect(detectToolIntentRequest('top kan je nu ook in python t schrijven en uitvoeren')).toBe(true);
    expect(detectToolIntentRequest('maak een simpel script en run t op mn pc')).toBe(true);
    expect(detectToolIntentRequest('maak simpel scriptje in python hello world')).toBe(true);
    expect(detectToolIntentRequest('schrijf een klein hello.py bestand')).toBe(true);
    expect(detectToolIntentRequest('"C:\\Users\\Justin\\Documents\\LLMelt\\sss.txt" zie je die file')).toBe(true);
    expect(detectToolIntentRequest('kan je ./notes.txt lezen')).toBe(true);
    expect(detectToolIntentRequest('je hebt t niet echt uitgevoerd')).toBe(true);
    expect(detectToolIntentRequest('doe dat nog eens voor me', [
      { role: 'assistant', content: '<run-command>.\\hello.bat</run-command>' },
    ])).toBe(true);
  });

  it('does not treat explanation requests as tool intent', () => {
    expect(detectToolIntentRequest('leg uit hoe echo werkt')).toBe(false);
    expect(detectToolIntentRequest('hoe kan ik een python script schrijven en uitvoeren?')).toBe(false);
    expect(detectToolIntentRequest('hey')).toBe(false);
    expect(detectToolIntentRequest('waarom zijn paarden zwart')).toBe(false);
  });

  it('detects fake execution claims without tool tags', () => {
    const reply = 'Ik heb een simpele Python versie gemaakt en meteen voor je uitgevoerd.\n\n```\nhellloo\n```';
    expect(detectToolExecutionClaim(reply)).toBe(true);
    expect(detectToolExecutionClaim('Ik heb een simpel Python scriptje voor je gemaakt.')).toBe(true);
    expect(detectToolExecutionClaim('Het bestand is voor je aangemaakt.')).toBe(true);
    expect(detectToolExecutionClaim('Ik kan dit niet daadwerkelijk uitvoeren, maar hier is de code.')).toBe(false);
  });

  it('requires repair for tool intent prose without strict tags', () => {
    const reply = 'Ik heb het gemaakt en uitgevoerd.\n\n```text\nhellloo\n```';
    expect(needsToolComplianceRepair({
      userInput: 'kan je in python iets schrijven en uitvoeren',
      reply,
    })).toBe(true);
  });

  it('requires repair when a create-only code request gets fake prose', () => {
    expect(needsToolComplianceRepair({
      userInput: 'maak simpel scriptje in python hello world',
      reply: 'Ik heb een simpel Python scriptje voor je gemaakt. Wil je dat ik hem ook run?',
    })).toBe(true);
  });

  it('treats a bare run follow-up as tool intent after a fake file claim', () => {
    expect(detectToolIntentRequest('run', [
      { role: 'assistant', content: 'Ik heb een simpel Python scriptje voor je gemaakt.' },
    ])).toBe(true);
  });

  it('requires repair for dangling tool markup that parsed no calls', () => {
    const reply = '<file-create path="hello.py">print("hi")\n\nif __name';
    expect(hasUnparsedToolMarkup(reply)).toBe(true);
    expect(needsToolComplianceRepair({
      userInput: 'maak nu de code wat uitgebreider',
      reply,
      recentMessages: [
        { role: 'user', content: 'Tool output:\n\nfile-create hello.py\ncreated hello.py (18 chars)' },
      ],
    })).toBe(true);
  });

  it('treats code modification follow-ups as tool intent after real tool output', () => {
    expect(detectToolIntentRequest('maak nu de code wat uitgebreider', [
      { role: 'assistant', content: 'Ik voer de gevraagde toolstappen uit: 1 bestand maken, 1 commando uitvoeren.' },
      { role: 'user', content: 'Tool output:\n\n$ python hello.py\nhellloo' },
    ])).toBe(true);
  });

  it('does not repair strict tool calls or normal chat', () => {
    expect(needsToolComplianceRepair({
      userInput: 'kan je in python iets schrijven en uitvoeren',
      reply: '<file-create path="hello.py">print("hi")</file-create>\n<run-command>python hello.py</run-command>',
    })).toBe(false);
    expect(needsToolComplianceRepair({
      userInput: 'leg uit hoe echo werkt',
      reply: 'Echo schrijft tekst naar stdout.',
    })).toBe(false);
  });

  it('builds a strict repair prompt', () => {
    const prompt = buildToolRepairPrompt({
      userInput: 'maak script en run',
      badReply: 'Ik heb het uitgevoerd.',
    });
    expect(prompt).toContain('<file-read path="relative/path.ext"></file-read>');
    expect(prompt).toContain('<file-create path="relative/path.ext">');
    expect(prompt).toContain('<run-command>commando</run-command>');
    expect(prompt).toContain('NO_TOOLS');
  });

  it('bouwt een gerichte syntaxreparatie zonder afgeronde acties te herhalen', () => {
    const prompt = buildToolSyntaxRepairPrompt({
      badReply: '<run-command>python gekte.py</run-command_',
      completedResults: [{ text: 'file-create gekte.py\ncreated gekte.py' }],
    });
    expect(prompt).toContain('<run-command>commando</run-command>');
    expect(prompt).toContain('Herhaal geen acties');
    expect(prompt).toContain('file-create gekte.py');
    expect(prompt).toContain('</run-command_');
  });

  it('leest browserveilige broncode uit het direct volgende codeblok', () => {
    const reply = [
      '<file-create path="nested.py" source="next-fence"></file-create>',
      '',
      '```python',
      'def main():',
      '    for item in range(2):',
      '        print(item)',
      '```',
      '<run-command>python nested.py</run-command>',
    ].join('\n');
    const calls = parseAgentToolCalls(reply, { includeShellFences: false });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      type: 'file-create',
      path: 'nested.py',
      content: 'def main():\n    for item in range(2):\n        print(item)',
    });
    expect(stripAgentToolMarkup(reply)).toBe('');
  });

  it('weigert een next-fence marker zonder direct volgend codeblok', () => {
    const calls = parseAgentToolCalls(
      '<file-create path="broken.py" source="next-fence"></file-create>\nGeen broncode.',
      { includeShellFences: false },
    );
    expect(calls).toEqual([]);
  });
});
