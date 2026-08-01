import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const mainEntry = path.join(root, 'dist-electron', 'main.js');
const rendererEntry = path.join(root, 'dist', 'index.html');
const outputDir = path.join(root, 'docs', 'assets', 'readme');
const profileDir = path.join(root, '.tmp-readme-profile');
const recordingDir = path.join(root, '.tmp-readme-recording');
const debugPort = 9333;
const liveChatRecording = process.argv.includes('--live-chat');
const chatDemo = {
  chatId: 'readme-chat-demo',
  title: 'Why use multiple AI models?',
  modelId: 'Claude Opus 4.6 · Thinking',
  prompt: 'In two short sentences, explain how using multiple AI models in one workspace can help a developer.',
  response: "Using multiple AI models lets a developer leverage each model's strengths—such as pairing a fast, lightweight model for quick lookups with a more powerful one for complex reasoning or large refactors. This flexibility reduces cost and latency on simple tasks while still delivering deep, high-quality analysis when the problem demands it.",
};

for (const requiredPath of [electronExecutable, mainEntry, rendererEntry]) {
  if (!existsSync(requiredPath)) {
    throw new Error(`Ontbrekend buildbestand: ${requiredPath}. Voer eerst npm run build uit.`);
  }
}

await rm(profileDir, { recursive: true, force: true });
await mkdir(profileDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

const electron = spawn(
  electronExecutable,
  [`--remote-debugging-port=${debugPort}`, mainEntry],
  {
    cwd: root,
    env: {
      ...process.env,
      AI_SUPERAPP_TEST_USER_DATA_DIR: profileDir,
      VITE_DEV_SERVER_URL: '',
    },
    stdio: 'ignore',
    windowsHide: true,
  },
);

let cdp;

try {
  const target = await waitForTarget();
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.bringToFront');
  await waitForText(cdp, 'Hallo, welkom bij LLMelt');

  await capture(cdp, 'welcome.png');

  await clickButton(cdp, 'Beginnen');
  await waitForText(cdp, "Al je LLM's op één plek");
  await capture(cdp, 'providers.png');

  await clickButton(cdp, 'Controleer deze pc');
  await waitForText(cdp, 'Dit is al gevonden', 30_000);
  await capture(cdp, 'provider-check.png');

  await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector('[aria-label="Overslaan"]')?.click()`,
  });
  await waitForText(cdp, 'Nieuw gesprek');
  await cdp.send('Runtime.evaluate', {
    expression: `window.electronAPI?.settings.set('onboarding.completedAt', new Date().toISOString())`,
    awaitPromise: true,
  });
  await capture(cdp, 'workspace.png');

  const chatGifCreated = liveChatRecording
    ? await captureLiveChatDemo(cdp)
    : await captureChatDemo(cdp).then(() => false);

  const gifCreated = generateTourGif();
  const generatedGifs = [gifCreated && 'tour.gif', chatGifCreated && 'chat-demo.gif'].filter(Boolean);
  process.stdout.write(`README-assets opgeslagen in ${outputDir}${generatedGifs.length ? ` (inclusief ${generatedGifs.join(' en ')})` : ''}\n`);
} finally {
  cdp?.close();
  electron.kill();
  await new Promise((resolve) => setTimeout(resolve, 800));
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

async function waitForTarget(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const target = targets.find((candidate) =>
        candidate.type === 'page' && /LLMelt|index\.html/i.test(`${candidate.title} ${candidate.url}`));
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Electron is nog aan het opstarten.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('De geïsoleerde LLMelt-renderer werd niet op tijd gevonden.');
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const eventListeners = new Map();
  let requestId = 0;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP-verbinding kon niet worden geopend.')), { once: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) {
      for (const listener of eventListeners.get(message.method) || []) listener(message.params || {});
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });

  return {
    send(method, params = {}) {
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
    on(method, listener) {
      const listeners = eventListeners.get(method) || new Set();
      listeners.add(listener);
      eventListeners.set(method, listeners);
      return () => listeners.delete(listener);
    },
  };
}

async function waitForText(client, text, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.send('Runtime.evaluate', {
      expression: `document.body?.innerText.includes(${JSON.stringify(text)}) === true`,
      returnByValue: true,
    });
    if (result.result?.value === true) {
      await new Promise((resolve) => setTimeout(resolve, 650));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Tekst niet gevonden in de renderer: ${text}`);
}

