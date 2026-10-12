'use strict';

const assert = require('assert');
const { ruleMatches, findRule, senderRule, upsertSenderRule, domainOf } = require('../src/rules');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    console.error('  FAIL ' + name + '\n       ' + err.message);
    process.exitCode = 1;
  }
}

const msg = {
  from: 'Factures@Amazon.fr',
  fromName: 'Amazon',
  to: 'moi@example.com',
  subject: 'Votre facture du mois',
};

test('domainOf extrait le domaine en minuscules', () => {
  assert.strictEqual(domainOf('Jean@Exemple.COM'), 'exemple.com');
  assert.strictEqual(domainOf('sans-arobase'), '');
});

test('règle expéditeur exact (insensible à la casse)', () => {
  const rule = senderRule({ accountId: 'a1', from: 'factures@amazon.fr', folder: 'Factures' });
  assert.ok(ruleMatches(rule, msg));
  assert.ok(!ruleMatches(rule, { ...msg, from: 'autre@amazon.fr' }));
});

test('règle par domaine', () => {
  const rule = senderRule({ accountId: 'a1', from: 'x@amazon.fr', folder: 'Achats', scope: 'domain' });
  assert.ok(ruleMatches(rule, msg));
  assert.ok(!ruleMatches(rule, { ...msg, from: 'x@amazon.com' }));
});

test('conditions multiples : all vs any', () => {
  const conditions = [
    { field: 'subject', op: 'contains', value: 'facture' },
    { field: 'from', op: 'contains', value: 'paypal' },
  ];
  assert.ok(!ruleMatches({ enabled: true, match: 'all', conditions, folder: 'X' }, msg));
  assert.ok(ruleMatches({ enabled: true, match: 'any', conditions, folder: 'X' }, msg));
});

test('règle désactivée ou sans condition ne correspond jamais', () => {
  const cond = [{ field: 'subject', op: 'contains', value: 'facture' }];
  assert.ok(!ruleMatches({ enabled: false, match: 'all', conditions: cond }, msg));
  assert.ok(!ruleMatches({ enabled: true, match: 'all', conditions: [] }, msg));
  assert.ok(!ruleMatches({ enabled: true, match: 'all', conditions: [{ field: 'subject', op: 'contains', value: '' }] }, msg));
});

test('findRule respecte le compte et l\'ordre', () => {
  const r1 = { id: '1', accountId: 'a2', enabled: true, match: 'all', folder: 'A', conditions: [{ field: 'subject', op: 'contains', value: 'facture' }] };
  const r2 = { id: '2', accountId: 'a1', enabled: true, match: 'all', folder: 'B', conditions: [{ field: 'subject', op: 'contains', value: 'facture' }] };
  const r3 = { id: '3', accountId: 'a1', enabled: true, match: 'all', folder: 'C', conditions: [{ field: 'subject', op: 'contains', value: 'facture' }] };
  assert.strictEqual(findRule([r1, r2, r3], 'a1', msg).id, '2');
  assert.strictEqual(findRule([r1], 'a1', msg), null);
});

test('champ « to » et opérateur endsWith', () => {
  const rule = { enabled: true, match: 'all', folder: 'X', conditions: [{ field: 'to', op: 'endsWith', value: '@example.com' }] };
  assert.ok(ruleMatches(rule, msg));
});

const rule = (conditions, extra = {}) => ({ enabled: true, match: 'all', folder: 'X', conditions, ...extra });
const m2 = { from: 'paul@acme.fr', fromName: 'Paul Durand', to: 'moi@x.fr, autre@x.fr', cc: 'chef@acme.fr', subject: 'Re: Devis [urgent]' };

test('opérateurs négatifs : notContains / notEquals', () => {
  assert.ok(ruleMatches(rule([{ field: 'subject', op: 'notContains', value: 'facture' }]), m2));
  assert.ok(!ruleMatches(rule([{ field: 'subject', op: 'notContains', value: 'devis' }]), m2));
  assert.ok(ruleMatches(rule([{ field: 'from', op: 'notEquals', value: 'jean@acme.fr' }]), m2));
  assert.ok(!ruleMatches(rule([{ field: 'from', op: 'notEquals', value: 'paul@acme.fr' }]), m2));
});

