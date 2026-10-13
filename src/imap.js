'use strict';

const { EventEmitter } = require('events');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const addressparser = require('nodemailer/lib/addressparser');
const { buildSignedMessage } = require('./signature');
const { findRule, senderRule, ruleMatches, domainOf } = require('./rules');

// ---------------------------------------------------------------- utilitaires

function friendlyError(err) {
  if (!err) return 'Erreur inconnue';
  if (err.authenticationFailed) {
    return "Identifiants refusés par le serveur. Vérifiez l'adresse et le mot de passe " +
      "(Gmail, iCloud et Yahoo exigent un « mot de passe d'application »).";
  }
  const code = err.code || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Serveur introuvable. Vérifiez le nom du serveur et votre connexion.';
  if (code === 'ECONNREFUSED') return 'Connexion refusée. Vérifiez le port et le mode de chiffrement (SSL/TLS).';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'Le serveur ne répond pas (délai dépassé).';
  if (/certificate|self.signed|CERT_/i.test(String(err.message) + code)) {
    return 'Certificat du serveur non valide : connexion refusée par sécurité.';
  }
  return err.responseText || err.message || String(err);
}

function isoDate(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    const d = new Date(c);
    if (!isNaN(d)) return d.toISOString();
  }
  return new Date(0).toISOString();
}

function hasAttachment(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes || []).some(hasAttachment);
}

function summarize(msg) {
  const env = msg.envelope || {};
  const from = (env.from && env.from[0]) || {};
  const flags = msg.flags || new Set();
  return {
    uid: msg.uid,
    subject: env.subject || '(sans objet)',
    from: (from.address || '').toLowerCase(),
    fromName: from.name || '',
    to: (env.to || []).map((a) => a.address || '').join(', '),
    cc: (env.cc || []).map((a) => a.address || '').join(', '),
    date: isoDate(env.date, msg.internalDate),
    size: msg.size || 0,
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    hasAttachment: hasAttachment(msg.bodyStructure),
  };
}

// mailparser renvoie un tableau quand l'en-tête apparaît plusieurs fois (To: a, puis To: b)
function addrList(field) {
  if (!field) return [];
  const blocks = Array.isArray(field) ? field : [field];
  const out = [];
  for (const block of blocks) {
    for (const a of (block && block.value) || []) {
      if (a.group) a.group.forEach((g) => out.push({ name: g.name || '', address: g.address || '' }));
      else out.push({ name: a.name || '', address: a.address || '' });
    }
  }
  return out;
}

function inlineCids(html, attachments) {
  if (!html) return html;
  let out = html;
  for (const att of attachments) {
    if (att.contentId && /^image\//i.test(att.contentType) && att.content) {
      const cid = att.contentId.replace(/^<|>$/g, '');
      const uri = `data:${att.contentType};base64,${att.content.toString('base64')}`;
      out = out.split(`cid:${cid}`).join(uri);
    }
  }
  return out;
}

const MAIL_PARSE_LIMIT = 25 * 1024 * 1024; // sécurité : on n'ouvre pas de message > 25 Mo

// Proton Mail Bridge (et ses semblables) écoute en local avec un certificat auto-signé.
// Le trafic ne quitte pas l'ordinateur : on n'assouplit la vérification que pour la boucle locale.
function tlsFor(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase())
    ? { rejectUnauthorized: false }
    : undefined;
}

// ------------------------------------------------------------------- gestion

class ImapManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.ops = new Map(); // accountId -> Promise<ImapFlow>
    this.watchers = new Map(); // accountId -> watcher
    this.processing = new Map(); // accountId -> { running, again }
  }

  // ---- connexions -----------------------------------------------------------

  _newClient(acc) {
    const client = new ImapFlow({
      host: acc.imap.host,
      port: acc.imap.port,
      secure: acc.imap.secure,
      auth: { user: acc.imap.user, pass: acc.password },
      // sans SSL direct, le chiffrement STARTTLS est exigé : jamais de mot de passe en clair
      doSTARTTLS: acc.imap.secure ? undefined : true,
      tls: tlsFor(acc.imap.host),
      logger: false,
      socketTimeout: 5 * 60 * 1000,
    });
    client.on('error', (err) => console.error(`[imap:${acc.email}]`, err.message));
    return client;
  }

  static async testConnection(cfg) {
    const client = new ImapFlow({
      host: cfg.imap.host,
      port: Number(cfg.imap.port) || 993,
      secure: cfg.imap.secure !== false,
      auth: { user: cfg.imap.user || cfg.email, pass: cfg.password },
      doSTARTTLS: cfg.imap.secure !== false ? undefined : true,
      tls: tlsFor(cfg.imap.host),
      logger: false,
      connectionTimeout: 15000,
    });
    client.on('error', () => {});
    try {
      await client.connect();
      const list = await client.list();
      await client.logout();
      return { ok: true, folders: list.length };
    } catch (err) {
      try { client.close(); } catch (_) { /* ignore */ }
      return { ok: false, error: friendlyError(err) };
    }
  }

  async _connect(accountId) {
    const acc = this.store.getAccount(accountId);
    if (!acc) throw new Error('Compte introuvable');
    const client = this._newClient(acc);
    await client.connect();
    return client;
  }

  async _ops(accountId) {
    let p = this.ops.get(accountId);
    if (p) {
      try {
        const c = await p;
        if (c.usable) return c;
      } catch (_) { /* on reconnecte */ }
      if (this.ops.get(accountId) === p) this.ops.delete(accountId);
    }
    p = this._connect(accountId);
    this.ops.set(accountId, p);
    try {
      return await p;
    } catch (err) {
      if (this.ops.get(accountId) === p) this.ops.delete(accountId);
      throw err;
    }
  }

  async withMailbox(accountId, path, fn, { readOnly = false } = {}) {
    const client = await this._ops(accountId);
    const lock = await client.getMailboxLock(path, { readOnly });
    try {
      // Si la boîte était déjà sélectionnée, son état en cache peut être périmé
      // (courrier arrivé depuis un autre appareil) : NOOP force le serveur à nous le dire.
      try { await client.noop(); } catch (_) { /* connexion en cours de reprise */ }
      return await fn(client);
    } finally {
      lock.release();
    }
  }

  async disconnect(accountId) {
    this.stopWatching(accountId);
    const p = this.ops.get(accountId);
    this.ops.delete(accountId);
    if (p) {
      try { (await p).close(); } catch (_) { /* ignore */ }
    }
  }

  async disconnectAll() {
    for (const id of [...this.watchers.keys(), ...this.ops.keys()]) await this.disconnect(id);
  }

  // ---- dossiers ---------------------------------------------------------------

  async listFolders(accountId) {
    const client = await this._ops(accountId);
    const list = await client.list({ statusQuery: { messages: true, unseen: true } });
    const folders = list.map((f) => ({
      path: f.path,
      name: f.name,
      delimiter: f.delimiter || '/',
      parentPath: f.parentPath || '',
      specialUse: f.specialUse || (f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : ''),
      selectable: !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'),
      total: f.status ? f.status.messages || 0 : 0,
      unseen: f.status ? f.status.unseen || 0 : 0,
    }));
    // Certains serveurs (Dovecot…) imposent le préfixe « INBOX. » pour les nouveaux dossiers
    const inbox = folders.find((f) => f.path.toUpperCase() === 'INBOX');
    const others = folders.filter((f) => f !== inbox);
    const prefixed = others.length > 0 && others.filter((f) => /^INBOX[./]/i.test(f.path)).length >= others.length / 2;
    const prefix = prefixed && inbox ? `INBOX${inbox.delimiter || '.'}` : '';
    return { folders, prefix };
  }

  async createFolder(accountId, path) {
    const client = await this._ops(accountId);
    const res = await client.mailboxCreate(path);
    try { await client.mailboxSubscribe(res.path); } catch (_) { /* facultatif */ }
    return { path: res.path };
  }

  async renameFolder(accountId, from, to) {
    const client = await this._ops(accountId);
    const res = await client.mailboxRename(from, to);
    return { path: res.path };
  }

  async deleteFolder(accountId, path) {
    const client = await this._ops(accountId);
    await client.mailboxDelete(path);
    return { ok: true };
  }

  async _findSpecial(client, use, nameRegex) {
    const list = await client.list();
    const bySpecial = list.find((f) => f.specialUse === use);
    if (bySpecial) return bySpecial.path;
    const byName = list.find((f) => nameRegex.test(f.name));
    return byName ? byName.path : null;
  }

  // ---- messages -----------------------------------------------------------------

  async listMessages(accountId, folder, { limit = 50, offset = 0 } = {}) {
    return this.withMailbox(accountId, folder, async (client) => {
      const exists = client.mailbox.exists;
      const end = exists - offset;
      if (end < 1) return { messages: [], total: exists };
      const start = Math.max(1, end - limit + 1);
      const out = [];
      for await (const msg of client.fetch(`${start}:${end}`, {
        uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true,
      })) {
        out.push(summarize(msg));
      }
      out.sort((a, b) => new Date(b.date) - new Date(a.date));
      return { messages: out, total: exists };
    }, { readOnly: true });
  }

  async searchMessages(accountId, folder, query, limit = 100) {
    return this.withMailbox(accountId, folder, async (client) => {
      const uids = await client.search(
        { or: [{ subject: query }, { from: query }, { to: query }] },
        { uid: true }
      );
      if (!uids || !uids.length) return { messages: [], total: 0 };
      const picked = uids.slice(-limit);
      const out = [];
      for await (const msg of client.fetch(picked.join(','), {
        uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true,
      }, { uid: true })) {
        out.push(summarize(msg));
      }
      out.sort((a, b) => new Date(b.date) - new Date(a.date));
      return { messages: out, total: uids.length };
    }, { readOnly: true });
  }

  async _fetchParsed(client, uid) {
    const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true, size: true }, { uid: true });
    if (!msg || !msg.source) throw new Error('Message introuvable (déjà déplacé ou supprimé ?)');
    if ((msg.size || 0) > MAIL_PARSE_LIMIT) throw new Error('Message trop volumineux pour être affiché.');
    const parsed = await simpleParser(msg.source);
    return { parsed, flags: msg.flags || new Set() };
  }

  async getMessage(accountId, folder, uid, { markSeen = true } = {}) {
    return this.withMailbox(accountId, folder, async (client) => {
      const { parsed, flags } = await this._fetchParsed(client, uid);
      if (markSeen && !flags.has('\\Seen')) {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }
      const attachments = parsed.attachments || [];
      const html = parsed.html ? inlineCids(parsed.html, attachments) : null;
      return {
        uid,
        messageId: parsed.messageId || '',
        references: parsed.references || [],
        subject: parsed.subject || '(sans objet)',
        from: addrList(parsed.from)[0] || { name: '', address: '' },
        to: addrList(parsed.to),
        cc: addrList(parsed.cc),
        replyTo: addrList(parsed.replyTo)[0] || null,
        date: isoDate(parsed.date),
        html,
        text: parsed.text || '',
        attachments: attachments
          .map((a, index) => ({
            index,
            filename: a.filename || `piece-jointe-${index + 1}`,
            contentType: a.contentType,
            size: a.size || (a.content ? a.content.length : 0),
            inline: !!(a.related && a.contentId),
          }))
          .filter((a) => !a.inline),
      };
    });
  }

  async getAttachment(accountId, folder, uid, index) {
    return this.withMailbox(accountId, folder, async (client) => {
      const { parsed } = await this._fetchParsed(client, uid);
      const att = (parsed.attachments || [])[index];
      if (!att) throw new Error('Pièce jointe introuvable');
      return { filename: att.filename || `piece-jointe-${index + 1}`, contentType: String(att.contentType || '').toLowerCase(), content: att.content };
    }, { readOnly: true });
  }

  async setFlag(accountId, folder, uids, flag, on) {
    const imapFlag = flag === 'seen' ? '\\Seen' : '\\Flagged';
    return this.withMailbox(accountId, folder, async (client) => {
      const range = uids.join(',');
      const res = on
        ? await client.messageFlagsAdd(range, [imapFlag], { uid: true })
        : await client.messageFlagsRemove(range, [imapFlag], { uid: true });
      if (res === false) throw new Error('Le serveur a refusé la modification du message.');
      return { ok: true };
    });
  }

  async moveMessages(accountId, folder, uids, dest) {
    return this.withMailbox(accountId, folder, async (client) => {
      const res = await client.messageMove(uids.join(','), dest, { uid: true });
      if (!res) throw new Error(`Le serveur a refusé le déplacement vers « ${dest} » (dossier introuvable ?).`);
      return { ok: true, moved: uids.length };
    });
  }

  async deleteMessages(accountId, folder, uids) {
    const client = await this._ops(accountId);
    const trash = await this._findSpecial(client, '\\Trash', /^(trash|corbeille|deleted|éléments supprimés|bin)$/i);
    return this.withMailbox(accountId, folder, async (c) => {
      const range = uids.join(',');
      const res = trash && trash !== folder
        ? await c.messageMove(range, trash, { uid: true })
        : await c.messageDelete(range, { uid: true }); // déjà dans la corbeille : suppression définitive
      if (!res) throw new Error('Le serveur a refusé la suppression.');
      return { ok: true, deleted: uids.length };
    });
  }

  /**
   * Déplace tous les messages d'un expéditeur (ou d'un domaine) d'un dossier vers un autre.
   * La recherche IMAP « FROM » est une recherche de sous-chaîne (paul@acme.fr trouverait aussi
   * bigpaul@acme.fr) : on revérifie donc chaque adresse avant de déplacer.
   */
  async moveSimilar(accountId, folder, from, dest, scope = 'address') {
    return this.withMailbox(accountId, folder, async (client) => {
      const probe = senderRule({ accountId, from, folder: dest, scope });
      const needle = scope === 'domain' ? '@' + domainOf(from) : String(from).toLowerCase();
      const found = await client.search({ from: needle }, { uid: true });
      if (!found || !found.length) return { moved: 0 };
      const exact = [];
      for await (const msg of client.fetch(found.join(','), { uid: true, envelope: true }, { uid: true })) {
        const s = summarize(msg);
        if (ruleMatches(probe, s)) exact.push(s.uid);
      }
      if (!exact.length) return { moved: 0 };
      await this._moveWithCreate(client, exact, dest);
      return { moved: exact.length };
    });
  }

  // ---- règles / tri automatique ---------------------------------------------------

  _rulesFor(accountId) {
    return this.store.listRules().filter((r) => r.accountId === accountId && r.enabled !== false);
  }

  async _moveWithCreate(client, uids, dest) {
    const range = uids.join(',');
    // ImapFlow renvoie false (sans lever d'erreur) quand le serveur refuse le déplacement
    let res = await client.messageMove(range, dest, { uid: true }).catch(() => false);
    if (!res) {
      // le dossier cible a peut-être été supprimé : on le recrée une fois
      try { await client.mailboxCreate(dest); } catch (_) { /* existe déjà ou création refusée */ }
      res = await client.messageMove(range, dest, { uid: true }).catch(() => false);
    }
    if (!res) throw new Error(`Le serveur a refusé le déplacement vers « ${dest} ».`);
  }

  /** Applique les règles aux N derniers messages d'un dossier (action manuelle). */
  async applyRulesToFolder(accountId, folder, { limit = 1000 } = {}) {
    const rules = this._rulesFor(accountId);
    if (!rules.length) return { moved: 0, scanned: 0, failed: [], noRules: true };
    return this.withMailbox(accountId, folder, async (client) => {
      const exists = client.mailbox.exists;
      if (!exists) return { moved: 0, scanned: 0, failed: [] };
      const start = Math.max(1, exists - limit + 1);
      const list = [];
      for await (const msg of client.fetch(`${start}:*`, { uid: true, envelope: true, flags: true })) {
        list.push(summarize(msg));
      }
      const byFolder = new Map();
      for (const m of list) {
        const rule = findRule(rules, accountId, m);
        if (rule && rule.folder !== folder) {
          if (!byFolder.has(rule.folder)) byFolder.set(rule.folder, []);
          byFolder.get(rule.folder).push(m.uid);
        }
      }
      let moved = 0;
      const failed = [];
      for (const [dest, uids] of byFolder) {
        try {
          await this._moveWithCreate(client, uids, dest);
          moved += uids.length;
        } catch (err) {
          failed.push({ folder: dest, count: uids.length, message: friendlyError(err) });
        }
      }
      return { moved, scanned: list.length, failed };
    });
  }

  /**
   * Traite les nouveaux messages de la boîte de réception (UID > dernier UID connu).
   * Au tout premier passage, on mémorise simplement la position : le courrier existant n'est pas touché.
   */
  async processNewInbox(accountId) {
    const rules = this._rulesFor(accountId);
    return this.withMailbox(accountId, 'INBOX', async (client) => {
      // STATUS donne des valeurs fraîches, contrairement à l'état mis en cache à la sélection
      const st = await client.status('INBOX', { uidNext: true, uidValidity: true });
      const uidNext = st.uidNext || 1;
      const validity = String(st.uidValidity);
      const sync = this.store.getSync(accountId);

      if (!sync || sync.uidValidity !== validity) {
        this.store.setSync(accountId, { uidValidity: validity, lastUid: uidNext - 1 });
        return { moved: [], fresh: [] };
      }
      if (uidNext - 1 <= sync.lastUid) return { moved: [], fresh: [] };

      const arrived = [];
      for await (const msg of client.fetch(`${sync.lastUid + 1}:*`, { uid: true, envelope: true, flags: true }, { uid: true })) {
        if (msg.uid > sync.lastUid) arrived.push(summarize(msg));
      }

      const byFolder = new Map();
      const kept = [];
      for (const m of arrived) {
        const rule = findRule(rules, accountId, m);
        if (rule && rule.folder && rule.folder.toUpperCase() !== 'INBOX') {
          if (!byFolder.has(rule.folder)) byFolder.set(rule.folder, []);
          byFolder.get(rule.folder).push(m);
        } else {
          kept.push(m);
        }
      }

      const moved = [];
      for (const [dest, list] of byFolder) {
        try {
          await this._moveWithCreate(client, list.map((m) => m.uid), dest);
          for (const m of list) moved.push({ subject: m.subject, from: m.fromName || m.from, folder: dest });
        } catch (err) {
          kept.push(...list);
          this.emit('error', { accountId, message: `Tri automatique vers « ${dest} » impossible : ${friendlyError(err)}` });
        }
      }

      const maxUid = Math.max(sync.lastUid, uidNext - 1, ...arrived.map((m) => m.uid));
      this.store.setSync(accountId, { uidValidity: validity, lastUid: maxUid });

      return { moved, fresh: kept.filter((m) => !m.seen) };
    });
  }

  _queueProcess(accountId) {
    const state = this.processing.get(accountId) || { running: false, again: false, timer: null };
    this.processing.set(accountId, state);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(async () => {
      state.timer = null;
      if (state.running) { state.again = true; return; }
      state.running = true;
      try {
        do {
          state.again = false;
          const res = await this.processNewInbox(accountId);
          if (res.moved.length) this.emit('sorted', { accountId, moved: res.moved });
          if (res.fresh.length) this.emit('new-mail', { accountId, messages: res.fresh });
          if (res.moved.length || res.fresh.length) this.emit('changed', { accountId });
        } while (state.again);
      } catch (err) {
        this.emit('error', { accountId, message: friendlyError(err) });
      } finally {
        state.running = false;
      }
    }, 1500);
  }

  // ---- surveillance (IDLE) ---------------------------------------------------------

  startWatching(accountId) {
    if (this.watchers.has(accountId)) return;
    const w = { stopped: false, client: null, timer: null, poll: null, backoff: 5000 };
    this.watchers.set(accountId, w);

    const schedule = () => {
      if (w.stopped || w.timer) return;
      w.timer = setTimeout(() => { w.timer = null; run(); }, w.backoff);
      w.backoff = Math.min(w.backoff * 2, 5 * 60 * 1000);
    };

    const run = async () => {
      if (w.stopped) return;
      const acc = this.store.getAccount(accountId);
      if (!acc) return;
      const client = this._newClient(acc);
      w.client = client;
      client.on('close', () => {
        if (w.client === client) {
          this.emit('status', { accountId, state: 'offline' });
          schedule();
        }
      });
      client.on('exists', () => this._queueProcess(accountId));
      try {
        await client.connect();
        await client.mailboxOpen('INBOX'); // reste sélectionnée : ImapFlow passe en IDLE tout seul
        w.backoff = 5000;
        this.emit('status', { accountId, state: 'online' });
        this._queueProcess(accountId);
      } catch (err) {
        this.emit('status', { accountId, state: 'error', message: friendlyError(err) });
        try { client.close(); } catch (_) { /* ignore */ }
        schedule();
      }
    };

    // filet de sécurité pour les serveurs sans IDLE
    w.poll = setInterval(() => this._queueProcess(accountId), 2 * 60 * 1000);
    run();
  }

  stopWatching(accountId) {
    const w = this.watchers.get(accountId);
    if (!w) return;
    w.stopped = true;
    clearTimeout(w.timer);
    clearInterval(w.poll);
    this.watchers.delete(accountId);
    const c = w.client;
    w.client = null;
    if (c) { try { c.close(); } catch (_) { /* ignore */ } }
  }

  // ---- favoris (messages suivis) --------------------------------------------------

  /** Messages suivis (étoile) de tous les dossiers utiles d'un compte. */
  async listFlagged(accountId, { perFolder = 100 } = {}) {
    const { folders } = await this.listFolders(accountId);
    const skip = new Set(['\\Trash', '\\Junk', '\\Drafts', '\\All', '\\Flagged']);
    const out = [];
    for (const f of folders) {
      if (!f.selectable || skip.has(f.specialUse)) continue;
      try {
        const msgs = await this.withMailbox(accountId, f.path, async (client) => {
          const found = await client.search({ flagged: true }, { uid: true });
          if (!found || !found.length) return [];
          const uids = found.slice(-perFolder);
          const list = [];
          for await (const msg of client.fetch(uids.join(','), {
            uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true,
          }, { uid: true })) list.push({ ...summarize(msg), folder: f.path });
          return list;
        }, { readOnly: true });
        out.push(...msgs);
      } catch (_) { /* dossier illisible : on passe au suivant */ }
    }
    return out;
  }

  // ---- carnet d'adresses --------------------------------------------------------

  static parseRecipients(...fields) {
    const out = [];
    const walk = (list) => (list || []).forEach((a) => {
      if (a.group) walk(a.group); else if (a.address) out.push({ name: a.name || '', address: a.address });
    });
    fields.filter(Boolean).forEach((f) => walk(addressparser(f)));
    return out;
  }

  /** Lit les destinataires des derniers messages du dossier Envoyés (pour amorcer le carnet). */
  async sentRecipients(accountId, { limit = 400 } = {}) {
    const client = await this._ops(accountId);
    const sent = await this._findSpecial(client, '\\Sent', /^(sent|envoy|éléments envoyés|sent items|sent messages)/i);
    if (!sent) return [];
    return this.withMailbox(accountId, sent, async (c) => {
      const exists = c.mailbox.exists;
      if (!exists) return [];
      const start = Math.max(1, exists - limit + 1);
      const out = [];
      for await (const msg of c.fetch(`${start}:*`, { envelope: true, internalDate: true })) {
        const env = msg.envelope || {};
        const when = isoDate(env.date, msg.internalDate);
        [...(env.to || []), ...(env.cc || [])].forEach((a) => { if (a.address) out.push({ name: a.name || '', address: a.address, when }); });
      }
      return out;
    }, { readOnly: true });
  }

  // ---- envoi (SMTP) ---------------------------------------------------------------------

  async send(accountId, mail) {
    const acc = this.store.getAccount(accountId);
    if (!acc) throw new Error('Compte introuvable');
    if (!acc.smtp) throw new Error("Aucun serveur d'envoi (SMTP) n'est configuré pour ce compte.");

    const transport = nodemailer.createTransport({
      host: acc.smtp.host,
      port: acc.smtp.port,
      secure: acc.smtp.secure,
      requireTLS: !acc.smtp.secure, // STARTTLS exigé : jamais de mot de passe en clair
      tls: tlsFor(acc.smtp.host),
      auth: { user: acc.smtp.user, pass: acc.password },
    });

    const message = {
      from: { name: acc.name, address: acc.email },
      to: mail.to,
      cc: mail.cc || undefined,
      bcc: mail.bcc || undefined,
      subject: mail.subject || '',
      text: mail.text || '',
      inReplyTo: mail.inReplyTo || undefined,
      references: mail.references && mail.references.length ? mail.references : undefined,
      attachments: (mail.attachments || []).map((p) => ({ path: p })),
    };
    // Signature avec images : les images viennent du compte (jamais de l'interface) et sont intégrées au message
    if (mail.signatureId) {
      const sig = (acc.signatures || []).find((s) => s.id === mail.signatureId);
      const built = sig && sig.images && sig.images.length ? buildSignedMessage(message.text, mail.signatureBlock || '', sig.images) : null;
      if (built) {
        message.text = built.text;
        message.html = built.html;
        message.attachments = [...built.attachments, ...message.attachments];
      }
    }

    await transport.sendMail(message);

    // Copie dans « Envoyés » (Gmail et consorts le font déjà côté serveur)
    if (!/gmail|googlemail/i.test(acc.smtp.host)) {
      try {
        const raw = await new Promise((resolve, reject) =>
          new MailComposer(message).compile().build((e, b) => (e ? reject(e) : resolve(b)))
        );
        const client = await this._ops(accountId);
        const sent = await this._findSpecial(client, '\\Sent', /^(sent|envoy|éléments envoyés|sent items|sent messages)/i);
        if (sent) await client.append(sent, raw, ['\\Seen']);
      } catch (err) {
        console.error('Copie dans Envoyés impossible :', err.message);
      }
    }
    return { ok: true };
  }
}

module.exports = { ImapManager, friendlyError };
