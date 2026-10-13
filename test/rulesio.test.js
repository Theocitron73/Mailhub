'use strict';
const assert = require('assert');
const { exportRules, parseRulesFile, ruleKey } = require('../src/rulesio');

let n = 0;
function t(name, fn) { fn(); n++; console.log('  ok   ' + name); }

const accounts = [{ id: 'a1', email: 'Moi@x.fr' }, { id: 'a2', email: 'pro@y.fr' }];
const rules = [
  { id: 'r1', accountId: 'a1', name: 'A', enabled: true, match: 'all', folder: 'Factures', conditions: [{ field: 'from', op: 'equals', value: 'a@b.fr' }] },
  { id: 'r2', accountId: 'zz', name: 'orpheline', folder: 'X', conditions: [{ field: 'from', op: 'equals', value: 'z' }] },
  { id: 'r3', accountId: 'a2', name: 'B', enabled: false, match: 'any', folder: 'INBOX/Voyages', conditions: [{ field: 'domain', op: 'equals', value: 'sncf.fr' }, { field: 'subject', op: 'contains', value: 'billet' }] },
];

t('export : adresses de compte à la place des identifiants, règles orphelines exclues', () => {
  const out = exportRules(rules, accounts);
  assert.strictEqual(out.rules.length, 2);
  assert.strictEqual(out.rules[0].accountEmail, 'Moi@x.fr');
  assert.ok(!('id' in out.rules[0]) && !('accountId' in out.rules[0]));
  assert.strictEqual(out.rules[1].enabled, false);
});
t('aller-retour export puis import', () => {
  const back = parseRulesFile(JSON.stringify(exportRules(rules, accounts)));
  assert.strictEqual(back.skipped, 0);
  assert.strictEqual(back.rules.length, 2);
  assert.strictEqual(back.rules[0].accountEmail, 'moi@x.fr');
  assert.deepStrictEqual(back.rules[1].conditions.map((c) => c.op), ['equals', 'contains']);
  assert.strictEqual(back.rules[1].match, 'any');
});
t('fichier qui n’est pas un export MailHub', () => {
  assert.throws(() => parseRulesFile('pas du json'), /JSON illisible/);
  assert.throws(() => parseRulesFile('{"type":"autre"}'), /pas un export/);
  assert.throws(() => parseRulesFile('{"type":"rules","version":9,"rules":[]}'), /Version/);
});
t('règles invalides ignorées et comptées', () => {
  const file = { type: 'rules', version: 1, rules: [
    { accountEmail: 'a@b.fr', folder: 'F', conditions: [{ field: 'from', op: 'equals', value: 'x' }] },
    { accountEmail: 'a@b.fr', folder: 'F', conditions: [{ field: 'inconnu', op: 'equals', value: 'x' }] },
    { accountEmail: 'a@b.fr', folder: '', conditions: [{ field: 'from', op: 'equals', value: 'x' }] },
    { accountEmail: 'a@b.fr', folder: 'F', conditions: [] },
    null,
  ] };
  const r = parseRulesFile(JSON.stringify(file));
  assert.strictEqual(r.rules.length, 1);
  assert.strictEqual(r.skipped, 4);
});
t('empreinte : insensible à la casse, sensible au dossier', () => {
  const a = { folder: 'F', match: 'all', conditions: [{ field: 'from', op: 'equals', value: 'A@b.fr' }] };
  const b = { folder: 'F', match: 'all', conditions: [{ field: 'from', op: 'equals', value: 'a@b.fr' }] };
  assert.strictEqual(ruleKey('x', a), ruleKey('x', b));
  assert.notStrictEqual(ruleKey('x', a), ruleKey('x', { ...b, folder: 'G' }));
  assert.notStrictEqual(ruleKey('x', a), ruleKey('y', b));
});

console.log(`\n${n} tests réussis`);
