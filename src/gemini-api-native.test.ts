import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { runGeminiApiNative } from '../electron/gemini-api-native';
import type { NativeToolActivity } from '../electron/native-tools';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('Gemini API native tools', () => {
  it('bewaart function calls en thought signatures en stuurt toolresultaten terug', async () => {
    let round = 0;
    const received: any[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (round++ === 0) {
          res.end(sse({
            candidates: [{
              content: {
                role: 'model',
                parts: [
                  { text: 'Ik voer het uit. ' },
                  {
                    functionCall: { id: 'call-1', name: 'run_command', args: { command: 'Write-Output hallo', shell: 'powershell' } },
                    thoughtSignature: 'handtekening-1',
                  },
                ],
              },
            }],
            usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3 },
          }));
        } else {
          res.end(sse({
            candidates: [{ content: { role: 'model', parts: [{ text: 'Klaar.' }] } }],
            usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 4 },
          }));
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const apiBaseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1beta`;
    const activities: NativeToolActivity[] = [];
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];

    const result = await runGeminiApiNative({
      apiKey: 'test-key',
      apiBaseUrl,
      model: 'gemini-test',
      contents: [{ role: 'user', parts: [{ text: 'Voer het commando uit.' }] }],
      signal: new AbortController().signal,
      onDelta: () => {},
      onToolActivity: (activity) => activities.push(activity),
      executeTool: async (name, input) => {
        calls.push({ name, input });
        return { ok: true, output: 'hallo' };
      },
    });

    expect(result).toEqual({ text: 'Ik voer het uit. Klaar.', inputTokens: 28, outputTokens: 7 });
    expect(calls).toEqual([{ name: 'run_command', input: { command: 'Write-Output hallo', shell: 'powershell' } }]);
    expect(activities.map((activity) => activity.phase)).toEqual(['requested', 'result']);
    expect(received[0].tools[0].functionDeclarations.map((tool: any) => tool.name)).toEqual([
      'read_file', 'write_file', 'edit_file', 'run_command',
    ]);
    expect(received[0].toolConfig.functionCallingConfig.mode).toBe('AUTO');
    expect(received[0].systemInstruction.parts.at(-1).text).toContain('response.ok');
    expect(received[1].contents.at(-2)).toEqual({
      role: 'model',
      parts: [
        { text: 'Ik voer het uit. ' },
        {
          functionCall: { id: 'call-1', name: 'run_command', args: { command: 'Write-Output hallo', shell: 'powershell' } },
          thoughtSignature: 'handtekening-1',
        },
      ],
    });
    expect(received[1].contents.at(-1)).toEqual({
      role: 'user',
      parts: [{ functionResponse: { id: 'call-1', name: 'run_command', response: { ok: true, output: 'hallo' } } }],
    });
  });

  it('stuurt parallelle function responses samen terug en markeert weigeringen', async () => {
    let round = 0;
    const received: any[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse(round++ === 0
          ? {
              candidates: [{ content: { role: 'model', parts: [
                { functionCall: { id: 'a', name: 'read_file', args: { path: 'a.txt' } } },
                { functionCall: { id: 'b', name: 'read_file', args: { path: 'b.txt' } } },
              ] } }],
            }
          : { candidates: [{ content: { role: 'model', parts: [{ text: 'Afgerond.' }] } }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const activities: NativeToolActivity[] = [];

    const result = await runGeminiApiNative({
      apiKey: 'test-key',
      apiBaseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1beta`,
      model: 'gemini-test',
      contents: [{ role: 'user', parts: [{ text: 'Lees beide.' }] }],
      signal: new AbortController().signal,
      onDelta: () => {},
      onToolActivity: (activity) => activities.push(activity),
      executeTool: async (_name, input) => input.path === 'b.txt'
        ? { ok: false, output: '[geweigerd door gebruiker]', denied: true }
        : { ok: true, output: 'a' },
    });

    expect(result.text).toBe('Afgerond.');
    expect(activities.map((activity) => activity.phase)).toEqual(['requested', 'result', 'requested', 'denied']);
    expect(received[1].contents.at(-1).parts.filter((part: any) => part.functionResponse)).toHaveLength(2);
    expect(received[1].contents.at(-1).parts[1].functionResponse.response).toEqual({
      ok: false,
      output: '[geweigerd door gebruiker]',
      error: '[geweigerd door gebruiker]',
      errorCode: 'USER_DENIED',
      retryable: false,
      instruction: 'Vraag geen nieuwe PC-toolactie; leg in het eindantwoord uit dat toestemming ontbrak.',
    });
    expect(received[1].toolConfig.functionCallingConfig.mode).toBe('NONE');
  });

  it('voert een identieke mislukte toolcall niet eindeloos opnieuw uit en dwingt een eindantwoord af', async () => {
    let round = 0;
    const received: any[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (round++ < 3) {
          res.end(sse({ candidates: [{ content: { role: 'model', parts: [{
            functionCall: {
              id: `run-${round}`,
              name: 'run_command',
              args: { shell: 'powershell', command: 'python skyline.py' },
            },
          }] } }] }));
        } else {
          res.end(sse({ candidates: [{
            content: { role: 'model', parts: [{ text: 'Het script faalde; ik heb dat eerlijk gerapporteerd.' }] },
            finishReason: 'STOP',
          }] }));
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    let executions = 0;

    const result = await runGeminiApiNative({
      apiKey: 'test-key',
      apiBaseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1beta`,
      model: 'gemini-test',
      contents: [{ role: 'user', parts: [{ text: 'Maak en test een skyline.' }] }],
      signal: new AbortController().signal,
      onDelta: () => {},
      executeTool: async () => {
        executions += 1;
        return { ok: false, output: 'UnicodeEncodeError: cp1252 kan dit teken niet coderen' };
      },
    });

    expect(executions).toBe(1);
    expect(received).toHaveLength(4);
    expect(received[2].contents.at(-1).parts[0].functionResponse.response).toMatchObject({
      ok: false,
      errorCode: 'NO_PROGRESS_REPEAT',
      retryable: false,
    });
    expect(received[3].toolConfig.functionCallingConfig.mode).toBe('NONE');
    expect(result.text).toContain('Het script faalde');
  });

  it('voert een identieke geslaagde call met een nieuwe provider-id maar één keer uit', async () => {
    let round = 0;
    const received: any[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (round++ < 3) {
          res.end(sse(functionCall(`run-${round}`, 'run_command', {
            shell: 'powershell',
            command: 'python skyline.py',
          })));
        } else {
          res.end(sse({ candidates: [{
            content: { role: 'model', parts: [{ text: 'Het commando is één keer uitgevoerd; duplicaten zijn gestopt.' }] },
            finishReason: 'STOP',
          }] }));
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    let executions = 0;

    const result = await runGeminiApiNative({
      apiKey: 'test-key',
      apiBaseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1beta`,
      model: 'gemini-test',
      contents: [{ role: 'user', parts: [{ text: 'Voer het commando uit.' }] }],
      signal: new AbortController().signal,
      onDelta: () => {},
      executeTool: async () => {
        executions += 1;
        return { ok: true, output: 'skyline uitgevoerd' };
      },
    });

    expect(executions).toBe(1);
    expect(received).toHaveLength(4);
    expect(received[2].contents.at(-1).parts[0].functionResponse.response).toMatchObject({
      ok: false,
      errorCode: 'NO_PROGRESS_REPEAT',
      retryable: false,
    });
    expect(received[3].toolConfig.functionCallingConfig.mode).toBe('NONE');
    expect(result.text).toContain('één keer uitgevoerd');
  });

  it('laat hetzelfde testcommando opnieuw toe nadat een bestand werkelijk is hersteld', async () => {
    let round = 0;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const payloads = [
        functionCall('run-1', 'run_command', { command: 'python skyline.py' }),
        functionCall('edit-1', 'edit_file', { path: 'skyline.py', old_text: 'print("🌟")', new_text: 'print("ster")' }),
        functionCall('run-2', 'run_command', { command: 'python skyline.py' }),
        { candidates: [{ content: { role: 'model', parts: [{ text: 'Hersteld en succesvol getest.' }] }, finishReason: 'STOP' }] },
      ];
      res.end(sse(payloads[round++]));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const calls: string[] = [];
    let runCount = 0;

    const result = await runGeminiApiNative({
      apiKey: 'test-key',
      apiBaseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1beta`,
      model: 'gemini-test',
      contents: [{ role: 'user', parts: [{ text: 'Herstel het script.' }] }],
      signal: new AbortController().signal,
      onDelta: () => {},
      executeTool: async (name) => {
        calls.push(name);
        if (name === 'run_command' && runCount++ === 0) return { ok: false, output: 'UnicodeEncodeError' };
        return { ok: true, output: name === 'run_command' ? 'ster' : 'edited' };
      },
    });

    expect(calls).toEqual(['run_command', 'edit_file', 'run_command']);
    expect(result.text).toBe('Hersteld en succesvol getest.');
  });

  it('reserveert na acht echte toolrondes altijd nog een toolvrije finalisatieronde', async () => {
    let round = 0;
    const received: any[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (round < 8) {
          res.end(sse(functionCall(`read-${round}`, 'read_file', { path: `stap-${round++}.txt` })));
        } else {
          round += 1;
          res.end(sse({ candidates: [{
            content: { role: 'model', parts: [{ text: 'Acht stappen uitgevoerd; verdere stappen zijn veilig gestopt.' }] },
            finishReason: 'STOP',
          }] }));
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    let executions = 0;

    const result = await runGeminiApiNative({
      apiKey: 'test-key',
      apiBaseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1beta`,
      model: 'gemini-test',
      contents: [{ role: 'user', parts: [{ text: 'Voer veel stappen uit.' }] }],
      signal: new AbortController().signal,
      onDelta: () => {},
      executeTool: async () => {
        executions += 1;
        return { ok: true, output: 'gelezen' };
      },
    });

    expect(executions).toBe(8);
    expect(received).toHaveLength(9);
    expect(received[8].toolConfig.functionCallingConfig.mode).toBe('NONE');
    expect(result.text).toContain('Acht stappen uitgevoerd');
  });

  it('vertaalt een exception uit de app-tool naar foutfeedback zodat Gemini kan afronden', async () => {
    let round = 0;
    const received: any[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse(round++ === 0
          ? functionCall('bad-1', 'write_file', { path: '../buiten.txt', content: 'nee' })
          : { candidates: [{ content: { role: 'model', parts: [{ text: 'Het pad werd terecht geweigerd.' }] }, finishReason: 'STOP' }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    const result = await runGeminiApiNative({
      apiKey: 'test-key',
      apiBaseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1beta`,
      model: 'gemini-test',
      contents: [{ role: 'user', parts: [{ text: 'Schrijf een bestand.' }] }],
      signal: new AbortController().signal,
      onDelta: () => {},
      executeTool: async () => { throw new Error('Bestand valt buiten de projectmap'); },
    });

    expect(received[1].contents.at(-1).parts[0].functionResponse.response).toMatchObject({
      ok: false,
      errorCode: 'TOOL_FAILED',
      retryable: true,
    });
    expect(result.text).toBe('Het pad werd terecht geweigerd.');
  });

  it('stuurt begrensde terminaluitvoer zonder ANSI- of onveilige controlcodes naar het model', async () => {
    let round = 0;
    const received: any[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse(round++ === 0
          ? functionCall('ansi-1', 'run_command', { command: 'python kleur.py' })
          : { candidates: [{ content: { role: 'model', parts: [{ text: 'Uitvoer verwerkt.' }] }, finishReason: 'STOP' }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    await runGeminiApiNative({
      apiKey: 'test-key',
      apiBaseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1beta`,
      model: 'gemini-test',
      contents: [{ role: 'user', parts: [{ text: 'Test kleuren.' }] }],
      signal: new AbortController().signal,
      onDelta: () => {},
      executeTool: async () => ({ ok: true, output: `\u001b[31mrood\u001b[0m\u0000${'x'.repeat(60_000)}` }),
    });

    const output = received[1].contents.at(-1).parts[0].functionResponse.response.output as string;
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0000');
    expect(output).toContain('rood');
    expect(output).toContain('[tool-output voor model afgekapt]');
    expect(output.length).toBeLessThan(49_000);
  });

  it('start na uitgevoerde tools geen gevaarlijke provider-fallback maar bewaart de beurt via een afsluitronde', async () => {
    let round = 0;
    const received: any[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        received.push(JSON.parse(body));
        if (round++ === 1) {
          res.writeHead(503, { 'content-type': 'text/plain' });
          res.end('tijdelijke providerfout');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse(round === 1
          ? functionCall('write-1', 'write_file', { path: 'resultaat.txt', content: 'klaar' })
          : { candidates: [{ content: { role: 'model', parts: [{ text: 'Het bestand is gemaakt; de vervolgrequest haperde.' }] }, finishReason: 'STOP' }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    let executions = 0;

    const result = await runGeminiApiNative({
      apiKey: 'test-key',
      apiBaseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1beta`,
      model: 'gemini-test',
      contents: [{ role: 'user', parts: [{ text: 'Maak een bestand.' }] }],
      signal: new AbortController().signal,
      onDelta: () => {},
      executeTool: async () => {
        executions += 1;
        return { ok: true, output: 'created resultaat.txt' };
      },
    });

    expect(executions).toBe(1);
    expect(received).toHaveLength(3);
    expect(received[2].toolConfig.functionCallingConfig.mode).toBe('NONE');
    expect(received[2].contents.some((content: any) => content.parts.some((part: any) => part.functionResponse))).toBe(true);
    expect(result.text).toContain('Het bestand is gemaakt');
  });

  it('accepteert een geblokkeerde of lege providerrespons nooit stil als succes', async () => {
    let requests = 0;
    const deltas: string[] = [];
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse({
        promptFeedback: { blockReason: 'SAFETY' },
        candidates: [{ finishReason: 'SAFETY', finishMessage: 'Geblokkeerd door veiligheidsfilter.' }],
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    const result = await runGeminiApiNative({
      apiKey: 'test-key',
      apiBaseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1beta`,
      model: 'gemini-test',
      contents: [{ role: 'user', parts: [{ text: 'Test.' }] }],
      signal: new AbortController().signal,
      onDelta: (delta) => deltas.push(delta),
      executeTool: async () => ({ ok: true, output: '' }),
    });

    expect(requests).toBe(1);
    expect(result.text).toContain('Gemini blokkeerde de prompt (SAFETY)');
    expect(deltas.join('')).toContain('niet volledig afronden');
  });

  it('voert een function call uit een afgekapt providerantwoord niet uit', async () => {
    let requests = 0;
    let executions = 0;
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(requests === 1
        ? {
            candidates: [{
              content: { role: 'model', parts: [{ functionCall: { id: 'half', name: 'run_command', args: { command: 'Remove-Item' } } }] },
              finishReason: 'MAX_TOKENS',
            }],
          }
        : { candidates: [{ content: { role: 'model', parts: [{ text: 'De afgekorte actie is niet uitgevoerd.' }] }, finishReason: 'STOP' }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    const result = await runGeminiApiNative({
      apiKey: 'test-key',
      apiBaseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1beta`,
      model: 'gemini-test',
      contents: [{ role: 'user', parts: [{ text: 'Test afkapping.' }] }],
      signal: new AbortController().signal,
      onDelta: () => {},
      executeTool: async () => {
        executions += 1;
        return { ok: true, output: 'mag niet gebeuren' };
      },
    });

    expect(executions).toBe(0);
    expect(requests).toBe(2);
    expect(result.text).toContain('niet uitgevoerd');
  });
});

function functionCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    candidates: [{ content: { role: 'model', parts: [{ functionCall: { id, name, args } }] } }],
  };
}

function sse(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
