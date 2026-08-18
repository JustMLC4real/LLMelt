/**
 * ChatGPT Browser Session Scraper
 *
 * Opens an Electron BrowserWindow to chatgpt.com, lets the user log in, then
 * reuses the session by driving the real ChatGPT web app. Backend-api reads are
 * still used for model/session discovery, but chat sending stays on the web UI
 * route because direct conversation POSTs are commonly flagged as unusual activity.
 */
import { BrowserWindow, session, app } from 'electron';
import { safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getStore } from './settings-store';
import type { AIModel, ChatgptVersion, ChatMessage, TokenUsage, UiLanguage } from '../src/providers/types';
import { localizedText } from '../src/i18n/language';
import type { AttachmentRecord } from './provider-adapters';
import { classifyChatGptPage } from '../src/components/chatgpt-diagnostics';
import { createSerialTaskQueue } from '../src/components/serial-task-queue';
import {
  redactChatGptDiagnosticText,
  redactChatGptDiagnosticValue,
} from './chatgpt-diagnostic-redaction';
import { chatGptChoiceValidationError } from './chatgpt-model-choice';
import { patchChatGptConversationBody } from './chatgpt-request-body';
import { chatgptIntelligenceLabel } from '../src/providers/chatgpt-labels';
import {
  chatGptCookieIdentity,
  toRestorableChatGptCookie,
} from './chatgpt-session-cookies';

// Diagnostiek is expliciet opt-in, begrensd en ontdaan van bekende geheimen.
// Het bestand staat in Electron's gebruikersgebonden logmap, nooit in het project.
const CHATGPT_DIAGNOSTICS_ENABLED = process.env.AI_SUPERAPP_DIAGNOSTICS === '1';

function debugLogPath(): string {
  try { return path.join(app.getPath('logs'), 'chatgpt-debug.log'); } catch { return 'chatgpt-debug.log'; }
}
function debugLog(label: string, data: unknown): void {
  if (!CHATGPT_DIAGNOSTICS_ENABLED) return;
  try {
    fs.mkdirSync(path.dirname(debugLogPath()), { recursive: true });
    const body = typeof data === 'string'
      ? redactChatGptDiagnosticText(data)
      : JSON.stringify(redactChatGptDiagnosticValue(data), null, 2);
    fs.appendFileSync(debugLogPath(), `\n===== ${new Date().toISOString()} ${label} =====\n${body}\n`);
  } catch { /* best-effort */ }
}

function summarizeRequestBody(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  try {
    const parsed = JSON.parse(text);
    return {
      bytes: Buffer.byteLength(text, 'utf8'),
      keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 30) : [],
      model: typeof parsed?.model === 'string' ? parsed.model : undefined,
    };
  } catch {
    return { bytes: Buffer.byteLength(text, 'utf8'), parseable: false };
  }
}

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const LOGIN_CHECK_INTERVAL_MS = 1500;
const LOGIN_TIMEOUT_MS = 300_000; // 5 minutes max for user to log in
const SESSION_PARTITION = 'persist:chatgpt';
const COMPOSER_SELECTOR = [
  '#prompt-textarea',
  '[data-testid="prompt-textarea"]',
  '[contenteditable="true"][role="textbox"]',
  '.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"]',
  'textarea',
].join(',');
const SEND_SELECTOR = [
  '[data-testid="send-button"]',
  '[data-testid="composer-send-button"]',
  'button[aria-label*="Send" i]',
  'button[aria-label*="verstuur" i]',
].join(',');

interface ChatGptSession {
  accessToken: string;
  cookies: Electron.Cookie[];
  expiresAt: number; // unix ms
}

let cachedSession: ChatGptSession | null = null;
let storedCookiesHydrated = false;
let storedCookiesHydration: Promise<void> | null = null;
let loginWindow: BrowserWindow | null = null;
let workerWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
// Ground-truth main-frame HTTP status of the chat window's last navigation, plus a
// flag set when its renderer crashes. Used to tell a transient blank/crash (retry)
// apart from a real 403 anti-bot block (honest fail). Reset before every load.
let chatWinHttpStatus = 0;
let chatWinRenderGone = false;
// De echte ChatGPT-webclient gebruikt één gedeeld BrowserWindow en één globale
// DOM-streambuffer. Twee gelijktijdige besturingen zouden antwoorden tussen chats
// kunnen verwisselen, dus alleen deze providerroute wordt strikt geserialiseerd.
const chatSendQueue = createSerialTaskQueue();

type ChatGptEngineStage =
  | 'idle'
  | 'session-check'
  | 'page-ready'
  | 'composer-ready'
  | 'message-injected'
  | 'send-clicked'
  | 'stream-detected'
  | 'response-complete'
  | 'recovering'
  | 'failed';

type ChatGptEngineStatus = {
  active: boolean;
  plan: string | null;
  stage: ChatGptEngineStage;
  transport: 'web-session';
  lastError: string | null;
  lastModel: string | null;
  recoverable: boolean;
  updatedAt: string | null;
};

let engineStatus: ChatGptEngineStatus = {
  active: false,
  plan: null,
  stage: 'idle',
  transport: 'web-session',
  lastError: null,
  lastModel: null,
  recoverable: false,
  updatedAt: null,
};

