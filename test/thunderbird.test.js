'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tb = require('../src/thunderbird');
const { findRule } = require('../src/rules');

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

const SAMPLE = [
  'version="9"',
  'logging="no"',
  'name="Factures Amazon"',
  'enabled="yes"',
  'type="17"',
  'action="Move to folder"',
  'actionValue="imap://moi%40exemple.fr@imap.exemple.fr/Factures"',
  'condition="AND (from,contains,amazon.fr) AND (subject,contains,facture)"',
  'name="Newsletters (2 sources)"',
  'enabled="yes"',
  'type="48"',
  'action="Move to folder"',
  'actionValue="imap://moi%40exemple.fr@imap.exemple.fr/INBOX/Lettres"',
  'action="Stop execution"',
  'condition="OR (from,is,news@lemonde.fr) OR (from,ends with,@notion.so)"',
  'name="Lu automatiquement"',
  'enabled="yes"',
  'type="17"',
  'action="Mark read"',
  'condition="AND (from,contains,bot)"',
  'name="Dans le corps"',
  'enabled="yes"',
  'type="17"',
  'action="Move to folder"',
  'actionValue="imap://moi%40exemple.fr@imap.exemple.fr/Factures"',
  'condition="AND (body,contains,facture)"',
  'name="Mixte"',
  'enabled="yes"',
  'type="17"',
  'action="Move to folder"',
  'actionValue="imap://moi%40exemple.fr@imap.exemple.fr/Factures"',
  'condition="AND (from,contains,a) OR (subject,contains,b)"',
  'name="Tout"',
  'enabled="yes"',
  'type="17"',
  'action="Move to folder"',
  'actionValue="imap://moi%40exemple.fr@imap.exemple.fr/Factures"',
  'condition="ALL"',
  'name="Manuel seulement"',
  'enabled="yes"',
  'type="16"',
  'action="Move to folder"',
  'actionValue="imap://moi%40exemple.fr@imap.exemple.fr/Voyages"',
  'condition="AND (subject,contains,billet)"',
  'name="Désactivé \\"test\\""',
  'enabled="no"',
  'type="17"',
  'action="Move to folder"',
  'actionValue="imap://moi%40exemple.fr@imap.exemple.fr/Voyages"',
  'condition="AND (subject,doesn\'t contain,spam)"',
  'name="Dossier local"',
  'enabled="yes"',
  'type="17"',
  'action="Move to folder"',
  'actionValue="mailbox://nobody@Local%20Folders/Archive"',
  'condition="AND (from,contains,x)"',
  'name="Accentué"',
  'enabled="yes"',
  'type="17"',
  'action="Move to folder"',
  'actionValue="imap://moi%40exemple.fr@imap.exemple.fr/Cat%26AOk-gorie"',
  'condition="AND (subject,contains,%5Burgent%5D)"',
  'name="Vers la boîte de réception"',
  'enabled="yes"',
  'type="17"',
  'action="Move to folder"',
  'actionValue="imap://moi%40exemple.fr@imap.exemple.fr/INBOX"',
  'condition="AND (from,contains,x)"',
  'name="Avec CC"',
  'enabled="yes"',
  'type="17"',
  'action="Move to folder"',
  'actionValue="imap://moi%40exemple.fr@imap.exemple.fr/Factures"',
  'condition="AND (to or cc,contains,compta@)"',
  '',
].join('\n');

const FOLDERS = [
  { path: 'INBOX', delimiter: '/', selectable: true },
  { path: 'Factures', delimiter: '/', selectable: true },
  { path: 'Lettres', delimiter: '/', selectable: true },
  { path: 'Voyages', delimiter: '/', selectable: true },
  { path: 'Catégorie', delimiter: '/', selectable: true },
];

const filters = tb.parseFilterFile(SAMPLE);
const byName = (n) => filters.find((f) => f.name === n);
const preview = tb.buildPreview(filters, { accountId: 'a1', folders: FOLDERS, existingRules: [] });
const item = (n) => preview.find((p) => p.name === n);

test('parseFilterFile lit tous les filtres, leurs actions et valeurs échappées', () => {
  assert.strictEqual(filters.length, 12);
  assert.strictEqual(byName('Newsletters (2 sources)').actions.length, 2);
  assert.strictEqual(byName('Newsletters (2 sources)').actions[0].value, 'imap://moi%40exemple.fr@imap.exemple.fr/INBOX/Lettres');
  assert.ok(filters.some((f) => f.name === 'Désactivé "test"'));
  assert.strictEqual(byName('Manuel seulement').type, 16);
});

