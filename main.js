'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, dialog, shell, Notification, safeStorage, Menu, nativeTheme, Tray, nativeImage,
} = require('electron');

const { Store } = require('./src/store');
const { ImapManager, friendlyError } = require('./src/imap');
const { senderRule, domainOf } = require('./src/rules');

let mainWindow = null;
let store = null;
let manager = null;
let tray = null;
let quitting = false;
let hintShown = false;

// Lancé à l'ouverture de session : on démarre sans fenêtre, le tri tourne en arrière-plan
const startHidden = process.argv.includes('--hidden');

// Une seule instance de l'application
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function isSafeExternal(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol);
  } catch (_) {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: !startHidden,
    title: 'MailHub',
    backgroundColor: '#0f1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Les liens (y compris ceux des e-mails HTML) s'ouvrent dans le navigateur par défaut
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (isSafeExternal(url)) shell.openExternal(url);
    }
  });

  // Windows/Linux : fermer la fenêtre réduit MailHub dans la zone de notification
  // pour que le tri automatique continue. « Quitter » se trouve dans le menu de l'icône.
  mainWindow.on('close', (event) => {
    if (quitting || process.platform === 'darwin') return;
    event.preventDefault();
    mainWindow.hide();
    if (!hintShown && Notification.isSupported()) {
      hintShown = true;
      new Notification({
        title: 'MailHub continue en arrière-plan',
        body: 'Le tri automatique reste actif. Pour quitter, faites un clic droit sur l’icône MailHub puis « Quitter ».',
      }).show();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (process.platform === 'darwin') return; // le Dock suffit sur macOS
  try {
    const image = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 18, height: 18 });
    tray = new Tray(image);
    tray.setToolTip('MailHub');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Ouvrir MailHub', click: showWindow },
      { type: 'separator' },
      { label: 'Quitter', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  } catch (err) {
    console.error('Icône de notification indisponible :', err.message);
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'Affichage',
      submenu: [
        { role: 'reload' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Enveloppe les handlers IPC : renvoie { ok, data } ou { ok:false, error }
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[${channel}]`, err);
      return { ok: false, error: friendlyError(err) };
    }
  });
}

function registerIpc() {
  // ---- comptes
  handle('accounts:list', () => store.listAccounts());
  handle('accounts:encryption', () => store.encryptionAvailable());
  handle('accounts:test', (cfg) => ImapManager.testConnection(cfg));
  handle('accounts:add', async (cfg) => {
    const test = await ImapManager.testConnection(cfg);
    if (!test.ok) throw new Error(test.error);
    const account = store.addAccount(cfg);
    manager.startWatching(account.id);
    return account;
  });
  handle('accounts:remove', async (id) => {
    await manager.disconnect(id);
    store.removeAccount(id);
    return true;
  });

  // ---- dossiers
  handle('folders:list', (accountId) => manager.listFolders(accountId));
  handle('folders:create', (accountId, p) => manager.createFolder(accountId, p));
  handle('folders:rename', (accountId, from, to) => manager.renameFolder(accountId, from, to));
  handle('folders:remove', (accountId, p) => manager.deleteFolder(accountId, p));

  // ---- messages
  handle('messages:list', (accountId, folder, opts) => manager.listMessages(accountId, folder, opts));
  handle('messages:search', (accountId, folder, query) => manager.searchMessages(accountId, folder, query));
  handle('messages:get', (accountId, folder, uid) => manager.getMessage(accountId, folder, uid));
  handle('messages:flag', (accountId, folder, uids, flag, on) => manager.setFlag(accountId, folder, uids, flag, on));
  handle('messages:move', (accountId, folder, uids, dest) => manager.moveMessages(accountId, folder, uids, dest));
  handle('messages:remove', (accountId, folder, uids) => manager.deleteMessages(accountId, folder, uids));

  // Boîte de réception unifiée : fusion des boîtes de tous les comptes
  handle('messages:unified', async (limit = 50) => {
    const accounts = store.listAccounts();
    const results = await Promise.all(accounts.map(async (acc) => {
      try {
        const { messages } = await manager.listMessages(acc.id, 'INBOX', { limit });
        return messages.map((m) => ({ ...m, accountId: acc.id }));
      } catch (err) {
        return [];
      }
    }));
    return results.flat().sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, limit);
  });

  handle('messages:saveAttachment', async (accountId, folder, uid, index) => {
    const att = await manager.getAttachment(accountId, folder, uid, index);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('downloads'), path.basename(att.filename)),
    });
    if (canceled || !filePath) return { saved: false };
    fs.writeFileSync(filePath, att.content);
    shell.showItemInFolder(filePath);
    return { saved: true, path: filePath };
  });

  handle('messages:pickAttachments', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
    if (canceled) return [];
    return filePaths.map((p) => ({ path: p, name: path.basename(p), size: fs.statSync(p).size }));
  });

  handle('messages:send', (accountId, mail) => manager.send(accountId, mail));

  // ---- règles
  handle('rules:list', () => store.listRules());
  handle('rules:add', (rule) => store.addRule(rule));
  handle('rules:update', (rule) => store.updateRule(rule));
  handle('rules:remove', (id) => store.removeRule(id));

  handle('rules:sortSender', async ({ accountId, folder, uids, from, dest, createRule, scope, moveExisting }) => {
    let moved = 0;
    if (uids && uids.length) {
      await manager.moveMessages(accountId, folder, uids, dest);
      moved += uids.length;
    }
    let rule = null;
    if (createRule && from) {
      rule = store.addRule(senderRule({ accountId, from, folder: dest, scope }));
    }
    if (moveExisting && from && dest !== folder) {
      const query = scope === 'domain' ? `@${domainOf(from)}` : from;
      const res = await manager.moveSimilar(accountId, folder, query, dest);
      moved += res.moved;
    }
    return { moved, rule };
  });

  handle('rules:applyToFolder', (accountId, folder) => manager.applyRulesToFolder(accountId, folder));

  // ---- préférences
  handle('prefs:get', () => store.getPrefs());
  handle('prefs:set', (patch) => {
    const prefs = store.setPrefs(patch);
    if (patch.theme) nativeTheme.themeSource = patch.theme === 'auto' ? 'system' : patch.theme;
    if ('openAtLogin' in patch && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: !!patch.openAtLogin, args: ['--hidden'] });
    }
    return prefs;
  });
}

function wireManagerEvents() {
  const accountName = (id) => {
    const a = store.listAccounts().find((x) => x.id === id);
    return a ? a.name : '';
  };

  manager.on('sorted', ({ accountId, moved }) => {
    send('mail:sorted', { accountId, moved });
    if (Notification.isSupported() && moved.length) {
      const counts = {};
      moved.forEach((m) => { counts[m.folder] = (counts[m.folder] || 0) + 1; });
      const body = Object.entries(counts).map(([f, n]) => `${n} → ${f}`).join('\n');
      new Notification({ title: `${moved.length} message(s) trié(s) · ${accountName(accountId)}`, body }).show();
    }
  });

  manager.on('new-mail', ({ accountId, messages }) => {
    send('mail:new', { accountId, count: messages.length });
    if (Notification.isSupported() && messages.length) {
      const first = messages[0];
      const title = messages.length === 1
        ? (first.fromName || first.from)
        : `${messages.length} nouveaux messages · ${accountName(accountId)}`;
      const body = messages.length === 1 ? first.subject : messages.slice(0, 3).map((m) => m.subject).join('\n');
      const n = new Notification({ title, body });
      n.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
      n.show();
    }
  });

  manager.on('changed', (payload) => send('mail:changed', payload));
  manager.on('status', (payload) => send('account:status', payload));
  manager.on('error', (payload) => send('app:error', payload));
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'), safeStorage);
  manager = new ImapManager(store);

  const prefs = store.getPrefs();
  nativeTheme.themeSource = !prefs.theme || prefs.theme === 'auto' ? 'system' : prefs.theme;

  registerIpc();
  wireManagerEvents();
  buildMenu();
  createWindow();
  createTray();

  // Surveillance IMAP (IDLE) + tri automatique des nouveaux messages
  store.listAccounts().forEach((acc) => manager.startWatching(acc.id));

  app.on('activate', () => showWindow());
});

app.on('before-quit', () => {
  quitting = true;
  if (manager) manager.disconnectAll();
});

// Aucune action : l'application reste vivante (icône de notification / Dock) pour continuer à trier.
// Elle se ferme via « Quitter » ou Cmd+Q.
app.on('window-all-closed', () => {});