function setEngineStatus(patch: Partial<ChatGptEngineStatus>) {
  engineStatus = {
    ...engineStatus,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

function setEngineStage(stage: ChatGptEngineStage, patch: Partial<ChatGptEngineStatus> = {}) {
  setEngineStatus({ stage, ...patch });
  debugLog('engine stage', { stage, ...patch });
}

function makeEngineError(message: string, stage: ChatGptEngineStage, recoverable = true) {
  const error = new Error(message);
  (error as any).chatgptStage = stage;
  (error as any).recoverable = recoverable;
  return error;
}

function friendlyChatGptError(error: unknown, stage: ChatGptEngineStage, language: UiLanguage = 'nl'): string {
  const message = (error as any)?.message || String(error);
  if (/niet ingelogd|login|log in|auth|unauthor|forbidden/i.test(message)) return localizedText(language, 'ChatGPT web-sessie is niet ingelogd', 'The ChatGPT web session is not signed in');
  if (/cloudflare|verify you are human|verificatie|turnstile/i.test(message)) return localizedText(language, 'ChatGPT verificatie/login blokkeert de sessie', 'ChatGPT verification or sign-in is blocking the session');
  if (/unusual activity|try again later|geautomatiseerde web-engine/i.test(message)) {
    return localizedText(language, 'ChatGPT blokkeert deze geautomatiseerde web-engine wegens unusual activity', 'ChatGPT is blocking this automated web engine because of unusual activity');
  }
  if (/composer not found|composer/i.test(message)) return localizedText(language, 'ChatGPT composer niet gevonden', 'ChatGPT composer not found');
  if (/geen antwoord gestart|verstuurd maar niets terug|no answer/i.test(message)) return localizedText(language, 'ChatGPT websessie startte geen antwoord', 'The ChatGPT web session did not start an answer');
  if (/conduit_token|prepare/i.test(message) && /geen tekst|geen antwoord|no text|no answer|prepare/i.test(message)) return localizedText(language, 'ChatGPT websessie gaf alleen prepare-data terug, geen antwoordstream', 'The ChatGPT web session returned only prepare data, not an answer stream');
  if (/backend.*stream|stream.*start/i.test(message)) return localizedText(language, 'ChatGPT websessie startte geen stream', 'The ChatGPT web session did not start a stream');
  if (/model.*not available|model niet beschikbaar|mismatch/i.test(message)) return localizedText(language, 'ChatGPT model niet beschikbaar', 'ChatGPT model unavailable');
  if (/timeout|timed out/i.test(message)) return localizedText(language, 'ChatGPT web-engine liep vast tijdens wachten op antwoord', 'The ChatGPT web engine timed out while waiting for an answer');
  return localizedText(language, `ChatGPT-webengine faalde bij ${stage}: ${message}`, `ChatGPT web engine failed at ${stage}: ${message}`);
}

function isUnusualActivityError(error: unknown) {
  const message = (error as any)?.message || String(error);
  return /unusual activity|try again later/i.test(message);
}

function unusualActivityBlockedMessage(language: UiLanguage = 'nl') {
  return localizedText(language,
    'ChatGPT blokkeert deze websessie wegens unusual activity. Open ChatGPT handmatig of probeer later opnieuw.',
    'ChatGPT is blocking this web session because of unusual activity. Open ChatGPT manually or try again later.');
}

// ─── Session Persistence ───────────────────────────────────────────────────

async function saveSession(sess: ChatGptSession, language: UiLanguage = 'nl') {
  const store = await getStore();
  const data = JSON.stringify(sess);
  if (!safeStorage.isEncryptionAvailable()) throw new Error(localizedText(language, 'Veilige Windows-opslag is niet beschikbaar; de ChatGPT-sessie is niet bewaard.', 'Windows secure storage is unavailable; the ChatGPT session was not saved.'));
  store.set('chatgpt.session', { encrypted: true, value: safeStorage.encryptString(data).toString('base64') });
  cachedSession = sess;
  setEngineStatus({ active: true, lastError: null, recoverable: false });
  console.log(`[chatgpt] session saved (encrypted=${safeStorage.isEncryptionAvailable()}, cookies=${sess.cookies.length})`);
}

async function loadSession(): Promise<ChatGptSession | null> {
  if (cachedSession && cachedSession.expiresAt > Date.now()) return cachedSession;
  const store = await getStore();
  const stored = store.get('chatgpt.session') as { encrypted: boolean; value: string } | undefined;
  if (!stored?.value) {
    console.log('[chatgpt] loadSession: no stored session');
    return null;
  }
  try {
    if (!stored.encrypted) {
      if (!safeStorage.isEncryptionAvailable()) {
        store.delete('chatgpt.session');
        return null;
      }
      const legacy = JSON.parse(stored.value) as ChatGptSession;
      await saveSession(legacy);
      return legacy;
    }
    const raw = stored.encrypted ? safeStorage.decryptString(Buffer.from(stored.value, 'base64')) : stored.value;
    const sess: ChatGptSession = JSON.parse(raw);
    if (sess.expiresAt && sess.expiresAt < Date.now()) {
      console.log('[chatgpt] loadSession: stored session expired, clearing');
      await clearSession();
      return null;
    }
    cachedSession = sess;
    return sess;
  } catch (error) {
    console.warn('[chatgpt] loadSession: failed to decrypt/parse stored session', error);
    return null;
  }
}

// Cookies we MUST keep to stay logged in / pass Cloudflare. Everything else (analytics,
// telemetry, A/B testing, Datadog `_dd_s`, GA, statsig, …) may be removed safely.
const ESSENTIAL_COOKIE_RE = /next-auth|cf_clearance|__cf_bm|^__Host-|^__Secure-|oai-did|oai-sc|oai-hlib|conversation/i;

// Fix for HTTP 431 "Request Header Fields Too Large": the persist:chatgpt cookie jar
// grows with every send (Cloudflare + analytics cookies) until the Cookie header exceeds
// the server limit and chatgpt.com returns a blank 431 page. Drop non-essential cookies
// so the header shrinks; auth + Cloudflare cookies are preserved (stays logged in).
async function pruneChatGptCookies(): Promise<number> {
  const ses = session.fromPartition(SESSION_PARTITION);
  let removed = 0;
  let kept = 0;
  try {
    const all = await ses.cookies.get({});
    for (const cookie of all) {
      if (ESSENTIAL_COOKIE_RE.test(cookie.name)) { kept++; continue; }
      const domain = (cookie.domain || '').replace(/^\./, '');
      if (!domain) continue;
      const url = `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path || '/'}`;
      try { await ses.cookies.remove(url, cookie.name); removed++; } catch { /* best-effort */ }
    }
  } catch (e) {
    debugLog('pruneChatGptCookies failed', String((e as any)?.message || e));
  }
  debugLog('pruned chatgpt cookies (HTTP 431 mitigation)', { removed, kept });
  return removed;
}

// Proactive guard: prune before the cookie header ever gets big enough to trigger 431.
// Most HTTP stacks cap header size around 8–16 KB, so we prune well below that.
async function pruneChatGptCookiesIfLarge(): Promise<void> {
  try {
    const ses = session.fromPartition(SESSION_PARTITION);
    const all = await ses.cookies.get({});
    const totalSize = all.reduce((n, c) => n + c.name.length + (c.value?.length || 0) + 3, 0);
    if (all.length > 25 || totalSize > 8000) {
      debugLog('cookie jar large, proactively pruning', { count: all.length, totalSize });
      await pruneChatGptCookies();
    }
  } catch { /* best-effort */ }
}

async function clearSession() {
  invalidateSessionModelCatalog();
  cachedSession = null;
  storedCookiesHydrated = false;
  storedCookiesHydration = null;
  setEngineStatus({ active: false, plan: null, stage: 'idle', lastError: null, recoverable: false });
  const store = await getStore();
  store.delete('chatgpt.session');
  if (workerWindow && !workerWindow.isDestroyed()) workerWindow.close();
  workerWindow = null;
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.close();
  chatWindow = null;
  try {
    const ses = session.fromPartition(SESSION_PARTITION);
    await ses.clearStorageData();
  } catch {
    // ignore
  }
}

async function ensureStoredSessionCookies(): Promise<void> {
  if (storedCookiesHydrated) return;
  if (storedCookiesHydration) return storedCookiesHydration;

  storedCookiesHydration = (async () => {
    const stored = await loadSession();
    if (!stored?.cookies?.length) {
      storedCookiesHydrated = true;
      return;
    }

    const ses = session.fromPartition(SESSION_PARTITION);
    const current = await ses.cookies.get({ domain: '.chatgpt.com' });
    const present = new Set(current.map(chatGptCookieIdentity));
    let restored = 0;

    for (const cookie of stored.cookies) {
      if (present.has(chatGptCookieIdentity(cookie))) continue;
      const details = toRestorableChatGptCookie(cookie);
      if (!details) continue;
      try {
        await ses.cookies.set(details);
        present.add(chatGptCookieIdentity(cookie));
        restored++;
      } catch (error) {
        debugLog('stored ChatGPT-cookie herstellen mislukt', {
          name: cookie.name,
          domain: cookie.domain,
          error: (error as Error)?.message || String(error),
        });
      }
    }

    if (restored) {
      await ses.cookies.flushStore();
      console.log(`[chatgpt] ${restored} ontbrekende sessiecookie(s) veilig hersteld`);
    }
    storedCookiesHydrated = true;
  })().finally(() => {
    storedCookiesHydration = null;
  });

  return storedCookiesHydration;
}

// ─── Hidden worker window (browser context for backend-api) ──────────────────

async function ensureWorker(): Promise<BrowserWindow> {
  if (workerWindow && !workerWindow.isDestroyed()) return workerWindow;
  await ensureStoredSessionCookies();
  const ses = session.fromPartition(SESSION_PARTITION);
  workerWindow = new BrowserWindow({
    show: false,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  workerWindow.on('closed', () => { workerWindow = null; });
  // A crashed renderer leaves a blank page; drop the ref so it gets recreated.
  workerWindow.webContents.on('render-process-gone', (_e, details) => {
    debugLog('worker render-process-gone', details);
    workerWindow = null;
  });
  await workerWindow.loadURL(CHATGPT_ORIGIN);
  return workerWindow;
}

// Separate window for DRIVING the SPA (plan-B), so navigating it doesn't break
// the apiGet worker that lists models / reads the plan.
async function ensureChatWindow(): Promise<BrowserWindow> {
  if (chatWindow && !chatWindow.isDestroyed()) return chatWindow;
  const ses = session.fromPartition(SESSION_PARTITION);
  chatWindow = new BrowserWindow({
    show: false,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  chatWindow.on('closed', () => { chatWindow = null; });
  // Record the main-frame HTTP status so we can tell a real 403 anti-bot block
  // apart from a transient blank/crashed render (which is worth retrying).
  chatWindow.webContents.on('did-navigate', (_e, _url, httpResponseCode) => {
    if (typeof httpResponseCode === 'number' && httpResponseCode > 0) chatWinHttpStatus = httpResponseCode;
  });
  // A crashed/unresponsive renderer leaves a blank page; drop the ref so the next
  // send recreates a fresh window instead of reusing the dead one.
  chatWindow.webContents.on('render-process-gone', (_e, details) => {
    debugLog('chat render-process-gone', details);
    chatWinRenderGone = true;
    chatWindow = null;
  });
  chatWindow.webContents.on('unresponsive', () => {
    debugLog('chat window unresponsive', { url: chatWindow?.webContents?.getURL?.() || '' });
  });
  return chatWindow;
}

async function createFreshChatWindow(): Promise<BrowserWindow> {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.close();
  chatWindow = null;
  return ensureChatWindow();
}

async function waitForChatGptPage(win: BrowserWindow, timeoutMs = 15000): Promise<boolean> {
  return win.webContents.executeJavaScript(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < ${Number(timeoutMs)}) {
      const bodyText = document.body ? document.body.innerText.trim() : '';
      const hasComposer = !!document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
      const hasShell = !!document.querySelector('main, #__next, [data-testid]');
      if (hasComposer || bodyText.length > 20 || hasShell) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  })()`, true).catch(() => false);
}

async function openChatGptWindow(language: UiLanguage = 'nl') {
  setEngineStage('recovering', { lastError: localizedText(language, 'ChatGPT-herstelvenster geopend.', 'ChatGPT recovery window opened.'), recoverable: true });
  const ses = session.fromPartition(SESSION_PARTITION);
  const win = new BrowserWindow({
    width: 1200,
    height: 850,
    title: localizedText(language, 'ChatGPT herstellen', 'Recover ChatGPT'),
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true },
    autoHideMenuBar: true,
  });
  await win.loadURL(CHATGPT_ORIGIN);
  return { success: true };
}

async function resetEngine() {
  setEngineStage('recovering', { lastError: null, recoverable: false });
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.close();
  chatWindow = null;
  if (workerWindow && !workerWindow.isDestroyed()) workerWindow.close();
  workerWindow = null;
  setEngineStage('idle', { lastError: null, recoverable: false });
  return getSessionStatus();
}

// One-time diagnostic: open ChatGPT's own model/intelligence picker and dump its
// structure so we can wire the real selectors (model / Instant-Thinking-Pro / effort).
let pickerDumped = false;
async function dumpChatgptPicker(win: BrowserWindow) {
  if (pickerDumped) return;
  pickerDumped = true;
  try {
    const dump = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // Wait until the composer/top bar exists.
      for (let i = 0; i < 30 && !document.querySelector('#prompt-textarea, div[contenteditable="true"]'); i++) await wait(300);
      await wait(800);
      const desc = (b) => ({ testid: b.getAttribute('data-testid'), aria: b.getAttribute('aria-label'), text: (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50) });
      // All buttons in the top ~120px (where the model switcher lives) + any mentioning a model.
      const topButtons = Array.from(document.querySelectorAll('button'))
        .filter((b) => { const r = b.getBoundingClientRect(); return (r.top < 130 && r.width > 0) || /gpt|model|5\\.[0-9]|4o|o3|instant|thinking|pro/i.test(b.textContent || ''); })
        .slice(0, 30)
        .map(desc);
      const candidate = document.querySelector('[data-testid="model-switcher-dropdown-button"]')
        || Array.from(document.querySelectorAll('button')).find((b) => /gpt|5\\.[0-9]|4o|o3/i.test(b.textContent || '') && b.getBoundingClientRect().top < 130);
      let menu = null;
      if (candidate) { try { candidate.click(); await wait(1000); } catch (e) {} menu = document.querySelector('[role="menu"],[data-radix-menu-content],[role="dialog"],[role="listbox"]'); }
      const items = menu ? Array.from(menu.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],button,[role="radio"]')).map((e) => ({ t: (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50), role: e.getAttribute('role'), testid: e.getAttribute('data-testid') })).filter((x) => x.t).slice(0, 60) : [];
      try { document.body.click(); } catch (e) {}
      return { clickedCandidate: candidate ? desc(candidate) : null, topButtons, menuFound: !!menu, items, menuHtml: menu ? menu.outerHTML.slice(0, 3000) : 'no-menu' };
    })()`, true);
    console.log('[chatgpt] picker dump >>>', JSON.stringify(dump));
  } catch (e) {
    console.warn('[chatgpt] picker dump failed', e);
  }
}

async function pageFetchJson(win: BrowserWindow, url: string, headers: Record<string, string>) {
  const result = await win.webContents.executeJavaScript(
    `(async () => {
      try {
        const res = await fetch(${JSON.stringify(url)}, { credentials: 'include', headers: ${JSON.stringify(headers)} });
        const body = await res.text();
        return { ok: res.ok, status: res.status, body };
      } catch (e) { return { ok: false, status: 0, body: String(e) }; }
    })()`,
    true,
  );
  let data: any = null;
  try { data = result?.body ? JSON.parse(result.body) : null; } catch { data = null; }
  return { ok: !!result?.ok, status: result?.status || 0, data };
}

/**
 * GET a JSON endpoint from inside the page context (passes Cloudflare).
 * /backend-api/* requires the Bearer access token (cookies alone → 401), so we
 * attach it and refresh once on a 401.
 */
// Het actieve workspace-account. Zonder de ChatGPT-Account-Id header antwoordt de
// backend op workspace-bronnen (zoals een gesprek van LF&CO) met "Je hebt geen
// toegang tot dit gesprek" — wat makkelijk te verwarren is met "bestaat niet".
let cachedAccountId: string | null = null;

async function getActiveAccountId(): Promise<string> {
  if (cachedAccountId !== null) return cachedAccountId;
  cachedAccountId = '';
  try {
    // Zonder account-header ophalen, anders bijten we in onze eigen staart.
    const { ok, data } = await apiGet('/backend-api/accounts/check/v4-2023-04-27', true, false);
    if (ok && data?.accounts) {
      const parsed = Object.entries(data.accounts as Record<string, any>)
        .filter(([key]) => key !== 'default')
        .map(([key, entry]: [string, any]) => {
          const account = entry?.account || entry || {};
          return {
            id: String(account.account_id || key),
            workspace: String(account.structure || '').toLowerCase() === 'workspace',
          };
        });
      const pick = parsed.find((account) => account.workspace) || parsed[0];
      cachedAccountId = pick?.id || '';
      if (cachedAccountId) {
        console.log(`[chatgpt] actieve ${pick?.workspace ? 'workspace-' : ''}accountcontext gevonden`);
      }
    }
  } catch { /* geen workspace-context; dan gewoon zonder header verder */ }
  return cachedAccountId;
}

async function apiGet(path: string, allowRefresh = true, withAccount = true): Promise<{ ok: boolean; status: number; data: any }> {
  const win = await ensureWorker();
  const url = path.startsWith('http') ? path : `${CHATGPT_ORIGIN}${path}`;
  const sess = await loadSession();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (sess?.accessToken) headers.Authorization = `Bearer ${sess.accessToken}`;
  if (withAccount) {
    const accountId = await getActiveAccountId();
    if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  }

  let result = await pageFetchJson(win, url, headers);
  if (result.status === 401 && allowRefresh) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      result = await pageFetchJson(win, url, { ...headers, Authorization: `Bearer ${newToken}` });
    }
  }
  return result;
}


// ─── Login Flow ──────────────────────────────────────────────────────────────

async function openLoginWindow(language: UiLanguage = 'nl'): Promise<ChatGptSession> {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    throw new Error(localizedText(language, 'Het inlogvenster is al geopend.', 'The sign-in window is already open.'));
  }
  const ses = session.fromPartition(SESSION_PARTITION);

  return new Promise<ChatGptSession>((resolve, reject) => {
    loginWindow = new BrowserWindow({
      width: 500,
      height: 700,
      title: localizedText(language, 'ChatGPT — Inloggen', 'ChatGPT — Sign in'),
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true },
      autoHideMenuBar: true,
    });
    loginWindow.loadURL(CHATGPT_ORIGIN);

    const timeout = setTimeout(() => { cleanup(); reject(new Error(localizedText(language, 'Inloggen duurde te lang. Probeer opnieuw.', 'Sign-in timed out. Try again.'))); }, LOGIN_TIMEOUT_MS);

    const interval = setInterval(async () => {
      if (!loginWindow || loginWindow.isDestroyed()) {
        cleanup();
        reject(new Error(localizedText(language, 'Het inlogvenster is gesloten voordat het inloggen was voltooid.', 'The sign-in window was closed before sign-in completed.')));
        return;
      }
      try {
        const token = await loginWindow.webContents.executeJavaScript(
          `(async () => {
            try {
              const res = await fetch('/api/auth/session', { credentials: 'include' });
              if (!res.ok) return null;
              const data = await res.json();
              return data?.accessToken || null;
            } catch { return null; }
          })()`,
          true,
        );
        if (token && typeof token === 'string') {
          const cookies = await ses.cookies.get({ domain: '.chatgpt.com' });
          const chatGptSession: ChatGptSession = {
            accessToken: token,
            cookies,
            expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
          };
          invalidateSessionModelCatalog();
          await saveSession(chatGptSession, language);
          storedCookiesHydrated = true;
          await ses.cookies.flushStore();
          cleanup();
          resolve(chatGptSession);
        }
      } catch {
        // not ready yet, keep waiting
      }
    }, LOGIN_CHECK_INTERVAL_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(interval);
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
      loginWindow = null;
    };
    loginWindow.on('closed', () => { loginWindow = null; });
  });
}

