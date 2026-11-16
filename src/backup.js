'use strict';

/**
 * Sauvegarde des réglages de MailHub (comptes, mots de passe en option, règles, signatures,
 * carnet d'adresses, préférences), chiffrée avec une phrase secrète que seul l'utilisateur connaît.
 *
 * - Chiffrement : clé dérivée de la phrase secrète par scrypt, puis AES-256-GCM (authentifié :
 *   une phrase fausse ou un fichier modifié sont détectés).
 * - Les comptes sont désignés par leur adresse e-mail (les identifiants internes changent d'un
 *   appareil à l'autre) : règles, couleurs et dossiers repliés sont réassociés à la restauration.
 * - BackupService range la sauvegarde dans un dossier de l'un des comptes mail (« MailHub-Sauvegarde ») :
 *   rien à installer ni à créer, et elle est retrouvée depuis n'importe quel appareil.
 */

const crypto = require('crypto');
const rulesio = require('./rulesio');

const FORMAT = 'mailhub-backup';
const VERSION = 1;
const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1 };
const MIN_PASSPHRASE = 8;

// Préférences propres à un appareil (taille de fenêtre, démarrage…) : jamais copiées ailleurs
const LOCAL_PREFS = new Set(['backup', 'openAtLogin', 'sidebarWidth', 'listWidth', 'listHeight', 'listFromWidth']);

// ------------------------------------------------------------------ chiffrement

function deriveKey(passphrase, saltB64, kdf = KDF) {
  const pass = String(passphrase || '').normalize('NFKC');
  if (pass.length < MIN_PASSPHRASE) throw new Error(`La phrase secrète doit faire au moins ${MIN_PASSPHRASE} caractères.`);
  if (kdf.name !== 'scrypt' || kdf.N > 1048576 || kdf.r > 16 || kdf.p > 4) throw new Error('Sauvegarde illisible (paramètres inconnus).');
  return crypto.scryptSync(pass, Buffer.from(saltB64, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

const newSalt = () => crypto.randomBytes(16).toString('base64');

// Enveloppe : seules la date, l'appareil et la version de MailHub restent lisibles
function encrypt(payload, key, saltB64, meta = {}) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(FORMAT));
  const data = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return {
    format: FORMAT,
    version: VERSION,
    createdAt: meta.createdAt || new Date().toISOString(),
    device: String(meta.device || '').slice(0, 80),
    app: String(meta.app || '').slice(0, 20),
    kdf: { ...KDF, salt: saltB64 },
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function readEnvelope(text) {
  let env;
  try { env = typeof text === 'string' ? JSON.parse(text) : text; } catch (_) { env = null; }
  if (!env || env.format !== FORMAT || !env.kdf || !env.data) throw new Error('Ce n’est pas une sauvegarde MailHub.');
  if (env.version !== VERSION) throw new Error('Sauvegarde faite par une version plus récente de MailHub : mettez l’application à jour.');
  return env;
}

function decrypt(env, key) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
    d.setAAD(Buffer.from(FORMAT));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    const json = Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]).toString('utf8');
    return JSON.parse(json);
  } catch (_) {
    throw new Error('Phrase secrète incorrecte (ou sauvegarde abîmée).');
  }
}

// ------------------------------------------------------- contenu de la sauvegarde

// Clés « idCompte|chemin » des préférences -> « email|chemin » (et l'inverse à la restauration)
function remapKeys(keys, from) {
  return keys.map((k) => {
    const i = k.indexOf('|');
    if (i < 0) return null;
    const to = from.get(k.slice(0, i));
    return to ? `${to}|${k.slice(i + 1)}` : null;
  }).filter(Boolean);
}
function remapObject(obj, from) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const [nk] = remapKeys([k], from);
    if (nk) out[nk] = v;
  }
  return out;
}

