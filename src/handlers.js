'use strict';

/**
 * Logique commune des « canaux » de l'interface (comptes, dossiers, messages, règles, contacts,
 * envoi programmé, préférences). Partagée par l'application de bureau (Electron, main.js) et
 * l'application Android (Node.js embarqué, mobile/nodejs). Ce qui dépend de la plateforme
 * (fenêtres de choix de fichier, ouverture de liens, notifications, mises à jour) reste à part.
 */
const { ImapManager, friendlyError } = require('./imap');
const rulesio = require('./rulesio');
const { attachmentPreview } = require('./attachment');
const tb = require('./thunderbird');

// Envoi d'un message : marque l'original « répondu » et enrichit le carnet d'adresses
function makeSendMail(store, manager) {
  return async function sendMail(accountId, mail) {
    const res = await manager.send(accountId, mail);
    // réponse : le message d'origine est marqué « répondu »
    const r = mail.replyOf;
    if (r && r.accountId && r.folder && r.uid) manager.setFlag(r.accountId, r.folder, [r.uid], 'answered', true).catch(() => {});
    // le carnet d'adresses retient tous les destinataires (À, Cc, Cci)
    try { store.recordContacts(ImapManager.parseRecipients(mail.to, mail.cc, mail.bcc)); } catch (e) { console.error('Carnet :', e.message); }
    return res;
  };
}

// Import de règles : analyse du fichier et association des comptes (aperçu avant import)
function rulesImportPreview(store, text, fileName) {
  if (String(text || '').length > 5 * 1024 * 1024) throw new Error('Fichier trop volumineux pour un export de règles.');
  const { rules, skipped } = rulesio.parseRulesFile(String(text || ''));
  const accounts = store.listAccounts();
  const existing = new Set(store.listRules().map((r) => rulesio.ruleKey(r.accountId, r)));
  const emails = [...new Set(rules.map((r) => r.accountEmail))];
  const mapping = {};
  emails.forEach((e) => { const a = accounts.find((x) => x.email.toLowerCase() === e); mapping[e] = a ? a.id : (accounts.length === 1 ? accounts[0].id : ''); });
  return {
    file: fileName, skipped, emails, mapping,
    rules: rules.map((r) => ({ ...r, duplicate: !!mapping[r.accountEmail] && existing.has(rulesio.ruleKey(mapping[r.accountEmail], r)) })),
  };
}

// Export des règles : contenu du fichier .json
function rulesExportData(store) {
  const rules = store.listRules();
  if (!rules.length) throw new Error('Vous n’avez aucune règle à exporter.');
  return rulesio.exportRules(rules, store.listAccounts());
}

// Aperçu d'un import Thunderbird à partir du texte d'un fichier msgFilterRules.dat
async function thunderbirdPreview(store, manager, text, accountId) {
  const filters = tb.parseFilterFile(String(text || ''));
  const { folders, prefix } = await manager.listFolders(accountId);
  return tb.buildPreview(filters, {
    accountId, folders, prefix, existingRules: store.listRules().filter((r) => r.accountId === accountId),
  });
}

/**
 * Enregistre les canaux communs. ctx :
 * - store, manager : stockage et connexions IMAP
 * - getScheduler() : envoi programmé (créé après l'enregistrement des canaux)
 * - safeMail(mail) : contrôle des pièces jointes d'un message sortant
 * - embedFiles(mail) : copie le contenu des fichiers joints (envoi programmé)
 * - sendMail(accountId, mail) : voir makeSendMail
 */
function registerCommonHandlers(handle, ctx) {
  const { store, manager, safeMail, embedFiles, sendMail } = ctx;
  const scheduler = { // résolu au moment de l'appel
    list: (...a) => ctx.getScheduler().list(...a),
    add: (...a) => ctx.getScheduler().add(...a),
    cancel: (...a) => ctx.getScheduler().cancel(...a),
    sendNow: (...a) => ctx.getScheduler().sendNow(...a),
    reschedule: (...a) => ctx.getScheduler().reschedule(...a),
  };

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
  handle('messages:saveDraft', (accountId, mail) => manager.saveDraft(accountId, safeMail(mail)));
  handle('messages:discardDraft', (accountId, draftId) => manager.discardDraft(accountId, draftId));

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

  handle('messages:send', (accountId, mail) => sendMail(accountId, safeMail(mail)));

  // ---- envoi programmé
  handle('scheduled:list', () => scheduler.list());
  handle('scheduled:add', async (accountId, mail, when) => {
    const m = embedFiles(safeMail(mail));
    // pièces jointes reprises d'un message (transfert, brouillon) : copiées maintenant, l'original peut disparaître
    if (m.sourceAttachments) {
      const extra = await manager._sourceAttachments(m.sourceAttachments);
      m.attachments.push(...extra.map((a) => ({ name: a.filename, contentType: a.contentType, dataUrl: `data:${a.contentType || 'application/octet-stream'};base64,${a.content.toString('base64')}` })));
      delete m.sourceAttachments;
    }
    return scheduler.add(accountId, m, when);
  });
  handle('scheduled:cancel', (id) => scheduler.cancel(id));
  handle('scheduled:sendNow', (id) => scheduler.sendNow(id));
  handle('scheduled:reschedule', (id, when) => scheduler.reschedule(id, when));

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
}

module.exports = { registerCommonHandlers, makeSendMail, rulesImportPreview, rulesExportData, thunderbirdPreview };
