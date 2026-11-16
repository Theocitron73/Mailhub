'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/store');
const backup = require('../src/backup');

let n = 0;
async function t(name, fn) { await fn(); n++; console.log('  ok   ' + name); }
const newStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'mh-bk-')), null);

// Appareil A : deux comptes, règles, signature, préférences rattachées aux comptes
function deviceA() {
  const s = newStore();
  const a1 = s.addAccount({ name: 'Perso', email: 'moi@exemple.fr', password: 'mdp-perso', imap: { host: 'imap.exemple.fr' }, smtp: { host: 'smtp.exemple.fr' } });
  const a2 = s.addAccount({ name: 'Travail', email: 'Pro@Boite.fr', password: 'mdp-pro', imap: { host: 'imap.boite.fr' } });
  s.updateAccount(a1.id, { signatures: [{ id: 's1', name: 'Courte', text: 'Théo' }], defaultSignature: 's1' });
  s.addRules([
    { accountId: a1.id, folder: 'Factures', match: 'any', conditions: [{ field: 'from', op: 'contains', value: 'edf' }] },
    { accountId: a2.id, folder: 'Clients', match: 'all', conditions: [{ field: 'domain', op: 'equals', value: 'client.fr' }] },
  ]);
  s.setPrefs({ theme: 'dark', threads: true, sidebarWidth: 300, folderColors: { [`${a1.id}|Factures`]: '#ff0000' }, collapsedFolders: [`${a2.id}|Clients`] });
  s.recordContacts([{ address: 'alice@exemple.fr', name: 'Alice' }]);
  return { s, a1, a2 };
}

