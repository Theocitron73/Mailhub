'use strict';

/**
 * Import des filtres Thunderbird (fichiers msgFilterRules.dat).
 *
 * Format d'un filtre :
 *   name="Factures"
 *   enabled="yes"
 *   type="17"
 *   action="Move to folder"
 *   actionValue="imap://moi%40exemple.fr@imap.exemple.fr/Factures"
 *   action="Stop execution"
 *   condition="AND (from,contains,amazon) AND (subject,contains,facture)"
 *
 * Tout ici est pur (hors recherche du profil) et couvert par test/thunderbird.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { norm } = require('./rules');

const MAX_FILE_SIZE = 5 * 1024 * 1024;

// ------------------------------------------------------------------ lecture

function parseFilterFile(text) {
  const filters = [];
  let cur = null;
  let lastAction = null;
  for (const line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]+)\s*=\s*"(.*)"\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2].replace(/\\(["\\])/g, '$1');
    switch (key) {
      case 'name':
        cur = { name: value, enabled: true, type: 17, actions: [], condition: '' };
        filters.push(cur);
        lastAction = null;
        break;
      case 'enabled':
        if (cur) cur.enabled = value.toLowerCase() === 'yes';
        break;
      case 'type':
        if (cur) cur.type = parseInt(value, 10) || 0;
        break;
      case 'action':
        if (cur) {
          lastAction = { action: value, value: '' };
          cur.actions.push(lastAction);
        }
        break;
      case 'actionValue':
        if (lastAction) lastAction.value = value;
        break;
      case 'condition':
        if (cur) cur.condition = value;
        break;
      default:
        break;
    }
  }
  return filters;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

function decodeValue(raw) {
  let v = String(raw).trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  if (/%[0-9a-f]{2}/i.test(v)) v = safeDecode(v);
  return v.trim();
}

/** Découpe « AND (from,contains,x) AND (subject,is,y) » en critères. */
function parseCondition(condition) {
  const text = String(condition || '').trim();
  if (/^ALL$/i.test(text)) return { all: true, terms: [], mode: 'all' };
  const terms = [];
  const re = /(AND|OR)\s*\((.*?)\)(?=\s*(?:AND|OR)\s*\(|\s*$)/gi;
  let m;
  while ((m = re.exec(text))) {
    const inner = m[2];
    const c1 = inner.indexOf(',');
    const c2 = c1 >= 0 ? inner.indexOf(',', c1 + 1) : -1;
    if (c1 < 0 || c2 < 0) continue;
    terms.push({
      bool: m[1].toUpperCase(),
      attr: inner.slice(0, c1).trim(),
      op: inner.slice(c1 + 1, c2).trim(),
      value: decodeValue(inner.slice(c2 + 1)),
    });
  }
  const bools = new Set(terms.map((t) => t.bool));
  return { all: false, terms, mode: bools.size > 1 ? 'mixed' : bools.has('OR') && terms.length > 1 ? 'any' : 'all' };
}

// ------------------------------------------------------------- dossiers (URI)

/** Décode l'UTF-7 modifié d'IMAP : « Cat&AOk-gorie » -> « Catégorie ». */
function decodeImapUtf7(s) {
  return String(s).replace(/&([^-]*)-/g, (all, b64) => {
    if (b64 === '') return '&';
    try {
      const buf = Buffer.from(b64.replace(/,/g, '/'), 'base64');
      if (buf.length % 2) return all;
      return buf.swap16().toString('utf16le');
    } catch (_) {
      return all;
    }
  });
}

function parseFolderUri(uri) {
  const m = /^([a-z0-9+.-]+):\/\/([^/]*)(?:\/(.*))?$/i.exec(String(uri || '').trim());
  if (!m) return null;
  const authority = m[2];
  const at = authority.lastIndexOf('@');
  const userinfo = at >= 0 ? authority.slice(0, at) : '';
  const host = (at >= 0 ? authority.slice(at + 1) : authority).replace(/:\d+$/, '');
  return {
    scheme: m[1].toLowerCase(),
    user: safeDecode(userinfo),
    host: safeDecode(host).toLowerCase(),
    segments: (m[3] || '')
      .split('/')
      .filter(Boolean)
      .map((seg) => decodeImapUtf7(safeDecode(seg))),
  };
}

/**
 * Retrouve le dossier du serveur qui correspond à un chemin Thunderbird.
 * folders : [{ path, delimiter, selectable }]
 */
function resolveFolder(folders, segments, { prefix = '' } = {}) {
  const key = (s) => String(s).normalize('NFC').toLowerCase();
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const stripInbox = (arr) => (arr.length > 1 && arr[0] === 'inbox' ? arr.slice(1) : arr);
  const target = segments.map(key);
  const usable = folders.filter((f) => f.selectable !== false);
  const segsOf = (f) => f.path.split(f.delimiter || '/').map(key);

  if (target.length === 1 && target[0] === 'inbox') return { status: 'inbox', path: 'INBOX' };

  let hit = usable.find((f) => same(segsOf(f), target));
  if (hit) return { status: 'found', path: hit.path };

  hit = usable.find((f) => same(stripInbox(segsOf(f)), stripInbox(target)));
  if (hit) return { status: 'found', path: hit.path };

  const last = target[target.length - 1];
  const byName = last ? usable.filter((f) => segsOf(f).slice(-1)[0] === last) : [];
  if (byName.length === 1) return { status: 'approx', path: byName[0].path };

  const delimiter = (folders[0] && folders[0].delimiter) || '/';
  let suggested = segments.join(delimiter);
  if (prefix && !key(suggested).startsWith(key(prefix)) && key(segments[0]) !== 'inbox') suggested = prefix + suggested;
  return { status: 'missing', path: suggested };
}

// --------------------------------------------------------------- conversion

const FIELD_MAP = { from: 'from', to: 'to', cc: 'cc', 'to or cc': 'tocc', subject: 'subject' };
const OP_MAP = {
  contains: 'contains',
  "doesn't contain": 'notContains',
  is: 'equals',
  "isn't": 'notEquals',
  'begins with': 'startsWith',
  'ends with': 'endsWith',
};
const ACTION_LABEL = {
  'mark read': 'marquer comme lu',
  'mark unread': 'marquer comme non lu',
  'mark flagged': 'suivre (étoile)',
  delete: 'supprimer',
  'copy to folder': 'copier vers un dossier',
  addtag: 'ajouter une étiquette',
  label: 'ajouter une étiquette',
  'change priority': 'changer la priorité',
  forward: 'transférer',
  reply: 'répondre',
  'mark junk': 'marquer comme indésirable',
};
const CRITERION_LABEL = {
  body: 'le corps du message',
  date: 'la date',
  'age in days': 'l’ancienneté',
  size: 'la taille',
  priority: 'la priorité',
  status: 'le statut',
  tag: 'l’étiquette',
  label: 'l’étiquette',
  'attachment status': 'les pièces jointes',
  'junk status': 'le statut indésirable',
};

function actionLabel(action) {
  return ACTION_LABEL[String(action).toLowerCase()] || action;
}

/** Un filtre Thunderbird s'exécute sur le courrier entrant s'il porte l'un de ces drapeaux. */
function runsOnIncoming(type) {
  return (type & 0x23) !== 0;
}

/**
 * Convertit un filtre en règle MailHub.
 * Renvoie { name, skip, rule, uri, notes } : skip est une raison lisible quand
 * le filtre ne peut pas être repris tel quel (jamais de reprise approximative d'un critère).
 */
function convertFilter(filter) {
  const notes = [];
  const out = { name: filter.name, skip: null, rule: null, uri: null, notes };

  const move = filter.actions.find((a) => a.action.toLowerCase() === 'move to folder');
  if (!move) {
    const labels = filter.actions
      .filter((a) => a.action.toLowerCase() !== 'stop execution')
      .map((a) => actionLabel(a.action));
    out.skip = `ne déplace pas de message${labels.length ? ` (action : ${labels.join(', ')})` : ''}`;
    return out;
  }
  filter.actions.forEach((a) => {
    const name = a.action.toLowerCase();
    if (a === move || name === 'stop execution') return;
    if (name === 'move to folder') notes.push('Deuxième déplacement ignoré.');
    else notes.push(`Action ignorée : ${actionLabel(a.action)}.`);
  });

  const cond = parseCondition(filter.condition);
  if (cond.all) {
    out.skip = 's’applique à tous les messages';
    return out;
  }
  if (!cond.terms.length) {
    out.skip = 'condition illisible';
    return out;
  }
  if (cond.mode === 'mixed') {
    out.skip = 'mélange de conditions « et » et « ou », impossible à reproduire fidèlement';
    return out;
  }

  const conditions = [];
  const unsupported = [];
  for (const t of cond.terms) {
    const field = FIELD_MAP[t.attr.toLowerCase()];
    const op = OP_MAP[t.op.toLowerCase()];
    if (!field) {
      unsupported.push(CRITERION_LABEL[t.attr.toLowerCase()] || `l’en-tête « ${t.attr} »`);
      continue;
    }
    if (!op) {
      unsupported.push(`l’opérateur « ${t.op} »`);
      continue;
    }
    if (!t.value) {
      unsupported.push('une valeur vide');
      continue;
    }
    conditions.push({ field, op, value: t.value });
  }
  if (unsupported.length) {
    out.skip = `critère non pris en charge : ${[...new Set(unsupported)].join(', ')}`;
    return out;
  }

  let enabled = filter.enabled;
  if (!filter.enabled) notes.push('Désactivé dans Thunderbird.');
  else if (!runsOnIncoming(filter.type)) {
    enabled = false;
    notes.push('Dans Thunderbird, ce filtre ne s’exécutait que manuellement : importé désactivé.');
  }

  out.uri = move.value;
  out.rule = { name: filter.name, enabled, match: cond.mode === 'any' ? 'any' : 'all', conditions };
  return out;
}

function sameRule(a, b) {
  const sig = (r) =>
    JSON.stringify([
      r.accountId,
      r.folder,
      r.match === 'any' ? 'any' : 'all',
      (r.conditions || []).map((c) => [c.field, c.op, norm(c.value)]),
    ]);
  return sig(a) === sig(b);
}

/**
 * Prépare l'aperçu : pour chaque filtre, la règle proposée, le dossier retrouvé
 * (ou à créer) et, le cas échéant, pourquoi il est ignoré.
 */
function buildPreview(filters, { accountId, folders, prefix = '', existingRules = [] }) {
  return filters.map((filter, index) => {
    const conv = convertFilter(filter);
    const item = {
      key: index,
      name: filter.name,
      skip: conv.skip,
      notes: conv.notes,
      rule: null,
      folder: null,
      duplicate: false,
    };
    if (conv.skip) return item;

    const uri = parseFolderUri(conv.uri);
    if (!uri) {
      item.skip = 'dossier de destination illisible';
      return item;
    }
    if (uri.scheme !== 'imap' && uri.scheme !== 'imaps') {
      item.skip = 'dossier local de Thunderbird, absent du serveur';
      return item;
    }
    if (!uri.segments.length) {
      item.skip = 'dossier de destination vide';
      return item;
    }
    const folder = resolveFolder(folders, uri.segments, { prefix });
    if (folder.status === 'inbox') {
      item.skip = 'le dossier de destination est la boîte de réception';
      return item;
    }
    item.folder = { status: folder.status, path: folder.path, display: uri.segments.join(' / ') };
    item.rule = { ...conv.rule, accountId, folder: folder.path, source: 'thunderbird' };
    item.duplicate = existingRules.some((r) => sameRule(r, item.rule));
    if (item.duplicate) item.notes = [...item.notes, 'Une règle identique existe déjà.'];
    return item;
  });
}

// ------------------------------------------------------------ fichiers/profil

function readFilterFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Ce n’est pas un fichier.');
  if (stat.size > MAX_FILE_SIZE) throw new Error('Fichier trop volumineux pour être un fichier de filtres.');
  return fs.readFileSync(file, 'utf8');
}

