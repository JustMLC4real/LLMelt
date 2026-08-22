export function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForElectronPage(debugPort, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const target = targets.find((candidate) => candidate.type === 'page' && predicate(candidate));
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Electron is nog aan het opstarten.
    }
    await pause(200);
  }
  throw new Error('De geïsoleerde Electron-renderer werd niet op tijd gevonden.');
}

export async function connectCdp(url) {
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

export async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer-evaluatie is mislukt.');
  }
  return result.result?.value;
}

export async function waitForSelector(client, selector, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return;
    await pause(150);
  }
  throw new Error(`Element niet gevonden in de renderer: ${selector}`);
}

export async function waitForText(client, text, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, `document.body?.innerText.includes(${JSON.stringify(text)}) === true`)) {
      await pause(250);
      return;
    }
    await pause(150);
  }
  throw new Error(`Tekst niet gevonden in de renderer: ${text}`);
}