(async () => {
  await t('chiffrement : la bonne phrase déchiffre, une autre est refusée, rien de lisible', async () => {
    const salt = backup.newSalt();
    const key = backup.deriveKey('ma phrase secrète', salt);
    const env = backup.encrypt({ secret: 'mdp-perso' }, key, salt, { device: 'PC' });
    const text = JSON.stringify(env);
    assert.ok(!text.includes('mdp-perso'));
    assert.strictEqual(env.device, 'PC');
    assert.deepStrictEqual(backup.decrypt(backup.readEnvelope(text), key), { secret: 'mdp-perso' });
    assert.throws(() => backup.decrypt(env, backup.deriveKey('une autre phrase', salt)), /Phrase secrète incorrecte/);
    const altered = { ...env, data: Buffer.from('x' + env.data).toString('base64') };
    assert.throws(() => backup.decrypt(altered, key), /incorrecte|abîmée/);
    assert.throws(() => backup.deriveKey('court', salt), /au moins 8/);
    assert.throws(() => backup.readEnvelope('{"a":1}'), /pas une sauvegarde/);
  });

  await t('contenu : mots de passe en option, préférences de l’appareil exclues, comptes désignés par adresse', async () => {
    const { s } = deviceA();
    const withPw = backup.collect(s, { includePasswords: true });
    assert.deepStrictEqual(withPw.accounts.map((a) => a.password), ['mdp-perso', 'mdp-pro']);
    const noPw = backup.collect(s, { includePasswords: false });
    assert.ok(noPw.accounts.every((a) => !('password' in a)));
    assert.strictEqual(withPw.prefs.sidebarWidth, undefined);
    assert.deepStrictEqual(Object.keys(withPw.prefs.folderColors), ['moi@exemple.fr|Factures']);
    assert.deepStrictEqual(withPw.prefs.collapsedFolders, ['pro@boite.fr|Clients']);
    assert.deepStrictEqual(withPw.rules.map((r) => r.accountEmail.toLowerCase()), ['moi@exemple.fr', 'pro@boite.fr']);
  });

  await t('restauration sur un nouvel appareil : tout revient, réassocié aux nouveaux comptes', async () => {
    const { s } = deviceA();
    const payload = backup.collect(s, { includePasswords: true });
    const b = newStore();
    b.setPrefs({ sidebarWidth: 200 });
    const sum = backup.restore(b, JSON.parse(JSON.stringify(payload)));
    assert.deepStrictEqual(sum.accountsAdded, ['moi@exemple.fr', 'Pro@Boite.fr']);
    assert.deepStrictEqual(sum.needPassword, []);
    assert.strictEqual(sum.rulesAdded, 2);
    const accs = b.listAccounts();
    assert.strictEqual(b.getAccount(accs[0].id).password, 'mdp-perso');
    assert.strictEqual(accs[0].signatures[0].text, 'Théo');
    assert.strictEqual(accs[0].defaultSignature, 's1');
    const rules = b.listRules();
    assert.strictEqual(rules.find((r) => r.folder === 'Clients').accountId, accs[1].id);
    const prefs = b.getPrefs();
    assert.strictEqual(prefs.theme, 'dark');
    assert.strictEqual(prefs.sidebarWidth, 200); // propre à l'appareil : conservée
    assert.deepStrictEqual(prefs.folderColors, { [`${accs[0].id}|Factures`]: '#ff0000' });
    assert.deepStrictEqual(prefs.collapsedFolders, [`${accs[1].id}|Clients`]);
    assert.strictEqual(b.listContacts()[0].email, 'alice@exemple.fr');
  });

  await t('restauration sur un appareil déjà configuré : fusion sans doublon', async () => {
    const { s } = deviceA();
    const payload = backup.collect(s, { includePasswords: false });
    const b = newStore();
    const local = b.addAccount({ email: 'moi@exemple.fr', password: 'local', imap: { host: 'imap.exemple.fr' } });
    b.addRules([{ accountId: local.id, folder: 'Factures', match: 'any', conditions: [{ field: 'from', op: 'contains', value: 'edf' }] }]);
    const sum = backup.restore(b, payload);
    assert.deepStrictEqual(sum.accountsAdded, ['Pro@Boite.fr']);
    assert.deepStrictEqual(sum.needPassword, ['Pro@Boite.fr']);
    assert.strictEqual(sum.rulesAdded, 1); // la règle « Factures » existait déjà
    assert.strictEqual(b.getAccount(local.id).password, 'local'); // jamais écrasé
    assert.strictEqual(b.listAccounts().length, 2);
    assert.strictEqual(backup.restore(b, payload).rulesAdded, 0); // deuxième passage : rien de neuf
  });

  await t('BackupService : sauvegarde dans la boîte mail, retrouvée et restaurée ailleurs', async () => {
    const mailbox = [];
    const manager = {
      saveBackup: async (accountId, text) => { mailbox.push({ uid: mailbox.length + 1, text, accountId }); },
      listBackups: async () => mailbox.slice().reverse().map((m) => ({ uid: m.uid })),
      readBackup: async (_a, uid) => mailbox.find((m) => m.uid === uid).text,
    };
    const { s, a1 } = deviceA();
    const svcA = new backup.BackupService(s, manager, { device: 'Ordinateur', app: '1.5.0' });
    assert.strictEqual(svcA.status().mode, 'local');
    await assert.rejects(svcA.enable({ accountId: a1.id, passphrase: 'court' }), /au moins 8/);
    const st = await svcA.enable({ accountId: a1.id, passphrase: 'cheval correct pile agrafe' });
    assert.strictEqual(st.mode, 'mailbox');
    assert.ok(st.lastSaved);
    assert.strictEqual(mailbox.length, 1);
    assert.ok(!mailbox[0].text.includes('mdp-pro'));
    // rien de changé : pas de nouvelle sauvegarde automatique
    await svcA.saveNow({ force: false });
    assert.strictEqual(mailbox.length, 1);
    s.setPrefs({ theme: 'light' });
    await svcA.saveNow({ force: false });
    assert.strictEqual(mailbox.length, 2);
    // la clé n'est pas stockée en clair
    assert.ok(!JSON.stringify(s.data.backup).includes('cheval'));

    // nouvel appareil : on ajoute le compte qui contient la sauvegarde, puis on restaure
    const b = newStore();
    const first = b.addAccount({ email: 'moi@exemple.fr', password: 'mdp-perso', imap: { host: 'imap.exemple.fr' } });
    const svcB = new backup.BackupService(b, manager, { device: 'Téléphone' });
    const found = await svcB.find(first.id);
    assert.strictEqual(found[0].device, 'Ordinateur');
    await assert.rejects(svcB.restore(first.id, 'mauvaise phrase !'), /incorrecte/);
    const sum = await svcB.restore(first.id, 'cheval correct pile agrafe');
    assert.deepStrictEqual(sum.accountsAdded, ['Pro@Boite.fr']);
    assert.strictEqual(b.getPrefs().theme, 'light');
    // le téléphone continue de sauvegarder au même endroit, avec la même phrase
    assert.strictEqual(svcB.status().mode, 'mailbox');
    await svcB.saveNow();
    const env = backup.readEnvelope(mailbox[mailbox.length - 1].text);
    assert.strictEqual(env.device, 'Téléphone');
    assert.strictEqual(backup.decrypt(env, backup.deriveKey('cheval correct pile agrafe', env.kdf.salt)).accounts.length, 2);
    // retour au « local seulement »
    assert.strictEqual(svcB.disable().mode, 'local');
    assert.strictEqual(b.data.backup.key, '');
  });

  console.log(`\n${n} tests réussis`);
})().catch((e) => { console.error(e); process.exit(1); });