/** Couples (utilisateur, serveur) trouvés dans les destinations des filtres. */
function serverHints(filters) {
  const seen = new Map();
  for (const f of filters) {
    for (const a of f.actions) {
      if (a.action.toLowerCase() !== 'move to folder') continue;
      const uri = parseFolderUri(a.value);
      if (uri && uri.scheme.startsWith('imap') && uri.host) seen.set(`${uri.user}@${uri.host}`, { user: uri.user, host: uri.host });
    }
  }
  return [...seen.values()];
}

/** Devine à quel compte MailHub appartient un fichier de filtres. */
function suggestAccount(accounts, hints, dirName) {
  const eq = (a, b) => norm(a) === norm(b) && norm(a) !== '';
  for (const h of hints) {
    const acc = accounts.find((a) => eq(a.email, h.user) || eq(a.imap && a.imap.user, h.user));
    if (acc) return acc.id;
  }
  const byHost = accounts.filter((a) => a.imap && eq(a.imap.host, dirName));
  return byHost.length === 1 ? byHost[0].id : null;
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch (_) {
    return [];
  }
}

function thunderbirdRoots(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'win32') return [path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Thunderbird')];
  if (platform === 'darwin') return [path.join(home, 'Library', 'Thunderbird')];
  return [
    path.join(home, '.thunderbird'),
    path.join(home, 'snap', 'thunderbird', 'common', '.thunderbird'),
    path.join(home, '.var', 'app', 'org.mozilla.Thunderbird', '.thunderbird'),
  ];
}

