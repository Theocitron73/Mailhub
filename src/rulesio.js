'use strict';

/**
 * Export / import des règles de tri (fichier JSON), pour retrouver ses règles sur un autre ordinateur.
 * Les règles sont rattachées à l'adresse du compte (pas à l'identifiant interne, propre à chaque installation).
 */

const { FIELDS, OPS } = require('./rules');

const MAX_RULES = 2000;

function exportRules(rules, accounts, now = new Date()) {
  const emailOf = new Map(accounts.map((a) => [a.id, a.email]));
  return {
    app: 'MailHub',
    type: 'rules',
    version: 1,
    exportedAt: now.toISOString(),
    rules: rules
      .filter((r) => emailOf.has(r.accountId))
      .map((r) => ({
        name: r.name || '',
        enabled: r.enabled !== false,
        match: r.match === 'any' ? 'any' : 'all',
        accountEmail: emailOf.get(r.accountId),
        folder: r.folder,
        conditions: r.conditions.map((c) => ({ field: c.field, op: c.op, value: c.value })),
      })),
  };
}

/** Lit un fichier d'export. Renvoie { rules, skipped } ; lève une erreur lisible si le fichier n'est pas le bon. */
function parseRulesFile(text) {
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error('Ce fichier n’est pas un export de règles MailHub (JSON illisible).'); }
  if (!data || data.type !== 'rules' || !Array.isArray(data.rules)) {
    throw new Error('Ce fichier n’est pas un export de règles MailHub.');
  }
  if (data.version !== 1) throw new Error('Version de fichier non prise en charge. Mettez MailHub à jour.');
  const rules = [];
  let skipped = 0;
  for (const r of data.rules.slice(0, MAX_RULES)) {
    const ok = r && typeof r.folder === 'string' && r.folder.trim() && typeof r.accountEmail === 'string'
      && Array.isArray(r.conditions) && r.conditions.length > 0 && r.conditions.length <= 20
      && r.conditions.every((c) => c && FIELDS.includes(c.field) && OPS.includes(c.op) && typeof c.value === 'string' && c.value.length <= 500);
    if (!ok) { skipped++; continue; }
    rules.push({
      name: String(r.name || '').slice(0, 120),
      enabled: r.enabled !== false,
      match: r.match === 'any' ? 'any' : 'all',
      accountEmail: r.accountEmail.trim().toLowerCase(),
      folder: r.folder.trim().slice(0, 300),
      conditions: r.conditions.map((c) => ({ field: c.field, op: c.op, value: c.value })),
    });
  }
  skipped += Math.max(0, data.rules.length - MAX_RULES);
  return { rules, skipped };
}

/** Empreinte d'une règle, pour repérer les doublons à l'import. */
function ruleKey(accountId, r) {
  return JSON.stringify([accountId, r.folder, r.match === 'any' ? 'any' : 'all',
    r.conditions.map((c) => [c.field, c.op, String(c.value).toLowerCase()])]);
}

module.exports = { exportRules, parseRulesFile, ruleKey };