// ─── Refresh Access Token (via worker page context) ──────────────────────────

async function refreshAccessToken(): Promise<string | null> {
  try {
    // /api/auth/session is cookie-based (NextAuth) — no bearer needed, and
    // allowRefresh=false prevents recursion back into apiGet's 401 handler.
    const { ok, data } = await apiGet('/api/auth/session', false);
    if (ok && data?.accessToken) {
      const ses = session.fromPartition(SESSION_PARTITION);
      const cookies = await ses.cookies.get({ domain: '.chatgpt.com' });
      await saveSession({
        accessToken: data.accessToken,
        cookies: cookies.length ? cookies : (cachedSession?.cookies || []),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      console.log('[chatgpt] access token refreshed');
      return data.accessToken;
    }
    console.warn('[chatgpt] refresh: no accessToken (login expired or Cloudflare blocked)');
  } catch (error) {
    console.warn('[chatgpt] refresh failed', error);
  }
  return null;
}

// ─── List Available Models ─────────────────────────────────────────────────

function makeSessionModel(raw: any): AIModel {
  const slug: string = raw.slug;
  const title: string = raw.title || slug;
  const maxTokens: number | undefined = raw.max_tokens;
  // Live thinking-effort options for this exact model (no hardcoding).
  const efforts = Array.isArray(raw.thinking_efforts)
    ? raw.thinking_efforts
        .filter((e: any) => e && e.thinking_effort)
        .map((e: any) => ({ value: String(e.thinking_effort), label: chatgptIntelligenceLabel(e.short_label || e.full_label || e.thinking_effort), description: e.description ? String(e.description) : undefined }))
    : [];
  return {
    id: `chatgpt:${slug}`,
    name: title || slug,
    provider: 'openai',
    contextWindow: maxTokens || 128000,
    maxOutputTokens: maxTokens ? Math.min(maxTokens, 16384) : 16384,
    supportsVision: true,
    supportsFiles: true,
    supportsStreaming: true,
    source: 'manual',
    sourceLabel: 'web-sessie',
    surfaceLabel: 'ChatGPT Subscription',
    providerSurface: 'subscription-web',
    limitScope: 'account',
    limitGroupKey: 'openai:account',
    providerCategory: 'api',
    executionMode: 'chat',
    canChat: true,
    contextSource: 'estimate',
    chatgptConfigurableEffort: !!raw.configurable_thinking_effort,
    chatgptThinkingEfforts: efforts,
    chatgptReasoningType: raw.reasoning_type ? String(raw.reasoning_type) : undefined,
    chatgptWorkMode: !!raw.is_work_mode_model,
  };
}

// Welke modellen mogen in de picker? ChatGPT zegt dat zelf: elke slug waar een
// versie of intelligentie-niveau naar verwijst. Zo kan een niveau nooit wijzen
// naar een model dat wij hebben weggefilterd (dan zou de knop grijs blijven).
function isChatGptPickerModel(raw: any): boolean {
  const slug = String(raw?.slug || '');
  if (!slug) return false;
  // Zonder live versions[] fabriceren of raden we geen pickerinhoud.
  return versionSlugs.size > 0 && versionSlugs.has(slug);
}

let schemaDumped = false;
const effortFieldLogged = false;
// ChatGPT's eigen modelkiezer, zoals de website hem opbouwt. We bewaren 'm bij
// elke models-call zodat de UI exact dezelfde lijst kan tonen.
let cachedVersions: ChatgptVersion[] = [];
let sessionModelsInFlight: Promise<AIModel[]> | null = null;
// Alle slugs waar ChatGPT's eigen kiezer naar verwijst (versie-slugs + niveau-slugs).
let versionSlugs = new Set<string>();
let sessionModelCatalogGeneration = 0;

function invalidateSessionModelCatalog() {
  sessionModelCatalogGeneration += 1;
  cachedVersions = [];
  versionSlugs = new Set<string>();
  sessionModelsInFlight = null;
  // Een login of expliciete refresh kan intussen naar een andere persoonlijke
  // of workspace-accountcontext wijzen. Hergebruik dan niet de eerste lege of
  // verouderde accountkeuze van de verse VM-start.
  cachedAccountId = null;
}

function parseSessionVersions(raw: any): ChatgptVersion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((version: any) => version?.enabled !== false)
    .map((version: any) => ({
      id: String(version.id ?? ''),
      title: String(version.display_text_for_intelligence || version.display_text || version.id || ''),
      shortTitle: version.short_display_text_for_intelligence ? String(version.short_display_text_for_intelligence) : undefined,
      enabled: version.enabled !== false,
      slugs: Array.isArray(version.slugs) ? version.slugs.map((slug: any) => String(slug)) : [],
      presets: (Array.isArray(version.intelligence_presets) ? version.intelligence_presets : [])
        .filter((preset: any) => preset?.title && preset?.model_slug)
        .map((preset: any) => ({
          title: chatgptIntelligenceLabel(preset.title),
          subtitle: preset.subtitle ? String(preset.subtitle) : undefined,
          modelSlug: String(preset.model_slug),
          lane: preset.lane ? String(preset.lane) : undefined,
          thinkingEffort: preset.thinking_effort ? String(preset.thinking_effort) : undefined,
          available: preset.preset_type === 'available',
        })),
    }))
    // o3 heeft geen intelligentie-presets maar wél een slug -> hoort gewoon in de lijst.
    .filter((version: ChatgptVersion) => version.title && (version.presets.length || version.slugs.length));
}

async function listSessionVersions(): Promise<ChatgptVersion[]> {
  // Als een cachevrije modelrefresh al bezig is, hoort versions() niet alvast
  // de vorige snapshot terug te geven; modellen en presets moeten atomair bij
  // dezelfde /backend-api/models-response blijven.
  if (sessionModelsInFlight) await sessionModelsInFlight;
  if (cachedVersions.length) return cachedVersions;
  await listSessionModels();
  return cachedVersions;
}

async function listSessionModels(): Promise<AIModel[]> {
  if (sessionModelsInFlight) return sessionModelsInFlight;

  const request = discoverSessionModels();
  sessionModelsInFlight = request;
  try {
    return await request;
  } finally {
    if (sessionModelsInFlight === request) sessionModelsInFlight = null;
  }
}

async function discoverSessionModels(): Promise<AIModel[]> {
  const generation = sessionModelCatalogGeneration;
  const sess = await loadSession();
  if (!sess) {
    invalidateSessionModelCatalog();
    return [];
  }
  try {
    const { ok, status, data } = await apiGet('/backend-api/models');
    if (generation !== sessionModelCatalogGeneration) return [];
    if (ok) {
      cachedVersions = parseSessionVersions(data?.versions);
      versionSlugs = new Set(cachedVersions.flatMap((version) => [
        ...version.slugs,
        ...version.presets.map((preset) => preset.modelSlug),
      ]));
      console.log('[chatgpt] intelligence versions:', cachedVersions.map((v) => `${v.title} [${v.presets.map((p) => p.title).join(', ')}]`));
    }
    if (ok && Array.isArray(data?.models)) {
      const models = data.models
        .filter((m: any) => m.slug)
        .filter((m: any) => isChatGptPickerModel(m))
        .map((m: any) => makeSessionModel(m));

      // Elk niveau moet naar een geladen model wijzen, anders blijft "Gebruik ChatGPT"
      // grijs zonder dat iemand snapt waarom. Meteen luidruchtig klagen als dat misgaat.
      const loaded = new Set(models.map((model: AIModel) => model.id.replace(/^chatgpt:/, '')));
      const missing = cachedVersions
        .flatMap((version) => version.presets.map((preset) => preset.modelSlug))
        .filter((slug) => !loaded.has(slug));
      if (missing.length) {
        console.warn('[chatgpt] intelligentie-niveaus verwijzen naar niet-geladen modellen:', [...new Set(missing)]);
      } else {
        console.log(`[chatgpt] alle intelligentie-niveaus zijn gedekt door ${models.length} geladen modellen`);
      }
      console.log(`[chatgpt] listSessionModels: ${models.length} picker chat models from backend-api (${data.models.length} raw)`);
      // One-time schema dump: show ALL fields of the raw model objects so we can
      // see whether reasoning effort ("Langer") is an API field/slug or UI-only.
      if (!schemaDumped) {
        schemaDumped = true;
        console.log('[chatgpt] models RAW slugs:', data.models.map((m: any) => m.slug));
        // Welke top-level velden geeft /backend-api/models nog meer terug? De echte
        // picker-samenstelling (welke modellen ChatGPT toont) zit mogelijk niet in
        // `models` maar in een apart veld zoals `categories`.
        console.log('[chatgpt] models response keys:', Object.keys(data || {}));
        debugLog('models response non-model keys', Object.fromEntries(
          Object.entries(data || {}).filter(([key]) => key !== 'models'),
        ));
        debugLog('models not referenced by live versions', data.models
          .map((m: any) => ({
            slug: m.slug,
            title: m.title,
            selectable: isChatGptPickerModel(m),
            reason: versionSlugs.size ? 'niet verwezen door versions[]' : 'versions[] ontbreekt',
          }))
          .filter((m: any) => !m.selectable));
        if (CHATGPT_DIAGNOSTICS_ENABLED) console.log('[chatgpt] geredigeerde diagnostiek ->', debugLogPath());
        debugLog('models RAW slugs', data.models.map((m: any) => m.slug));
        debugLog('models RAW full', data.models);
      }
      return models;
    }
    console.warn(`[chatgpt] listSessionModels: backend-api status=${status}, geen modellen`);
  } catch (error) {
    console.warn('[chatgpt] listSessionModels failed', error);
  }
  invalidateSessionModelCatalog();
  // Honest: no fabricated models. If the endpoint can't be reached, show nothing.
  return [];
}

async function assertLiveSessionModelChoice(modelSlug: string, thinkingEffort?: string, language: UiLanguage = 'nl') {
  if (!versionSlugs.size) await listSessionModels();
  const error = chatGptChoiceValidationError(
    cachedVersions,
    versionSlugs,
    modelSlug,
    thinkingEffort,
    language,
  );
  if (error) throw new Error(error);
}

// ─── Send Chat (streaming via worker page context) ───────────────────────────

interface ChatGptSendOptions {
  modelSlug: string;
  thinkingEffort?: string;
  messages: ChatMessage[];
  systemPrompt?: string;
  attachments?: AttachmentRecord[];
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
  language?: UiLanguage;
}

async function sendChatViaSession(options: ChatGptSendOptions): Promise<{ text: string; usage: TokenUsage }> {
  return chatSendQueue.run(
    () => sendChatViaSessionUnlocked(options),
    {
      signal: options.signal,
      onWait: () => options.onStatus?.(localizedText(options.language || 'nl', 'Wacht op de actieve ChatGPT-websessie', 'Waiting for the active ChatGPT web session')),
    },
  );
}

async function sendChatViaSessionUnlocked(options: ChatGptSendOptions): Promise<{ text: string; usage: TokenUsage }> {
  // ChatGPT Subscription chat intentionally uses the real web app route only.
  // Direct /backend-api/f/conversation POSTs zijn bewust niet geïmplementeerd: chat
  // versturen blijft altijd bij de echte webclient. Backend-api is hier alleen
  // read-only voor model-, account- en sessiediscovery.
  debugLog('using ChatGPT websession transport', {
    route: 'web-session',
    model: options.modelSlug.replace(/^chatgpt:/, ''),
  });
  await assertLiveSessionModelChoice(options.modelSlug, options.thinkingEffort, options.language || 'nl');
  try {
    options.onStatus?.(localizedText(options.language || 'nl', 'ChatGPT websessie voorbereiden', 'Preparing the ChatGPT web session'));
  } catch {
    // Status callbacks are UI-only.
  }

  // Proactive cookie hygiene so navigations never hit HTTP 431 (cookie jar too big).
  await pruneChatGptCookiesIfLarge();

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      setEngineStage('session-check', {
        active: true,
        lastError: null,
        lastModel: options.modelSlug.replace(/^chatgpt:/, ''),
        recoverable: false,
      });

      return await sendChatViaDomDriver(options);
    } catch (error) {
      // An "unusual activity" error from the real page is final for this attempt.
      // Surface it honestly, do not loop or try to bypass the web-session block.
      if (isUnusualActivityError(error)) {
        const message = unusualActivityBlockedMessage(options.language || 'nl');
        setEngineStage('failed', { lastError: message, recoverable: true });
        throw makeEngineError(message, 'send-clicked', true);
      }
      lastError = error;
      const stage = ((error as any)?.chatgptStage || engineStatus.stage || 'failed') as ChatGptEngineStage;
      const friendly = friendlyChatGptError(error, stage, options.language || 'nl');
      const recoverable = (error as any)?.recoverable !== false;
      debugLog('engine failure', {
        attempt,
        stage,
        friendly,
        raw: (error as any)?.message || String(error),
      });

      if (attempt === 0 && recoverable && /antwoord startte geen antwoord|geen antwoord|geen stream|verstuurd maar niets terug|did not start an answer|no answer|no stream|sent but nothing|backend.*start/i.test(friendly + ' ' + ((error as any)?.message || ''))) {
        setEngineStage('recovering', { lastError: friendly, recoverable: true });
        if (chatWindow && !chatWindow.isDestroyed()) chatWindow.close();
        chatWindow = null;
        if (workerWindow && !workerWindow.isDestroyed()) workerWindow.close();
        workerWindow = null;
        continue;
      }

      setEngineStage('failed', { lastError: friendly, recoverable });
      throw makeEngineError(friendly, stage, recoverable);
    }
  }

  const stage = ((lastError as any)?.chatgptStage || engineStatus.stage || 'failed') as ChatGptEngineStage;
  const friendly = friendlyChatGptError(lastError, stage, options.language || 'nl');
  setEngineStage('failed', { lastError: friendly, recoverable: true });
  throw makeEngineError(friendly, stage, true);
}


