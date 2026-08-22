import fs from 'fs';
import path from 'path';
import { app, type BrowserWindow, type IpcMain } from 'electron';
import updaterPkg from 'electron-updater';
import { downloadingStatus, type UpdateStatus } from '../src/update-status';
import {
  allowsPrerelease,
  buildUpdateChannel,
  isEmptyChannelError,
  normalizeUpdateChannel,
  resolveUpdateChannel,
  type UpdateChannel,
} from '../src/update-channel';
import { getStore } from './settings-store';

// electron-updater ships as CommonJS; grab autoUpdater off the default export.
const { autoUpdater } = updaterPkg;

const CHANNEL_SETTING_KEY = 'updates.channel';

let latestStatus: UpdateStatus = { state: 'idle' };
let availableVersion: string | undefined;
let activeChannel: UpdateChannel = 'stable';
/**
 * Hoogt op bij elke kanaalwissel. electron-updater deelt één autoUpdater voor
 * alle kanalen: een lopende `checkForUpdates()` wordt hergebruikt zodra er al
 * één onderweg is, en een gestarte download loopt gewoon door. Zonder deze
 * teller landt het antwoord van het verlaten kanaal alsnog in de UI.
 */
let channelGeneration = 0;
/** De generatie waarvoor de nu lopende check en download geldig zijn. */
let runningGeneration = 0;
let runningCheck: { cancellationToken?: { cancel: () => void } } | null = null;

/**
 * Het kanaal waarop deze build is uitgebracht, zoals meegegeven in package.json.
 * Dat bestand wordt meegepackaged, dus in de geïnstalleerde app leest dit
 * dezelfde waarde als tijdens het bouwen.
 */
function packagedUpdateChannel(): unknown {
  // In de geïnstalleerde app wijst getAppPath() naar de asar met de
  // meegepackagede package.json. Tijdens ontwikkelen wijst hij naar de
  // buildmap, waar geen package.json staat; dan telt de projectmap.
  const candidates = app.isPackaged ? [app.getAppPath()] : [app.getAppPath(), process.cwd()];
  for (const directory of candidates) {
    try {
      const manifest = fs.readFileSync(path.join(directory, 'package.json'), 'utf8');
      const channel = JSON.parse(manifest).updateChannel;
      if (channel !== undefined) return channel;
    } catch {
      // Geen leesbare package.json op dit pad: probeer de volgende kandidaat.
    }
  }
  return undefined;
}

function applyChannel(channel: UpdateChannel) {
  activeChannel = channel;
  // Met een stabiel versienummer beslist alleen deze vlag of prereleases
  // meetellen; het versienummer zelf draagt geen kanaalinformatie.
  autoUpdater.allowPrerelease = allowsPrerelease(channel);
}

/** Laat alles vallen wat nog bij het vorige kanaal hoorde. */
function abandonRunningWork() {
  channelGeneration += 1;
  try {
    runningCheck?.cancellationToken?.cancel();
  } catch {
    // Een token dat al klaar of geannuleerd is hoeft niets meer te doen.
  }
  runningCheck = null;
  availableVersion = undefined;
}

/** Of wat er nu binnenkomt nog bij het gekozen kanaal hoort. */
function isCurrentGeneration() {
  return runningGeneration === channelGeneration;
}