test('parseCondition : ET, OU, mixte, ALL', () => {
  const and = tb.parseCondition('AND (from,contains,amazon.fr) AND (subject,contains,facture)');
  assert.strictEqual(and.mode, 'all');
  assert.deepStrictEqual(and.terms.map((t) => [t.attr, t.op, t.value]), [['from', 'contains', 'amazon.fr'], ['subject', 'contains', 'facture']]);
  assert.strictEqual(tb.parseCondition('OR (a,is,b) OR (c,is,d)').mode, 'any');
  assert.strictEqual(tb.parseCondition('AND (a,is,b) OR (c,is,d)').mode, 'mixed');
  assert.strictEqual(tb.parseCondition('ALL').all, true);
  assert.strictEqual(tb.parseCondition('AND (subject,contains,Re: a, b)').terms[0].value, 'Re: a, b');
  assert.strictEqual(tb.parseCondition('AND (subject,contains,%5Burgent%5D)').terms[0].value, '[urgent]');
  assert.strictEqual(tb.parseCondition("AND (subject,doesn't contain,spam)").terms[0].op, "doesn't contain");
});

test('filtre ET : règle « toutes les conditions »', () => {
  const p = item('Factures Amazon');
  assert.strictEqual(p.skip, null);
  assert.strictEqual(p.rule.match, 'all');
  assert.strictEqual(p.rule.folder, 'Factures');
  assert.strictEqual(p.rule.enabled, true);
  assert.strictEqual(p.rule.accountId, 'a1');
  assert.deepStrictEqual(p.rule.conditions, [
    { field: 'from', op: 'contains', value: 'amazon.fr' },
    { field: 'subject', op: 'contains', value: 'facture' },
  ]);
});

test('filtre OU + « Stop execution » ignoré sans bruit + sous-dossier INBOX/ retrouvé', () => {
  const p = item('Newsletters (2 sources)');
  assert.strictEqual(p.skip, null);
  assert.strictEqual(p.rule.match, 'any');
  assert.strictEqual(p.rule.folder, 'Lettres');
  assert.strictEqual(p.folder.status, 'found');
  assert.deepStrictEqual(p.notes, []);
});

test('filtres non reprenables : raison lisible, jamais de reprise approximative', () => {
  assert.ok(/ne déplace pas.*marquer comme lu/.test(item('Lu automatiquement').skip), item('Lu automatiquement').skip);
  assert.ok(/le corps du message/.test(item('Dans le corps').skip));
  assert.ok(/mélange/.test(item('Mixte').skip));
  assert.ok(/tous les messages/.test(item('Tout').skip));
  assert.ok(/dossier local/.test(item('Dossier local').skip));
  assert.ok(/boîte de réception/.test(item('Vers la boîte de réception').skip));
  [ 'Lu automatiquement', 'Dans le corps', 'Mixte', 'Tout', 'Dossier local', 'Vers la boîte de réception' ].forEach((n) => assert.strictEqual(item(n).rule, null));
});

test('filtre manuel ou désactivé : importé désactivé, avec explication', () => {
  assert.strictEqual(item('Manuel seulement').rule.enabled, false);
  assert.ok(/manuellement/.test(item('Manuel seulement').notes.join(' ')));
  assert.strictEqual(item('Désactivé "test"').rule.enabled, false);
  assert.strictEqual(item('Désactivé "test"').rule.conditions[0].op, 'notContains');
});

test('« to or cc » devient le champ tocc', () => {
  assert.strictEqual(item('Avec CC').rule.conditions[0].field, 'tocc');
});

test('UTF-7 IMAP et URL : Cat&AOk-gorie -> Catégorie', () => {
  assert.strictEqual(tb.decodeImapUtf7('Cat&AOk-gorie'), 'Catégorie');
  assert.strictEqual(tb.decodeImapUtf7('A &- B'), 'A & B');
  const p = item('Accentué');
  assert.strictEqual(p.rule.folder, 'Catégorie');
  assert.strictEqual(p.rule.conditions[0].value, '[urgent]');
});

test('parseFolderUri', () => {
  const u = tb.parseFolderUri('imap://moi%40exemple.fr@imap.exemple.fr:993/%5BGmail%5D/Spam%20bis');
  assert.deepStrictEqual(u, { scheme: 'imap', user: 'moi@exemple.fr', host: 'imap.exemple.fr', segments: ['[Gmail]', 'Spam bis'] });
  assert.strictEqual(tb.parseFolderUri('pas une uri'), null);
});

test('resolveFolder : exact, préfixe INBOX, séparateur différent, nom unique, manquant', () => {
  const dots = [
    { path: 'INBOX', delimiter: '.' }, { path: 'INBOX.Factures', delimiter: '.' }, { path: 'INBOX.Clients.ACME', delimiter: '.' },
  ];
  assert.deepStrictEqual(tb.resolveFolder(dots, ['INBOX', 'Factures']), { status: 'found', path: 'INBOX.Factures' });
  assert.deepStrictEqual(tb.resolveFolder(dots, ['Factures']), { status: 'found', path: 'INBOX.Factures' });
  assert.deepStrictEqual(tb.resolveFolder(dots, ['Clients', 'ACME']), { status: 'found', path: 'INBOX.Clients.ACME' });
  assert.deepStrictEqual(tb.resolveFolder(dots, ['ACME']), { status: 'approx', path: 'INBOX.Clients.ACME' });
  assert.deepStrictEqual(tb.resolveFolder(dots, ['factures']), { status: 'found', path: 'INBOX.Factures' });
  assert.deepStrictEqual(tb.resolveFolder(dots, ['Voyages'], { prefix: 'INBOX.' }), { status: 'missing', path: 'INBOX.Voyages' });
  assert.deepStrictEqual(tb.resolveFolder(FOLDERS, ['Nouveau', 'Sous']), { status: 'missing', path: 'Nouveau/Sous' });
});

