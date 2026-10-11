'use strict';

/**
 * Moteur de règles de tri (pur, sans dépendance, testable).
 *
 * Une règle :
 * {
 *   id, accountId, name, enabled,
 *   match: 'all' | 'any',
 *   conditions: [{ field: 'from'|'to'|'subject'|'domain', op: 'contains'|'equals'|'endsWith', value }],
 *   folder: 'Chemin/IMAP/Du/Dossier'
 * }
 *
 * Un message (forme minimale) : { from, fromName, to, subject }
 */

function norm(s) {
  return String(s || '').toLowerCase().trim();
}

function domainOf(address) {
  const a = norm(address);
  const at = a.lastIndexOf('@');
  return at >= 0 ? a.slice(at + 1) : '';
}

function fieldValue(message, field) {
  switch (field) {
    case 'from':
      return norm(message.from) + ' ' + norm(message.fromName);
    case 'to':
      return norm(message.to);
    case 'subject':
      return norm(message.subject);
    case 'domain':
      return domainOf(message.from);
    default:
      return '';
  }
}

function conditionMatches(cond, message) {
  const haystack = fieldValue(message, cond.field);
  const needle = norm(cond.value);
  if (!needle) return false;
  switch (cond.op) {
    case 'equals':
      if (cond.field === 'from') {
        return norm(message.from) === needle;
      }
      return haystack.trim() === needle;
    case 'endsWith':
      return haystack.trim().endsWith(needle);
    case 'contains':
    default:
      return haystack.includes(needle);
  }
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

/** Construit une règle « toujours ranger cet expéditeur dans ce dossier ». */
function senderRule({ accountId, from, folder, scope = 'address' }) {
  const address = norm(from);
  const isDomain = scope === 'domain';
  const value = isDomain ? domainOf(address) : address;
  return {
    id: 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
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

module.exports = { ruleMatches, findRule, senderRule, domainOf, norm };
