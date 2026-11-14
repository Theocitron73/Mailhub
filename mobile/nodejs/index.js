'use strict';

/**
 * MailHub Android : moteur mail exécuté par Node.js embarqué (@capawesome/capacitor-nodejs).
 *
 * Le même code que l'application de bureau (src/) se charge des comptes IMAP, du tri automatique,
 * de l'envoi SMTP et de l'envoi programmé. L'interface (WebView) lui parle par le module « bridge » :
 * - interface -> Node : « ipc » { id, channel, args }  ->  réponse « ipc:reply » { id, ok, data | error }
 * - Node -> interface : « event » (canal, données) pour les nouveaux messages, tris, états…
 * - interface -> Node : « init » { key, version } au démarrage (clé de chiffrement venue du Keystore Android)
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { app, channel } = require('bridge');

const { Store } = require('../../src/store');
const { ImapManager, friendlyError } = require('../../src/imap');
const { safeOutgoing } = require('../../src/attachment');
const { cleanImage } = require('../../src/signature');
const { Scheduler } = require('../../src/scheduler');
const tb = require('../../src/thunderbird');
const { registerCommonHandlers, makeSendMail, rulesImportPreview, rulesExportData, thunderbirdPreview } = require('../../src/handlers');

const handlers = new Map();
const handle = (name, fn) => handlers.set(name, fn);
const emit = (name, payload) => channel.post('event', name, payload);

let store = null;
let manager = null;
let scheduler = null;
let sendMail = null;
let started = false;
let appVersion = '0.0.0';

// Chiffrement des mots de passe : AES-256-GCM avec une clé gardée dans le Keystore Android
// (transmise par l'interface au démarrage). Même interface que safeStorage d'Electron.
function keystoreCipher(keyB64) {
  const key = Buffer.from(String(keyB64 || ''), 'base64');
  const ok = key.length === 32;
  return {
    isEncryptionAvailable: () => ok,
    encryptString(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), enc]);
    },
    decryptString(buf) {
      const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

// Sur le téléphone, aucun fichier n'est lu par chemin : les pièces jointes arrivent avec leur contenu
const safeMail = (mail) => safeOutgoing(mail, new Set(), () => null);
const embedFiles = (mail) => mail;

const MAX_RAW = 25 * 1024 * 1024;
const thunderbirdFiles = new Map(); // fichiers de filtres choisis dans l'interface (nom -> texte)

function registerMobileHandlers() {
  registerCommonHandlers(handle, { store, manager, getScheduler: () => scheduler, safeMail, embedFiles, sendMail });

  // Pièce jointe complète, pour l'enregistrer ou l'ouvrir avec une autre application
  handle('messages:attachmentRaw', async (accountId, folder, uid, index) => {
    const att = await manager.getAttachment(accountId, folder, uid, index);
    if (att.content.length > MAX_RAW) throw new Error('Pièce jointe trop lourde pour le téléphone (25 Mo maximum).');
    return { filename: path.basename(att.filename) || 'piece-jointe', contentType: att.contentType || 'application/octet-stream', base64: att.content.toString('base64') };
  });

  // Image de signature choisie dans l'interface : vérifiée ici (format, taille)
  handle('signatures:clean', (im) => {
    const out = cleanImage({ ...im, id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) });
    if (!out) throw new Error('Image illisible ou trop lourde (png, jpg, gif ou webp, 1,5 Mo maximum).');
    return out;
  });

  // Réglages et règles : contenu échangé avec l'interface, qui l'enregistre ou le partage
  handle('settings:exportData', () => store.exportSettings());
  handle('settings:importData', (data) => {
    if (!data || typeof data !== 'object') throw new Error('Fichier de réglages illisible.');
    store.importSettings(data);
    return { imported: true };
  });
  handle('rules:exportData', () => rulesExportData(store));
  handle('rules:importPickDirect', ({ file, text }) => rulesImportPreview(store, text, String(file || 'regles.json')));

  // Import Thunderbird : le fichier msgFilterRules.dat est choisi dans l'interface
  handle('thunderbird:scan', () => []);
  handle('thunderbird:pickDirect', ({ file, text }) => {
    const filters = tb.parseFilterFile(String(text || ''));
    if (!filters.length) throw new Error('Ce fichier ne contient aucun filtre Thunderbird reconnu.');
    const id = 'tb-' + Date.now().toString(36) + '-' + path.basename(String(file || 'msgFilterRules.dat'));
    thunderbirdFiles.set(id, String(text));
    return { file: id, server: path.basename(String(file || '')), filters: filters.length, suggestedAccountId: tb.suggestAccount(store.listAccounts(), tb.serverHints(filters), ''), profile: '' };
  });
  handle('thunderbird:preview', (file, accountId) => {
    if (!thunderbirdFiles.has(file)) throw new Error('Fichier non autorisé : choisissez-le de nouveau.');
    return thunderbirdPreview(store, manager, thunderbirdFiles.get(file), accountId);
  });

  handle('prefs:set', (patch) => store.setPrefs(patch || {}));

  // Mises à jour : dernière version publiée sur GitHub (l'APK se télécharge depuis la page de la version)
  handle('updates:check', async () => {
    const res = await fetch('https://api.github.com/repos/Theocitron73/Mailhub/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MailHub-Android' },
    });
    if (res.status === 404) return { update: false, version: appVersion, noRelease: true, message: 'Aucune version publiée.' };
    if (!res.ok) throw new Error(`Impossible de vérifier les mises à jour (GitHub : ${res.status}).`);
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const apk = (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
    return {
      update: newer(latest, appVersion) && !!apk,
      version: appVersion,
      latest,
      url: apk ? apk.browser_download_url : rel.html_url,
      page: rel.html_url,
    };
  });
}

// « 1.10.0 » est plus récent que « 1.9.2 »
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function wireManagerEvents() {
  manager.on('sorted', ({ accountId, moved }) => emit('mail:sorted', { accountId, moved }));
  manager.on('new-mail', ({ accountId, messages }) => {
    const acc = store.listAccounts().find((a) => a.id === accountId);
    emit('mail:new', {
      accountId,
      count: messages.length,
      accountName: acc ? acc.name : '',
      messages: messages.slice(0, 3).map((m) => ({ uid: m.uid, subject: m.subject, from: m.fromName || m.from })),
    });
  });
  manager.on('changed', (payload) => emit('mail:changed', payload));
  manager.on('status', (payload) => emit('account:status', payload));
  manager.on('error', (payload) => emit('app:error', payload));
}

function start({ key, version } = {}) {
  if (started) return { ready: true };
  started = true;
  appVersion = String(version || appVersion);
  const dataDir = app.datadir();
  fs.mkdirSync(dataDir, { recursive: true });
  store = new Store(dataDir, keystoreCipher(key));
  manager = new ImapManager(store);
  sendMail = makeSendMail(store, manager);
  registerMobileHandlers();
  wireManagerEvents();
  scheduler = new Scheduler(store, sendMail, (kind, item) => emit('mail:scheduled', { kind, item }));
  scheduler.start();
  store.listAccounts().forEach((acc) => manager.startWatching(acc.id));
  return { ready: true };
}

// Requêtes de l'interface
channel.on('ipc', async (msg) => {
  const { id, channel: name, args } = msg || {};
  const reply = (body) => channel.post('ipc:reply', { id, ...body });
  try {
    if (name === 'init') { reply({ ok: true, data: start(args && args[0]) }); return; }
    if (!started) throw new Error('MailHub démarre encore, réessayez dans un instant.');
    const fn = handlers.get(name);
    if (!fn) throw new Error(`Canal inconnu : ${name}`);
    reply({ ok: true, data: await fn(...(Array.isArray(args) ? args : [])) });
  } catch (err) {
    console.error(`[${name}]`, err && err.message);
    reply({ ok: false, error: friendlyError(err) });
  }
});

// Application mise en arrière-plan : Android peut figer Node.js et couper les connexions.
// Au retour, on rouvre des connexions neuves, on relance l'envoi programmé et on rafraîchit l'interface.
app.on('pause', (lock) => lock.release());
app.on('resume', async () => {
  if (!started) return;
  for (const acc of store.listAccounts()) {
    try { await manager.disconnect(acc.id); } catch (_) { /* déjà fermée */ }
    manager.startWatching(acc.id);
    emit('mail:changed', { accountId: acc.id });
  }
  scheduler.tick().catch(() => {});
});

module.exports = { keystoreCipher, newer, channels: () => [...handlers.keys()] };