function buildChatGptPrompt(messages: ChatMessage[], systemPrompt?: string, attachments: AttachmentRecord[] = [], language: UiLanguage = 'nl') {
  const lastUserIndex = [...messages].reverse().findIndex((message) => message.role === 'user');
  const actualLastUserIndex = lastUserIndex === -1 ? -1 : messages.length - 1 - lastUserIndex;
  const transcript = messages
    .map((m, index) => {
      const attached = m.role === 'user' ? chatMessageAttachments(m, attachments, index === actualLastUserIndex) : [];
      return `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${appendChatGptTextAttachments(m.content, attached, language)}`;
    })
    .join('\n\n');
  const base = (systemPrompt ? `${systemPrompt}\n\n` : '')
    + (messages.length > 1 ? transcript : appendChatGptTextAttachments(messages[messages.length - 1]?.content || '', chatMessageAttachments(messages[messages.length - 1], attachments, true), language));
  return base;
}

function chatMessageAttachments(message: ChatMessage | undefined, fallback: AttachmentRecord[], useFallback: boolean) {
  const own = Array.isArray(message?.attachments)
    ? (message!.attachments as AttachmentRecord[]).filter((attachment) => !!attachment && typeof attachment === 'object')
    : [];
  return own.length ? own : useFallback ? fallback : [];
}

function appendChatGptTextAttachments(input: string, attachments: AttachmentRecord[], language: UiLanguage = 'nl') {
  const text = attachments
    .filter((attachment) => attachment.textContent)
    .map((attachment) => `\n\n[${localizedText(language, 'Bijlage', 'Attachment')}: ${attachment.name}]\n${attachment.textContent}`)
    .join('');
  return text ? `${input}${text}` : input;
}


