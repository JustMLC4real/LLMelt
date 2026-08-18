import { describe, expect, it } from 'vitest';
import type { CommandRun, Message } from '../providers/types';
import {
  appendLiveToolRunOutput,
  buildMessageRenderItems,
  commandRunGroupLabel,
  commandRunFileActivity,
  commandRunItemLabel,
  commandRunStatusLabel,
  makeToolSummaryErrorContent,
  normalizeActivityGroupOrder,
  parseToolOutputActivity,
  removeLiveToolRuns,
  shouldAcceptLiveRequestEvent,
  shouldAcceptOwnedRequestEvent,
  upsertLiveToolActivity,
  upsertLiveToolRun,
} from './command-run-utils';

const baseRun: CommandRun = {
  id: 'run-1',
  source: 'model',
  command: '.\\hello.bat',
  shell: 'powershell',
  cwd: 'C:\\project',
  status: 'running',
  stdout: '',
  stderr: '',
  exitCode: null,
  startedAt: '2026-06-28T10:00:00.000Z',
  endedAt: null,
  durationMs: null,
};

const assistantMessage: Message = {
  id: 'assistant-1',
  chatId: 'chat-1',
  role: 'assistant',
  content: 'Ik voer de gevraagde toolstappen uit.',
  modelId: 'chatgpt:gpt-5-5-instant',
  provider: 'openai',
  inputTokens: 1,
  outputTokens: 1,
  createdAt: '2026-06-28T10:00:00.000Z',
};

