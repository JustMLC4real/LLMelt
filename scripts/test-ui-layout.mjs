import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { connectCdp, evaluate, pause, waitForElectronPage, waitForSelector, waitForText } from './lib/electron-cdp.mjs';

const root = process.cwd();
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const mainEntry = path.join(root, 'dist-electron', 'main.js');
const rendererEntry = path.join(root, 'dist', 'index.html');
const profileDir = path.join(root, '.tmp-ui-layout-profile');
const artifactsDir = path.join(root, 'test-results', 'ui-layout');
const debugPort = 9334;

for (const requiredPath of [electronExecutable, mainEntry, rendererEntry]) {
  if (!existsSync(requiredPath)) {
    throw new Error(`Ontbrekend buildbestand: ${requiredPath}. Voer eerst npm run build uit.`);
  }
}

await rm(profileDir, { recursive: true, force: true });
await rm(artifactsDir, { recursive: true, force: true });
await mkdir(profileDir, { recursive: true });
await mkdir(artifactsDir, { recursive: true });

const electron = spawn(electronExecutable, [`--remote-debugging-port=${debugPort}`, mainEntry], {
  cwd: root,
  env: { ...process.env, AI_SUPERAPP_TEST_USER_DATA_DIR: profileDir, VITE_DEV_SERVER_URL: '' },
  stdio: 'ignore',
  windowsHide: true,
});

// De app kiest zijn taal uit `navigator.language`, dus een Engelse machine
// (zoals de CI-runner) toont andere knoppen dan een Nederlandse. De suite leest
// daarom dezelfde catalogus als de app in plaats van vaste teksten te bevatten.
const locales = {
  nl: JSON.parse(readFileSync(path.join(root, 'src', 'i18n', 'locales', 'nl.json'), 'utf8')),
  en: JSON.parse(readFileSync(path.join(root, 'src', 'i18n', 'locales', 'en.json'), 'utf8')),
};
let uiLanguage = 'en';

function text(key) {
  const value = key.split('.').reduce((node, part) => node?.[part], locales[uiLanguage]);
  if (typeof value !== 'string') throw new Error(`Ontbrekende vertaling voor ${key} in ${uiLanguage}.`);
  return value;
}

/** Dezelfde keuze als getDefaultLanguage() in src/i18n/index.ts. */
async function detectUiLanguage(client) {
  const language = await evaluate(client, `(() => {
    try {
      const stored = localStorage.getItem('ai-superapp-language');
      if (stored) return stored;
    } catch {}
    return navigator.language.toLowerCase().startsWith('nl') ? 'nl' : 'en';
  })()`);
  return Object.prototype.hasOwnProperty.call(locales, language) ? language : 'en';
}

let cdp;
let activeCase = 'opstart';
const skippedCases = [];

