import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, type MenuItemConstructorOptions } from 'electron';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { registerIpcHandlers } from './ipc-handlers.ts';
import { initDatabase, getDb } from './database.ts';
import { registerUpdater } from './updater.ts';
import { appEvents } from './app-events.ts';
import { createTrustedIpcMain, isAllowedRendererUrl, isSafeExternalUrl, trustRenderer } from './ipc-security.ts';
import { recoverAntigravityHookMutation } from './antigravity-native.ts';
import { chatgptScraper } from './chatgpt-scraper.ts';
import { getStore } from './settings-store.ts';
import { localizedText, normalizeUiLanguage, type UiLanguage } from '../src/i18n/language.ts';

// Een GUI-launcher, gesloten terminal of testhost kan stdout/stderr loskoppelen
// terwijl Electron nog draait. Een latere console.log geeft dan EPIPE; zonder
// listener maakt Node daar een uncaught main-processfout van. Logging mag de GUI
// nooit beëindigen wanneer het ontvangende kanaal al verdwenen is.
process.stdout?.on('error', () => undefined);
process.stderr?.on('error', () => undefined);

// De zichtbare productnaam en package-naam zijn LLMelt, maar bestaande installaties
// bewaren hun chats en instellingen in dit eerdere profielpad. Houd dat pad stabiel
// zodat een rebrand nooit als een lege nieuwe installatie opent.
app.setName('LLMelt');
app.setPath('userData', path.join(app.getPath('appData'), 'ai-superapp'));

// Alleen voor lokale end-to-endtests: hiermee kan een volledig leeg profiel
// starten zonder de echte chats, keys, sessies of instellingen aan te raken.
const testUserDataDir = process.env.AI_SUPERAPP_TEST_USER_DATA_DIR?.trim();
if (!app.isPackaged && testUserDataDir) {
  const isolatedUserData = path.resolve(testUserDataDir);
  fs.mkdirSync(isolatedUserData, { recursive: true });
  app.setPath('userData', isolatedUserData);
}

process.env.DIST_ELECTRON = path.join(__dirname);
process.env.DIST = path.join(process.env.DIST_ELECTRON, '../dist');
process.env.VITE_PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? path.join(process.env.DIST_ELECTRON, '../public')
  : process.env.DIST;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let mainUiLanguage: UiLanguage = 'nl';

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const trustedIpcMain = createTrustedIpcMain(ipcMain);

// Alleen expliciet terugvallen op software-rendering voor machines waar GPU-rendering
// problemen geeft. De normale route houdt animaties en tekstweergave efficiënt.
if (process.env.AI_SUPERAPP_SOFTWARE_RENDERING === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

// Quiet Chromium's internal C++ logging (the [ERROR:ssl_client_socket...] /
// SSL-handshake / GPU spam from the hidden ChatGPT browser window). This only
// silences Chromium's own logs — our own console.log('[chatgpt] ...') still shows.
app.commandLine.appendSwitch('log-level', '3'); // 3 = FATAL only
function createWindow() {
  const rendererUrl = VITE_DEV_SERVER_URL || pathToFileURL(path.join(process.env.DIST!, 'index.html')).toString();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'LLMelt',
    icon: nativeImage.createFromPath(path.join(process.env.VITE_PUBLIC!, 'icon.png')),
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0e1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: false,
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximizeChanged', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximizeChanged', false));
  registerRendererContextMenu(mainWindow);
  trustRenderer(mainWindow.webContents, rendererUrl);
  secureMainWindow(mainWindow, rendererUrl);

  mainWindow.on('close', (event) => {
    // Minimize to tray instead of closing
    event.preventDefault();
    mainWindow?.hide();
  });

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(process.env.DIST!, 'index.html'));
  }
}

function secureMainWindow(win: BrowserWindow, rendererUrl: string) {
  const openExternal = (url: string) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedRendererUrl(url, rendererUrl)) return;
    event.preventDefault();
    openExternal(url);
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (isAllowedRendererUrl(url, rendererUrl)) return;
    event.preventDefault();
    openExternal(url);
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

