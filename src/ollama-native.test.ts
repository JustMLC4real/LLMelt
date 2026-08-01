import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  explicitRequestedArtifactCount,
  ollamaArtifactCompletionEvidence,
  ollamaArtifactExecutionCommand,
  parseStrictTextToolCalls,
  requestedArtifactExtension,
  runOllamaNative,
} from '../electron/ollama-native';
import { nativeToolInputProtocolError } from '../electron/native-tools';
import type { NativeToolActivity, NativeToolExecutor } from '../electron/native-tools';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('Ollama native tools', () => {
  it('leidt alleen expliciete aantallen artefacten uit de gebruikersvraag af', () => {
    expect(explicitRequestedArtifactCount([
      { role: 'user', content: 'Maak twee Python-scripts en voer ze allebei uit.' },
    ])).toBe(2);
    expect(explicitRequestedArtifactCount([
      { role: 'user', content: 'Maak 3 bestanden met verschillende voorbeelden.' },
    ])).toBe(3);
    expect(explicitRequestedArtifactCount([
      { role: 'user', content: 'Maak een script en test het.' },
    ])).toBe(0);
    expect(explicitRequestedArtifactCount([
      { role: 'user', content: 'Repareer twee bestaande bestanden en voer ze uit.' },
    ])).toBe(0);
  });

  it('leidt bewijs en veilige uitvoercommando’s af zonder onbewezen uitvoering te accepteren', () => {
    const created = new Set(['city skyline.py', 'animated_skyline.py']);
    const executed = new Set(['city skyline.py']);
    expect(ollamaArtifactCompletionEvidence(2, true, created, executed)).toEqual({
      missingCreatedArtifacts: false,
      missingExecutedFiles: ['animated_skyline.py'],
    });
    expect(ollamaArtifactExecutionCommand('city skyline.py')).toBe('python "city skyline.py"');
    expect(ollamaArtifactExecutionCommand('app.js')).toBe('node "app.js"');
    expect(ollamaArtifactExecutionCommand('notities.txt')).toBe('');
  });

  it('herkent een expliciet gevraagd scripttype zonder modelnaam-allowlist', () => {
    expect(requestedArtifactExtension([
      { role: 'user', content: 'Maak twee Python-scripts en voer ze uit.' },
    ])).toBe('.py');
    expect(requestedArtifactExtension([
      { role: 'user', content: 'Schrijf een PowerShell script.' },
    ])).toBe('.ps1');
    expect(requestedArtifactExtension([
      { role: 'user', content: 'Maak twee bestanden.' },
    ])).toBe('');
  });

  it('weigert een README als de gebruiker expliciet Python-scripts vroeg', async () => {
    let round = 0;
    const received: any[] = [];
    const replies = [
      ollamaToolResponse(toolCall('wrong-1', 'write_file', { path: 'README.md', content: 'nee' })),
      ollamaToolResponse(toolCall('write-1', 'write_file', { path: 'goed.py', content: 'print(1)' })),
      ollamaTextResponse('Het Python-script is gemaakt.'),
      ollamaTextResponse('Gecontroleerd: klaar.'),
    ];
    const baseUrl = await serve((body, res) => {
      received.push(body);
      sendNdjson(res, replies[round++]);
    });
    const calls: string[] = [];

    const result = await runOllamaNative({
      baseUrl,
      model: 'tool-model',
      messages: [{ role: 'user', content: 'Maak een Python-script.' }],
      signal: new AbortController().signal,
      requireToolUse: true,
      supportsThinking: false,
      onDelta: () => {},
      executeTool: async (name) => {
        calls.push(name);
        return { ok: true, output: 'created goed.py' };
      },
    });

    expect(calls).toEqual(['write_file']);
    expect(JSON.parse(received[1].messages.at(-1).content)).toMatchObject({
      errorCode: 'WRONG_ARTIFACT_TYPE',
      retryable: true,
    });
    expect(result.text).toContain('Gecontroleerd');
  });

  it('plant na één genegeerde completion-gate de expliciet gevraagde Pythonuitvoering zelf', async () => {
    let round = 0;
    const replies = [
      ollamaToolResponse(toolCall('write-1', 'write_file', { path: 'a.py', content: 'print(1)' })),
      ollamaTextResponse('Het bestand is uitgevoerd.'),
      ollamaTextResponse('Het bestand is uitgevoerd.'),
      ollamaTextResponse('Alles is nu echt klaar.'),
      ollamaTextResponse('Gecontroleerd: alles is klaar.'),
    ];
    const baseUrl = await serve((_body, res) => sendNdjson(res, replies[round++]));
    const calls: Array<{ name: string; command?: unknown }> = [];

    const result = await runOllamaNative({
      baseUrl,
      model: 'tool-model',
      messages: [{ role: 'user', content: 'Maak a.py en voer het bestand uit.' }],
      signal: new AbortController().signal,
      requireToolUse: true,
      supportsThinking: false,
      onDelta: () => {},
      executeTool: async (name, input) => {
        calls.push({ name, command: input.command });
        return { ok: true, output: name === 'run_command' ? '1' : 'created a.py' };
      },
    });

    expect(calls).toEqual([
      { name: 'write_file', command: undefined },
      { name: 'run_command', command: 'python "a.py"' },
    ]);
    expect(result.text).toContain('Gecontroleerd');
  });

  it('weigert directory- en wildcardpaden vóór echte uitvoering', () => {
    expect(nativeToolInputProtocolError('read_file', { path: '.' })).toMatch(/geen map/i);
    expect(nativeToolInputProtocolError('read_file', { path: 'src/' })).toMatch(/geen map/i);
    expect(nativeToolInputProtocolError('read_file', { path: '*.py' })).toMatch(/wildcard/i);
    expect(nativeToolInputProtocolError('read_file', { path: 'src/app.ts' })).toBeNull();
    if (process.platform === 'win32') {
      expect(nativeToolInputProtocolError('run_command', {
        command: "cat > skyline.py << 'EOF'\nprint('x')\nEOF",
      })).toMatch(/write_file/i);
      expect(nativeToolInputProtocolError('run_command', {
        command: 'python skyline.py',
      })).toBeNull();
    }
  });

  it('herkent een volledig tekstueel tool-JSON-antwoord en voert per ronde alleen de eerste call uit', async () => {
    let round = 0;
    const received: any[] = [];
    const baseUrl = await serve((body, res) => {
      received.push(body);
      if (round++ === 0) {
        sendNdjson(res, ollamaTextResponse([
          JSON.stringify({ name: 'read_file', arguments: { path: 'a.py' } }),
          JSON.stringify({ name: 'edit_file', arguments: { path: 'a.py', old_text: 'x', new_text: 'y' } }),
          JSON.stringify({ name: 'run_command', arguments: { command: 'python a.py' } }),
        ].join('\n')));
      } else {
        sendNdjson(res, ollamaTextResponse('Bestand gelezen; de volgende stap kan nu veilig worden gepland.'));
      }
    });
    const calls: string[] = [];

    const result = await run(baseUrl, {
      executeTool: async (name) => {
        calls.push(name);
        return { ok: true, output: 'x' };
      },
    });

    expect(calls).toEqual(['read_file']);
    expect(received[1].messages.at(-2).tool_calls).toHaveLength(1);
    expect(result.text).toContain('volgende stap');
  });

  it('voert gemengde prose, onbekende tools of gedeeltelijke JSON nooit als teksttool uit', () => {
    expect(parseStrictTextToolCalls('Ik stel voor: {"name":"run_command","arguments":{"command":"whoami"}}')).toEqual([]);
    expect(parseStrictTextToolCalls('{"name":"delete_everything","arguments":{}}')).toEqual([]);
    expect(parseStrictTextToolCalls('{"name":"run_command","arguments":')).toEqual([]);
  });

  it('accepteert korte plannotities tussen verder uitsluitend bekende teksttools', () => {
    expect(parseStrictTextToolCalls([
      '{"name":"read_file","arguments":{"path":"a.py"}}',
      '// wacht op het leesresultaat',
      '{"name":"edit_file","arguments":{"path":"a.py","old_text":"x","new_text":"y"}}',
    ].join('\n'))).toHaveLength(2);
  });

  it('audit een vroeg eindantwoord na tools en laat daarna ontbrekende stappen uitvoeren', async () => {
    let round = 0;
    const received: any[] = [];
    const replies = [
      ollamaToolResponse(toolCall('write-1', 'write_file', { path: 'a.py', content: 'print(1)' })),
      ollamaTextResponse('Voer het bestand nu zelf uit.'),
      ollamaToolResponse(toolCall('run-1', 'run_command', { command: 'python a.py' })),
      ollamaTextResponse('Alles is nu uitgevoerd.'),
      ollamaTextResponse('Gecontroleerd: alles is voltooid.'),
    ];
    const baseUrl = await serve((body, res) => {
      received.push(body);
      sendNdjson(res, replies[round++]);
    });
    const calls: string[] = [];

    const result = await run(baseUrl, {
      executeTool: async (name) => {
        calls.push(name);
        return { ok: true, output: 'ok' };
      },
    });

    expect(calls).toEqual(['write_file', 'run_command']);
    expect(received[2].messages.at(-1).content).toContain('completion audit');
    expect(received[4].messages.at(-1).content).toContain('completion audit');
    expect(result.text).toBe('Gecontroleerd: alles is voltooid.');
  });

  it('accepteert een expliciet onvoltooid rapport niet als eindantwoord', async () => {
    let round = 0;
    const received: any[] = [];
    const replies = [
      ollamaToolResponse(toolCall('write-1', 'write_file', { path: 'a.py', content: 'print(1)' })),
      ollamaTextResponse('Geen uitvoering getoond; het bestand is niet volledig valid en vereist extra correcties.'),
      ollamaToolResponse(toolCall('run-1', 'run_command', { command: 'python a.py' })),
      ollamaTextResponse('Het bestand is nu gemaakt en uitgevoerd.'),
      ollamaTextResponse('Gecontroleerd: het bestand is gemaakt en uitgevoerd.'),
    ];
    const baseUrl = await serve((body, res) => {
      received.push(body);
      sendNdjson(res, replies[round++]);
    });
    const calls: string[] = [];

    const result = await runOllamaNative({
      baseUrl,
      model: 'tool-model',
      messages: [{ role: 'user', content: 'maak en run a.py' }],
      signal: new AbortController().signal,
      requireToolUse: true,
      supportsThinking: false,
      onDelta: () => {},
      executeTool: async (name) => {
        calls.push(name);
        return { ok: true, output: name === 'run_command' ? '1' : 'created a.py' };
      },
    });

    expect(calls).toEqual(['write_file', 'run_command']);
    expect(received[2].messages.at(-1).content).toContain('onvoltooide-taak-herstel');
    expect(result.text).toBe('Gecontroleerd: het bestand is gemaakt en uitgevoerd.');
  });

  it('finaliseert twee gevraagde scripts pas nadat beide echt succesvol zijn uitgevoerd', async () => {
    let round = 0;
    const received: any[] = [];
    const replies = [
      ollamaToolResponse(toolCall('write-1', 'write_file', { path: 'een.py', content: 'print(1)' })),
      ollamaToolResponse(toolCall('write-2', 'write_file', { path: 'twee.py', content: 'print(2)' })),
      ollamaTextResponse('De bestanden bestaan, maar zijn nog niet uitgevoerd.'),
      ollamaToolResponse(toolCall('run-1', 'run_command', { command: 'python een.py' })),
      ollamaTextResponse('Alleen het eerste script is uitgevoerd.'),
      ollamaToolResponse(toolCall('run-2', 'run_command', { command: 'python twee.py' })),
      ollamaTextResponse('Beide scripts zijn uitgevoerd.'),
      ollamaTextResponse('Gecontroleerd: beide scripts zijn gemaakt en uitgevoerd.'),
    ];
    const baseUrl = await serve((body, res) => {
      received.push(body);
      sendNdjson(res, replies[round++]);
    });
    const calls: string[] = [];

    const result = await runOllamaNative({
      baseUrl,
      model: 'tool-model',
      messages: [{ role: 'user', content: 'Maak twee scripts en voer ze allebei uit.' }],
      signal: new AbortController().signal,
      requireToolUse: true,
      supportsThinking: false,
      onDelta: () => {},
      executeTool: async (name) => {
        calls.push(name);
        return { ok: true, output: 'ok' };
      },
    });

    expect(calls).toEqual(['write_file', 'write_file', 'run_command', 'run_command']);
    expect(received[3].messages.at(-1).content).toContain('harde completion gate');
    expect(received[5].messages.at(-1).content).toContain('harde completion gate');
    expect(result.text).toContain('beide scripts');
  });

  it('voert tool_calls uit en bewaart toolresultaat en thinking in de vervolgronde', async () => {
    let round = 0;
    const received: any[] = [];
    const baseUrl = await serve((body, res) => {
      received.push(body);
      if (round++ === 0) {
        sendNdjson(res, {
          message: {
            role: 'assistant',
            content: 'Ik lees. ',
            thinking: 'Eerst het bestand lezen.',
            tool_calls: [toolCall('read-1', 'read_file', { path: 'a.txt' })],
          },
          done: true,
          prompt_eval_count: 10,
          eval_count: 2,
        });
      } else {
        sendNdjson(res, {
          message: { role: 'assistant', content: 'Klaar.' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 14,
          eval_count: 3,
        });
      }
    });
    const activities: NativeToolActivity[] = [];

    const result = await run(baseUrl, {
      onToolActivity: (activity) => activities.push(activity),
      executeTool: async (name, input) => ({ ok: true, output: `${name}:${input.path}=hallo` }),
    });

    // Tussennarratie die samen met een toolcall komt hoort niet als zichtbaar
    // eindantwoord tussen toolkaarten terecht te komen.
    expect(result.text).toBe('Klaar.');
    expect(result.inputTokens).toBe(38);
    expect(result.outputTokens).toBe(8);
    expect(activities.map((activity) => activity.phase)).toEqual(['requested', 'result']);
    expect(received[0].messages[0]).toMatchObject({ role: 'system' });
    expect(received[0].messages[0].content).toContain('errorCode');
    expect(received[0].think).toBe(false);
    expect(received[0].tools.map((tool: any) => tool.function.name)).toContain('run_command');
    expect(received[1].messages.find((message: any) => message.role === 'assistant')).toMatchObject({
      thinking: 'Eerst het bestand lezen.',
    });
    expect(JSON.parse(received[1].messages.at(-1).content)).toEqual({
      ok: true,
      output: 'read_file:a.txt=hallo',
    });
  });

  it('gebruikt live thinking-capability en herstelt eenmaal als een verplichte eerste toolcall ontbreekt', async () => {
    let round = 0;
    const received: any[] = [];
    const replies = [
      ollamaTextResponse('Ik zal een bestand voor je maken.'),
      ollamaToolResponse(toolCall('write-1', 'write_file', { path: 'a.py', content: 'print(1)' })),
      ollamaTextResponse('Het bestand is klaar.'),
      ollamaTextResponse('Gecontroleerd: het bestand is echt gemaakt.'),
    ];
    const baseUrl = await serve((body, res) => {
      received.push(body);
      sendNdjson(res, replies[round++]);
    });
    const calls: string[] = [];
    const deltas: string[] = [];

    const result = await runOllamaNative({
      baseUrl,
      model: 'tool-model',
      messages: [{ role: 'user', content: 'maak a.py' }],
      signal: new AbortController().signal,
      requireToolUse: true,
      supportsThinking: true,
      onDelta: (delta) => deltas.push(delta),
      executeTool: async (name) => {
        calls.push(name);
        return { ok: true, output: 'created a.py' };
      },
    });

    expect(calls).toEqual(['write_file']);
    expect(received[0].think).toBe(true);
    expect(received[1].think).toBe(true);
    expect(received[1].messages.at(-1).content).toContain('toolprotocol-herstel');
    expect(deltas.join('')).toBe('Gecontroleerd: het bestand is echt gemaakt.');
    expect(result.text).toBe('Gecontroleerd: het bestand is echt gemaakt.');
  });

  it('voert een identieke geslaagde call met een nieuwe id maar één keer uit', async () => {
    let round = 0;
    const received: any[] = [];
    const baseUrl = await serve((body, res) => {
      received.push(body);
      if (round < 3) {
        sendNdjson(res, ollamaToolResponse(toolCall(`run-${++round}`, 'run_command', {
          shell: 'powershell',
          command: 'python skyline.py',
        })));
      } else {
        round += 1;
        sendNdjson(res, ollamaTextResponse('Het commando is één keer uitgevoerd; duplicaten zijn gestopt.'));
      }
    });
    let executions = 0;

    const result = await run(baseUrl, {
      executeTool: async () => {
        executions += 1;
        return { ok: true, output: 'skyline uitgevoerd' };
      },
    });

    expect(executions).toBe(1);
    expect(received).toHaveLength(4);
    expect(JSON.parse(received[2].messages.at(-1).content)).toMatchObject({
      ok: false,
      errorCode: 'NO_PROGRESS_REPEAT',
      retryable: false,
    });
    expect(received[3].tools).toBeUndefined();
    expect(result.text).toContain('één keer uitgevoerd');
  });

  it('voert een identieke geslaagde write niet opnieuw uit na zijn eigen mutatie', async () => {
    let round = 0;
    const received: any[] = [];
    const sameWrite = { path: 'a.py', content: 'print(1)' };
    const baseUrl = await serve((body, res) => {
      received.push(body);
      if (round++ === 0) sendNdjson(res, ollamaToolResponse(toolCall('write-1', 'write_file', sameWrite)));
      else if (round === 2) sendNdjson(res, ollamaToolResponse(toolCall('write-2', 'write_file', sameWrite)));
      else sendNdjson(res, ollamaTextResponse('De identieke tweede write is terecht niet opnieuw uitgevoerd.'));
    });
    let executions = 0;

    const result = await run(baseUrl, {
      executeTool: async () => {
        executions += 1;
        return { ok: true, output: 'created a.py' };
      },
    });

    expect(executions).toBe(1);
    expect(JSON.parse(received[2].messages.at(-1).content)).toMatchObject({
      ok: false,
      errorCode: 'NO_PROGRESS_REPEAT',
    });
    expect(result.text).toContain('niet opnieuw uitgevoerd');
  });

  it('geeft na een mislukte exacte edit één gecachte herlezing terug', async () => {
    let round = 0;
    const replies = [
      ollamaToolResponse(toolCall('read-1', 'read_file', { path: 'a.py' })),
      ollamaToolResponse(toolCall('edit-1', 'edit_file', {
        path: 'a.py',
        old_text: 'verkeerd',
        new_text: 'goed',
      })),
      ollamaToolResponse(toolCall('read-2', 'read_file', { path: 'a.py' })),
      ollamaToolResponse(toolCall('edit-2', 'edit_file', {
        path: 'a.py',
        old_text: 'fout',
        new_text: 'goed',
      })),
      ollamaTextResponse('De edit is hersteld.'),
      ollamaTextResponse('Gecontroleerd: de edit is hersteld.'),
    ];
    const baseUrl = await serve((_body, res) => sendNdjson(res, replies[round++]));
    const calls: string[] = [];

    const result = await run(baseUrl, {
      executeTool: async (name, input) => {
        calls.push(name);
        if (name === 'read_file') return { ok: true, output: 'fout' };
        if (input.old_text === 'verkeerd') return { ok: false, output: '[geen wijziging] old_text niet gevonden' };
        return { ok: true, output: 'edited a.py' };
      },
    });

    expect(calls).toEqual(['read_file', 'edit_file', 'edit_file']);
    expect(result.text).toContain('hersteld');
  });

  it('laat hetzelfde testcommando na een echte bestandsmutatie opnieuw toe', async () => {
    let round = 0;
    const replies = [
      ollamaToolResponse(toolCall('run-1', 'run_command', { command: 'python skyline.py' })),
      ollamaToolResponse(toolCall('edit-1', 'edit_file', {
        path: 'skyline.py',
        old_text: 'print("🌟")',
        new_text: 'print("ster")',
      })),
      ollamaToolResponse(toolCall('run-2', 'run_command', { command: 'python skyline.py' })),
      ollamaTextResponse('Hersteld en opnieuw succesvol getest.'),
      ollamaTextResponse('Hersteld en opnieuw succesvol getest.'),
    ];
    const baseUrl = await serve((_body, res) => sendNdjson(res, replies[round++]));
    const calls: string[] = [];
    let runCount = 0;

    const result = await run(baseUrl, {
      executeTool: async (name) => {
        calls.push(name);
        if (name === 'run_command' && runCount++ === 0) return { ok: false, output: 'UnicodeEncodeError' };
        return { ok: true, output: name === 'run_command' ? 'ster' : 'edited' };
      },
    });

    expect(calls).toEqual(['run_command', 'edit_file', 'run_command']);
    expect(result.text).toBe('Hersteld en opnieuw succesvol getest.');
  });

  it('reserveert na twaalf uitvoerende rondes een dertiende toolvrije finalisatieronde', async () => {
    let round = 0;
    const received: any[] = [];
    const baseUrl = await serve((body, res) => {
      received.push(body);
      if (round < 12) {
        sendNdjson(res, ollamaToolResponse(toolCall(`read-${round}`, 'read_file', { path: `stap-${round++}.txt` })));
      } else {
        round += 1;
        sendNdjson(res, ollamaTextResponse('Twaalf stappen uitgevoerd; verdere stappen zijn veilig gestopt.'));
      }
    });
    let executions = 0;

    const result = await run(baseUrl, {
      executeTool: async () => {
        executions += 1;
        return { ok: true, output: 'gelezen' };
      },
    });

    expect(executions).toBe(12);
    expect(received).toHaveLength(13);
    expect(received[12].tools).toBeUndefined();
    expect(result.text).toContain('Twaalf stappen uitgevoerd');
  });

  it('vertaalt een executor-exception naar gestructureerde foutfeedback', async () => {
    let round = 0;
    const received: any[] = [];
    const baseUrl = await serve((body, res) => {
      received.push(body);
      sendNdjson(res, round++ === 0
        ? ollamaToolResponse(toolCall('bad-1', 'write_file', { path: '../buiten.txt', content: 'nee' }))
        : ollamaTextResponse('Het onveilige pad is niet geschreven.'));
    });

    const result = await run(baseUrl, {
      executeTool: async () => { throw new Error('Bestand valt buiten de projectmap'); },
    });

    expect(JSON.parse(received[1].messages.at(-1).content)).toMatchObject({
      ok: false,
      errorCode: 'TOOL_FAILED',
      retryable: true,
    });
    expect(result.text).toContain('niet geschreven');
  });

  it('stuurt begrensde output zonder ANSI- en controlcodes naar het model', async () => {
    let round = 0;
    const received: any[] = [];
    const baseUrl = await serve((body, res) => {
      received.push(body);
      sendNdjson(res, round++ === 0
        ? ollamaToolResponse(toolCall('ansi-1', 'run_command', { command: 'python kleur.py' }))
        : ollamaTextResponse('Uitvoer verwerkt.'));
    });

    await run(baseUrl, {
      executeTool: async () => ({ ok: true, output: `\u001b[31mrood\u001b[0m\u0000${'x'.repeat(60_000)}` }),
    });

    const output = JSON.parse(received[1].messages.at(-1).content).output as string;
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0000');
    expect(output).toContain('rood');
    expect(output).toContain('[tool-output voor model afgekapt]');
    expect(output.length).toBeLessThan(49_000);
  });

  it('start na een uitgevoerde tool geen provider-fallback maar rondt lokaal toolvrij af', async () => {
    let round = 0;
    const received: any[] = [];
    const baseUrl = await serve((body, res) => {
      received.push(body);
      if (round++ === 0) {
        sendNdjson(res, ollamaToolResponse(toolCall('write-1', 'write_file', {
          path: 'resultaat.txt',
          content: 'klaar',
        })));
      } else if (round === 2) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('tijdelijke providerfout');
      } else {
        sendNdjson(res, ollamaTextResponse('Het bestand is gemaakt; de vervolgrequest haperde.'));
      }
    });
    let executions = 0;

    const result = await run(baseUrl, {
      executeTool: async () => {
        executions += 1;
        return { ok: true, output: 'created resultaat.txt' };
      },
    });

    expect(executions).toBe(1);
    expect(received).toHaveLength(3);
    expect(received[2].tools).toBeUndefined();
    expect(received[2].messages.some((message: any) => message.role === 'tool')).toBe(true);
    expect(result.text).toContain('Het bestand is gemaakt');
  });

  it('voert toolcalls uit een onvolledige stream nooit uit', async () => {
    let executions = 0;
    const baseUrl = await serve((_body, res) => {
      sendNdjson(res, {
        message: { role: 'assistant', tool_calls: [toolCall('half-1', 'run_command', { command: 'Remove-Item gevaarlijk' })] },
        done: false,
      });
    });

    await expect(run(baseUrl, {
      executeTool: async () => {
        executions += 1;
        return { ok: true, output: 'mag niet gebeuren' };
      },
    })).rejects.toThrow('zonder een volledige done-respons');
    expect(executions).toBe(0);
  });

  it('verwerkt een laatste NDJSON-regel zonder newline en dedupliceert gestreamde call-id’s', async () => {
    let round = 0;
    const received: any[] = [];
    const baseUrl = await serve((body, res) => {
      received.push(body);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (round++ === 0) {
        res.write(JSON.stringify({
          message: {
            role: 'assistant',
            thinking: 'Eerst ',
            tool_calls: [toolCall('dup-1', 'read_file', { path: 'a.txt' })],
          },
          done: false,
        }) + '\n');
        res.end(JSON.stringify({
          message: {
            role: 'assistant',
            thinking: 'lezen.',
            tool_calls: [toolCall('dup-1', 'read_file', { path: 'a.txt' })],
          },
          done: true,
        }));
      } else {
        res.end(JSON.stringify(ollamaTextResponse('Klaar zonder trailing newline.')));
      }
    });
    let executions = 0;

    const result = await run(baseUrl, {
      executeTool: async () => {
        executions += 1;
        return { ok: true, output: 'hallo' };
      },
    });

    expect(executions).toBe(1);
    expect(result.text).toBe('Klaar zonder trailing newline.');
    expect(received[1].messages.find((message: any) => message.role === 'assistant')).toMatchObject({
      thinking: 'Eerst lezen.',
    });
  });
});

async function run(
  baseUrl: string,
  overrides: {
    executeTool?: NativeToolExecutor;
    onToolActivity?: (activity: NativeToolActivity) => void;
  } = {},
) {
  return runOllamaNative({
    baseUrl,
    model: 'tool-model',
    messages: [{ role: 'user', content: 'voer de taak uit' }],
    signal: new AbortController().signal,
    onDelta: () => {},
    executeTool: overrides.executeTool || (async () => ({ ok: true, output: 'ok' })),
    onToolActivity: overrides.onToolActivity,
  });
}

async function serve(handler: (body: any, response: http.ServerResponse) => void) {
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => raw += chunk);
    request.on('end', () => handler(JSON.parse(raw), response));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

function sendNdjson(response: http.ServerResponse, payload: unknown) {
  response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  response.end(`${JSON.stringify(payload)}\n`);
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, function: { name, arguments: args } };
}

function ollamaToolResponse(call: ReturnType<typeof toolCall>) {
  return { message: { role: 'assistant', content: '', tool_calls: [call] }, done: true, done_reason: 'stop' };
}

function ollamaTextResponse(text: string) {
  return { message: { role: 'assistant', content: text }, done: true, done_reason: 'stop' };
}
