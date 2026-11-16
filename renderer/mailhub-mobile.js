'use strict';

/**
 * MailHub Android : fournit window.mailhub (la même interface que preload.js sur ordinateur)
 * au-dessus de Capacitor.
 * - Les requêtes partent vers le moteur mail qui tourne dans Node.js embarqué (plugin Nodejs).
 * - Fichiers, partage, liens, notifications et bouton retour passent par les plugins Capacitor.
 * Chargé après capacitor.js (window.capacitorExports) et version.js.
 */
(() => {
  const core = window.capacitorExports;
  if (!core) { console.error('Capacitor indisponible'); return; }
  const plugin = (name) => core.registerPlugin(name);
  const Nodejs = plugin('Nodejs');
  const Secure = plugin('SecureStoragePlugin');
  const Fs = plugin('Filesystem');
  const Share = plugin('Share');
  const Browser = plugin('Browser');
  const Notif = plugin('LocalNotifications');
  const App = plugin('App');
  const FileOpener = plugin('FileOpener');
  const VERSION = window.MAILHUB_VERSION || '0.0.0';

  // ---------------------------------------------------------------- événements
  const listeners = new Map(); // canal -> Set(callback)
  function dispatch(channel, payload) {
    const set = listeners.get(channel);
    if (set) set.forEach((cb) => { try { cb(payload); } catch (err) { console.error(err); } });
  }

  // ------------------------------------------------- dialogue avec Node.js embarqué
  const pending = new Map();
  let seq = 0;
  Nodejs.addListener('message', ({ eventName, args }) => {
    if (eventName === 'ipc:reply') {
      const m = args[0] || {};
      const done = pending.get(m.id);
      if (done) { pending.delete(m.id); done(m.ok ? { ok: true, data: m.data } : { ok: false, error: m.error }); }
    } else if (eventName === 'event') {
      onEngineEvent(args[0], args[1]);
    }
  });
  function send(channel, args) {
    const id = ++seq;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      Nodejs.send({ eventName: 'ipc', args: [{ id, channel, args }] }).catch((err) => {
        pending.delete(id);
        resolve({ ok: false, error: err.message || String(err) });
      });
    });
  }

  // Clé de chiffrement des mots de passe : créée au premier lancement, gardée dans le Keystore Android
  async function encryptionKey() {
    try {
      const { value } = await Secure.get({ key: 'mailhub.engine.key' });
      if (value) return value;
    } catch (_) { /* pas encore de clé */ }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const value = btoa(String.fromCharCode(...bytes));
    await Secure.set({ key: 'mailhub.engine.key', value });
    return value;
  }

  async function boot() {
    await new Promise((resolve) => {
      let done = false;
      const ok = () => { if (!done) { done = true; resolve(); } };
      Nodejs.addListener('ready', ok);
      Nodejs.isReady().then(({ ready }) => { if (ready) ok(); }).catch(() => {});
    });
    const key = await encryptionKey();
    const r = await send('init', [{ key, version: VERSION }]);
    if (!r.ok) throw new Error(r.error);
  }
  const booted = boot();
  booted.catch((err) => console.error('Moteur MailHub :', err));

  async function invoke(channel, ...args) {
    try { await booted; } catch (err) { return { ok: false, error: 'Le moteur mail n’a pas pu démarrer : ' + (err.message || err) }; }
    return send(channel, args);
  }
  const ok = (data) => ({ ok: true, data });
  const fail = (err) => ({ ok: false, error: (err && err.message) || String(err) });
  // annulation volontaire (partage refusé, aucun fichier choisi) : pas une erreur
  const isCancel = (err) => /cancel|annul/i.test(String((err && err.message) || err));

  // ----------------------------------------------------------------- fichiers
  function pickFiles({ accept = '', multiple = false, as = 'dataUrl' } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = multiple;
      input.style.display = 'none';
      document.body.appendChild(input);
      const finish = (v) => { input.remove(); resolve(v); };
      input.addEventListener('cancel', () => finish([]));
      input.addEventListener('change', async () => {
        const out = [];
        for (const f of Array.from(input.files || [])) {
          const content = await new Promise((res, rej) => {
            const reader = new FileReader();
            reader.onload = () => res(reader.result);
            reader.onerror = () => rej(reader.error);
            if (as === 'text') reader.readAsText(f); else reader.readAsDataURL(f);
          });
          out.push({ name: f.name, size: f.size, type: f.type, content });
        }
        finish(out);
      });
      input.click();
    });
  }

  const safeName = (n) => String(n || 'fichier').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'fichier';
  async function writeCache(name, data, encoding) {
    const res = await Fs.writeFile({
      path: `mailhub/${Date.now().toString(36)}-${safeName(name)}`,
      data,
      directory: 'CACHE',
      recursive: true,
      ...(encoding ? { encoding } : {}),
    });
    return res.uri;
  }
  // Feuille de partage Android : « Enregistrer dans Fichiers », Drive, une messagerie…
  async function shareFile(name, data, encoding, title) {
    const uri = await writeCache(name, data, encoding);
    try {
      await Share.share({ title: title || name, files: [uri], dialogTitle: title || 'Enregistrer ou partager' });
      return true;
    } catch (err) {
      if (isCancel(err)) return false;
      throw err;
    }
  }
  const BLOCKED_OPEN = /\.(apk|apks|xapk|aab|exe|bat|cmd|com|scr|msi|js|jse|vbs|ps1|sh|jar|dex)$/i;

  // ----------------------------------------------------------------- liens
  const openUrl = (url) => Browser.open({ url, presentationStyle: 'popover' });
  // les ouvertures de fenêtre (liens d'aide, page de mise à jour) passent par le navigateur du téléphone
  const nativeOpen = window.open.bind(window);
  window.open = (url, ...rest) => {
    const u = String(url || '');
    if (/^https?:/i.test(u)) { openUrl(u); return null; }
    return nativeOpen(url, ...rest);
  };

  // ------------------------------------------------------------- notifications
  let foreground = true;
  App.addListener('appStateChange', ({ isActive }) => { foreground = isActive; });
  let notifId = 1;
  let notifAllowed = null;
  async function canNotify() {
    if (notifAllowed !== null) return notifAllowed;
    try {
      let p = await Notif.checkPermissions();
      if (p.display === 'prompt' || p.display === 'prompt-with-rationale') p = await Notif.requestPermissions();
      notifAllowed = p.display === 'granted';
    } catch (_) { notifAllowed = false; }
    return notifAllowed;
  }
  async function notify(title, body, extra) {
    if (foreground && !document.hidden) return; // l'interface affiche déjà l'information
    if (!(await canNotify())) return;
    try {
      await Notif.schedule({ notifications: [{ id: (notifId++ % 100000) + 1, title: String(title).slice(0, 120), body: String(body || '').slice(0, 300), extra }] });
    } catch (err) { console.error('Notification :', err); }
  }
  Notif.addListener('localNotificationActionPerformed', ({ notification }) => {
    const x = notification && notification.extra;
    if (x && x.accountId) dispatch('app:open', { accountId: x.accountId, folder: x.folder || 'INBOX', uid: x.uid || null });
  });

  function onEngineEvent(channel, payload) {
    if (channel === 'mail:new' && payload && payload.count) {
      const first = (payload.messages || [])[0] || {};
      const title = payload.count === 1 ? (first.from || 'Nouveau message') : `${payload.count} nouveaux messages · ${payload.accountName || ''}`;
      const body = payload.count === 1 ? first.subject : (payload.messages || []).map((m) => m.subject).join('\n');
      notify(title, body, { accountId: payload.accountId, folder: 'INBOX', uid: payload.count === 1 ? first.uid : null });
    } else if (channel === 'mail:sorted' && payload && payload.moved && payload.moved.length) {
      notify(`${payload.moved.length} message(s) trié(s)`, payload.moved.slice(0, 3).map((m) => `${m.subject} → ${m.folder}`).join('\n'), { accountId: payload.accountId, folder: 'INBOX' });
    } else if (channel === 'mail:scheduled' && payload && payload.kind === 'failed') {
      notify('Envoi programmé en échec', `« ${payload.item.subject || '(sans objet)'} » : ${payload.item.error}`, {});
    }
    dispatch(channel, payload);
  }

  // ------------------------------------------------------------ bouton retour
  // L'interface s'abonne avec mailhubMobile.onBack(fn) ; fn renvoie true si elle a géré le retour.
  const backHandlers = [];
  App.addListener('backButton', () => {
    for (let i = backHandlers.length - 1; i >= 0; i--) {
      try { if (backHandlers[i]()) return; } catch (err) { console.error(err); }
    }
    App.minimizeApp(); // rien à fermer : MailHub passe en arrière-plan (sans quitter)
  });
  window.mailhubMobile = {
    onBack(fn) { backHandlers.push(fn); return () => { const i = backHandlers.indexOf(fn); if (i >= 0) backHandlers.splice(i, 1); }; },
  };

  // ------------------------------------------------------------ mises à jour
  let latestUpdate = null;
  async function checkUpdates() {
    const r = await invoke('updates:check');
    if (r.ok && r.data && r.data.update) latestUpdate = r.data;
    return r;
  }
  setTimeout(() => {
    checkUpdates().then((r) => {
      if (r.ok && r.data && r.data.update) dispatch('app:updateApk', { version: r.data.latest, url: r.data.url });
    }).catch(() => {});
  }, 15000);

  // --------------------------------------------------------- API window.mailhub
  window.mailhub = {
    platform: 'android',
    mobile: true,
    getPathForFile: () => '',

    accounts: {
      list: () => invoke('accounts:list'),
      test: (cfg) => invoke('accounts:test', cfg),
      add: (cfg) => invoke('accounts:add', cfg),
      update: (id, patch) => invoke('accounts:update', id, patch),
      remove: (id) => invoke('accounts:remove', id),
      encryptionAvailable: () => invoke('accounts:encryption'),
    },

    folders: {
      list: (accountId) => invoke('folders:list', accountId),
      create: (accountId, path) => invoke('folders:create', accountId, path),
      rename: (accountId, from, to) => invoke('folders:rename', accountId, from, to),
      remove: (accountId, path) => invoke('folders:remove', accountId, path),
    },

    messages: {
      list: (accountId, folder, opts) => invoke('messages:list', accountId, folder, opts),
      unified: (limit) => invoke('messages:unified', limit),
      search: (accountId, folder, query) => invoke('messages:search', accountId, folder, query),
      get: (accountId, folder, uid) => invoke('messages:get', accountId, folder, uid),
      flag: (accountId, folder, uids, flag, on) => invoke('messages:flag', accountId, folder, uids, flag, on),
      move: (accountId, folder, uids, dest) => invoke('messages:move', accountId, folder, uids, dest),
      remove: (accountId, folder, uids) => invoke('messages:remove', accountId, folder, uids),
      attachmentData: (accountId, folder, uid, index) => invoke('messages:attachmentData', accountId, folder, uid, index),
      saveAttachment: async (accountId, folder, uid, index) => {
        const r = await invoke('messages:attachmentRaw', accountId, folder, uid, index);
        if (!r.ok) return r;
        try { return ok({ saved: await shareFile(r.data.filename, r.data.base64, null, 'Enregistrer la pièce jointe') }); } catch (err) { return fail(err); }
      },
      saveAllAttachments: async (accountId, folder, uid) => {
        const r = await invoke('messages:attachmentsRaw', accountId, folder, uid);
        if (!r.ok) return r;
        try {
          const files = [];
          for (const a of r.data) files.push(await writeCache(a.filename, a.base64));
          await Share.share({ title: 'Pièces jointes', files, dialogTitle: `Enregistrer les ${files.length} pièces jointes` });
          return ok({ saved: true, count: files.length });
        } catch (err) {
          return isCancel(err) ? ok({ saved: false }) : fail(err);
        }
      },
      openAttachment: async (accountId, folder, uid, index) => {
        const r = await invoke('messages:attachmentRaw', accountId, folder, uid, index);
        if (!r.ok) return r;
        if (BLOCKED_OPEN.test(r.data.filename)) return fail('Ce type de fichier ne peut pas être ouvert directement, par sécurité. Enregistrez-le d’abord.');
        try {
          const uri = await writeCache(r.data.filename, r.data.base64);
          await FileOpener.openFile({ path: uri, mimeType: r.data.contentType });
          return ok({ ok: true });
        } catch (err) {
          return fail(/activity|no app|aucune/i.test(String(err.message)) ? 'Aucune application du téléphone ne sait ouvrir ce fichier. Enregistrez-le ou partagez-le.' : err);
        }
      },
      send: (accountId, mail) => invoke('messages:send', accountId, mail),
      markAllRead: (accountId, folder) => invoke('messages:markAllRead', accountId, folder),
      markAllReadInAccount: (accountId) => invoke('messages:markAllReadInAccount', accountId),
      deleteAllInFolder: (accountId, folder) => invoke('messages:deleteAllInFolder', accountId, folder),
      saveDraft: (accountId, mail) => invoke('messages:saveDraft', accountId, mail),
      discardDraft: (accountId, draftId) => invoke('messages:discardDraft', accountId, draftId),
      flagged: () => invoke('messages:flagged'),
      pickAttachments: async () => {
        const files = await pickFiles({ multiple: true });
        return ok(files.map((f) => ({ name: f.name, size: f.size, dataUrl: f.content, path: '' })));
      },
    },

    rules: {
      list: () => invoke('rules:list'),
      add: (rule) => invoke('rules:add', rule),
      update: (rule) => invoke('rules:update', rule),
      remove: (id) => invoke('rules:remove', id),
      addMany: (list) => invoke('rules:addMany', list),
      move: (id, delta) => invoke('rules:move', id, delta),
      sortSender: (payload) => invoke('rules:sortSender', payload),
      autoSender: (payload) => invoke('rules:autoSender', payload),
      applyToFolder: (accountId, folder) => invoke('rules:applyToFolder', accountId, folder),
      applyAll: (accountId) => invoke('rules:applyAll', accountId),
      export: async () => {
        const r = await invoke('rules:exportData');
        if (!r.ok) return r;
        try {
          const saved = await shareFile('mailhub-regles.json', JSON.stringify(r.data, null, 2), 'utf8', 'Exporter les règles de tri');
          return ok({ saved, count: r.data.rules.length, path: 'mailhub-regles.json' });
        } catch (err) { return fail(err); }
      },
      importPick: async () => {
        const [f] = await pickFiles({ accept: '.json,application/json', as: 'text' });
        if (!f) return ok(null);
        return invoke('rules:importPickDirect', { file: f.name, text: f.content });
      },
      duplicates: (items) => invoke('rules:duplicates', items),
    },

    signatures: {
      pickImage: async () => {
        const [f] = await pickFiles({ accept: 'image/png,image/jpeg,image/gif,image/webp' });
        if (!f) return ok(null);
        return invoke('signatures:clean', { dataUrl: f.content, name: f.name });
      },
    },

    contacts: {
      list: () => invoke('contacts:list'),
      remove: (email) => invoke('contacts:remove', email),
      importSent: () => invoke('contacts:importSent'),
    },

    app: {
      hide: async () => { try { await App.minimizeApp(); } catch (_) { /* ignore */ } return ok(true); },
      openExternal: async (url) => {
        const u = String(url || '');
        if (!/^https?:/i.test(u)) return fail('Ce lien ne peut pas être ouvert (adresse non web).');
        try { await openUrl(u); return ok(true); } catch (err) { return fail(err); }
      },
    },

    thunderbird: {
      scan: () => invoke('thunderbird:scan'),
      pick: async () => {
        const [f] = await pickFiles({ accept: '.dat,text/plain', as: 'text' });
        if (!f) return ok(null);
        return invoke('thunderbird:pickDirect', { file: f.name, text: f.content });
      },
      preview: (file, accountId) => invoke('thunderbird:preview', file, accountId),
    },

    prefs: {
      get: () => invoke('prefs:get'),
      set: (patch) => invoke('prefs:set', patch),
    },

    settings: {
      export: async () => {
        const r = await invoke('settings:exportData');
        if (!r.ok) return r;
        try { return ok({ saved: await shareFile('mailhub-settings.json', JSON.stringify(r.data, null, 2), 'utf8', 'Exporter les réglages'), path: 'mailhub-settings.json' }); } catch (err) { return fail(err); }
      },
      import: async () => {
        const [f] = await pickFiles({ accept: '.json,application/json', as: 'text' });
        if (!f) return ok(null);
        let data;
        try { data = JSON.parse(f.content); } catch (_) { return fail('Ce fichier n’est pas un export de réglages MailHub.'); }
        return invoke('settings:importData', data);
      },
    },

    backup: {
      status: () => invoke('backup:status'),
      enable: (opts) => invoke('backup:enable', opts),
      update: (opts) => invoke('backup:update', opts),
      disable: () => invoke('backup:disable'),
      saveNow: () => invoke('backup:saveNow'),
      find: (accountId) => invoke('backup:find', accountId),
      restore: (accountId, passphrase, uid) => invoke('backup:restore', accountId, passphrase, uid),
    },

    scheduled: {
      list: () => invoke('scheduled:list'),
      add: (accountId, mail, when) => invoke('scheduled:add', accountId, mail, when),
      cancel: (id) => invoke('scheduled:cancel', id),
      sendNow: (id) => invoke('scheduled:sendNow', id),
      reschedule: (id, when) => invoke('scheduled:reschedule', id, when),
    },

    // Mises à jour : la nouvelle version (APK) se télécharge depuis GitHub, Android l'installe
    updates: {
      check: () => checkUpdates(),
      install: async () => {
        const url = latestUpdate ? latestUpdate.url : 'https://github.com/Theocitron73/Mailhub/releases/latest';
        try { await openUrl(url); return ok(true); } catch (err) { return fail(err); }
      },
    },

    on: (channel, callback) => {
      const allowed = ['mail:sorted', 'mail:new', 'mail:changed', 'account:status', 'app:error', 'app:closeTab', 'app:updateAvailable', 'app:updateDownloaded', 'app:updateApk', 'app:open', 'mail:scheduled', 'backup:status'];
      if (!allowed.includes(channel)) return () => {};
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(callback);
      return () => { const set = listeners.get(channel); if (set) set.delete(callback); };
    },
  };
})();