async function sendChatViaDomDriver(options: ChatGptSendOptions): Promise<{ text: string; usage: TokenUsage }> {
  const { modelSlug, thinkingEffort, messages, systemPrompt, attachments = [], signal, onDelta, onStatus } = options;
  const language = options.language || 'nl';
  const slug = modelSlug.replace(/^chatgpt:/, '');
  const requestBodyPatcherSource = patchChatGptConversationBody.toString();
  const reportStatus = (status: string) => {
    try {
      onStatus?.(status);
    } catch {
      // Status callbacks are UI-only; never let them break the web driver.
    }
  };

  // Assemble a single composer message. Temporary chat = no history pollution;
  // for multi-turn we include a transcript so the model has context. Keep this
  // on the shared prompt builder so uploaded files and path-read attachments
  // reach the ChatGPT web-session route too.
  const prompt = buildChatGptPrompt(messages, systemPrompt, attachments, language);

  await ensureStoredSessionCookies();
  await refreshAccessToken().catch(() => {});
  reportStatus(localizedText(language, 'ChatGPT websessie openen', 'Opening the ChatGPT web session'));
  let win = await ensureChatWindow();

  // Plan-B: drive the REAL ChatGPT web app so it generates all anti-bot tokens
  // (PoW, Turnstile, SO, …) itself. Open a temporary chat with the chosen model,
  // type the prompt, send it, and read the streamed answer from the page DOM.
  const targetUrl = `${CHATGPT_ORIGIN}/?temporary-chat=true&model=${encodeURIComponent(slug)}`;

  // Wait for the composer (input field) to appear. A slow load otherwise looks like
  // "composer not found". `win` is reassigned between retries, so read it lazily.
  const waitForComposer = () => win.webContents.executeJavaScript(`(async () => {
    const COMPOSER = ${JSON.stringify(COMPOSER_SELECTOR)};
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      if (document.querySelector(COMPOSER)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  })()`, true).catch(() => false);

  // Load the temporary-chat page and confirm the composer is present. WHY the
  // composer can be missing differs fundamentally:
  //   - blank/crashed render → transient, a fresh window fixes it (we retry)
  //   - real 403 "unusual activity" anti-bot → NOT retried, honest fail + recovery
  //   - Cloudflare / login wall → user must act
  // classifyChatGptPage() makes that distinction from the captured HTTP status.
  const MAX_ATTEMPTS = 3;
  let composerReady = false;
  let verdict: ReturnType<typeof classifyChatGptPage> | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    chatWinHttpStatus = 0;
    chatWinRenderGone = false;
    try {
      reportStatus(attempt === 1
        ? localizedText(language, 'ChatGPT websessie laden', 'Loading the ChatGPT web session')
        : localizedText(language, 'ChatGPT websessie herstellen', 'Recovering the ChatGPT web session'));
      await win.loadURL(targetUrl);
      await waitForChatGptPage(win, 12000);
      setEngineStage('page-ready');
    } catch (e) {
      console.warn('[chatgpt] loadURL failed', e);
    }

    reportStatus(localizedText(language, 'Composer zoeken', 'Looking for the composer'));
    composerReady = await waitForComposer();
    if (composerReady) break;

    // Composer missing — capture the DOM and classify the root cause.
    const diag = await win.webContents.executeJavaScript(`(function () {
      const q = (s) => document.querySelectorAll(s).length;
      return {
        url: location.href,
        title: document.title,
        composer: q(${JSON.stringify(COMPOSER_SELECTOR)}),
        textareas: q('textarea'),
        contenteditable: q('div[contenteditable="true"]'),
        bodyHead: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 500),
      };
    })()`, true).catch((e: any) => ({ error: String(e?.message || e) }));

    verdict = classifyChatGptPage({
      httpStatus: chatWinHttpStatus,
      url: diag?.url || targetUrl,
      title: diag?.title || '',
      bodyText: diag?.bodyHead || '',
      hasComposer: (diag?.composer || 0) > 0,
      renderGone: chatWinRenderGone,
    }, language);
    debugLog('composer MISSING', { attempt, httpStatus: chatWinHttpStatus, renderGone: chatWinRenderGone, verdict, diag });
    console.warn(`[chatgpt] composer MISSING (poging ${attempt}/${MAX_ATTEMPTS}) → ${verdict.kind}: ${verdict.message}`);

    // A real block / Cloudflare / login wall won't fix itself by retrying.
    if (!verdict.retryable) break;
    if (attempt < MAX_ATTEMPTS) {
      // HTTP 431 = cookie jar too big → prune non-essential cookies before retrying,
      // otherwise every reload hits the same oversized-header wall.
      if (verdict.kind === 'headers' || chatWinHttpStatus === 431) {
        const removed = await pruneChatGptCookies();
        console.warn(`[chatgpt] HTTP 431 — pruned ${removed} non-essential cookies, retrying`);
      }
      win = await createFreshChatWindow();
      await new Promise((r) => setTimeout(r, 400 * attempt)); // small backoff
    }
  }

  if (!composerReady) {
    const v = verdict || classifyChatGptPage({ httpStatus: chatWinHttpStatus, renderGone: chatWinRenderGone }, language);
    if (v.kind === 'blocked') {
      // Message contains "unusual activity" → sendChatViaSession applies the cooldown
      // and reports honestly. We do NOT try to bypass this; it's a real block.
      throw makeEngineError(unusualActivityBlockedMessage(language), 'composer-ready', true);
    }
    // Pass the honest, classified message through (it starts with "ChatGPT" so
    // friendlyChatGptError keeps it verbatim).
    throw makeEngineError(v.message, 'composer-ready', v.recoverable);
  }
  setEngineStage('composer-ready');
  reportStatus(localizedText(language, 'Composer klaar', 'Composer ready'));

  if (attachments.length) {
    reportStatus(localizedText(language, 'Bijlagen uploaden', 'Uploading attachments'));
    await uploadFilesToChatGpt(win, attachments.map((attachment) => attachment.path).filter((filePath): filePath is string => !!filePath));
  }

  const driver = `
    (async () => {
      const S = (window.__cgbuf = { text: '', done: false, error: null, status: 0, sent: false, stage: 'init', modelSlug: '', convId: '', reqModel: '', reqUrl: '', sample: '', reqBody: '', modelLines: [], firstFrames: [], lastFrames: [], frameCount: 0, esFrames: 0, esModelLines: [], wsFrames: 0, wsModelLines: [], modelSlugSource: '' });
      const patchRequestBody = ${requestBodyPatcherSource};
      window.__cgModel = ${JSON.stringify(slug)};
      window.__cgEffort = ${JSON.stringify(thinkingEffort || '')};
      window.__cgNet = window.__cgNet || [];
      if (!window.__cgHooked) {
        window.__cgHooked = true;
        // Debug recorder: every fetch + XHR endpoint, so we can see where the
        // completion request really goes.
        try {
          const ox = window.XMLHttpRequest.prototype.open;
          window.XMLHttpRequest.prototype.open = function (m, url) {
            try { window.__cgNet.push('XHR ' + String(m).toUpperCase() + ' ' + String(url)); } catch (e) {}
            return ox.apply(this, arguments);
          };
        } catch (e) {}
        // Het antwoord komt na een "stream_handoff" over een TWEEDE verbinding. De
        // opties zijn resume_sse_endpoint of subscribe_ws_topic; ChatGPT kiest de
        // WebSocket. Frames daarin zijn vaak base64 in een "body"-veld, dus zoeken
        // op platte tekst werkt niet zonder eerst te decoderen.
        try {
          const scanForSlug = function (d) {
            const S2 = window.__cgbuf;
            if (!S2 || !d) return;
            const text = String(d);
            S2.wsFrames = (S2.wsFrames || 0) + 1;

            // Een WS-frame is JSON. De échte SSE zit als string in encoded_item, met
            // ge-escapete quotes — daar matcht een regex op "model_slug" dus nooit op.
            // Eerst parsen, dán de ontsnapte inhoud scannen.
            const parts = [text];
            try {
              const parsed = JSON.parse(text);
              const items = Array.isArray(parsed) ? parsed : [parsed];
              for (let i = 0; i < items.length; i++) {
                const it = items[i] || {};
                const inner = (it.payload && it.payload.payload) || {};
                if (typeof inner.encoded_item === 'string') parts.push(inner.encoded_item);
                if (typeof it.body === 'string') { try { parts.push(atob(it.body)); } catch (e) {} }
              }
            } catch (e) {}

            for (let i = 0; i < parts.length && !S2.modelSlug; i++) {
              const c = parts[i];
              let mm = c.match(/"model_slug"\\s*:\\s*"([^"]+)"/);
              if (!mm) mm = c.match(/\\/message\\/metadata\\/model_slug"[\\s\\S]*?"v"\\s*:\\s*"([^"]+)"/);
              if (mm) { S2.modelSlug = mm[1]; S2.modelSlugSource = 'websocket'; }
            }
            if (S2.wsModelLines && S2.wsModelLines.length < 10 && text.indexOf('model') !== -1) {
              S2.wsModelLines.push(text.slice(0, 400));
            }
          };
          const OWS = window.WebSocket;
          if (OWS && !OWS.__cgPatched) {
            const PatchedWS = function (url, protocols) {
              const ws = protocols === undefined ? new OWS(url) : new OWS(url, protocols);
              try { window.__cgNet.push('WS ' + String(url)); } catch (e) {}
              try { ws.addEventListener('message', function (ev) { scanForSlug(ev && ev.data); }); } catch (e) {}
              return ws;
            };
            PatchedWS.prototype = OWS.prototype;
            PatchedWS.CONNECTING = OWS.CONNECTING; PatchedWS.OPEN = OWS.OPEN;
            PatchedWS.CLOSING = OWS.CLOSING; PatchedWS.CLOSED = OWS.CLOSED;
            PatchedWS.__cgPatched = true;
            window.WebSocket = PatchedWS;
          }
        } catch (e) {}
        try {
          const OES = window.EventSource;
          if (OES && !OES.__cgPatched) {
            const Patched = function (url, cfg) {
              const es = new OES(url, cfg);
              try { window.__cgNet.push('EVENTSOURCE ' + String(url)); } catch (e) {}
              try {
                es.addEventListener('message', function (ev) {
                  const d = String((ev && ev.data) || '');
                  if (!d) return;
                  const S2 = window.__cgbuf;
                  if (!S2) return;
                  S2.esFrames = S2.esFrames || 0;
                  S2.esFrames++;
                  if (!S2.modelSlug) {
                    let mm = d.match(/"model_slug"\\s*:\\s*"([^"]+)"/);
                    if (!mm) mm = d.match(/\\/message\\/metadata\\/model_slug"[\\s\\S]*?"v"\\s*:\\s*"([^"]+)"/);
                    if (mm) S2.modelSlug = mm[1];
                  }
                  if (S2.esModelLines && S2.esModelLines.length < 10 && d.indexOf('model') !== -1) {
                    S2.esModelLines.push(d.slice(0, 400));
                  }
                });
              } catch (e) {}
              return es;
            };
            Patched.prototype = OES.prototype;
            Patched.__cgPatched = true;
            window.EventSource = Patched;
          }
        } catch (e) {}
        const of = window.fetch;
        window.fetch = function (...a) {
          let u = '';
          try { u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || ''; } catch (e) {}
          let method = 'GET';
          try { method = String((a[1] && a[1].method) || (a[0] && a[0].method) || 'GET').toUpperCase(); } catch (e) {}
          try { window.__cgNet.push('FETCH ' + method + ' ' + u); } catch (e) {}
          // The streaming completion is a POST to .../conversation (singular).
          // Catches /backend-api/conversation AND /backend-api/f/conversation.
          // Excludes /conversations (history list) and /conversation/init.
          const isStreamPost = method === 'POST'
            && u.indexOf('/conversation') !== -1
            && u.indexOf('/conversations') === -1
            && u.indexOf('/init') === -1;
          // De SPA kan bij de eerste koude beurt de ?model-keuze negeren en nog
          // haar vorige standaardmodel versturen. Trek uitsluitend model + effort
          // gelijk met de al live gevalideerde keuze; de webapp maakt de rest.
          if (isStreamPost) {
            try {
              const body = a[1] && a[1].body;
              if (typeof body === 'string') {
                const patched = patchRequestBody(body, window.__cgModel, window.__cgEffort);
                if (patched !== body) a[1] = Object.assign({}, a[1], { body: patched });
              }
            } catch (e) {}
          }
          const pr = of.apply(this, a);
          if (isStreamPost) {
            const B = window.__cgbuf;
            B.stage = 'streaming';
            B.reqUrl = u;
            // What the SPA actually asked the backend for (the URL ?model= may be ignored).
            try {
              const body = a[1] && a[1].body;
              if (typeof body === 'string') {
                const rm = body.match(/"model"\\s*:\\s*"([^"]+)"/);
                if (rm) B.reqModel = rm[1];
                // Capture the FULL body (cap to avoid pathological sizes).
                if (!B.reqBody) B.reqBody = body.slice(0, 200000);
              }
            } catch (e) {}
            pr.then(async (res) => {
              try {
                B.status = res.status;
                const clone = res.clone();
                if (!clone.body) { B.done = true; return; }
                const reader = clone.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                while (true) {
                  const r = await reader.read();
                  if (r.done) break;
                  buf += dec.decode(r.value, { stream: true });
                  if (B.sample.length < 1200) B.sample += buf.slice(0, 1200 - B.sample.length);
                  const lines = buf.split('\\n');
                  buf = lines.pop() || '';
                  for (const line of lines) {
                    const t = line.trim();
                    if (!t.startsWith('data:')) continue;
                    const d = t.slice(5).trim();
                    if (!d || d === '[DONE]') continue;
                    // Ground truth: the backend stamps the model that actually answered.
                    // The SSE is delta/patch-shaped, so scan the raw line. Two shapes:
                    //  - full:  "model_slug":"gpt-5-2"
                    //  - patch: "p":"/message/metadata/model_slug",...,"v":"gpt-5-2"
                    // "default_model_slug" won't match the first (no quote before it).
                    if (!B.modelSlug) {
                      let mm = d.match(/"model_slug"\\s*:\\s*"([^"]+)"/);
                      if (!mm) mm = d.match(/\\/message\\/metadata\\/model_slug"[\\s\\S]*?"v"\\s*:\\s*"([^"]+)"/);
                      if (mm) B.modelSlug = mm[1];
                    }
                    if (!B.convId) {
                      const cm = d.match(/"conversation_id"\\s*:\\s*"([^"]+)"/);
                      if (cm) B.convId = cm[1];
                    }
                    // Diagnose: bewaar elke frame waarin "model" voorkomt, zodat we zien
                    // WAAR ChatGPT het antwoordende model meldt bij delta_encoding v1.
                    if (B.modelLines.length < 20 && d.indexOf('model') !== -1) {
                      B.modelLines.push(d.slice(0, 300));
                    }
                    // En leg de eerste + laatste frames onverkort vast: bij delta-encoding
                    // hoort het eerste frame het volledige bericht (incl. metadata) te dragen.
                    B.frameCount = (B.frameCount || 0) + 1;
                    if (B.firstFrames.length < 6) B.firstFrames.push(d.slice(0, 2000));
                    B.lastFrames.push(d.slice(0, 500));
                    if (B.lastFrames.length > 8) B.lastFrames.shift();
                    try {
                      const ev = JSON.parse(d);
                      const parts = ev && ev.message && ev.message.content && ev.message.content.parts;
                      const role = ev && ev.message && ev.message.author && ev.message.author.role;
                      if (Array.isArray(parts) && role === 'assistant') {
                        const f = parts.join('');
                        if (f.length > B.text.length) B.text = f;
                      }
                      // The backend reports which model actually answered. This is the
                      // ground truth — not what the model "says" it is.
                      const ms = ev && ev.message && ev.message.metadata && ev.message.metadata.model_slug;
                      if (ms && role === 'assistant') B.modelSlug = String(ms);
                      if (ev && ev.error) B.error = String(ev.error);
                    } catch (e) {}
                  }
                }
                B.done = true;
              } catch (e) { B.error = String((e && e.message) || e); B.done = true; }
            }).catch((e) => { B.error = String((e && e.message) || e); B.done = true; });
          }
          return pr;
        };
      }
      const COMPOSER = ${JSON.stringify(COMPOSER_SELECTOR)};
      const SEND = ${JSON.stringify(SEND_SELECTOR)};
      const findComposer = () => document.querySelector(COMPOSER);
      let composer = null; const t0 = Date.now();
      while (!composer && Date.now() - t0 < 25000) { composer = findComposer(); if (!composer) await new Promise((r) => setTimeout(r, 250)); }
      if (!composer) { S.error = 'composer not found'; S.done = true; return; }
      S.stage = 'typing';
      composer.focus();
      const PROMPT = ${JSON.stringify(prompt)};
      try {
        if (composer.tagName === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(composer, PROMPT);
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          const range = document.createRange();
          range.selectNodeContents(composer);
          const sel = window.getSelection();
          if (sel) { sel.removeAllRanges(); sel.addRange(range); }
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, PROMPT);
          composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: PROMPT, inputType: 'insertText' }));
        }
      } catch (e) { S.error = 'type failed: ' + ((e && e.message) || e); }
      await new Promise((r) => setTimeout(r, 400));
      S.stage = 'sending';
      const findSend = () => document.querySelector(SEND);
      let send = findSend(); const t1 = Date.now();
      while ((!send || send.disabled) && Date.now() - t1 < 6000) { send = findSend(); if (!send || send.disabled) await new Promise((r) => setTimeout(r, 150)); }
      if (send && !send.disabled) { send.click(); S.sent = true; }
      else {
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        S.sent = true;
      }
    })();
    true
  `;
  setEngineStage('message-injected');
  reportStatus(localizedText(language, 'Bericht versturen', 'Sending message'));
  await win.webContents.executeJavaScript(driver, true);
  setEngineStage('send-clicked');
  reportStatus(localizedText(language, 'ChatGPT denkt', 'ChatGPT is thinking'));

  let text = '';
  let last: any = null;
  let modelVerificationError = '';
  const start = Date.now();
  let stableSince = 0;
  let sawStreaming = false;
  let reportedFirstText = false;
  let nativeRetried = false;
  try {
    while (true) {
      if (signal.aborted) break;
      last = await win.webContents.executeJavaScript(
        `(function () {
          const s = window.__cgbuf || {};
          const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
          const el = nodes[nodes.length - 1];
          let dom = '';
          if (el) {
            // Read ONLY the real answer (.markdown/.prose). During the "Denkt na"
            // thinking phase there is no .markdown yet, so we keep waiting instead
            // of mistaking the status text for the answer.
            const content = el.querySelector('.markdown') || el.querySelector('[class*="markdown"]') || el.querySelector('.prose');
            if (content) {
              // Reconstruct markdown so fenced code blocks survive (innerText drops the
              // backticks). Needed so the host can detect/run code the model writes.
              const F = String.fromCharCode(96, 96, 96);
              const extract = (node) => {
                let out = '';
                node.childNodes.forEach((c) => {
                  if (c.nodeType === 3) { out += c.textContent; return; }
                  if (c.nodeType !== 1) return;
                  const tag = c.tagName;
                  if (tag === 'PRE') {
                    const codeEl = c.querySelector('code') || c;
                    const lang = ((codeEl.className || '').match(/language-([\\w+#-]+)/) || [])[1] || '';
                    out += '\\n' + F + lang + '\\n' + (codeEl.innerText || '') + '\\n' + F + '\\n';
                  } else if (tag === 'BR') { out += '\\n'; }
                  else {
                    out += extract(c);
                    if (/^(P|DIV|LI|H[1-6]|UL|OL|TABLE)$/.test(tag)) out += '\\n';
                  }
                });
                return out;
              };
              dom = extract(content).replace(/\\n{3,}/g, '\\n\\n').trim();
            }
          }
          const stop = !!(document.querySelector('[data-testid="stop-button"]') || document.querySelector('button[aria-label*="Stop" i]'));
          return { dom: dom, streaming: stop, status: s.status || 0, error: s.error || null, sent: s.sent || false, stage: s.stage || '', modelSlug: s.modelSlug || '', convId: s.convId || '', pageUrl: location.pathname || '', reqModel: s.reqModel || '', reqUrl: s.reqUrl || '', sample: s.sample || '', reqBody: s.reqBody || '', modelLines: s.modelLines || [], firstFrames: s.firstFrames || [], lastFrames: s.lastFrames || [], frameCount: s.frameCount || 0, esFrames: s.esFrames || 0, esModelLines: s.esModelLines || [], wsFrames: s.wsFrames || 0, wsModelLines: s.wsModelLines || [], modelSlugSource: s.modelSlugSource || '', net: (window.__cgNet || []).slice(-40) };
        })()`,
      );
      if (last) {
        if (last.error) throw makeEngineError('ChatGPT: ' + last.error, 'send-clicked', true);
        if (last.reqModel && last.reqModel !== slug) {
          throw makeEngineError(
            localizedText(language,
              `ChatGPT wilde ${slug} gebruiken, maar de website verstuurde ${last.reqModel}. Het antwoord is gestopt om een verborgen modelfallback te voorkomen.`,
              `ChatGPT was asked to use ${slug}, but the website sent ${last.reqModel}. The answer was stopped to prevent a hidden model fallback.`),
            'send-clicked',
            true,
          );
        }
        if (last.streaming) {
          if (!sawStreaming) {
            setEngineStage('stream-detected');
          }
          sawStreaming = true;
        }
        const dom: string = last.dom || '';
        if (dom.length > text.length) {
          if (!reportedFirstText) {
            reportedFirstText = true;
            reportStatus(localizedText(language, 'Antwoord streamt', 'Answer is streaming'));
          }
          onDelta(dom.slice(text.length));
          text = dom;
          stableSince = Date.now();
        }
        // Done once we have text, generation stopped, and it stayed stable a moment.
        if (text && !last.streaming && stableSince && Date.now() - stableSince > 1200) break;
      }
      // "No answer started" only applies while nothing is happening — thinking models
      // can churn for a while before the .markdown answer appears, so don't trip then.
      if (!nativeRetried && !last?.reqUrl && !sawStreaming && Date.now() - start > 8000) {
        nativeRetried = true;
        reportStatus(localizedText(language, 'Bericht opnieuw versturen', 'Sending the message again'));
        debugLog('plan-B native input retry', {
          stage: last?.stage || '',
          sent: !!last?.sent,
          status: last?.status || 0,
          net: (last?.net || []).slice(-10),
        });
        try {
          await nativeComposerSend(win, prompt);
        } catch (error: any) {
          debugLog('plan-B native input retry failed', error?.message || String(error));
        }
      }
      if (nativeRetried && !last?.reqUrl && !text && !sawStreaming && Date.now() - start > 22000) {
        throw makeEngineError(localizedText(language, 'ChatGPT browserflow kon geen backend POST starten na klikken op versturen', 'The ChatGPT browser flow could not start a backend POST after clicking send'), 'send-clicked', true);
      }
      if (last?.sent && !text && !sawStreaming && Date.now() - start > 60000) throw makeEngineError(localizedText(language, 'Bericht verstuurd, maar ChatGPT startte geen antwoord', 'Message sent, but ChatGPT did not start an answer'), 'send-clicked', true);
      if (Date.now() - start > 240000) throw makeEngineError(localizedText(language, 'ChatGPT web-engine liep vast tijdens wachten op antwoord', 'The ChatGPT web engine timed out while waiting for an answer'), sawStreaming ? 'stream-detected' : 'send-clicked', true);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    let actualSlug = (last?.modelSlug || '').trim();
    let slugSource = actualSlug ? (last?.modelSlugSource || 'sse') : '';
    let slugFailure = '';

    // Reasoning-modellen (Gemiddeld/Hoog) stampen hun model_slug niet altijd in de
    // SSE-stream. Vraag het dan gezaghebbend na bij de backend. Het gesprek-id komt
    // uit de stream óf uit de URL (/c/<uuid>) — zonder id is er geen fallback.
    const convId = (last?.convId || '').trim()
      || (String(last?.pageUrl || '').match(/\/c\/([0-9a-fA-F-]{36})/)?.[1] || '');

    if (!actualSlug && convId) {
      // De backend heeft het antwoord soms nog niet weggeschreven: kort opnieuw proberen.
      for (const wait of [0, 400, 1200]) {
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        try {
          const conv = await apiGet(`/backend-api/conversation/${convId}`);
          // Staat geschiedenis uit (history_and_training_disabled), dan bewaart ChatGPT
          // het gesprek niet en antwoordt de API met {detail: ...}. Blijven pollen is zinloos.
          if (!conv?.data?.mapping && conv?.data?.detail) {
            const detail = typeof conv.data.detail === 'string' ? conv.data.detail : JSON.stringify(conv.data.detail);
            slugFailure = `conversation-api weigerde (status ${conv.status}): ${detail.slice(0, 100)}`;
            break;
          }
          const mapping = conv?.data?.mapping || {};
          // Object.keys is géén chronologische volgorde -> pak het NIEUWSTE
          // bericht, anders lees je een ouder model uit hetzelfde gesprek.
          const pickNewest = (accept: (msg: any) => boolean) => {
            let newest: { slug: string; at: number } | null = null;
            for (const key of Object.keys(mapping)) {
              const msg = mapping[key]?.message;
              if (!msg || !accept(msg)) continue;
              const msgSlug = msg?.metadata?.model_slug;
              if (!msgSlug) continue;
              const at = Number(msg.create_time) || 0;
              if (!newest || at >= newest.at) newest = { slug: String(msgSlug), at };
            }
            return newest;
          };

          // Een reasoning-antwoord bestaat uit meerdere berichten (gedachten + antwoord).
          // Het assistant-bericht draagt de slug niet altijd; accepteer dan elk bericht
          // dat 'm wél heeft, maar noteer die zwakkere herkomst apart.
          const fromAssistant = pickNewest((msg) => msg?.author?.role === 'assistant');
          const fromAnyMessage = fromAssistant || pickNewest(() => true);
          if (fromAnyMessage) {
            actualSlug = fromAnyMessage.slug;
            slugSource = fromAssistant ? 'conversation-api' : 'conversation-api(any-role)';
            slugFailure = '';
            break;
          }

          slugFailure = 'gesprek bevat geen bericht met model_slug';
          // Niet gokken: laat zien wat er dan wél in dat gesprek staat.
          debugLog('conversation zonder model_slug', {
            convKeys: Object.keys(conv?.data || {}),
            messages: Object.values(mapping).slice(0, 25).map((node: any) => ({
              role: node?.message?.author?.role,
              contentType: node?.message?.content?.content_type,
              metadataKeys: Object.keys(node?.message?.metadata || {}),
              modelFields: Object.fromEntries(
                Object.entries(node?.message?.metadata || {}).filter(([key]) => /model/i.test(key)),
              ),
            })),
          });
        } catch (error: any) {
          slugFailure = `conversation-api faalde: ${error?.message || String(error)}`;
        }
      }
    } else if (!actualSlug) {
      slugFailure = 'geen conversation-id (niet in stream, niet in URL)';
    }

    // De pagina zelf bevraagt /stream_status met datzelfde gesprek-id. Werkt dat ook
    // met geschiedenis uit, dan hebben we alsnog een gezaghebbende bron.
    if (!actualSlug && convId) {
      try {
        const status = await apiGet(`/backend-api/conversation/${convId}/stream_status`);
        const fromStatus = status?.data?.model_slug || status?.data?.model || '';
        if (fromStatus) {
          actualSlug = String(fromStatus);
          slugSource = 'stream_status';
          slugFailure = '';
        } else {
          debugLog('stream_status zonder model', { keys: Object.keys(status?.data || {}), body: status?.data });
        }
      } catch (error: any) {
        debugLog('stream_status faalde', error?.message || String(error));
      }
    }

    // Meldt de backend het model terug, dan is dat de waarheid. Doet hij dat niet
    // (reasoning-antwoorden streamen via een conduit én met geschiedenis uit is er
    // geen gesprek om na te vragen), dan is het uitgaande verzoek het beste bewijs
    // dat we hebben. Dat is géén "onbekend": we weten dan zeker wát we vroegen,
    // alleen niet wat er antwoordde. Die twee niet op één hoop gooien.
    const reqModel = (last?.reqModel || '').trim();
    const match = actualSlug
      ? (actualSlug === slug ? 'EXACT' : (actualSlug.startsWith(slug) || slug.startsWith(actualSlug) ? 'FAMILY' : 'MISMATCH'))
      : reqModel
        ? (reqModel === slug ? 'REQUEST-OK' : 'REQUEST-MISMATCH')
        : 'UNKNOWN';
    const summary = { stage: last?.stage, sent: last?.sent, status: last?.status, streaming: last?.streaming, textLen: text.length, requested: slug, reqModel: last?.reqModel || '', actual: actualSlug, slugSource, match, ...(slugFailure ? { slugFailure } : {}) };
    console.log('[chatgpt] plan-B', summary);
    if (CHATGPT_DIAGNOSTICS_ENABLED) console.log('[chatgpt] geredigeerde diagnostiek ->', debugLogPath());
    debugLog('plan-B summary', summary);
    debugLog('plan-B reqUrl', last?.reqUrl || '(none)');
    debugLog('plan-B request metadata', summarizeRequestBody(last?.reqBody || ''));
    debugLog('plan-B network (conversation-calls)', (last?.net || []).filter((line: string) => /conversation/i.test(line)));
    if (match === 'MISMATCH') {
      console.warn(`[chatgpt] MODEL MISMATCH: vroeg "${slug}" maar backend gebruikte "${actualSlug}" — de website viel terug op een ander model.`);
      modelVerificationError = localizedText(language, `ChatGPT gebruikte ${actualSlug} in plaats van het gekozen model ${slug}. Het antwoord is afgekeurd.`, `ChatGPT used ${actualSlug} instead of the selected model ${slug}. The answer was rejected.`);
    }
    if (match === 'REQUEST-MISMATCH') {
      console.warn(`[chatgpt] VERZOEK-MISMATCH: wilde "${slug}" maar de site verstuurde "${reqModel}".`);
      modelVerificationError = localizedText(language, `ChatGPT verstuurde ${reqModel} in plaats van het gekozen model ${slug}. Het antwoord is afgekeurd.`, `ChatGPT sent ${reqModel} instead of the selected model ${slug}. The answer was rejected.`);
    }
    if (match === 'REQUEST-OK') {
      // Geen alarm: het verzoek klopte aantoonbaar. De backend meldt het model
      // alleen niet terug (reasoning streamt via een conduit, en met geschiedenis
      // uit bestaat er geen gesprek om na te vragen).
      console.log(`[chatgpt] verzoek verstuurde "${reqModel}" zoals gevraagd; backend meldde geen model terug (${slugFailure || 'geen model_slug in de stream'})`);
    }
    if (!actualSlug) {
      // Waar meldt ChatGPT het model dan wél? Deze frames zijn het enige bewijs.
      debugLog('plan-B stream frames (ruw)', {
        frameCount: last?.frameCount || 0,
        firstFrames: last?.firstFrames || [],
        lastFrames: last?.lastFrames || [],
        framesMetModel: last?.modelLines || [],
        eventSourceFrames: last?.esFrames || 0,
        eventSourceModelLines: last?.esModelLines || [],
        webSocketFrames: last?.wsFrames || 0,
        webSocketModelLines: last?.wsModelLines || [],
        alleNetwerkcalls: last?.net || [],
      });
      console.warn(`[chatgpt] geen model gevonden — POST: ${last?.frameCount || 0} frames, EventSource: ${last?.esFrames || 0}, WebSocket: ${last?.wsFrames || 0} (${(last?.wsModelLines || []).length} met "model"). Zie ${debugLogPath()}`);
    }
    if (match === 'UNKNOWN') {
      const modelLines: string[] = last?.modelLines || [];
      console.warn(`[chatgpt] geen model_slug in de stream (${modelLines.length} frames met "model").`);
    }
    // REQUEST-OK is gezond: geen dump nodig. Bij een afwijking gaat ruwe informatie
    // uitsluitend geredigeerd naar het expliciet ingeschakelde diagnosebestand.
    if (match === 'MISMATCH' || match === 'REQUEST-MISMATCH' || match === 'UNKNOWN') {
      const net: string[] = (last?.net || []).filter((line: string) => /conversation/i.test(line));
      debugLog('plan-B stream sample', (last?.sample || '(empty)').slice(0, 8_000));
      debugLog('plan-B afwijkende netwerkcalls', net.length ? net : (last?.net || []).slice(-15));
      console.warn(
        `[chatgpt] afwijkende modeldiagnose: ${last?.frameCount || 0} POST-frames, `
        + `${net.length} gesprekscalls${CHATGPT_DIAGNOSTICS_ENABLED ? `; geredigeerde details: ${debugLogPath()}` : ''}.`,
      );
    }
    win.webContents.executeJavaScript(`try { window.__cgbuf = null; } catch (e) {}`).catch(() => {});
  }

  if (modelVerificationError) {
    throw makeEngineError(modelVerificationError, 'response-complete', true);
  }
  if (!text) {
    // If the page's own POST got blocked too, report it as unusual-activity so the
    // caller can back off honestly (instead of a vague "no answer").
    const sample = String(last?.sample || '');
    if (last?.status === 403 || last?.status === 429 || /unusual activity|try again later/i.test(sample)) {
      throw makeEngineError(unusualActivityBlockedMessage(language), 'send-clicked', true);
    }
    throw makeEngineError(localizedText(language, 'Bericht verstuurd, maar ChatGPT startte geen antwoord', 'Message sent, but ChatGPT did not start an answer'), 'send-clicked', true);
  }
  setEngineStage('response-complete', { lastError: null, recoverable: false, lastModel: (last?.modelSlug || slug || '').trim() || slug });

  const inputTokens = Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
  const outputTokens = Math.ceil(text.length / 4);
  return {
    text,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      contextWindowSize: 128000,
      contextUsedPercent: Math.round((inputTokens / 128000) * 100),
      source: 'estimate',
    },
  };
}

