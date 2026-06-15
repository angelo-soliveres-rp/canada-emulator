import { app, shell, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { EmulatorService } from '../server/emulatorService';
import type { Channel, PosConfig } from '../core/posTypes';
import { PLAYER_KEY_FILENAME } from '../core/globalInit';

let mainWindow: BrowserWindow | null = null;

/**
 * Resolve a bundled resource subfolder for the Electron app. Tries the
 * candidates for dev (project root), packaged builds (resourcesPath), and the
 * built main dir, returning the first that exists so the emulator is
 * self-contained without an external liftck_player checkout.
 */
function electronResourceDir(name: string): string {
  const candidates = [
    join(app.getAppPath(), 'resources', name),
    join(process.resourcesPath, name),
    join(__dirname, `../../resources/${name}`),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/** The single emulator service backing every IPC handler. */
const service = new EmulatorService({
  playerKeyFilePath: join(app.getPath('userData'), PLAYER_KEY_FILENAME),
  resolveResourceDir: electronResourceDir,
});

/** Wire the shared service's methods + events to Electron IPC. */
function registerEmulatorIpc(getWindow: () => BrowserWindow | null): void {
  // Push service events to the renderer (registered once; survives reconnects).
  service.onStatus((status) => getWindow()?.webContents.send('emulator:status-changed', status));
  service.onInject((cmd) => getWindow()?.webContents.send('emulator:inject', cmd));

  ipcMain.handle('emulator:connect', (_evt, config: PosConfig) => service.connect(config));
  ipcMain.handle('emulator:disconnect', () => service.disconnect());
  ipcMain.handle('emulator:send', (_evt, payload: { channel: Channel; data: string }) => service.send(payload));
  ipcMain.handle('emulator:status', () => service.status());
  ipcMain.handle('pricebook:load', (_evt, req: { dir?: string; playerCode: string }) => service.loadPricebook(req));
  ipcMain.handle('quickkeys:load', (_evt, req: { dir?: string }) => service.loadQuickKeys(req));
  ipcMain.handle('ads:load', (_evt, req: { backendBaseUrl: string; playerCode: string; playerKey: string }) =>
    service.loadAds(req),
  );
  ipcMain.handle(
    'ads:adDetail',
    (_evt, req: { backendBaseUrl: string; playerCode: string; playerKey: string; id: string }) =>
      service.loadAdDetail(req),
  );
  ipcMain.handle('globalinit:register', (_evt, req: { playerKey: string; product?: string }) =>
    service.registerPlayer(req),
  );
  ipcMain.handle('globalinit:load', () => service.loadPlayerKey());
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1320,
    height: 1000,
    // Low minimums so the window can be parked at a quarter of a laptop screen;
    // the renderer's compact layout (mode = one region) takes over below ~720px.
    minWidth: 380,
    minHeight: 320,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  });

  win.on('ready-to-show', () => {
    win.show();
  });
  win.on('closed', () => {
    mainWindow = null;
  });

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow = win;
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('io.rocketpartners.canada-emulator');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  registerEmulatorIpc(() => mainWindow);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