try {
  const target = await waitForElectronPage(
    debugPort,
    (candidate) => /LLMelt|index\.html/i.test(`${candidate.title} ${candidate.url}`),
  );
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.bringToFront');
  await completeOnboarding(cdp);

  for (const size of [
    { width: 1400, height: 900, name: 'desktop' },
    { width: 1100, height: 760, name: 'compact' },
    { width: 900, height: 650, name: 'minimum' },
  ]) {
    activeCase = size.name;
    await setWindowBounds(cdp, size.width, size.height);
    await assertLayout(cdp, size.name);
  }

  activeCase = 'model-selector';
  await setWindowBounds(cdp, 1100, 760);
  await click(cdp, '.composer-model-chip');
  await waitForSelector(cdp, '.model-selector-panel');
  await assertOverlay(cdp, '.model-selector-panel', '.model-selector-list');
  await click(cdp, '.model-selector-overlay');
  await waitUntilGone(cdp, '.model-selector-panel');

  // Het tandwiel bestaat alleen bij een actief model. Een kale machine zonder
  // geïnstalleerde providers — zoals de CI-runner — heeft geen enkel model en
  // dus niets om runinstellingen voor te tonen; die case slaan we daar over in
  // plaats van hem als layoutfout te melden.
  activeCase = 'run-settings';
  if (await evaluate(cdp, `!!document.querySelector('.run-settings .icon-button')`)) {
    await click(cdp, '.run-settings .icon-button');
    await waitForSelector(cdp, '.run-settings-popover');
    await assertOverlay(cdp, '.run-settings-popover', '.run-settings-popover');
    await dragRunSettingsSlider(cdp);
    await click(cdp, '.run-settings-view-switch button:last-child');
    await pause(220);
    await waitForSelector(cdp, '.run-settings-view-panel.advanced');
    const quickPanelVisible = await evaluate(cdp, `!!document.querySelector('.run-settings-view-panel.quick')`);
    if (quickPanelVisible) throw new Error('Snel kiezen bleef zichtbaar naast Geavanceerd.');
    await assertOverlay(cdp, '.run-settings-popover', '.run-settings-popover');
    await click(cdp, '.run-settings .icon-button');
    await waitUntilGone(cdp, '.run-settings-popover');
  } else {
    skippedCases.push('run-settings (geen provider met modellen op deze machine)');
  }

  activeCase = 'command-palette';
  await setTextarea(cdp, '/');
  await waitForSelector(cdp, '.command-palette');
  await assertOverlay(cdp, '.command-palette', '.command-palette');
  await setTextarea(cdp, '');

  activeCase = 'terminal-desktop';
  await click(cdp, '[data-utility-panel="terminal"]');
  await waitForSelector(cdp, '.terminal-panel-slot:not([aria-hidden="true"])');
  await waitForStableWidth(cdp, '.terminal-panel-slot:not([aria-hidden="true"])', 240);
  await assertLayout(cdp, activeCase);

  activeCase = 'terminal-compact';
  await setWindowBounds(cdp, 900, 650);
  await assertLayout(cdp, activeCase);

  process.stdout.write('Visuele layoutcontracten geslaagd voor desktop, compact, minimum, overlays en terminal.\n');
  if (skippedCases.length) {
    process.stdout.write(`Overgeslagen op deze machine: ${skippedCases.join(', ')}.\n`);
  }
} catch (error) {
  if (cdp) await captureFailure(cdp, `${activeCase}.png`).catch(() => {});
  throw error;
} finally {
  cdp?.close();
  electron.kill();
  await pause(500);
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

async function completeOnboarding(client) {
  uiLanguage = await detectUiLanguage(client);
  await waitForText(client, text('onboarding.welcome.title'));
  await clickButton(client, text('onboarding.welcome.start'));
  await waitForText(client, text('onboarding.intro.title'));
  await clickButton(client, text('onboarding.intro.check'));
  await waitForText(client, text('onboarding.confirm.title'), 30_000);
  await evaluate(client, `document.querySelector(${JSON.stringify(`[aria-label="${text('onboarding.skip')}"]`)})?.click()`);
  await waitForText(client, text('chat.newChat'));
  await evaluate(client, `window.electronAPI?.settings.set('onboarding.completedAt', new Date().toISOString())`, true);
  await clickButton(client, text('chat.newChat'));
  await waitForSelector(client, '.chat-input-wrapper');
  await waitForSelector(client, '.composer-model-chip');
}

async function setWindowBounds(client, width, height) {
  const deadline = Date.now() + 5_000;
  let actual = { width: 0, height: 0 };
  let nextResizeAttempt = 0;
  while (Date.now() < deadline) {
    if (Date.now() >= nextResizeAttempt) {
      const accepted = await evaluate(client, `window.electronAPI?.windowControls.testSetBounds(${width}, ${height})`, true);
      if (!accepted) throw new Error('Het testvensterkanaal heeft de maat geweigerd.');
      // Windows kan een setContentSize-aanroep negeren terwijl een eerdere native
      // resize nog wordt afgerond. Herhaal gecontroleerd tot de renderermaat klopt.
      nextResizeAttempt = Date.now() + 250;
    }
    actual = await evaluate(client, `({ width: innerWidth, height: innerHeight })`);
    if (Math.abs(actual.width - width) <= 2 && Math.abs(actual.height - height) <= 2) {
      await pause(250);
      return;
    }
    await pause(50);
  }
  throw new Error(`Venster kon niet worden ingesteld op ${width}x${height}; renderer bleef ${actual.width}x${actual.height}.`);
}

async function waitForStableWidth(client, selector, minimumWidth, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let previousWidth = -1;
  let stableMeasurements = 0;
  while (Date.now() < deadline) {
    const width = await evaluate(client, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      return element instanceof HTMLElement ? element.getBoundingClientRect().width : 0;
    })()`);
    if (width >= minimumWidth && Math.abs(width - previousWidth) <= 1) {
      stableMeasurements += 1;
      if (stableMeasurements >= 3) return;
    } else {
      stableMeasurements = 0;
    }
    previousWidth = width;
    await pause(75);
  }
  throw new Error(`${selector} bereikte geen stabiele breedte van minimaal ${minimumWidth}px.`);
}

async function clickButton(client, text) {
  const clicked = await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim().includes(${JSON.stringify(text)}));
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Knop niet gevonden: ${text}`);
}

