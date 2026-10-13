'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, dialog, shell, Notification, safeStorage, Menu, nativeTheme, Tray, nativeImage,
} = require('electron');

const { Store } = require('./src/store');
const { ImapManager, friendlyError } = require('./src/imap');
const tb = require('./src/thunderbird');

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
  handle('accounts:update', (id, patch) => store.updateAccount(id, patch || {}));
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

  handle('messages:send', async (accountId, mail) => {
    const res = await manager.send(accountId, mail);
    // le carnet d'adresses retient tous les destinataires (À, Cc, Cci)
    try { store.recordContacts(ImapManager.parseRecipients(mail.to, mail.cc, mail.bcc)); } catch (e) { console.error('Carnet :', e.message); }
    return res;
  });

  // Favoris : messages suivis de tous les comptes
  handle('messages:flagged', async () => {
    const results = await Promise.all(store.listAccounts().map(async (acc) => {
      try { return (await manager.listFlagged(acc.id)).map((m) => ({ ...m, accountId: acc.id })); } catch (_) { return []; }
    }));
    return results.flat().sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 300);
  });

  // ---- carnet d'adresses
  handle('contacts:list', () => store.listContacts());
  handle('contacts:remove', (email) => { store.removeContact(email); return store.listContacts(); });
  handle('contacts:importSent', async () => {
    let scanned = 0;
    let added = 0;
    for (const acc of store.listAccounts()) {
      try {
        const list = await manager.sentRecipients(acc.id);
        scanned += list.length;
        // un seul passage par adresse et par message : bump 1
        for (const c of list) added += store.recordContacts([c], { when: c.when });
      } catch (e) { console.error('Import Envoyés :', e.message); }
    }
    return { scanned, added, contacts: store.listContacts() };
  });

  // ---- règles
  handle('rules:list', () => store.listRules());
  handle('rules:add', (rule) => store.addRule(rule));
  handle('rules:update', (rule) => store.updateRule(rule));
  handle('rules:remove', (id) => store.removeRule(id));

  handle('rules:addMany', (list) => store.addRules(list));
  handle('rules:move', (id, delta) => store.moveRule(id, delta));

  handle('rules:sortSender', async ({ accountId, folder, uids, from, dest, createRule, scope, moveExisting }) => {
    let moved = 0;
    if (uids && uids.length) {
      await manager.moveMessages(accountId, folder, uids, dest);
      moved += uids.length;
    }
    let rule = null;
    if (createRule && from) {
      rule = store.upsertSenderRule({ accountId, from, folder: dest, scope }).rule;
    }
    if (moveExisting && from && dest !== folder) {
      const res = await manager.moveSimilar(accountId, folder, from, dest, scope);
      moved += res.moved;
    }
    return { moved, rule };
  });

  // Glisser-déposer : une règle « cette adresse -> ce dossier » par expéditeur.
  // Renvoie de quoi annuler (règle créée, ou ancien dossier d'une règle mise à jour).
  handle('rules:autoSender', ({ accountId, senders, folder }) => {
    const unique = [...new Set((senders || []).map((s) => String(s || '').toLowerCase().trim()).filter(Boolean))].slice(0, 20);
    return unique.map((from) => {
      const res = store.upsertSenderRule({ accountId, from, folder, scope: 'address' });
      return { from, rule: res.rule, created: res.created, previousFolder: res.previousFolder, previousEnabled: res.previousEnabled };
    });
  });

  // ---- import des filtres Thunderbird
  const importable = new Set(); // seuls les fichiers trouvés ou choisis par l'utilisateur peuvent être lus

  const describeFile = (file, extra = {}) => {
    const filters = tb.parseFilterFile(tb.readFilterFile(file));
    if (!filters.length) throw new Error('Ce fichier ne contient aucun filtre Thunderbird reconnu.');
    importable.add(file);
    return {
      file,
      server: path.basename(path.dirname(file)),
      filters: filters.length,
      suggestedAccountId: tb.suggestAccount(store.listAccounts(), tb.serverHints(filters), path.basename(path.dirname(file))),
      ...extra,
    };
  };

  handle('thunderbird:scan', () => tb.findFilterFiles().map((f) => describeFile(f.file, { profile: f.profile })));

  handle('thunderbird:pick', async () => {
    const root = tb.thunderbirdRoots().find((r) => fs.existsSync(r));
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Choisir un fichier de filtres Thunderbird',
      defaultPath: root,
      properties: ['openFile'],
      filters: [{ name: 'Filtres Thunderbird (msgFilterRules.dat)', extensions: ['dat'] }, { name: 'Tous les fichiers', extensions: ['*'] }],
    });
    if (canceled || !filePaths.length) return null;
    return describeFile(filePaths[0], { profile: '' });
  });

  handle('thunderbird:preview', async (file, accountId) => {
    if (!importable.has(file)) throw new Error('Fichier non autorisé : choisissez-le de nouveau.');
    const filters = tb.parseFilterFile(tb.readFilterFile(file));
    const { folders, prefix } = await manager.listFolders(accountId);
    return tb.buildPreview(filters, {
      accountId, folders, prefix, existingRules: store.listRules().filter((r) => r.accountId === accountId),
    });
  });

  handle('rules:applyToFolder', (accountId, folder) => manager.applyRulesToFolder(accountId, folder));
  // « Trier maintenant » : boîte de réception de chaque compte (ou d'un seul)
  handle('rules:applyAll', async (accountId) => {
    const ids = accountId ? [accountId] : store.listAccounts().map((a) => a.id);
    const total = { moved: 0, scanned: 0, failed: [], accounts: ids.length, noRules: true };
    for (const id of ids) {
      try {
        const r = await manager.applyRulesToFolder(id, 'INBOX');
        total.moved += r.moved; total.scanned += r.scanned || 0; total.failed.push(...(r.failed || []));
        if (!r.noRules) total.noRules = false;
      } catch (e) { total.failed.push({ folder: 'INBOX', count: 0, message: friendlyError(e) }); }
    }
    return total;
  });

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
