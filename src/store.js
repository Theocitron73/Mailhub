'use strict';

const fs = require('fs');
const path = require('path');
const { upsertSenderRule, newId } = require('./rules');

/**
 * Stockage local : comptes, règles, préférences.
 * Les mots de passe sont chiffrés avec safeStorage (Keychain macOS / DPAPI Windows)
 * quand il est disponible. Sinon, repli en base64 (déconseillé) avec avertissement.
 */
class Store {
  constructor(dir, safeStorage) {
    this.dir = dir;
    this.file = path.join(dir, 'mailhub-data.json');
    this.safe = safeStorage;
    this.data = { accounts: [], rules: [], prefs: { theme: 'auto' }, sync: {} };
    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = Object.assign(this.data, parsed);
      }
    } catch (err) {
      console.error('Lecture du stockage impossible :', err);
    }
  }

  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  encryptionAvailable() {
    return !!(this.safe && this.safe.isEncryptionAvailable && this.safe.isEncryptionAvailable());
  }

  _encrypt(plain) {
    if (this.encryptionAvailable()) {
      return 'enc:' + this.safe.encryptString(plain).toString('base64');
    }
    return 'b64:' + Buffer.from(plain, 'utf8').toString('base64');
  }

  _decrypt(stored) {
    if (!stored) return '';
    if (stored.startsWith('enc:')) {
      return this.safe.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    if (stored.startsWith('b64:')) {
      return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    }
    return stored;
  }

  // ---- Comptes ----
  listAccounts() {
    // Ne jamais renvoyer le mot de passe à l'interface
    return this.data.accounts.map(({ secret, ...rest }) => rest);
  }

  getAccount(id) {
    const acc = this.data.accounts.find((a) => a.id === id);
    if (!acc) return null;
    const { secret, ...rest } = acc;
    return { ...rest, password: this._decrypt(secret) };
  }

  addAccount(input) {
    const id = 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const account = {
      id,
      name: input.name || input.email,
      email: input.email,
      color: input.color || pickColor(this.data.accounts.length),
      imap: {
        host: input.imap.host,
        port: Number(input.imap.port) || 993,
        secure: input.imap.secure !== false,
        user: input.imap.user || input.email,
      },
      smtp: input.smtp
        ? {
            host: input.smtp.host,
            port: Number(input.smtp.port) || 465,
            secure: input.smtp.secure !== false,
            user: input.smtp.user || input.email,
          }
        : null,
      secret: this._encrypt(input.password),
    };
    this.data.accounts.push(account);
    this._save();
    return this.listAccounts().find((a) => a.id === id);
  }

  removeAccount(id) {
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    this.data.rules = this.data.rules.filter((r) => r.accountId !== id);
    delete this.data.sync[id];
    this._save();
  }

  // ---- Position de synchronisation (dernier UID traité par le tri automatique) ----
  getSync(accountId) {
    return this.data.sync[accountId] || null;
  }

  setSync(accountId, value) {
    this.data.sync[accountId] = value;
    this._save();
  }

  // ---- Règles ----
  listRules() {
    return this.data.rules;
  }

  addRule(rule) {
    this.data.rules.push(rule);
    this._save();
    return rule;
  }

  updateRule(rule) {
    const i = this.data.rules.findIndex((r) => r.id === rule.id);
    if (i >= 0) this.data.rules[i] = rule;
    this._save();
    return rule;
  }

  removeRule(id) {
    this.data.rules = this.data.rules.filter((r) => r.id !== id);
    this._save();
  }

  /** Ajoute plusieurs règles à la suite (import). */
  addRules(list) {
    const added = list.map((r) => ({ ...r, id: r.id || newId() }));
    this.data.rules.push(...added);
    this._save();
    return added;
  }

  /** Règle « cet expéditeur va dans ce dossier » : création ou mise à jour, placée en tête. */
  upsertSenderRule(params) {
    const res = upsertSenderRule(this.data.rules, params);
    if (res.rule) this._save();
    return res;
  }

  /** Remonte (delta < 0) ou descend (delta > 0) une règle dans l'ordre d'application. */
  moveRule(id, delta) {
    const rules = this.data.rules;
    const from = rules.findIndex((r) => r.id === id);
    if (from < 0) return rules;
    const to = Math.max(0, Math.min(rules.length - 1, from + delta));
    const [rule] = rules.splice(from, 1);
    rules.splice(to, 0, rule);
    this._save();
    return rules;
  }

  // ---- Préférences ----
  getPrefs() {
    return this.data.prefs;
  }

  setPrefs(patch) {
    this.data.prefs = Object.assign({}, this.data.prefs, patch);
    this._save();
    return this.data.prefs;
  }
}

const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#ec4899'];
function pickColor(i) {
  return COLORS[i % COLORS.length];
}

module.exports = { Store };
