'use strict';

/**
 * Moteur de règles de tri (pur, sans dépendance, testable).
 *
 * Une règle :
 * {
 *   id, accountId, name, enabled,
 *   match: 'all' | 'any',
 *   conditions: [{ field, op, value }],
 *   folder: 'Chemin/IMAP/Du/Dossier'
 * }
 *
 * field : 'from' | 'to' | 'cc' | 'tocc' | 'subject' | 'domain'
 * op    : 'contains' | 'notContains' | 'equals' | 'notEquals' | 'startsWith' | 'endsWith'
 *
 * Un message (forme minimale) : { from, fromName, to, cc, subject }
 */

const FIELDS = ['from', 'to', 'cc', 'tocc', 'subject', 'domain'];
const OPS = ['contains', 'notContains', 'equals', 'notEquals', 'startsWith', 'endsWith'];

function norm(s) {
  return String(s || '').toLowerCase().trim();
}

function domainOf(address) {
  const a = norm(address);
  const at = a.lastIndexOf('@');
  return at >= 0 ? a.slice(at + 1) : '';
}

function addressList(s) {
  return String(s || '')
    .split(/[,;]/)
    .map(norm)
    .filter(Boolean);
}

/** Les textes du message sur lesquels une condition peut porter. */
function candidates(message, field) {
  const from = norm(message.from);
  const name = norm(message.fromName);
  switch (field) {
    case 'from':
      return [from, name, name ? `${name} <${from}>` : from].filter(Boolean);
    case 'to': {
      const list = addressList(message.to);
      return list.length > 1 ? [...list, list.join(', ')] : list;
    }
    case 'cc': {
      const list = addressList(message.cc);
      return list.length > 1 ? [...list, list.join(', ')] : list;
    }
    case 'tocc':
      return [...addressList(message.to), ...addressList(message.cc)];
    case 'subject':
      return [norm(message.subject)];
    case 'domain':
      return [domainOf(message.from)].filter(Boolean);
    default:
      return [];
  }
}

function positive(op, text, needle) {
  switch (op) {
    case 'equals':
      return text === needle;
    case 'startsWith':
      return text.startsWith(needle);
    case 'endsWith':
      return text.endsWith(needle);
    case 'contains':
    default:
      return text.includes(needle);
  }
}

function conditionMatches(cond, message) {
  const needle = norm(cond.value);
  if (!needle) return false;
  const texts = candidates(message, cond.field);
  if (cond.op === 'notContains') return !texts.some((t) => t.includes(needle));
  if (cond.op === 'notEquals') return !texts.some((t) => t === needle);
  return texts.some((t) => positive(cond.op, t, needle));
}

function ruleMatches(rule, message) {
  if (!rule || rule.enabled === false) return false;
  const conds = rule.conditions || [];
  if (!conds.length) return false;
  return rule.match === 'any'
    ? conds.some((c) => conditionMatches(c, message))
    : conds.every((c) => conditionMatches(c, message));
}

/** Retourne la première règle applicable (ordre de la liste), ou null. */
function findRule(rules, accountId, message) {
  for (const rule of rules || []) {
    if (rule.accountId && rule.accountId !== accountId) continue;
    if (ruleMatches(rule, message)) return rule;
  }
  return null;
}

function newId() {
  return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Construit une règle « toujours ranger cet expéditeur dans ce dossier ». */
function senderRule({ accountId, from, folder, scope = 'address' }) {
  const address = norm(from);
  const isDomain = scope === 'domain';
  const value = isDomain ? domainOf(address) : address;
  return {
    id: newId(),
    accountId,
    name: isDomain ? `Domaine ${value}` : `Expéditeur ${value}`,
    enabled: true,
    match: 'all',
    conditions: [
      isDomain
        ? { field: 'domain', op: 'equals', value }
        : { field: 'from', op: 'equals', value: address },
    ],
    folder,
  };
}

/**
 * Ajoute (ou met à jour) la règle « cet expéditeur va dans ce dossier ».
 * - Si une règle identique existe déjà pour cet expéditeur, on change son dossier
 *   plutôt que d'en créer une seconde qui ne servirait jamais (la première l'emporte).
 * - La règle est placée en tête de liste : le dernier choix de l'utilisateur doit gagner,
 *   y compris contre une règle plus large (domaine, « contient »…) définie avant.
 * Modifie `rules` en place et renvoie ce qu'il faut pour annuler.
 */
function upsertSenderRule(rules, { accountId, from, folder, scope = 'address' }) {
  const address = norm(from);
  const value = scope === 'domain' ? domainOf(address) : address;
  if (!value) return { rule: null, created: false, previousFolder: null, previousEnabled: null };
  const field = scope === 'domain' ? 'domain' : 'from';

  const index = rules.findIndex(
    (r) =>
      r.accountId === accountId &&
      (r.conditions || []).length === 1 &&
      r.conditions[0].field === field &&
      r.conditions[0].op === 'equals' &&
      norm(r.conditions[0].value) === value
  );

  if (index >= 0) {
    const [rule] = rules.splice(index, 1);
    const previousFolder = rule.folder;
    const previousEnabled = rule.enabled !== false;
    rule.folder = folder;
    rule.enabled = true;
    rules.unshift(rule);
    return { rule, created: false, previousFolder, previousEnabled };
  }

  const rule = senderRule({ accountId, from, folder, scope });
  rules.unshift(rule);
  return { rule, created: true, previousFolder: null, previousEnabled: null };
}

module.exports = {
  FIELDS, OPS, ruleMatches, findRule, senderRule, upsertSenderRule, newId, domainOf, norm,
};