async function clickButton(client, text) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim().includes(${JSON.stringify(text)}));
      if (!button) return false;
      button.click();
      return true;
    })()`,
    returnByValue: true,
  });
  if (result.result?.value !== true) throw new Error(`Knop niet gevonden: ${text}`);
}

async function waitForSelector(client, selector, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.send('Runtime.evaluate', {
      expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      returnByValue: true,
    });
    if (result.result?.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Element niet gevonden in de renderer: ${selector}`);
}

async function clickSelector(client, selector) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`,
    returnByValue: true,
  });
  if (result.result?.value !== true) throw new Error(`Element kon niet worden aangeklikt: ${selector}`);
}

async function clickText(client, selector, text) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)});
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`,
    returnByValue: true,
  });
  if (result.result?.value !== true) throw new Error(`Tekst kon niet worden aangeklikt: ${text}`);
}

async function fillInput(client, selector, value) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      setter?.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.focus();
      return true;
    })()`,
    returnByValue: true,
  });
  if (result.result?.value !== true) throw new Error(`Veld kon niet worden ingevuld: ${selector}`);
}

async function chooseCompositeOption(client, sectionName, fieldLabel, optionLabel, optional = false) {
  const triggerResult = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const section = [...document.querySelectorAll('.model-provider-section')]
        .find((candidate) => candidate.querySelector('.provider-label')?.textContent?.includes(${JSON.stringify(sectionName)}));
      const label = section && [...section.querySelectorAll('.field-label')]
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(fieldLabel)});
      const trigger = label?.parentElement?.querySelector('.select-trigger');
      if (!(trigger instanceof HTMLElement)) return false;
      trigger.click();
      return true;
    })()`,
    returnByValue: true,
  });
  if (triggerResult.result?.value !== true) {
    if (optional) return false;
    throw new Error(`Dropdown niet gevonden: ${sectionName} / ${fieldLabel}`);
  }

  await waitForSelector(client, '[role="listbox"]');
  const optionResult = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const option = [...document.querySelectorAll('[role="option"]')]
        .find((candidate) => candidate.querySelector('.select-option-label')?.textContent?.trim().startsWith(${JSON.stringify(optionLabel)}));
      if (!(option instanceof HTMLElement)) return false;
      option.click();
      return true;
    })()`,
    returnByValue: true,
  });
  if (optionResult.result?.value !== true) {
    if (optional) return false;
    throw new Error(`Dropdownoptie niet gevonden: ${fieldLabel} = ${optionLabel}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  return true;
}

async function captureLiveChatDemo(client) {
  await installDemoCursor(client);
  const recording = await startScreencastRecording(client);
  try {
    await pause(900);
    await visualClickText(client, 'button', 'Nieuw gesprek');
    await waitForSelector(client, '.chat-input-textarea');
    await waitForSelector(client, '.composer-model-chip:not(:disabled)', 30_000);
    await pause(700);
    await capture(client, 'chat-start.png');

    await visualClickSelector(client, '.composer-model-chip');
    await waitForSelector(client, '.model-selector-panel');
    await visualType(client, '.model-selector-search input', 'Antigravity', 70);
    await waitForText(client, 'Gebruik Antigravity');
    await pause(650);
    await capture(client, 'chat-model-picker.png');

    await visualChooseCompositeOption(client, 'Antigravity', 'Provider', 'Claude');
    await visualChooseCompositeOption(client, 'Antigravity', 'Model', 'Opus 4.6');
    await visualChooseCompositeOption(client, 'Antigravity', 'Stand', 'Thinking', true);
    await pause(650);
    await capture(client, 'chat-model-selected.png');

    await visualClickText(client, 'button', 'Gebruik Antigravity');
    await waitForSelector(client, '.chat-input-textarea');
    await pause(500);
    await visualType(client, '.chat-input-textarea', chatDemo.prompt, 27);
    await pause(800);
    await capture(client, 'chat-prompt.png');

    await visualClickSelector(client, '.btn-send');
    await waitForSelector(client, '.message.is-assistant', 45_000);
    await waitForSelector(client, '.message.is-assistant .message-copy-btn', 150_000);
    await pause(2_500);
    await capture(client, 'chat-response.png');
  } finally {
    await recording.stop();
  }

  const created = await renderChatRecordingGif(recording.frames);
  await rm(recordingDir, { recursive: true, force: true });
  return created;
}