test('dossier manquant : proposé avec le bon chemin', () => {
  const p = tb.buildPreview(tb.parseFilterFile(['name="X"', 'action="Move to folder"', 'actionValue="imap://u@h/Projets/2026"', 'condition="AND (from,is,a@b.fr)"'].join('\n')),
    { accountId: 'a1', folders: FOLDERS })[0];
  assert.strictEqual(p.folder.status, 'missing');
  assert.strictEqual(p.rule.folder, 'Projets/2026');
});

test('les règles importées fonctionnent vraiment sur un message', () => {
  const rules = preview.filter((p) => p.rule).map((p, i) => ({ id: 'r' + i, ...p.rule }));
  const hit = findRule(rules, 'a1', { from: 'commandes@amazon.fr', fromName: 'Amazon', subject: 'Votre facture', to: '', cc: '' });
  assert.strictEqual(hit.folder, 'Factures');
  assert.strictEqual(findRule(rules, 'a1', { from: 'commandes@amazon.fr', subject: 'Promo' }), null);
  assert.strictEqual(findRule(rules, 'a1', { from: 'x@notion.so', subject: 'Hello' }).folder, 'Lettres');
  assert.strictEqual(findRule(rules, 'a1', { from: 'a@b.fr', subject: 'Re: [URGENT] stock' }).folder, 'Catégorie');
});

test('doublons détectés', () => {
  const first = preview.find((p) => p.rule);
  const again = tb.buildPreview(filters, { accountId: 'a1', folders: FOLDERS, existingRules: [{ ...first.rule }] });
  assert.strictEqual(again[first.key].duplicate, true);
  assert.strictEqual(again.filter((p) => p.duplicate).length, 1);
  const other = tb.buildPreview(filters, { accountId: 'a2', folders: FOLDERS, existingRules: [{ ...first.rule }] });
  assert.strictEqual(other.filter((p) => p.duplicate).length, 0);
});

test('suggestAccount : par adresse puis par serveur', () => {
  const accounts = [
    { id: 'a1', email: 'perso@gmail.com', imap: { host: 'imap.gmail.com', user: 'perso@gmail.com' } },
    { id: 'a2', email: 'moi@exemple.fr', imap: { host: 'imap.exemple.fr', user: 'moi@exemple.fr' } },
  ];
  const hints = tb.serverHints(filters);
  assert.deepStrictEqual(hints, [{ user: 'moi@exemple.fr', host: 'imap.exemple.fr' }]);
  assert.strictEqual(tb.suggestAccount(accounts, hints, 'imap.exemple.fr'), 'a2');
  assert.strictEqual(tb.suggestAccount(accounts, [], 'imap.gmail.com'), 'a1');
  assert.strictEqual(tb.suggestAccount(accounts, [], 'autre.fr'), null);
});

test('findFilterFiles : trouve les profils (profiles.ini + dossier Profiles)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-'));
  try {
    const profile = path.join(root, 'Profiles', 'abc123.default-release');
    fs.mkdirSync(path.join(profile, 'ImapMail', 'imap.exemple.fr'), { recursive: true });
    fs.mkdirSync(path.join(profile, 'ImapMail', 'imap.vide.fr'), { recursive: true });
    fs.mkdirSync(path.join(profile, 'Mail', 'Local Folders'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'ImapMail', 'imap.exemple.fr', 'msgFilterRules.dat'), SAMPLE);
    fs.writeFileSync(path.join(profile, 'Mail', 'Local Folders', 'msgFilterRules.dat'), SAMPLE);
    fs.writeFileSync(path.join(root, 'profiles.ini'), '[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc123.default-release\n');
    const found = tb.findFilterFiles({ roots: [root] });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].server, 'imap.exemple.fr');
    assert.strictEqual(found[0].filters, 12);
    assert.strictEqual(found[0].profile, 'abc123.default-release');
    assert.deepStrictEqual(tb.findFilterFiles({ roots: [path.join(root, 'inexistant')] }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('thunderbirdRoots : chemins par système', () => {
  assert.ok(tb.thunderbirdRoots('win32', 'C:\\Users\\a', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' })[0].endsWith('Thunderbird'));
  assert.ok(tb.thunderbirdRoots('darwin', '/Users/a')[0].includes('Library'));
  assert.ok(tb.thunderbirdRoots('linux', '/home/a')[0].endsWith('.thunderbird'));
});

console.log(`\n${passed} tests réussis`);
