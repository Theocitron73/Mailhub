'use strict';

const assert = require('assert');
const { ruleMatches, findRule, senderRule, domainOf } = require('../src/rules');

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

console.log(`\n${passed} tests réussis`);