async function installDemoCursor(client) {
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      document.getElementById('readme-demo-cursor')?.remove();
      const style = document.createElement('style');
      style.id = 'readme-demo-cursor-style';
      style.textContent = ` + "`" + `
        #readme-demo-cursor {
          position: fixed; left: 0; top: 0; z-index: 2147483647; width: 27px; height: 34px;
          pointer-events: none; transform: translate(1040px, 650px);
          transition: transform 340ms cubic-bezier(.22,.8,.25,1); filter: drop-shadow(0 2px 4px #000a);
        }
        #readme-demo-cursor svg { display: block; width: 100%; height: 100%; }
        .readme-demo-click {
          position: fixed; z-index: 2147483646; width: 12px; height: 12px; border-radius: 999px;
          border: 2px solid #20c9ff; pointer-events: none; transform: translate(-50%, -50%);
          animation: readme-demo-click 520ms ease-out forwards;
        }
        @keyframes readme-demo-click { from { opacity: .95; width: 12px; height: 12px; } to { opacity: 0; width: 48px; height: 48px; } }
      ` + "`" + `;
      document.getElementById(style.id)?.remove();
      document.head.appendChild(style);
      const cursor = document.createElement('div');
      cursor.id = 'readme-demo-cursor';
      cursor.innerHTML = '<svg viewBox="0 0 27 34" aria-hidden="true"><path d="M2 2 22 18l-9 1 5 10-5 3-5-11-6 7Z" fill="#fff" stroke="#09111f" stroke-width="2.2" stroke-linejoin="round"/></svg>';
      document.body.appendChild(cursor);
      return true;
    })()`,
    returnByValue: true,
  });
}

async function visualClickSelector(client, selector) {
  return visualClickExpression(client, `document.querySelector(${JSON.stringify(selector)})`, selector);
}

async function visualClickText(client, selector, text, startsWith = false) {
  const normalizedText = JSON.stringify(text.replace(/\s+/g, ' ').trim());
  const comparison = startsWith
    ? `candidate.textContent?.replace(/\\s+/g, ' ').trim().startsWith(${normalizedText})`
    : `candidate.textContent?.replace(/\\s+/g, ' ').trim().includes(${normalizedText})`;
  return visualClickExpression(
    client,
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find((candidate) => ${comparison})`,
    text,
  );
}

async function visualClickExpression(client, elementExpression, label) {
  const pointResult = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const element = ${elementExpression};
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
    returnByValue: true,
  });
  const point = pointResult.result?.value;
  if (!point) throw new Error(`Opname-element niet gevonden: ${label}`);

  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const cursor = document.getElementById('readme-demo-cursor');
      if (cursor) cursor.style.transform = 'translate(${Math.round(point.x)}px, ${Math.round(point.y)}px)';
    })()`,
  });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await pause(430);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const pulse = document.createElement('span');
      pulse.className = 'readme-demo-click';
      pulse.style.left = '${point.x}px'; pulse.style.top = '${point.y}px';
      document.body.appendChild(pulse);
      setTimeout(() => pulse.remove(), 600);
    })()`,
  });
  await pause(330);
  return true;
}

async function visualType(client, selector, value, delayMs) {
  await visualClickSelector(client, selector);
  for (const character of value) {
    await client.send('Input.insertText', { text: character });
    await pause(delayMs + (character === ' ' ? 14 : 0));
  }
}