function collect(store, { includePasswords = true } = {}) {
  const accounts = store.listAccounts();
  const emailOf = new Map(accounts.map((a) => [a.id, a.email.toLowerCase()]));
  const prefs = {};
  for (const [k, v] of Object.entries(store.getPrefs() || {})) if (!LOCAL_PREFS.has(k)) prefs[k] = v;
  if (prefs.folderColors) prefs.folderColors = remapObject(prefs.folderColors, emailOf);
  if (Array.isArray(prefs.collapsedFolders)) prefs.collapsedFolders = remapKeys(prefs.collapsedFolders, emailOf);
  return {
    accounts: accounts.map((a) => {
      const full = store.getAccount(a.id);
      let password = '';
      if (includePasswords) { try { password = full.password || ''; } catch (_) { password = ''; } }
      return {
        email: a.email, name: a.name, color: a.color, imap: a.imap, smtp: a.smtp || null,
        signatures: a.signatures || [], defaultSignature: a.defaultSignature || '',
        ...(includePasswords && password ? { password } : {}),
      };
    }),
    rules: rulesio.exportRules(store.listRules(), accounts).rules,
    prefs,
    contacts: store.listContacts(),
    includesPasswords: !!includePasswords,
  };
}

// Empreinte du contenu (pour ne sauvegarder que ce qui a changé)
function fingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Restaure une sauvegarde en la FUSIONNANT avec ce qui existe déjà sur l'appareil :
 * comptes ajoutés s'ils manquent (repérés par l'adresse), mot de passe complété s'il manquait,
 * règles ajoutées sans doublon, contacts fusionnés, préférences remplacées (sauf celles de l'appareil).
 */
function restore(store, payload) {
  const summary = { accountsAdded: [], accountsUpdated: [], needPassword: [], rulesAdded: 0, contacts: 0 };
  const byEmail = () => new Map(store.listAccounts().map((a) => [a.email.toLowerCase(), a]));

  for (const acc of Array.isArray(payload.accounts) ? payload.accounts : []) {
    if (!acc || !acc.email || !acc.imap || !acc.imap.host) continue;
    const email = String(acc.email).toLowerCase();
    const local = byEmail().get(email);
    const sig = Array.isArray(acc.signatures) && acc.signatures.length ? { signatures: acc.signatures, defaultSignature: acc.defaultSignature || '' } : {};
    if (!local) {
      const created = store.addAccount({ name: acc.name, email: acc.email, color: acc.color, imap: acc.imap, smtp: acc.smtp, password: acc.password || '' });
      if (sig.signatures) store.updateAccount(created.id, sig);
      summary.accountsAdded.push(acc.email);
      if (!acc.password) summary.needPassword.push(acc.email);
    } else {
      const patch = {};
      if (sig.signatures && !(local.signatures || []).length) Object.assign(patch, sig);
      let hasPassword = true;
      try { hasPassword = !!store.getAccount(local.id).password; } catch (_) { hasPassword = false; }
      if (!hasPassword && acc.password) patch.password = acc.password;
      if (Object.keys(patch).length) { store.updateAccount(local.id, patch); summary.accountsUpdated.push(acc.email); }
    }
  }

  const ids = byEmail();
  const idOf = new Map([...ids].map(([email, a]) => [email, a.id]));
  const existing = new Set(store.listRules().map((r) => rulesio.ruleKey(r.accountId, r)));
  const { rules } = rulesio.parseRulesFile(JSON.stringify({ type: 'rules', version: 1, rules: payload.rules || [] }));
  const toAdd = [];
  for (const r of rules) {
    const accountId = idOf.get(r.accountEmail);
    if (!accountId) continue;
    const key = rulesio.ruleKey(accountId, r);
    if (existing.has(key)) continue;
    existing.add(key);
    const { accountEmail, ...rest } = r;
    toAdd.push({ ...rest, accountId });
  }
  if (toAdd.length) store.addRules(toAdd);
  summary.rulesAdded = toAdd.length;

  const prefs = { ...(payload.prefs || {}) };
  for (const k of LOCAL_PREFS) delete prefs[k];
  if (prefs.folderColors) prefs.folderColors = { ...(store.getPrefs().folderColors || {}), ...remapObject(prefs.folderColors, idOf) };
  if (Array.isArray(prefs.collapsedFolders)) prefs.collapsedFolders = [...new Set([...(store.getPrefs().collapsedFolders || []), ...remapKeys(prefs.collapsedFolders, idOf)])];
  delete prefs.includesPasswords;
  if (Object.keys(prefs).length) store.setPrefs(prefs);

  for (const c of Array.isArray(payload.contacts) ? payload.contacts : []) {
    if (!c || !c.email) continue;
    summary.contacts += store.recordContacts([{ address: c.email, name: c.name || '' }], { when: c.last || undefined, bump: Math.max(1, Number(c.count) || 1) });
  }
  return summary;
}

// ------------------------------------------------- sauvegarde dans la boîte mail

const AUTO_DELAY = 90 * 1000; // après une modification, on attend un peu (plusieurs changements = une sauvegarde)

class BackupService {
  /**
   * store, manager : stockage et connexions IMAP
   * opts.device : nom de l'appareil ; opts.app : version de MailHub ; opts.notify(kind, data) : événements
   */
  constructor(store, manager, opts = {}) {
    this.store = store;
    this.manager = manager;
    this.device = opts.device || 'MailHub';
    this.app = opts.app || '';
    this.notify = opts.notify || (() => {});
    this.timer = null;
    this.saving = null;
  }

  get conf() { return this.store.data.backup || { mode: 'local' }; }
  setConf(patch) {
    this.store.data.backup = { ...this.conf, ...patch };
    this.store._save();
  }

  status() {
    const c = this.conf;
    const acc = this.store.listAccounts().find((a) => a.id === c.accountId);
    return {
      mode: c.mode === 'mailbox' && acc ? 'mailbox' : 'local',
      accountId: acc ? acc.id : null,
      accountEmail: acc ? acc.email : '',
      includePasswords: c.includePasswords !== false,
      lastSaved: c.lastSaved || '',
      lastError: c.lastError || '',
    };
  }

  _key() {
    const c = this.conf;
    if (!c.key || !c.salt) throw new Error('Sauvegarde non configurée : choisissez une phrase secrète.');
    return Buffer.from(this.store._decrypt(c.key), 'base64');
  }

  // Active la sauvegarde dans la boîte mail de accountId, avec une nouvelle phrase secrète
  async enable({ accountId, passphrase, includePasswords = true }) {
    if (!this.store.listAccounts().some((a) => a.id === accountId)) throw new Error('Compte introuvable.');
    const salt = newSalt();
    const key = deriveKey(passphrase, salt);
    this.setConf({ mode: 'mailbox', accountId, includePasswords: includePasswords !== false, salt, key: this.store._encrypt(key.toString('base64')), lastHash: '', lastError: '' });
    return this.saveNow();
  }

  // Changer de compte ou d'option sans retaper la phrase secrète
  async update({ accountId, includePasswords }) {
    const patch = {};
    if (accountId) {
      if (!this.store.listAccounts().some((a) => a.id === accountId)) throw new Error('Compte introuvable.');
      patch.accountId = accountId;
    }
    if (typeof includePasswords === 'boolean') patch.includePasswords = includePasswords;
    this.setConf({ ...patch, lastHash: '' });
    return this.saveNow();
  }

  disable() {
    if (this.timer) clearTimeout(this.timer);
    this.setConf({ mode: 'local', key: '', salt: '', lastHash: '', lastError: '' });
    return this.status();
  }

  async saveNow({ force = true } = {}) {
    const st = this.status();
    if (st.mode !== 'mailbox') throw new Error('La sauvegarde dans la boîte mail n’est pas activée.');
    if (this.saving) return this.saving;
    const run = (async () => {
      await null; // le verrou ci-dessous est posé avant tout travail
      try {
        const payload = collect(this.store, { includePasswords: st.includePasswords });
        const hash = fingerprint(payload);
        if (!force && hash === this.conf.lastHash) return this.status();
        const env = encrypt(payload, this._key(), this.conf.salt, { device: this.device, app: this.app });
        await this.manager.saveBackup(st.accountId, JSON.stringify(env));
        this.setConf({ lastSaved: env.createdAt, lastHash: hash, lastError: '' });
        this.notify('saved', this.status());
      } catch (err) {
        this.setConf({ lastError: err.message || String(err) });
        this.notify('failed', this.status());
        throw err;
      } finally {
        if (this.saving === run) this.saving = null;
      }
      return this.status();
    })();
    this.saving = run;
    return run;
  }

  // Appelé à chaque modification du stockage : sauvegarde automatique, regroupée
  schedule() {
    if (this.conf.mode !== 'mailbox' || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow({ force: false }).catch(() => {});
    }, AUTO_DELAY);
    if (this.timer.unref) this.timer.unref();
  }

  // Transfert vers un autre appareil (QR code) : tous les réglages, mots de passe compris, et la
  // configuration de sauvegarde (le nouvel appareil continue de sauvegarder sans retaper la phrase).
  // Le tout voyage chiffré par une clé à usage unique contenue dans le QR code (src/transfer.js).
  transferPayload() {
    const payload = collect(this.store, { includePasswords: true });
    const st = this.status();
    if (st.mode === 'mailbox') {
      try {
        payload.backupConf = { accountEmail: st.accountEmail, includePasswords: st.includePasswords, salt: this.conf.salt, key: this._key().toString('base64') };
      } catch (_) { /* configuration incomplète : on ne la transmet pas */ }
    }
    return payload;
  }

  // Réglages reçus d'un autre appareil : fusion, puis reprise de sa configuration de sauvegarde
  receive(payload) {
    const summary = restore(this.store, payload);
    const bc = payload.backupConf;
    if (bc && bc.salt && bc.key && this.conf.mode !== 'mailbox') {
      const acc = this.store.listAccounts().find((a) => a.email.toLowerCase() === String(bc.accountEmail || '').toLowerCase());
      if (acc) {
        this.setConf({ mode: 'mailbox', accountId: acc.id, includePasswords: bc.includePasswords !== false, salt: bc.salt, key: this.store._encrypt(bc.key), lastHash: '', lastError: '' });
        summary.backup = acc.email;
      }
    }
    return summary;
  }

  // Sauvegardes présentes dans la boîte de accountId (la plus récente d'abord)
  async find(accountId) {
    const list = await this.manager.listBackups(accountId);
    const out = [];
    for (const b of list.slice(0, 3)) {
      try {
        const env = readEnvelope(await this.manager.readBackup(accountId, b.uid));
        out.push({ uid: b.uid, createdAt: env.createdAt, device: env.device, app: env.app });
      } catch (_) { /* message illisible : ignoré */ }
    }
    return out;
  }

  // Restaure la sauvegarde (la plus récente, ou uid), puis continue à sauvegarder au même endroit
  async restore(accountId, passphrase, uid) {
    let target = uid;
    if (!target) {
      const list = await this.manager.listBackups(accountId);
      if (!list.length) throw new Error('Aucune sauvegarde MailHub dans cette boîte mail.');
      target = list[0].uid;
    }
    const env = readEnvelope(await this.manager.readBackup(accountId, target));
    const key = deriveKey(passphrase, env.kdf.salt, env.kdf);
    const payload = decrypt(env, key);
    const summary = restore(this.store, payload);
    this.setConf({ mode: 'mailbox', accountId, includePasswords: payload.includesPasswords !== false, salt: env.kdf.salt, key: this.store._encrypt(key.toString('base64')), lastHash: '', lastError: '' });
    return { ...summary, createdAt: env.createdAt, device: env.device };
  }
}

module.exports = {
  FORMAT, KDF, MIN_PASSPHRASE, LOCAL_PREFS,
  deriveKey, newSalt, encrypt, decrypt, readEnvelope, collect, restore, fingerprint, BackupService,
};
