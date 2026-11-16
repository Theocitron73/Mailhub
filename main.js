'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, dialog, shell, Notification, safeStorage, Menu, nativeTheme, Tray, nativeImage,
} = require('electron');

const { Store } = require('./src/store');
const { ImapManager, friendlyError } = require('./src/imap');
const { safeOutgoing, uniqueFileNames } = require('./src/attachment');
const { cleanImage } = require('./src/signature');
const { Scheduler } = require('./src/scheduler');
const { BackupService } = require('./src/backup');
const os = require('os');
const tb = require('./src/thunderbird');
const { registerCommonHandlers, makeSendMail, rulesImportPreview, rulesExportData } = require('./src/handlers');

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
let scheduler = null;
let backupSvc = null;

// Sécurité : seuls les fichiers que l'utilisateur a choisis lui-même (fenêtre « Joindre ») peuvent être
// lus sur le disque. Tout autre chemin transmis par l'interface est ignoré ; un fichier glissé-déposé
// arrive déjà avec son contenu (dataUrl).
const pickedFiles = new Set();
const safeMail = (mail) => safeOutgoing(mail, pickedFiles, (p) => { try { return fs.statSync(p).size; } catch (_) { return null; } });

// Pour un envoi programmé, les fichiers sont copiés dans le message (ils peuvent être déplacés d'ici là)
function embedFiles(mail) {
  return {
    ...mail,
    attachments: mail.attachments.map((a) => {
      if (!a.path) return a;
      const mime = a.contentType || 'application/octet-stream';
      return { name: a.name, contentType: a.contentType, dataUrl: `data:${mime};base64,${fs.readFileSync(a.path).toString('base64')}` };
    }),
  };
}

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
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
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
  // Filet de sécurité : un lien du message qui tenterait de charger une page DANS l'aperçu
  // (target="_self", formulaire…) est ouvert dans le navigateur à la place.
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    const { url, isMainFrame } = event;
    if (isMainFrame || !url || /^(about:|data:|blob:|file:)/i.test(url)) return;
    event.preventDefault();
    if (isSafeExternal(url)) shell.openExternal(url);
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
    const image = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png')).resize({ width: 18, height: 18 });
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
  // ---- canaux communs au bureau et au téléphone (src/handlers.js)
  registerCommonHandlers(handle, { store, manager, getScheduler: () => scheduler, getBackup: () => backupSvc, safeMail, embedFiles, sendMail });


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

  // Liens cliqués dans un e-mail : navigateur par défaut (http, https) ou logiciel associé (mailto)
  handle('app:openExternal', async (url) => {
    const u = String(url || '');
    if (!isSafeExternal(u)) throw new Error('Ce lien ne peut pas être ouvert (adresse non web).');
    await shell.openExternal(u);
    return true;
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

  // Toutes les pièces jointes d'un message dans un dossier choisi par l'utilisateur
  handle('messages:saveAllAttachments', async (accountId, folder, uid) => {
    const atts = await manager.getAllAttachments(accountId, folder, uid);
    if (!atts.length) throw new Error('Ce message n’a pas de pièce jointe.');
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: `Enregistrer les ${atts.length} pièces jointes`,
      buttonLabel: 'Enregistrer ici',
      defaultPath: app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths.length) return { saved: false };
    const dir = filePaths[0];
    // pas d'écrasement : un fichier déjà présent dans le dossier garde son nom, le nouveau est numéroté
    const existing = new Set(fs.readdirSync(dir).map((f) => f.toLowerCase()));
    const names = uniqueFileNames([...existing, ...atts.map((a) => a.filename)]).slice(existing.size);
    atts.forEach((a, i) => fs.writeFileSync(path.join(dir, names[i]), a.content));
    shell.showItemInFolder(path.join(dir, names[0]));
    return { saved: true, count: atts.length, path: dir };
  });

  handle('messages:pickAttachments', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
    if (canceled) return [];
    filePaths.forEach((p) => pickedFiles.add(p));
    return filePaths.map((p) => ({ path: p, name: path.basename(p), size: fs.statSync(p).size }));
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
    const data = rulesExportData(store);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Exporter les règles de tri',
      defaultPath: path.join(app.getPath('documents'), 'mailhub-regles.json'),
      filters: [{ name: 'Règles MailHub (.json)', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { saved: false };
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
    return rulesImportPreview(store, fs.readFileSync(filePaths[0], 'utf8'), path.basename(filePaths[0]));
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
    if (!autoUpdater) throw new Error('Module de mise à jour non disponible');
    quitting = true;
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      console.error('Erreur quitAndInstall:', err);
      throw err;
    }
    return true;
  });
}

let sendMail = null; // créé au démarrage (makeSendMail)

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
      // clic : ouvre le message (un seul) ou la boîte de réception du compte
      n.on('click', () => {
        showWindow();
        send('app:open', { accountId, folder: 'INBOX', uid: messages.length === 1 ? first.uid : null });
      });
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
  sendMail = makeSendMail(store, manager);
  // Sauvegarde des réglages dans la boîte mail : automatique après chaque modification
  backupSvc = new BackupService(store, manager, {
    device: os.hostname() || 'Ordinateur',
    app: app.getVersion(),
    notify: (kind, status) => send('backup:status', { kind, status }),
  });
  store.onChange = () => backupSvc.schedule();
  backupSvc.schedule(); // modifications faites avant la dernière fermeture

  const prefs = store.getPrefs();
  nativeTheme.themeSource = !prefs.theme || prefs.theme === 'auto' ? 'system' : (prefs.theme === 'graphite' ? 'dark' : prefs.theme);

  registerIpc();
  wireManagerEvents();
  buildMenu();
  createWindow();
  createTray();

  // Surveillance IMAP (IDLE) + tri automatique des nouveaux messages
  store.listAccounts().forEach((acc) => manager.startWatching(acc.id));

  // Envoi programmé : vérification toutes les 30 s
  scheduler = new Scheduler(store, sendMail, (kind, item) => {
    send('mail:scheduled', { kind, item });
    if (kind === 'failed' && Notification.isSupported()) {
      new Notification({ title: 'Envoi programmé en échec', body: `« ${item.subject || '(sans objet)'} » : ${item.error}${item.paused ? ' (envoi suspendu)' : ' (nouvel essai dans quelques minutes)'}` }).show();
    }
  });
  scheduler.start();

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
    send('app:error', { message: 'Mise à jour : ' + (err.message || String(err)) });
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