async function visualChooseCompositeOption(client, sectionName, fieldLabel, optionLabel, optional = false) {
  const triggerExpression = `(() => {
    const section = [...document.querySelectorAll('.model-provider-section')]
      .find((candidate) => candidate.querySelector('.provider-label')?.textContent?.includes(${JSON.stringify(sectionName)}));
    const label = section && [...section.querySelectorAll('.field-label')]
      .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(fieldLabel)});
    return label?.parentElement?.querySelector('.select-trigger') || null;
  })()`;
  const present = await client.send('Runtime.evaluate', {
    expression: `Boolean(${triggerExpression})`,
    returnByValue: true,
  });
  if (!present.result?.value) {
    if (optional) return false;
    throw new Error(`Opname-dropdown niet gevonden: ${sectionName} / ${fieldLabel}`);
  }
  await visualClickExpression(client, triggerExpression, `${sectionName} / ${fieldLabel}`);
  await waitForSelector(client, '[role="listbox"]');
  await visualClickExpression(
    client,
    `[...document.querySelectorAll('[role="option"] .select-option-label')]
      .find((candidate) => candidate.textContent?.trim().startsWith(${JSON.stringify(optionLabel)}))`,
    `${fieldLabel} = ${optionLabel}`,
  );
  await pause(300);
  return true;
}

async function startScreencastRecording(client) {
  await rm(recordingDir, { recursive: true, force: true });
  await mkdir(recordingDir, { recursive: true });
  const frames = [];
  let index = 0;
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const startedAt = Date.now();
      const screenshot = await client.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 82,
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const framePath = path.join(recordingDir, `frame-${String(index++).padStart(5, '0')}.jpg`);
      frames.push({ path: framePath, timestamp: Date.now() / 1000 });
      await writeFile(framePath, Buffer.from(screenshot.data, 'base64'));
      await pause(Math.max(0, 100 - (Date.now() - startedAt)));
    }
  })();

  return {
    frames,
    async stop() {
      await pause(700);
      stopped = true;
      await loop;
      if (frames.length < 10) throw new Error(`Te weinig opnameframes ontvangen: ${frames.length}`);
    },
  };
}