function profileDirs(root) {
  const dirs = new Set();
  try {
    const ini = fs.readFileSync(path.join(root, 'profiles.ini'), 'utf8');
    let rel = true;
    for (const line of ini.split(/\r?\n/)) {
      const r = /^IsRelative=(\d)/.exec(line);
      if (r) rel = r[1] === '1';
      const p = /^Path=(.+)$/.exec(line);
      if (p) dirs.add(rel ? path.join(root, p[1]) : p[1]);
    }
  } catch (_) { /* pas de profiles.ini */ }
  subdirs(path.join(root, 'Profiles')).forEach((d) => dirs.add(d));
  subdirs(root).forEach((d) => { if (fs.existsSync(path.join(d, 'prefs.js'))) dirs.add(d); });
  return [...dirs];
}

/** Cherche les msgFilterRules.dat des comptes IMAP dans les profils Thunderbird. */
function findFilterFiles(options = {}) {
  const found = [];
  const seen = new Set();
  for (const root of options.roots || thunderbirdRoots()) {
    for (const profile of profileDirs(root)) {
      for (const server of subdirs(path.join(profile, 'ImapMail'))) {
        const file = path.join(server, 'msgFilterRules.dat');
        if (seen.has(file) || !fs.existsSync(file)) continue;
        seen.add(file);
        try {
          const filters = parseFilterFile(readFilterFile(file));
          found.push({ file, profile: path.basename(profile), server: path.basename(server), filters: filters.length, hints: serverHints(filters) });
        } catch (_) { /* fichier illisible : ignoré */ }
      }
    }
  }
  return found;
}

module.exports = {
  parseFilterFile, parseCondition, parseFolderUri, decodeImapUtf7, resolveFolder,
  convertFilter, buildPreview, readFilterFile, serverHints, suggestAccount,
  findFilterFiles, thunderbirdRoots, runsOnIncoming,
};