// ─── Account Plan ──────────────────────────────────────────────────────────

async function nativeComposerSend(win: BrowserWindow, prompt: string): Promise<void> {
  const focusDiag = await win.webContents.executeJavaScript(
    `(async () => {
      const COMPOSER = ${JSON.stringify(COMPOSER_SELECTOR)};
      const SEND = ${JSON.stringify(SEND_SELECTOR)};
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let composer = document.querySelector(COMPOSER);
      const t0 = Date.now();
      while (!composer && Date.now() - t0 < 5000) {
        await wait(100);
        composer = document.querySelector(COMPOSER);
      }
      if (!composer) {
        return { ok: false, reason: 'composer missing', url: location.href, title: document.title };
      }
      composer.focus();
      try {
        if (composer.tagName === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter) setter.call(composer, '');
          else composer.value = '';
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          const range = document.createRange();
          range.selectNodeContents(composer);
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            sel.addRange(range);
          }
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        }
      } catch (error) {
        return { ok: false, reason: 'clear failed: ' + ((error && error.message) || error) };
      }
      return {
        ok: true,
        sendCount: document.querySelectorAll(SEND).length,
        currentText: (composer.innerText || composer.value || '').slice(0, 80),
      };
    })()`,
    true,
  );
  debugLog('native input focus', focusDiag);
  if (!focusDiag?.ok) return;

  const dbg = win.webContents.debugger;
  let attachedHere = false;
  if (!dbg.isAttached()) {
    dbg.attach('1.3');
    attachedHere = true;
  }
  try {
    await dbg.sendCommand('Input.insertText', { text: prompt });
  } finally {
    if (attachedHere && dbg.isAttached()) dbg.detach();
  }

  await new Promise((resolve) => setTimeout(resolve, 600));
  const sendDiag = await win.webContents.executeJavaScript(
    `(async () => {
      const COMPOSER = ${JSON.stringify(COMPOSER_SELECTOR)};
      const SEND = ${JSON.stringify(SEND_SELECTOR)};
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let send = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        send = document.querySelector(SEND);
        if (send && !send.disabled && send.getAttribute('aria-disabled') !== 'true') break;
        await wait(150);
      }
      const disabled = !!(send && (send.disabled || send.getAttribute('aria-disabled') === 'true'));
      if (window.__cgbuf) {
        window.__cgbuf.sent = true;
        window.__cgbuf.stage = 'native-sending';
      }
      if (send && !disabled) {
        send.click();
        return { clicked: true, disabled: false, label: send.getAttribute('aria-label') || send.textContent || '' };
      }
      const composer = document.querySelector(COMPOSER);
      if (composer) {
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }
      return { clicked: false, disabled, hasSend: !!send, hasComposer: !!composer };
    })()`,
    true,
  );
  debugLog('native input send', sendDiag);
}