export function registerUpdater(ipcMain: IpcMain, getWindow: () => BrowserWindow | null) {
  // Updates worden stil gecontroleerd en automatisch gedownload. Installeren
  // blijft altijd een expliciete gebruikersactie via het updatepaneel.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  latestStatus = { state: 'idle' };
  availableVersion = undefined;
  runningCheck = null;

  const buildChannel = buildUpdateChannel(packagedUpdateChannel());
  applyChannel(buildChannel);
  // De opgeslagen keuze komt uit een async store; tot die geladen is volgt de
  // app het kanaal van zijn eigen build. De eerste check volgt pas na vier
  // seconden, ruim nadat dit is toegepast.
  const channelReady = getStore()
    .then((store) => applyChannel(resolveUpdateChannel(store.get(CHANNEL_SETTING_KEY), packagedUpdateChannel())))
    .catch(() => {});

  const push = (status: UpdateStatus) => {
    latestStatus = status;
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('updater:status', status);
  };
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // Een geannuleerde check hoort bij een kanaal dat de gebruiker net verliet.
    if (/cancelled|canceled/i.test(message) || !isCurrentGeneration()) return message;
    push(isEmptyChannelError(message)
      ? { state: 'no-release', channel: activeChannel }
      : { state: 'error', error: message, version: availableVersion });
    return message;
  };

  autoUpdater.on('checking-for-update', () => {
    if (isCurrentGeneration()) push({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    if (!isCurrentGeneration()) return;
    availableVersion = info.version;
    // electron-updater start de download door autoDownload zelf. Zet de UI meteen
    // in voorbereidingsstatus zodat "gevonden" nooit lijkt vast te hangen.
    push(downloadingStatus({}, info.version));
  });
  autoUpdater.on('update-not-available', (info) => {
    if (!isCurrentGeneration()) return;
    availableVersion = undefined;
    push({ state: 'up-to-date', version: info?.version });
  });
  autoUpdater.on('download-progress', (progress) => {
    // Een download van het vorige kanaal loopt nog even door na een wissel. De
    // wissel wist de versie die erbij hoorde, dus voortgang zonder versie is van
    // een download die we hebben losgelaten.
    if (isCurrentGeneration() && availableVersion) push(downloadingStatus(progress, availableVersion));
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (!isCurrentGeneration() || !availableVersion) return;
    availableVersion = info.version;
    push({ state: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (error) => fail(error));

  /**
   * Start een check voor het kanaal dat nu gekozen is. Wisselt de gebruiker
   * ondertussen, dan hoort het antwoord bij een verlaten kanaal en gooien we het
   * weg — electron-updater deelt namelijk één lopende check tussen aanroepers.
   */
  const runCheck = async () => {
    const generation = channelGeneration;
    runningGeneration = generation;
    const result = await autoUpdater.checkForUpdates();
    if (generation !== channelGeneration) return null;
    runningCheck = result;
    return result;
  };

  ipcMain.handle('updater:getStatus', async () => {
    await channelReady;
    return {
      status: latestStatus,
      currentVersion: app.getVersion(),
      supported: app.isPackaged,
      channel: activeChannel,
      buildChannel,
    };
  });

  ipcMain.handle('updater:setChannel', async (_event, value: unknown) => {
    const channel = normalizeUpdateChannel(value);
    if (!channel) return { ok: false, error: `Onbekend updatekanaal: ${String(value)}` };

    await channelReady;
    if (channel === activeChannel) return { ok: true, channel };

    // Eerst het vorige kanaal loslaten: een lopende download annuleren en alles
    // wat daarna nog binnenkomt buiten beeld houden.
    abandonRunningWork();
    applyChannel(channel);
    const store = await getStore();
    store.set(CHANNEL_SETTING_KEY, channel);
    push({ state: 'idle' });

    if (!app.isPackaged) return { ok: true, channel };
    try {
      const result = await runCheck();
      return { ok: true, channel, version: result?.updateInfo?.version };
    } catch (error: unknown) {
      return { ok: false, channel, error: fail(error) };
    }
  });

  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) {
      return {
        ok: false,
        reason: 'installed-only',
        error: 'Updates werken alleen in de geïnstalleerde app (niet in dev).',
      };
    }
    try {
      const result = await runCheck();
      return { ok: true, version: result?.updateInfo?.version };
    } catch (error: unknown) {
      return { ok: false, error: fail(error) };
    }
  });

  ipcMain.handle('updater:download', async () => {
    if (!app.isPackaged) return { ok: false, reason: 'installed-only', error: 'Alleen in de geïnstalleerde app.' };
    if (latestStatus.state !== 'available' && latestStatus.state !== 'error') {
      return {
        ok: false,
        reason: 'no-failed-download',
        error: 'Er staat geen mislukte update klaar om opnieuw te downloaden.',
      };
    }
    // Compatibiliteit voor oudere renderers en een handmatige retry na een fout.
    // Nieuwe updates bereiken deze handler normaal niet: autoDownload doet dit.
    push(downloadingStatus({}, availableVersion));
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: fail(error) };
    }
  });

  ipcMain.handle('updater:install', async () => {
    if (latestStatus.state !== 'downloaded') {
      return { ok: false, reason: 'download-first', error: 'Download de update eerst volledig.' };
    }
    // Een losse installer is bewust begeleid en laat een installatiemap kiezen.
    // Een reeds gedownloade update gebruikt die wizard niet opnieuw: stil vervangen
    // en daarna herstarten.
    push({ state: 'installing', version: latestStatus.version });
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { ok: true };
  });

  if (app.isPackaged) {
    // Pas zoeken als het gekozen kanaal geladen is; anders zou de eerste check
    // nog het kanaal van de build gebruiken in plaats van dat van de gebruiker.
    const check = () => channelReady.then(runCheck).catch(fail);
    // Stille auto-check snel na opstarten, daarna elke 30 min.
    setTimeout(check, 4000);
    setInterval(check, 30 * 60 * 1000);
  }
}
