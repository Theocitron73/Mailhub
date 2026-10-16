'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, dialog, shell, Notification, safeStorage, Menu, nativeTheme, Tray, nativeImage,
} = require('electron');

const { Store } = require('./src/store');
const { ImapManager, friendlyError } = require('./src/imap');
const rulesio = require('./src/rulesio');
const { attachmentPreview } = require('./src/attachment');
const { cleanImage } = require('./src/signature');
const tb = require('./src/thunderbird');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (_) {}

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
    {
      label: 'Fichier',
      submenu: [
        { label: 'Fermer l’onglet', accelerator: 'CmdOrCtrl+W', click: () => send('app:closeTab') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
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
    {
      label: 'Fenêtre',
      submenu: [{ role: 'minimize' }, ...(isMac ? [{ role: 'zoom' }, { type: 'separator' }, { role: 'front' }] : [])],
    },
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

const BLOCKED_OPEN = /\.(exe|bat|cmd|com|scr|msi|msp|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|sh|command|app|jar|dmg|pkg|lnk|hta|reg|cpl|scf|pif|gadget|appimage|deb|rpm|apk|url|iso)$/i;
const attachmentsTmp = () => {
  const dir = path.join(app.getPath('temp'), 'mailhub-attachments');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

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
  handle('accounts:update', async (id, patch = {}) => {
    const cur = store.getAccount(id);
    if (!cur) throw new Error('Compte introuvable');
    const touchesServer = !!(patch.imap || patch.email || patch.password);
    if (touchesServer) {
      // on vérifie la connexion avec les nouveaux paramètres AVANT d'enregistrer quoi que ce soit
      const email = typeof patch.email === 'string' ? patch.email.trim() : cur.email;
      const imap = patch.imap
        ? { host: String(patch.imap.host || '').trim(), port: Number(patch.imap.port) || 993, secure: patch.imap.secure !== false, user: String(patch.imap.user || '').trim() || email }
        : cur.imap;
      if (!imap.host) throw new Error('Indiquez le serveur IMAP.');
      const test = await ImapManager.testConnection({ email, password: patch.password || cur.password, imap });
      if (!test.ok) throw new Error(test.error);
    }
    const before = JSON.stringify([cur.imap, cur.email]);
    const updated = store.updateAccount(id, patch);
    const after = JSON.stringify([store.getAccount(id).imap, store.getAccount(id).email]);
    if (touchesServer) {
      await manager.disconnect(id);
      if (before !== after) store.setSync(id, null); // autre serveur : les numéros de messages ne sont plus comparables
      manager.startWatching(id);
    }
    return updated;
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
  handle('messages:markAllRead', (accountId, folder) => manager.markAllRead(accountId, folder));
  handle('messages:markAllReadInAccount', (accountId) => manager.markAllReadInAccount(accountId));
  handle('messages:deleteAllInFolder', (accountId, folder) => manager.deleteAllInFolder(accountId, folder));
  handle('messages:saveDraft', (accountId, mail) => manager.saveDraft(accountId, mail));

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

  // Aperçu d'une pièce jointe dans un onglet : le type est décidé ici, jamais par l'interface
  handle('messages:attachmentData', async (accountId, folder, uid, index) => {
    const att = await manager.getAttachment(accountId, folder, uid, index);
    return attachmentPreview(att);
  });

  // Ouvre une pièce jointe avec l'application associée (copie temporaire), sauf types exécutables
  handle('messages:openAttachment', async (accountId, folder, uid, index) => {
    const att = await manager.getAttachment(accountId, folder, uid, index);
    const name = path.basename(att.filename).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'piece-jointe';
    if (BLOCKED_OPEN.test(name)) throw new Error('Ce type de fichier ne peut pas être ouvert directement, par sécurité. Enregistrez-le d’abord.');
    const dir = fs.mkdtempSync(path.join(attachmentsTmp(), 'a-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, att.content);
    const err = await shell.openPath(file);
    if (err) throw new Error('Impossible d’ouvrir ce fichier : ' + err);
    return { ok: true };
  });

  handle('app:hide', () => { if (mainWindow) mainWindow.hide(); return true; });

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

  // Signatures : choix d'une image (png, jpg, gif, webp ; 1,5 Mo maximum)
  handle('signatures:pickImage', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Choisir une image pour la signature',
      properties: ['openFile'],
      filters: [{ name: 'Images (png, jpg, gif, webp)', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    if (canceled || !filePaths.length) return null;
    const file = filePaths[0];
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[path.extname(file).slice(1).toLowerCase()];
    if (!mime) throw new Error('Format d’image non pris en charge (png, jpg, gif ou webp).');
    const size = fs.statSync(file).size;
    if (size > 1.5 * 1024 * 1024) throw new Error('Image trop lourde (1,5 Mo maximum). Réduisez-la avant de l’ajouter.');
    const im = cleanImage({ dataUrl: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`, name: path.basename(file), id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) });
    if (!im) throw new Error('Image illisible.');
    return im;
  });

  // Export / import des réglages
  handle('settings:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Exporter les réglages',
      defaultPath: path.join(app.getPath('documents'), 'mailhub-settings.json'),
      filters: [{ name: 'Réglages MailHub (.json)', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { saved: false };
    const data = store.exportSettings();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { saved: true, path: filePath };
  });

  handle('settings:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Importer des réglages',
      properties: ['openFile'],
      filters: [{ name: 'Réglages MailHub (.json)', extensions: ['json'] }],
    });
    if (canceled || !filePaths.length) return null;
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    store.importSettings(data);
    return { imported: true };
  });

  // Export / import des règles de tri
  handle('rules:export', async () => {
    const rules = store.listRules();
    if (!rules.length) throw new Error('Vous n’avez aucune règle à exporter.');
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Exporter les règles de tri',
      defaultPath: path.join(app.getPath('documents'), 'mailhub-regles.json'),
      filters: [{ name: 'Règles MailHub (.json)', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { saved: false };
    const data = rulesio.exportRules(rules, store.listAccounts());
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { saved: true, count: data.rules.length, path: filePath };
  });

  handle('rules:importPick', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Importer des règles de tri',
      properties: ['openFile'],
      filters: [{ name: 'Règles MailHub (.json)', extensions: ['json'] }, { name: 'Tous les fichiers', extensions: ['*'] }],
    });
    if (canceled || !filePaths.length) return null;
    if (fs.statSync(filePaths[0]).size > 5 * 1024 * 1024) throw new Error('Fichier trop volumineux pour un export de règles.');
    const { rules, skipped } = rulesio.parseRulesFile(fs.readFileSync(filePaths[0], 'utf8'));
    const accounts = store.listAccounts();
    const existing = new Set(store.listRules().map((r) => rulesio.ruleKey(r.accountId, r)));
    const emails = [...new Set(rules.map((r) => r.accountEmail))];
    const mapping = {};
    emails.forEach((e) => { const a = accounts.find((x) => x.email.toLowerCase() === e); mapping[e] = a ? a.id : (accounts.length === 1 ? accounts[0].id : ''); });
    return {
      file: path.basename(filePaths[0]), skipped, emails, mapping,
      rules: rules.map((r) => ({ ...r, duplicate: !!mapping[r.accountEmail] && existing.has(rulesio.ruleKey(mapping[r.accountEmail], r)) })),
    };
  });
  // doublons recalculés quand l'utilisateur change l'association d'un compte
  handle('rules:duplicates', (items) => {
    const existing = new Set(store.listRules().map((r) => rulesio.ruleKey(r.accountId, r)));
    return items.map((it) => !!it.accountId && existing.has(rulesio.ruleKey(it.accountId, it)));
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
    if (patch.theme) nativeTheme.themeSource = patch.theme === 'auto' ? 'system' : (patch.theme === 'graphite' ? 'dark' : patch.theme);
    if ('openAtLogin' in patch && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: !!patch.openAtLogin, args: ['--hidden'] });
    }
    return prefs;
  });

  // ---- mises à jour automatiques
  handle('updates:check', async () => {
    if (!autoUpdater) throw new Error('Module de mise à jour non disponible');
    if (!app.isPackaged) {
      return { update: false, version: app.getVersion(), dev: true, message: 'Mode développement (mises à jour automatiques désactivées)' };
    }
    try {
      const res = await autoUpdater.checkForUpdates();
      return { update: !!res && !!res.updateInfo, version: app.getVersion(), latest: res?.updateInfo?.version, info: res && res.updateInfo };
    } catch (err) {
      if (err.message && (err.message.includes('404') || err.message.includes('latest-mac.yml') || err.message.includes('latest.yml'))) {
        return { update: false, version: app.getVersion(), noRelease: true, message: 'Aucune mise à jour publiée pour cette version/plateforme.' };
      }
      throw new Error('Impossible de vérifier les mises à jour : ' + err.message);
    }
  });
  handle('updates:install', () => {
    if (autoUpdater) {
      quitting = true;
      autoUpdater.quitAndInstall();
    }
    return true;
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
  nativeTheme.themeSource = !prefs.theme || prefs.theme === 'auto' ? 'system' : (prefs.theme === 'graphite' ? 'dark' : prefs.theme);

  registerIpc();
  wireManagerEvents();
  buildMenu();
  createWindow();
  createTray();

  // Surveillance IMAP (IDLE) + tri automatique des nouveaux messages
  store.listAccounts().forEach((acc) => manager.startWatching(acc.id));

  initAutoUpdater();

  app.on('activate', () => showWindow());
});

function initAutoUpdater() {
  if (!autoUpdater) return;
  autoUpdater.logger = console;
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    send('app:updateAvailable', { version: info.version });
  });

  autoUpdater.on('update-downloaded', (info) => {
    send('app:updateDownloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.warn('Mise à jour automatique :', err.message);
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('Erreur vérification mise à jour:', err.message);
    });
  }, 10000);

  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('Erreur intervalle mise à jour:', err.message);
    });
  }, 4 * 60 * 60 * 1000);
}

app.on('before-quit', () => {
  quitting = true;
  try { fs.rmSync(path.join(app.getPath('temp'), 'mailhub-attachments'), { recursive: true, force: true }); } catch (_) { /* ignore */ }
  if (manager) manager.disconnectAll();
});

// Aucune action : l'application reste vivante (icône de notification / Dock) pour continuer à trier.
// Elle se ferme via « Quitter » ou Cmd+Q.
app.on('window-all-closed', () => {});
