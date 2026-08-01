import { app, type BrowserWindow, type IpcMain } from 'electron';
import updaterPkg from 'electron-updater';
import { downloadingStatus, type UpdateStatus } from '../src/update-status';

// electron-updater ships as CommonJS; grab autoUpdater off the default export.
const { autoUpdater } = updaterPkg;

let latestStatus: UpdateStatus = { state: 'idle' };
let availableVersion: string | undefined;

export function registerUpdater(ipcMain: IpcMain, getWindow: () => BrowserWindow | null) {
  // Updates worden stil gecontroleerd en automatisch gedownload. Installeren
  // blijft altijd een expliciete gebruikersactie via het updatepaneel.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  const push = (status: UpdateStatus) => {
    latestStatus = status;
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('updater:status', status);
  };
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    push({ state: 'error', error: message, version: availableVersion });
    return message;
  };

  autoUpdater.on('checking-for-update', () => push({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    availableVersion = info.version;
    // electron-updater start de download door autoDownload zelf. Zet de UI meteen
    // in voorbereidingsstatus zodat "gevonden" nooit lijkt vast te hangen.
    push(downloadingStatus({}, info.version));
  });
  autoUpdater.on('update-not-available', (info) => {
    availableVersion = undefined;
    push({ state: 'up-to-date', version: info?.version });
  });
  autoUpdater.on('download-progress', (progress) => {
    push(downloadingStatus(progress, availableVersion));
  });
  autoUpdater.on('update-downloaded', (info) => {
    availableVersion = info.version;
    push({ state: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (error) => fail(error));

  ipcMain.handle('updater:getStatus', async () => ({ status: latestStatus, currentVersion: app.getVersion(), supported: app.isPackaged }));

  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) return { ok: false, error: 'Updates werken alleen in de geïnstalleerde app (niet in dev).' };
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, version: result?.updateInfo?.version };
    } catch (error: unknown) {
      return { ok: false, error: fail(error) };
    }
  });

  ipcMain.handle('updater:download', async () => {
    if (!app.isPackaged) return { ok: false, error: 'Alleen in de geïnstalleerde app.' };
    if (latestStatus.state !== 'available' && latestStatus.state !== 'error') {
      return { ok: false, error: 'Er staat geen mislukte update klaar om opnieuw te downloaden.' };
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
      return { ok: false, error: 'Download de update eerst volledig.' };
    }
    // Een losse installer is bewust begeleid en laat een installatiemap kiezen.
    // Een reeds gedownloade update gebruikt die wizard niet opnieuw: stil vervangen
    // en daarna herstarten.
    push({ state: 'installing', version: latestStatus.version });
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { ok: true };
  });

  if (app.isPackaged) {
    const check = () => autoUpdater.checkForUpdates().catch(fail);
    // Stille auto-check snel na opstarten, daarna elke 30 min.
    setTimeout(check, 4000);
    setInterval(check, 30 * 60 * 1000);
  }
}