async function renderChatRecordingGif(frames) {
  const concatPath = path.join(recordingDir, 'frames.ffconcat');
  const lines = ['ffconcat version 1.0'];
  for (let index = 0; index < frames.length; index += 1) {
    const current = frames[index];
    const next = frames[index + 1];
    const duration = next
      ? Math.max(0.025, Math.min(2.5, next.timestamp - current.timestamp))
      : 3;
    lines.push(`file '${current.path.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`);
    lines.push(`duration ${duration.toFixed(4)}`);
  }
  lines.push(`file '${frames.at(-1).path.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`);
  await writeFile(concatPath, `${lines.join('\n')}\n`, 'utf8');

  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-filter_complex',
    '[0:v]fps=10,scale=960:-2:flags=lanczos,split[s0][s1];' +
      '[s0]palettegen=max_colors=112:stats_mode=diff[p];' +
      '[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-loop', '0', path.join(outputDir, 'chat-demo.gif'),
  ], { cwd: root, stdio: 'ignore', windowsHide: true });
  if (result.status !== 0) throw new Error('ffmpeg kon de vloeiende chatopname niet naar GIF omzetten.');
  return true;
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function captureChatDemo(client) {
  await clickButton(client, 'Nieuw gesprek');
  await waitForSelector(client, '.chat-input-textarea');
  await waitForSelector(client, '.composer-model-chip:not(:disabled)');
  await capture(client, 'chat-start.png');

  await selectAntigravityInComposer(client, true);
  await waitForSelector(client, '.chat-input-textarea');
  await fillInput(
    client,
    '.chat-input-textarea',
    chatDemo.prompt,
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  await capture(client, 'chat-prompt.png');

  await seedChatDemo(client);
  await selectAntigravityInComposer(client, false);
  await capture(client, 'chat-response.png');
}

async function selectAntigravityInComposer(client, captureSteps) {
  await clickSelector(client, '.composer-model-chip');
  await waitForSelector(client, '.model-selector-panel');
  await fillInput(client, '.model-selector-search input', 'Antigravity');
  await waitForText(client, 'Gebruik Antigravity');
  if (captureSteps) await capture(client, 'chat-model-picker.png');

  await chooseCompositeOption(client, 'Antigravity', 'Provider', 'Claude');
  await chooseCompositeOption(client, 'Antigravity', 'Model', 'Opus 4.6');
  await chooseCompositeOption(client, 'Antigravity', 'Stand', 'Thinking', true);
  if (captureSteps) await capture(client, 'chat-model-selected.png');

  await clickButton(client, 'Gebruik Antigravity');
  await waitForSelector(client, '.chat-input-textarea');
  await new Promise((resolve) => setTimeout(resolve, 350));
}

async function seedChatDemo(client) {
  const now = Date.now();
  const chat = {
    id: chatDemo.chatId,
    title: chatDemo.title,
    activeModelId: 'Claude-opus-4-6-thinking',
    activeProvider: 'antigravity',
  };
  const messages = [
    {
      id: 'readme-chat-demo-user',
      chatId: chatDemo.chatId,
      role: 'user',
      content: chatDemo.prompt,
      modelId: chatDemo.modelId,
      provider: 'antigravity',
      inputTokens: 23,
      outputTokens: 0,
      createdAt: new Date(now - 1_000).toISOString(),
    },
    {
      id: 'readme-chat-demo-assistant',
      chatId: chatDemo.chatId,
      role: 'assistant',
      content: chatDemo.response,
      modelId: chatDemo.modelId,
      provider: 'antigravity',
      inputTokens: 23,
      outputTokens: 66,
      createdAt: new Date(now).toISOString(),
    },
  ];
  const result = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const api = window.electronAPI?.db;
      if (!api) return { ok: false, error: 'database-bridge ontbreekt' };
      try {
        await api.createChat(${JSON.stringify(chat.title)}, undefined, ${JSON.stringify(chat.id)});
        await api.updateChat(${JSON.stringify(chat.id)}, ${JSON.stringify({
          activeModelId: chat.activeModelId,
          activeProvider: chat.activeProvider,
          activeRunConfig: {
            antigravityProvider: 'Claude',
            antigravityModel: 'Opus 4.6',
            antigravityMode: 'Thinking',
          },
        })});
        for (const message of ${JSON.stringify(messages)}) await api.addMessage(message);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = result.result?.value;
  if (!value?.ok) throw new Error(`README-chat kon niet worden voorbereid: ${value?.error || 'onbekende fout'}`);

  await client.send('Page.reload', { ignoreCache: true });
  await waitForText(client, chatDemo.title, 20_000);
  await clickText(client, '.chat-item-title', chatDemo.title);
  await waitForText(client, chatDemo.response.slice(0, 70), 20_000);
  await new Promise((resolve) => setTimeout(resolve, 850));
}

async function capture(client, filename) {
  const screenshot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(path.join(outputDir, filename), Buffer.from(screenshot.data, 'base64'));
}

function generateTourGif() {
  const inputs = ['welcome.png', 'providers.png', 'provider-check.png'];
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const input of inputs) {
    args.push('-loop', '1', '-t', '2', '-i', path.join(outputDir, input));
  }
  args.push(
    '-filter_complex',
    '[0:v]scale=960:-2:flags=lanczos[v0];' +
      '[1:v]scale=960:-2:flags=lanczos[v1];' +
      '[2:v]scale=960:-2:flags=lanczos[v2];' +
      '[v0][v1][v2]concat=n=3:v=1:a=0,fps=8,split[s0][s1];' +
      '[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5',
    '-loop',
    '0',
    path.join(outputDir, 'tour.gif'),
  );

  const result = spawnSync('ffmpeg', args, { cwd: root, stdio: 'ignore', windowsHide: true });
  if (result.status === 0) return true;
  process.stderr.write('ffmpeg niet gevonden; de PNG-screenshots zijn wel bijgewerkt en tour.gif bleef ongewijzigd.\n');
  return false;
}