async function click(client, selector) {
  const clicked = await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Element kon niet worden aangeklikt: ${selector}`);
}

async function dragRunSettingsSlider(client) {
  const slider = await evaluate(client, `(() => {
    const element = document.querySelector('.run-settings-slider');
    const thumb = element?.querySelector('.run-settings-slider-thumb');
    const modelLabel = document.querySelector('.composer-model-label');
    if (!(element instanceof HTMLElement) || !(thumb instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      y: rect.top + rect.height / 2,
      thumbX: thumbRect.left + thumbRect.width / 2,
      before: Number(element.getAttribute('aria-valuenow') || 0),
      max: Number(element.getAttribute('aria-valuemax') || 0),
      modelLabel: modelLabel?.textContent || '',
    };
  })()`);
  if (!slider || slider.max < 1) return;
  const toX = slider.before >= slider.max / 2 ? slider.left + 10 : slider.right - 10;
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: slider.thumbX, y: slider.y, button: 'left', buttons: 1, clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: toX, y: slider.y, button: 'left', buttons: 1 });
  await pause(120);
  const during = await evaluate(client, `(() => ({
    popover: !!document.querySelector('.run-settings-popover.entered'),
    dragging: !!document.querySelector('.run-settings-slider.dragging'),
    modelLabel: document.querySelector('.composer-model-label')?.textContent || '',
  }))()`);
  if (!during.popover || !during.dragging) throw new Error('De run-instellingenpopup bleef niet stabiel tijdens slepen vanaf de bol.');
  if (during.modelLabel !== slider.modelLabel) throw new Error('De modelkeuze werd al tijdens het slepen gecommit.');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: slider.y, button: 'left', buttons: 0, clickCount: 1 });
  await pause(240);
  const after = await evaluate(client, `(() => ({
    value: Number(document.querySelector('.run-settings-slider')?.getAttribute('aria-valuenow') || -1),
    popover: !!document.querySelector('.run-settings-popover.entered'),
  }))()`);
  if (after.value === slider.before) throw new Error('De run-instellingenslider reageerde niet op slepen vanaf de bol.');
  if (!after.popover) throw new Error('De run-instellingenpopup werd na de modelwissel opnieuw geopend of gesloten.');
}

async function setTextarea(client, value) {
  const changed = await evaluate(client, `(() => {
    const element = document.querySelector('.chat-input-textarea');
    if (!(element instanceof HTMLTextAreaElement)) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!changed) throw new Error('Het chatveld kon niet worden ingevuld.');
  await pause(100);
}

async function assertLayout(client, name) {
  const issues = await evaluate(client, `(() => {
    const issues = [];
    const visible = (element) => element instanceof HTMLElement && element.getClientRects().length > 0;
    const rect = (element) => element.getBoundingClientRect();
    const overlaps = (a, b) => {
      const ar = rect(a); const br = rect(b);
      return ar.left < br.right - 1 && ar.right > br.left + 1 && ar.top < br.bottom - 1 && ar.bottom > br.top + 1;
    };
    const viewportWidth = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > viewportWidth + 1) issues.push('document heeft horizontale overflow');
    const main = document.querySelector('.main-content');
    const composer = document.querySelector('.chat-input-container');
    const wrapper = document.querySelector('.chat-input-wrapper');
    if (!visible(main) || !visible(composer) || !visible(wrapper)) return ['hoofdlayout of composer ontbreekt'];
    const mr = rect(main); const cr = rect(composer); const wr = rect(wrapper);
    if (cr.left < mr.left - 1 || cr.right > mr.right + 1) issues.push('composer valt buiten de chatkolom');
    if (wr.left < cr.left - 1 || wr.right > cr.right + 1) issues.push('composerkaart valt buiten zijn container');
    if (wrapper.scrollWidth > wrapper.clientWidth + 1) issues.push('composerkaart heeft horizontale overflow');
    if (Math.abs((wr.left - cr.left) - (cr.right - wr.right)) > 2) issues.push('composer heeft ongelijke linker- en rechtermarge');
    const controls = [...wrapper.querySelectorAll('button, .composer-context-meter')].filter(visible);
    for (let i = 0; i < controls.length; i += 1) {
      for (let j = i + 1; j < controls.length; j += 1) {
        if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
        if (overlaps(controls[i], controls[j])) {
          issues.push('composerknoppen overlappen');
          i = controls.length;
          break;
        }
      }
    }
    const terminal = document.querySelector('.terminal-panel-slot:not([aria-hidden="true"])');
    if (visible(terminal)) {
      const tr = rect(terminal);
      if (tr.left < mr.right - 1 || tr.right > viewportWidth + 1) issues.push('terminal overlapt of valt buiten het venster');
      if (tr.width < 240) issues.push('terminal is smaller dan de bruikbare minimummaat');
    }
    return [...new Set(issues)];
  })()`);
  if (issues.length) throw new Error(`${name}: ${issues.join('; ')}`);
}

async function assertOverlay(client, panelSelector, scrollSelector) {
  const issues = await evaluate(client, `(() => {
    const panel = document.querySelector(${JSON.stringify(panelSelector)});
    const scroll = document.querySelector(${JSON.stringify(scrollSelector)});
    if (!(panel instanceof HTMLElement) || !(scroll instanceof HTMLElement)) return ['overlay ontbreekt'];
    const rect = panel.getBoundingClientRect();
    const issues = [];
    if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) issues.push('overlay valt buiten het venster');
    const style = getComputedStyle(scroll);
    if (scroll.scrollHeight > scroll.clientHeight + 1 && !['auto', 'scroll'].includes(style.overflowY)) issues.push('lange inhoud is niet scrolbaar');
    return issues;
  })()`);
  if (issues.length) throw new Error(`${panelSelector}: ${issues.join('; ')}`);
}

async function waitUntilGone(client, selector, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await evaluate(client, `Boolean(document.querySelector(${JSON.stringify(selector)}))`))) return;
    await pause(50);
  }
  throw new Error(`Overlay sloot niet op tijd: ${selector}`);
}

async function captureFailure(client, filename) {
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(path.join(artifactsDir, filename), Buffer.from(screenshot.data, 'base64'));
}