async function uploadFilesToChatGpt(win: BrowserWindow, filePaths: string[]) {
  if (!filePaths.length) return;
  console.log('[chatgpt] upload: starting for', filePaths.length, 'file(s)');
  const foundInput = await win.webContents.executeJavaScript(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const input = document.querySelector('input[type="file"]');
      if (input) return true;
      const controls = Array.from(document.querySelectorAll('button,[role="button"],[aria-haspopup]'));
      const upload = controls.find((el) => /attach|upload|bestand|bijlage|paperclip|toevoeg|add photos|add files/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')));
      try { if (upload) upload.click(); } catch (e) {}
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return !!document.querySelector('input[type="file"]');
  })()`, true);
  console.log('[chatgpt] upload: file input present =', foundInput);

  const dbg = win.webContents.debugger;
  let attachedHere = false;
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
      attachedHere = true;
    }
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true }) as any;
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' }) as any;
    if (!nodeId) throw new Error('ChatGPT upload control not found');
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: filePaths });
    console.log('[chatgpt] upload: files set on input, waiting for processing…');
  } catch (error: any) {
    console.warn('[chatgpt] upload: failed to set files —', error?.message || error);
    throw new Error(error?.message || 'ChatGPT upload control not found');
  } finally {
    if (attachedHere && dbg.isAttached()) dbg.detach();
  }

  const ready = await win.webContents.executeJavaScript(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      const error = document.querySelector('[data-testid*="upload-error" i],[aria-label*="upload failed" i],[aria-label*="upload mislukt" i]');
      if (error) return { ok: false, error: (error.textContent || 'ChatGPT upload failed').trim() };
      const busy = document.querySelector('[aria-label*="Uploading" i],[aria-label*="uploaden" i],[data-testid*="uploading" i]');
      if (!busy) return { ok: true };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { ok: false, error: 'ChatGPT upload timed out' };
  })()`, true);
  console.log('[chatgpt] upload: result =', ready);
  if (!ready?.ok) throw new Error(ready?.error || 'ChatGPT upload failed');
}

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  go: 'Go',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