describe('command-run activity helpers', () => {
  it('negeert late live-events van een oude beurt', () => {
    expect(shouldAcceptLiveRequestEvent('nieuw', 'nieuw')).toBe(true);
    expect(shouldAcceptLiveRequestEvent('nieuw', 'oud')).toBe(false);
    expect(shouldAcceptLiveRequestEvent(null, 'oud')).toBe(false);
    expect(shouldAcceptLiveRequestEvent(null, 'auto-responder-1')).toBe(true);
  });

  it('weigert een event met de juiste request-id maar een andere chat-eigenaar', () => {
    expect(shouldAcceptOwnedRequestEvent('chat-a', 'req-a', { chatId: 'chat-a', requestId: 'req-a' })).toBe(true);
    expect(shouldAcceptOwnedRequestEvent('chat-a', 'req-a', { requestId: 'req-a' })).toBe(true);
    expect(shouldAcceptOwnedRequestEvent('chat-a', 'req-a', { chatId: 'chat-b', requestId: 'req-a' })).toBe(false);
  });

  it('formats running and finished labels', () => {
    expect(commandRunGroupLabel({ key: 'g', runs: [{ key: 'r', run: baseRun, live: true }] })).toBe('Voert 1 opdracht uit');
    expect(commandRunItemLabel(baseRun)).toBe('Heeft uitgevoerd: .\\hello.bat');
    expect(commandRunStatusLabel(baseRun, Date.parse('2026-06-28T10:00:14.000Z'))).toBe('14s');

    const completed = { ...baseRun, status: 'completed' as const, exitCode: 0 };
    expect(commandRunGroupLabel({ key: 'g', runs: [{ key: 'r', run: completed, live: false }] })).toBe('Voerde 1 opdracht uit');
    expect(commandRunStatusLabel(completed)).toBe('Afsluitcode 0');
  });

  it('upserts live runs and appends output', () => {
    const started = upsertLiveToolRun([], {
      chatId: 'chat-1',
      requestId: 'req-1',
      anchorMessageId: 'assistant-1',
      run: baseRun,
      updatedAt: 'now',
    });

    const withOutput = appendLiveToolRunOutput(started, { chatId: 'chat-1', requestId: 'req-1' }, 'run-1', 'stdout', 'hello', 'later');
    expect(withOutput).toHaveLength(1);
    expect(withOutput[0].run.stdout).toBe('hello');
    expect(withOutput[0].updatedAt).toBe('later');
  });

  it('houdt gelijke provider-run-id\'s uit twee chats strikt apart', () => {
    const chatA = {
      chatId: 'chat-a', requestId: 'req-a', run: { ...baseRun, id: 'provider-call-1' }, updatedAt: 'a',
    };
    const chatB = {
      chatId: 'chat-b', requestId: 'req-b', run: { ...baseRun, id: 'provider-call-1' }, updatedAt: 'b',
    };
    let runs = upsertLiveToolRun([], chatA);
    runs = upsertLiveToolRun(runs, chatB);
    runs = appendLiveToolRunOutput(
      runs,
      { chatId: 'chat-b', requestId: 'req-b' },
      'provider-call-1',
      'stdout',
      'alleen B',
      'later',
    );

    expect(runs).toHaveLength(2);
    expect(runs.find((item) => item.chatId === 'chat-a')?.run.stdout).toBe('');
    expect(runs.find((item) => item.chatId === 'chat-b')?.run.stdout).toBe('alleen B');
    expect(removeLiveToolRuns(runs, new Set(['provider-call-1']), 'chat-a')).toEqual([runs[1]]);
  });

  it('houdt gelijke activiteit-id\'s uit twee chats strikt apart', () => {
    const baseActivity = {
      id: 'provider-activity-1',
      phase: 'running' as const,
      label: 'Bezig',
      updatedAt: 'nu',
    };
    let activities = upsertLiveToolActivity([], {
      ...baseActivity, chatId: 'chat-a', requestId: 'req-a', detail: 'A',
    });
    activities = upsertLiveToolActivity(activities, {
      ...baseActivity, chatId: 'chat-b', requestId: 'req-b', detail: 'B',
    });

    expect(activities).toHaveLength(2);
    expect(activities.map((activity) => activity.detail)).toEqual(['A', 'B']);
  });

  it('toont een native Gemini-bestandstool als dezelfde bestandkaart', () => {
    const fileRun: CommandRun = {
      ...baseRun,
      id: 'gemini-file-1',
      command: 'write_file simpel.py',
      status: 'completed',
      exitCode: 0,
      stdout: 'file-create simpel.py\ncreated simpel.py (11 chars)\n\n--- bestandsinhoud ---\nprint("hi")',
      toolName: 'write_file',
      toolKind: 'file-create',
      toolPath: 'simpel.py',
    };

    expect(commandRunFileActivity(fileRun)).toMatchObject({
      tone: 'ok',
      file: {
        kind: 'file-create',
        path: 'simpel.py',
        status: 'created',
        contentPreview: 'print("hi")',
      },
    });
  });

  it('gebruikt providerneutrale toolmetadata als een CLI geen preview levert', () => {
    const fileRun: CommandRun = {
      ...baseRun,
      id: 'claude-file-1',
      command: 'Edit src/app.ts',
      status: 'completed',
      exitCode: 0,
      stdout: 'File updated successfully',
      toolName: 'Edit',
      toolKind: 'file-edit',
      toolPath: 'src/app.ts',
    };

    expect(commandRunFileActivity(fileRun)).toMatchObject({
      file: { kind: 'file-edit', path: 'src/app.ts', status: 'edited' },
      label: 'Heeft uitgevoerd: bestand bewerken src/app.ts',
    });
  });

  it('groups live tool activity phases under the anchor assistant', () => {
    const liveActivities = upsertLiveToolActivity([], {
      id: 'approval-1',
      chatId: 'chat-1',
      requestId: 'req-1',
      anchorMessageId: 'assistant-1',
      phase: 'approval_pending',
      label: 'Wacht op goedkeuring: Bestand maken',
      detail: 'file-create hello.py',
      approvalStatus: 'pending',
      tone: 'running',
      updatedAt: 'now',
    });

    const items = buildMessageRenderItems([assistantMessage], [], 'chat-1', liveActivities);

    expect(items.map((item) => item.type)).toEqual(['message', 'command-run-group']);
    if (items[1].type === 'command-run-group') {
      expect(commandRunGroupLabel(items[1].group)).toBe('Wacht op goedkeuring');
      expect(items[1].group.runs[0]).toMatchObject({
        label: 'Wacht op goedkeuring: Bestand maken',
        phase: 'approval_pending',
        approvalStatus: 'pending',
      });
    }
  });

  it('plaatst modelplanning niet als losse actie onder de assistentkop', () => {
    const userMessage: Message = {
      ...assistantMessage,
      id: 'user-1',
      role: 'user',
      content: 'Maak hello.py',
    };
    const pendingAssistant: Message = {
      ...assistantMessage,
      id: 'streaming',
      content: '',
    };
    const liveActivities = upsertLiveToolActivity([], {
      id: 'repair-1',
      chatId: 'chat-1',
      requestId: 'req-1',
      phase: 'planning',
      label: 'Model maakt een echte tool-opdracht',
      detail: 'Herstelpoging',
      tone: 'running',
      updatedAt: 'now',
    });

    const items = buildMessageRenderItems([userMessage, pendingAssistant], [], 'chat-1', liveActivities);

    expect(items.map((item) => item.type)).toEqual(['message', 'message']);
  });

  it('houdt model-samenvatten uit het vaste activiteitenoverzicht', () => {
    const persistedToolMessage: Message = {
      ...assistantMessage,
      id: 'tool-1',
      role: 'user',
      content: 'Tool output',
      toolRun: JSON.stringify({ ...baseRun, status: 'completed', exitCode: 0, anchorMessageId: 'assistant-1' }),
    };
    const liveActivities = upsertLiveToolActivity([], {
      id: 'summary-1',
      chatId: 'chat-1',
      requestId: 'req-1',
      anchorMessageId: 'assistant-1',
      phase: 'summarizing',
      label: 'GPT vat samen',
      detail: 'Tool-output is teruggestuurd naar GPT.',
      tone: 'running',
      updatedAt: 'now',
    });

    const items = buildMessageRenderItems([assistantMessage, persistedToolMessage], [], 'chat-1', liveActivities);

    expect(items.map((item) => item.type)).toEqual(['message', 'command-run-group']);
    if (items[1].type === 'command-run-group') {
      expect(commandRunGroupLabel(items[1].group)).toBe('Voerde 1 opdracht uit');
      expect(items[1].group.runs.some((item) => item.phase === 'summarizing')).toBe(false);
    }
  });

  it('does not keep approval-approved/done activity as an active visible row', () => {
    const persistedToolMessage: Message = {
      ...assistantMessage,
      id: 'tool-1',
      role: 'user',
      content: 'Tool output',
      toolRun: JSON.stringify({ ...baseRun, status: 'completed', exitCode: 0, anchorMessageId: 'assistant-1' }),
    };
    const liveActivities = [
      {
        id: 'approval-1',
        chatId: 'chat-1',
        requestId: 'req-1',
        anchorMessageId: 'assistant-1',
        phase: 'approval_approved' as const,
        label: 'Goedgekeurd: Commando uitvoeren',
        detail: 'python .\\hello.py',
        approvalStatus: 'approved' as const,
        tone: 'running' as const,
        updatedAt: 'now',
      },
      {
        id: 'loop-1',
        chatId: 'chat-1',
        requestId: 'req-1',
        anchorMessageId: 'assistant-1',
        phase: 'done' as const,
        label: 'Klaar',
        detail: 'Tool-output is verwerkt door GPT.',
        tone: 'ok' as const,
        updatedAt: 'later',
      },
    ];

    const items = buildMessageRenderItems([assistantMessage, persistedToolMessage], [], 'chat-1', liveActivities);

    expect(items.map((item) => item.type)).toEqual(['message', 'command-run-group']);
    if (items[1].type === 'command-run-group') {
      expect(commandRunGroupLabel(items[1].group)).toBe('Voerde 1 opdracht uit');
      expect(items[1].group.runs).toHaveLength(1);
      expect(items[1].group.runs[0].run?.command).toBe('.\\hello.bat');
    }
  });

  it('groups tool runs under the anchor assistant and dedupes persisted runs', () => {
    const persistedToolMessage: Message = {
      ...assistantMessage,
      id: 'tool-1',
      role: 'user',
      content: 'Tool output',
      toolRun: JSON.stringify({ ...baseRun, status: 'completed', exitCode: 0, anchorMessageId: 'assistant-1' }),
    };

    const items = buildMessageRenderItems(
      [assistantMessage, persistedToolMessage],
      [{ chatId: 'chat-1', anchorMessageId: 'assistant-1', run: baseRun, updatedAt: 'now' }],
      'chat-1',
    );

    expect(items.map((item) => item.type)).toEqual(['message', 'command-run-group']);
    expect(items[1]).toMatchObject({ type: 'command-run-group' });
    if (items[1].type === 'command-run-group') {
      expect(items[1].group.runs).toHaveLength(1);
      expect(items[1].group.runs[0].live).toBe(false);
    }
  });

  it('adds compact summary errors to the previous command group', () => {
    const persistedToolMessage: Message = {
      ...assistantMessage,
      id: 'tool-1',
      role: 'user',
      content: 'Tool output',
      toolRun: JSON.stringify({ ...baseRun, status: 'completed', exitCode: 0, anchorMessageId: 'assistant-1' }),
    };
    const errorMessage: Message = {
      ...assistantMessage,
      id: 'summary-error',
      content: makeToolSummaryErrorContent('ChatGPT composer niet gevonden'),
    };

    const items = buildMessageRenderItems([assistantMessage, persistedToolMessage, errorMessage], [], 'chat-1');

    expect(items.map((item) => item.type)).toEqual(['message', 'command-run-group']);
    if (items[1].type === 'command-run-group') {
      expect(items[1].group.summaryError).toBe('ChatGPT composer niet gevonden');
    }
  });

  it('parses file-tool and skipped-command output as activity items', () => {
    expect(parseToolOutputActivity('Tool output:\n\nfile-create bad.py\n[invalid file payload] nope')).toMatchObject({
      label: 'Bestand niet gemaakt: bad.py',
      tone: 'failed',
    });
    expect(parseToolOutputActivity('Tool output:\n\nfile-create bad.py\n[invalid file payload] nope')?.file).toBeUndefined();
    expect(parseToolOutputActivity('Tool output:\n\nrun python .\\bad.py\n[error] Command overgeslagen omdat de file-tool voor bad.py faalde')).toMatchObject({
      label: 'Heeft overgeslagen: python .\\bad.py',
      tone: 'failed',
    });
  });

  it('labels a user-denied tool as geweigerd, not uitgevoerd', () => {
    expect(parseToolOutputActivity('Tool output:\n\nfile-create secret.py\n[geweigerd door gebruiker]')).toMatchObject({
      label: 'Geweigerd: file-create secret.py',
      tone: 'denied',
    });
  });

  it('still labels a genuinely written file as uitgevoerd', () => {
    expect(parseToolOutputActivity('Tool output:\n\nfile-create hello.py\ncreated hello.py (18 chars)\n\n--- bestandsinhoud ---\nprint("hi")')).toMatchObject({
      label: 'Heeft uitgevoerd: bestand maken hello.py',
      tone: 'ok',
      file: {
        kind: 'file-create',
        path: 'hello.py',
        status: 'created',
        addLines: 1,
        contentPreview: 'print("hi")',
      },
    });
  });

  it('parses file-read output with text preview for the activity UI', () => {
    expect(parseToolOutputActivity('Tool output:\n\nfile-read notes.txt\nread notes.txt (11 chars)\n\n--- bestandsinhoud ---\nhello world')).toMatchObject({
      label: 'Heeft uitgevoerd: bestand lezen notes.txt',
      tone: 'ok',
      file: {
        kind: 'file-read',
        path: 'notes.txt',
        status: 'read',
        addLines: 0,
        deleteLines: 0,
        contentPreview: 'hello world',
      },
    });
  });

  it('treats exists unchanged as neutral, not a failed edit', () => {
    expect(parseToolOutputActivity('Tool output:\n\nfile-create hello.py\nexists unchanged hello.py (22 chars)\n\n--- bestandsinhoud ---\nprint("Hello, world!")')).toMatchObject({
      label: 'Ongewijzigd: hello.py',
      tone: 'ok',
      file: {
        kind: 'file-create',
        path: 'hello.py',
        status: 'unchanged',
        addLines: 0,
        deleteLines: 0,
        contentPreview: 'print("Hello, world!")',
      },
    });
  });

  it('keeps bestand bestaat al outside the file review card', () => {
    const parsed = parseToolOutputActivity('Tool output:\n\nfile-create hello.py\n[geen wijziging] Bestand bestaat al. Gebruik overwrite="true" als overschrijven bedoeld is.');
    expect(parsed).toMatchObject({
      label: 'Geen wijziging: hello.py',
      tone: 'failed',
    });
    expect(parsed?.file).toBeUndefined();
  });

  it('parses file-edit diff previews for review UI', () => {
    expect(parseToolOutputActivity([
      'Tool output:',
      '',
      'file-edit src/index.css',
      'edited src/index.css (+8 chars)',
      '',
      '--- wijziging ---',
      '-padding: 176px;',
      '+padding: 220px;',
      '',
      '--- bestandsinhoud ---',
      'padding: 220px;',
    ].join('\n'))).toMatchObject({
      label: 'Heeft uitgevoerd: bestand bewerken src/index.css',
      tone: 'ok',
      file: {
        kind: 'file-edit',
        path: 'src/index.css',
        status: 'edited',
        addLines: 1,
        deleteLines: 1,
        diffPreview: [
          { type: 'remove', text: 'padding: 176px;' },
          { type: 'add', text: 'padding: 220px;' },
        ],
        contentPreview: 'padding: 220px;',
      },
    });
  });

  it('toont een providerneutrale bestanddiff zonder volledige bestandsinhoud', () => {
    const fileRun: CommandRun = {
      ...baseRun,
      id: 'native-edit-1',
      command: 'Edit src/app.ts',
      status: 'completed',
      exitCode: 0,
      stdout: [
        'file-edit src/app.ts',
        'edited src/app.ts (+0 chars)',
        '',
        '--- wijziging ---',
        '-const status = "oud";',
        '+const status = "nieuw";',
      ].join('\n'),
      toolName: 'Edit',
      toolKind: 'file-edit',
      toolPath: 'src/app.ts',
    };

    expect(commandRunFileActivity(fileRun)).toMatchObject({
      file: {
        kind: 'file-edit',
        path: 'src/app.ts',
        addLines: 1,
        deleteLines: 1,
        diffPreview: [
          { type: 'remove', text: 'const status = "oud";' },
          { type: 'add', text: 'const status = "nieuw";' },
        ],
      },
    });
    expect(commandRunFileActivity(fileRun)?.file?.contentPreview).toBeUndefined();
  });

  it('renders raw tool output messages as activity items, not normal chat text', () => {
    const rawToolOutput: Message = {
      ...assistantMessage,
      id: 'tool-file-create',
      role: 'user',
      content: 'Tool output:\n\nfile-create hello.py\ncreated hello.py (18 chars)',
      provider: null,
      modelId: null,
    };

    const items = buildMessageRenderItems([assistantMessage, rawToolOutput], [], 'chat-1');

    expect(items.map((item) => item.type)).toEqual(['message', 'command-run-group']);
    if (items[1].type === 'command-run-group') {
      expect(items[1].group.runs).toHaveLength(1);
      expect(items[1].group.runs[0]).toMatchObject({
        label: 'Heeft uitgevoerd: bestand maken hello.py',
        tone: 'ok',
        file: {
          path: 'hello.py',
        },
      });
    }
  });

  it('orders successful file and command before duplicate/no-op previous attempts', () => {
    const duplicateCreate: Message = {
      ...assistantMessage,
      id: 'tool-duplicate',
      role: 'user',
      content: 'Tool output:\n\nfile-create hello.py\n[geen wijziging] Bestand bestaat al. Gebruik overwrite="true" als overschrijven bedoeld is.',
      provider: null,
      modelId: null,
    };
    const createdFile: Message = {
      ...assistantMessage,
      id: 'tool-created',
      role: 'user',
      content: 'Tool output:\n\nfile-create hello.py\ncreated hello.py (22 chars)\n\n--- bestandsinhoud ---\nprint("Hello, world!")',
      provider: null,
      modelId: null,
    };
    const commandMessage: Message = {
      ...assistantMessage,
      id: 'tool-run',
      role: 'user',
      content: 'Tool output',
      toolRun: JSON.stringify({ ...baseRun, status: 'completed', exitCode: 0, command: 'python hello.py', anchorMessageId: 'assistant-1' }),
      provider: null,
      modelId: null,
    };

    const items = buildMessageRenderItems([assistantMessage, duplicateCreate, createdFile, commandMessage], [], 'chat-1');

    if (items[1].type !== 'command-run-group') throw new Error('expected command-run-group');
    const normalized = normalizeActivityGroupOrder(items[1].group);

    expect(commandRunGroupLabel(normalized)).toBe('Maakte 1 bestand en voerde 1 opdracht uit · 1 eerdere poging');
    expect(normalized.runs.map((item) => item.attemptKind || 'primary')).toEqual(['primary', 'primary', 'previous-attempt']);
    expect(normalized.runs[0].file?.path).toBe('hello.py');
    expect(normalized.runs[1].run?.command).toBe('python hello.py');
    expect(normalized.runs[2].label).toBe('Geen wijziging: hello.py');
  });

  it('toont bij herhaald overschrijven maar één actuele rij per bestand', () => {
    const attempts = [88, 93, 94].map((lines, index) => ({
      key: `file-${index}`,
      tone: 'ok' as const,
      file: {
        kind: 'file-create' as const,
        path: index === 1 ? 'SRC\\skyline.py' : 'src/skyline.py',
        status: 'created' as const,
        addLines: lines,
        deleteLines: 0,
        contentPreview: `# versie ${index + 1}`,
      },
    }));

    const normalized = normalizeActivityGroupOrder({ key: 'g', runs: attempts });
    const primary = normalized.runs.filter((item) => item.attemptKind === 'primary');
    const previous = normalized.runs.filter((item) => item.attemptKind === 'previous-attempt');

    expect(primary).toHaveLength(1);
    expect(primary[0].file).toMatchObject({ addLines: 94, contentPreview: '# versie 3' });
    expect(previous).toHaveLength(2);
    expect(commandRunGroupLabel(normalized)).toBe('Maakte 1 bestand · 2 eerdere pogingen');
  });
});

describe('Engelse toolactiviteit', () => {
  it('bouwt Engelse labels en leest Engelse bestandssecties', () => {
    const completed = { ...baseRun, status: 'completed' as const, exitCode: 0 };
    expect(commandRunGroupLabel({ key: 'g', runs: [{ key: 'r', run: completed }] }, 'en')).toBe('Ran 1 command');
    expect(commandRunItemLabel(completed, 'en')).toBe('Ran: .\\hello.bat');
    expect(commandRunStatusLabel(completed, Date.now(), 'en')).toBe('Exit code 0');
    const parsed = parseToolOutputActivity('Tool output:\n\nfile-create demo.py\ncreated demo.py\n\n--- file contents ---\nprint("ok")', 'en');
    expect(parsed?.label).toBe('Completed: create file demo.py');
    expect(parsed?.file?.contentPreview).toBe('print("ok")');
  });
});