test('startsWith sur l\'adresse et sur le nom', () => {
  assert.ok(ruleMatches(rule([{ field: 'from', op: 'startsWith', value: 'paul@' }]), m2));
  assert.ok(ruleMatches(rule([{ field: 'from', op: 'startsWith', value: 'paul d' }]), m2));
  assert.ok(!ruleMatches(rule([{ field: 'from', op: 'startsWith', value: 'acme' }]), m2));
});

test('from equals accepte aussi le nom affiché', () => {
  assert.ok(ruleMatches(rule([{ field: 'from', op: 'equals', value: 'Paul Durand' }]), m2));
});

test('to : plusieurs destinataires, cc et « to or cc »', () => {
  assert.ok(ruleMatches(rule([{ field: 'to', op: 'equals', value: 'autre@x.fr' }]), m2));
  assert.ok(ruleMatches(rule([{ field: 'cc', op: 'contains', value: 'chef@' }]), m2));
  assert.ok(ruleMatches(rule([{ field: 'tocc', op: 'equals', value: 'chef@acme.fr' }]), m2));
  assert.ok(!ruleMatches(rule([{ field: 'to', op: 'contains', value: 'chef@' }]), m2));
});

test('upsertSenderRule : crée en tête de liste', () => {
  const rules = [{ id: 'old', accountId: 'a1', enabled: true, match: 'all', folder: 'Achats', conditions: [{ field: 'domain', op: 'equals', value: 'amazon.fr' }] }];
  const res = upsertSenderRule(rules, { accountId: 'a1', from: 'Factures@Amazon.fr', folder: 'Factures' });
  assert.strictEqual(res.created, true);
  assert.strictEqual(rules.length, 2);
  assert.strictEqual(rules[0].id, res.rule.id);
  // la règle précise l'emporte sur la règle de domaine
  assert.strictEqual(findRule(rules, 'a1', { from: 'factures@amazon.fr' }).folder, 'Factures');
  assert.strictEqual(findRule(rules, 'a1', { from: 'autre@amazon.fr' }).folder, 'Achats');
});

test('upsertSenderRule : remplace le dossier au lieu de dupliquer, et se place en tête', () => {
  const rules = [
    { id: 'broad', accountId: 'a1', enabled: true, match: 'all', folder: 'Achats', conditions: [{ field: 'from', op: 'contains', value: 'amazon' }] },
    { id: 'exact', accountId: 'a1', enabled: false, match: 'all', folder: 'Vieux', conditions: [{ field: 'from', op: 'equals', value: 'factures@amazon.fr' }] },
  ];
  const res = upsertSenderRule(rules, { accountId: 'a1', from: 'factures@amazon.fr', folder: 'Factures' });
  assert.strictEqual(res.created, false);
  assert.strictEqual(res.previousFolder, 'Vieux');
  assert.strictEqual(res.previousEnabled, false);
  assert.strictEqual(rules.length, 2);
  assert.strictEqual(rules[0].id, 'exact');
  assert.strictEqual(rules[0].enabled, true);
  assert.strictEqual(findRule(rules, 'a1', { from: 'factures@amazon.fr' }).folder, 'Factures');
});

test('upsertSenderRule : un autre compte n\'est pas touché', () => {
  const rules = [{ id: 'x', accountId: 'a2', enabled: true, match: 'all', folder: 'Z', conditions: [{ field: 'from', op: 'equals', value: 'p@q.fr' }] }];
  const res = upsertSenderRule(rules, { accountId: 'a1', from: 'p@q.fr', folder: 'Y' });
  assert.strictEqual(res.created, true);
  assert.strictEqual(rules.length, 2);
  assert.strictEqual(rules.find((r) => r.id === 'x').folder, 'Z');
});

test('upsertSenderRule : adresse vide ignorée', () => {
  const rules = [];
  assert.strictEqual(upsertSenderRule(rules, { accountId: 'a1', from: '', folder: 'Y' }).rule, null);
  assert.strictEqual(rules.length, 0);
});

console.log(`\n${passed} tests réussis`);