function normalizePlanLabel(raw: unknown): string | null {
  if (!raw) return null;
  const key = String(raw).toLowerCase()
    .replace(/^chatgpt[_-]?/, '')
    .replace(/[_-]?subscription$/, '')
    .replace(/[_-]?plan$/, '');
  return PLAN_LABELS[key] || String(raw);
}

async function getAccountPlan(): Promise<string | null> {
  // /backend-api/accounts/check bevat ALLE accounts (persoonlijk + werk-workspaces).
  // Een werk-workspace (Business/Team/Enterprise) heeft voorrang op het persoonlijke
  // account, zodat we het echte actieve abonnement tonen i.p.v. altijd "Plus".
  try {
    const { ok, data } = await apiGet('/backend-api/accounts/check/v4-2023-04-27');
    if (ok && data?.accounts) {
      const entries = Object.entries(data.accounts as Record<string, any>).filter(([key]) => key !== 'default');
      const parsed = entries.map(([, acc]) => {
        const account = acc?.account || acc || {};
        const ent = acc?.entitlement || account?.entitlement || {};
        const rawPlan = ent?.subscription_plan || ent?.plan_type || account?.plan_type;
        const structure = String(account?.structure || account?.account_structure || '').toLowerCase();
        const isWorkspace = structure === 'workspace' || /business|team|enterprise/i.test(String(rawPlan || ''));
        return {
          plan: normalizePlanLabel(rawPlan),
          name: typeof account?.name === 'string' ? account.name : undefined,
          isWorkspace,
          active: !!ent?.has_active_subscription,
        };
      });
      const pick =
        parsed.find((a) => a.isWorkspace && a.plan && a.active) ||
        parsed.find((a) => a.isWorkspace && a.plan) ||
        parsed.find((a) => a.plan && a.active) ||
        parsed.find((a) => a.plan);
      if (pick?.plan) {
        return pick.isWorkspace && pick.name ? `${pick.plan} · ${pick.name}` : pick.plan;
      }
    }
  } catch { /* door naar /me */ }

  // Fallback: /backend-api/me (persoonlijk account).
  try {
    const { ok, data } = await apiGet('/backend-api/me');
    if (ok && data) {
      const raw = data?.account_plan?.plan_type || data?.plan_type || (data?.has_plus ? 'plus' : null);
      const label = normalizePlanLabel(raw);
      if (label) return label;
    }
  } catch { /* niks gevonden */ }

  return null;
}

// ─── Session Status ────────────────────────────────────────────────────────

async function getSessionStatus() {
  const sess = await loadSession();
  const plan = sess ? await getAccountPlan() : null;
  setEngineStatus({ active: !!sess, plan });
  return {
    active: !!sess,
    expiresAt: sess?.expiresAt ? new Date(sess.expiresAt).toISOString() : null,
    plan,
    stage: engineStatus.stage,
    transport: engineStatus.transport,
    lastError: engineStatus.lastError,
    lastModel: engineStatus.lastModel,
    recoverable: engineStatus.recoverable,
    updatedAt: engineStatus.updatedAt,
  };
}

// ─── Exports ───────────────────────────────────────────────────────────────

export const chatgptScraper = {
  openLoginWindow,
  openChatGptWindow,
  clearSession,
  resetEngine,
  invalidateModelCatalog: invalidateSessionModelCatalog,
  loadSession,
  refreshAccessToken,
  listSessionModels,
  listSessionVersions,
  sendChatViaSession,
  getSessionStatus,
  getAccountPlan,
  isSessionActive: async () => {
    const sess = await loadSession();
    return !!sess;
  },
};