function registerRendererContextMenu(win: BrowserWindow) {
  win.webContents.on('context-menu', (_event, params) => {
    const hasSelection = !!params.selectionText?.trim();
    if (!params.isEditable && !hasSelection) return;

    const template: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      template.push(
        { label: localizedText(mainUiLanguage, 'Ongedaan maken', 'Undo'), role: 'undo', enabled: params.editFlags.canUndo },
        { label: localizedText(mainUiLanguage, 'Opnieuw', 'Redo'), role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { label: localizedText(mainUiLanguage, 'Knippen', 'Cut'), role: 'cut', enabled: params.editFlags.canCut },
        { label: localizedText(mainUiLanguage, 'Kopiëren', 'Copy'), role: 'copy', enabled: params.editFlags.canCopy },
        { label: localizedText(mainUiLanguage, 'Plakken', 'Paste'), role: 'paste', enabled: params.editFlags.canPaste },
        { label: localizedText(mainUiLanguage, 'Verwijderen', 'Delete'), role: 'delete', enabled: params.editFlags.canDelete },
        { type: 'separator' },
        { label: localizedText(mainUiLanguage, 'Alles selecteren', 'Select all'), role: 'selectAll', enabled: params.editFlags.canSelectAll },
      );
    } else {
      template.push(
        { label: localizedText(mainUiLanguage, 'Kopiëren', 'Copy'), role: 'copy', enabled: hasSelection },
        { type: 'separator' },
        { label: localizedText(mainUiLanguage, 'Alles selecteren', 'Select all'), role: 'selectAll' },
      );
    }

    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openChatFromTray(chatId: string) {
  showMainWindow();
  const send = () => mainWindow?.webContents.send('tray:openChat', chatId);
  if (mainWindow && !mainWindow.webContents.isLoading()) send();
  else mainWindow?.webContents.once('did-finish-load', send);
}

type TrayChat = { id: string; title: string; folder?: string };

function trayChatTitleText(chat: TrayChat) {
  const clean = (chat.title || '').trim() || localizedText(mainUiLanguage, 'Naamloos gesprek', 'Untitled chat');
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean;
}

// Zet het project als voorvoegsel: "[Nieuwe map] Nieuw gesprek". Altijd strak links
// uitgelijnd — rechts-uitlijnen kan niet in een Electron tray-popup (die rendert een
// tab als een zichtbaar pijltje i.p.v. uit te lijnen).
function trayChatLabel(chat: TrayChat) {
  const title = trayChatTitleText(chat);
  return chat.folder ? `[${chat.folder}] ${title}` : title;
}

// De renderer pusht z'n exacte chat-lijst hierheen (zie 'tray:setChats'), zodat
// het tray-menu altijd 1-op-1 gelijk is aan de zijbalk — geen stale DB-cache.
let trayChats: TrayChat[] | null = null;

function buildTrayMenu(): Menu {
  let chats: TrayChat[] = [];
  if (trayChats) {
    chats = trayChats;
  } else {
    // Alleen als de renderer nog niks heeft gestuurd (vroege opstart): lees de DB.
    try {
      chats = getDb().prepare('SELECT id, title FROM chats ORDER BY updatedAt DESC LIMIT 60').all() as TrayChat[];
    } catch {
      // DB nog niet klaar bij een vroege bouw van het menu.
    }
  }

  // Toon 3 recente gesprekken; de rest zit onder "Meer…" (een submenu dat
  // openklapt). De actie-knop heet "Start nieuw gesprek" zodat 'ie duidelijk iets
  // anders is dan een recent gesprek dat toevallig nog "Nieuw gesprek" heet.
  const recent = chats.slice(0, 3);
  const rest = chats.slice(3);

  const template: MenuItemConstructorOptions[] = [
    { label: localizedText(mainUiLanguage, 'LLMelt openen', 'Open LLMelt'), click: () => showMainWindow() },
    { label: localizedText(mainUiLanguage, 'Start nieuw gesprek', 'Start new chat'), click: () => openChatFromTray('__new__') },
    { type: 'separator' },
  ];

  if (recent.length) {
    template.push({ label: localizedText(mainUiLanguage, 'Recente gesprekken', 'Recent chats'), enabled: false });
    for (const chat of recent) {
      template.push({ label: trayChatLabel(chat), click: () => openChatFromTray(chat.id) });
    }
    if (rest.length) {
      template.push({
        label: localizedText(mainUiLanguage, `Meer… (${rest.length})`, `More… (${rest.length})`),
        submenu: rest.map((chat) => ({ label: trayChatLabel(chat), click: () => openChatFromTray(chat.id) })),
      });
    }
    template.push({ type: 'separator' });
  }

  template.push({ label: localizedText(mainUiLanguage, 'Afsluiten', 'Quit'), click: () => { mainWindow?.destroy(); app.quit(); } });
  return Menu.buildFromTemplate(template);
}

let trayRefreshTimer: NodeJS.Timeout | null = null;
function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  // Kleine debounce: bundel meerdere wijzigingen (bv. maken + hernoemen).
  if (trayRefreshTimer) clearTimeout(trayRefreshTimer);
  trayRefreshTimer = setTimeout(() => {
    if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
  }, 120);
}

function createTray() {
  const source = nativeImage.createFromPath(path.join(process.env.VITE_PUBLIC!, 'icon.png'));
  const icon = source.isEmpty() ? source : source.resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('LLMelt');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => showMainWindow());
  // Realtime: de renderer stuurt z'n actuele chat-lijst; het menu spiegelt die 1-op-1.
  trustedIpcMain.on('tray:setChats', (_event, chats: TrayChat[]) => {
    trayChats = Array.isArray(chats) ? chats.slice(0, 60) : [];
    refreshTrayMenu();
  });
  // Vangnet voor DB-directe wijzigingen (bv. auto-titel) vóór de renderer pusht.
  appEvents.on('chats-changed', refreshTrayMenu);
  appEvents.on('ui-language-changed', (language) => {
    mainUiLanguage = normalizeUiLanguage(language, 'nl');
    refreshTrayMenu();
  });
}

function registerWindowControls() {
  trustedIpcMain.handle('window:minimize', () => mainWindow?.minimize());
  trustedIpcMain.handle('window:maximizeToggle', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  trustedIpcMain.handle('window:close', () => mainWindow?.close());
  trustedIpcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);
}

// Eenmalige diagnose: verstuurt ÉÉN kort bericht via een expliciet doorgegeven
// live model. Zonder CG_SELFTEST_MODEL gebeurt niets; zo introduceert diagnostiek
// geen vaste modelslug. De test verbruikt één bericht op het account.
function runChatgptModelSelfTest() {
  if (process.env.CG_SELFTEST !== '1') return;
  const modelSlug = process.env.CG_SELFTEST_MODEL?.trim();
  const thinkingEffort = process.env.CG_SELFTEST_EFFORT?.trim() || undefined;
  if (!modelSlug) {
    console.warn('[selftest] overgeslagen: zet CG_SELFTEST_MODEL op een slug uit de live catalogus.');
    return;
  }
  setTimeout(async () => {
    try {
      console.log(`[selftest] stuurt 1 bericht via ${modelSlug}${thinkingEffort ? ` (effort ${thinkingEffort})` : ''}...`);
      const result = await chatgptScraper.sendChatViaSession({
        modelSlug,
        thinkingEffort,
        messages: [{ role: 'user', content: 'Antwoord met exact het woord: ping' }],
        attachments: [],
        signal: AbortSignal.timeout(180000),
        onDelta: () => { },
        onStatus: () => { },
      } as any);
      console.log(`[selftest] KLAAR — antwoordlengte ${result?.text?.length ?? 0}`);
    } catch (error: any) {
      console.warn('[selftest] MISLUKT:', error?.message || String(error));
    }
  }, 12000);
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  initDatabase();
  mainUiLanguage = normalizeUiLanguage((await getStore()).get('ui.language'), 'nl');
  void recoverAntigravityHookMutation();
  registerIpcHandlers(trustedIpcMain);
  registerWindowControls();
  registerUpdater(trustedIpcMain, () => mainWindow);
  createWindow();
  createTray();
  runChatgptModelSelfTest();
});

app.on('window-all-closed', () => {
  // Keep running in tray on Windows
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
