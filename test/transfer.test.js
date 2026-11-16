'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const transfer = require('../src/transfer');
const { Store } = require('../src/store');
const backup = require('../src/backup');

let n = 0;
async function t(name, fn) { await fn(); n++; console.log('  ok   ' + name); }
const newStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'mh-tr-')), null);
const local = { hosts: ['127.0.0.1'], bind: '127.0.0.1' };

(async () => {
  await t('QR code : contenu lu et vérifié', async () => {
    const key = Buffer.alloc(32, 7);
    const code = transfer.encodeCode({ hosts: ['192.168.1.20', '10.0.0.4'], port: 51000, token: 'a'.repeat(32), key });
    assert.ok(code.startsWith('MAILHUB-TRANSFER:1;'));
    assert.ok(code.length < 200); // assez court pour un QR code lisible
    const p = transfer.parseCode(code);
    assert.deepStrictEqual(p.hosts, ['192.168.1.20', '10.0.0.4']);
    assert.strictEqual(p.port, 51000);
    assert.ok(p.key.equals(key));
    assert.throws(() => transfer.parseCode('https://exemple.fr'), /pas un transfert MailHub/);
    assert.throws(() => transfer.parseCode(code.replace(/t=a+/, 't=zz')), /incomplet/);
  });

  await t('transfert : les réglages arrivent, une seule fois, et circulent chiffrés', async () => {
    const events = [];
    const srv = new transfer.TransferServer({ onEvent: (e) => events.push(e) });
    const payload = { accounts: [{ email: 'moi@exemple.fr', password: 'secret-123' }] };
    const res = await srv.start(payload, local);
    // ce qui passe sur le réseau ne contient pas le mot de passe
    const { port, token } = transfer.parseCode(res.code);
    const wrong = await new Promise((r) => http.get(`http://127.0.0.1:${port}/mailhub-transfer/${'0'.repeat(32)}`, (x) => { x.resume(); r(x.statusCode); }));
    assert.strictEqual(wrong, 404);
    const got = await transfer.receive(res.code);
    assert.deepStrictEqual(got, payload);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(events, ['done']);
    await assert.rejects(transfer.receive(res.code, { timeout: 1000 }), /même Wi-Fi/);
    void token;
  });

  await t('transfert : le QR code expire', async () => {
    const events = [];
    const srv = new transfer.TransferServer({ onEvent: (e) => events.push(e) });
    const res = await srv.start({ a: 1 }, { ...local, ttl: 100 });
    await new Promise((r) => setTimeout(r, 250));
    assert.deepStrictEqual(events, ['expired']);
    await assert.rejects(transfer.receive(res.code, { timeout: 1000 }), /joindre l’ordinateur/);
  });

  await t('le chiffrement du transfert détecte une mauvaise clé', async () => {
    const box = transfer.seal({ x: 'y' }, Buffer.alloc(32, 1));
    assert.ok(!JSON.stringify(box).includes('"y"'));
    assert.throws(() => transfer.open(box, Buffer.alloc(32, 2)), /illisibles/);
  });

  await t('le téléphone reçoit tout et continue la sauvegarde au même endroit', async () => {
    const mailbox = [];
    const manager = {
      saveBackup: async (_a, text) => { mailbox.push(text); },
      listBackups: async () => [], readBackup: async () => '',
    };
    const pc = newStore();
    const acc = pc.addAccount({ email: 'moi@exemple.fr', password: 'mdp', imap: { host: 'imap.exemple.fr' } });
    pc.addRules([{ accountId: acc.id, folder: 'Factures', match: 'any', conditions: [{ field: 'from', op: 'contains', value: 'edf' }] }]);
    const svcPC = new backup.BackupService(pc, manager, { device: 'PC' });
    await svcPC.enable({ accountId: acc.id, passphrase: 'phrase très secrète' });

    const srv = new transfer.TransferServer();
    const res = await srv.start(svcPC.transferPayload(), local);
    const phone = newStore();
    const svcPhone = new backup.BackupService(phone, manager, { device: 'Téléphone' });
    const sum = svcPhone.receive(await transfer.receive(res.code));
    assert.deepStrictEqual(sum.accountsAdded, ['moi@exemple.fr']);
    assert.strictEqual(sum.backup, 'moi@exemple.fr');
    assert.strictEqual(phone.getAccount(phone.listAccounts()[0].id).password, 'mdp');
    assert.strictEqual(phone.listRules().length, 1);
    // le téléphone sauvegarde sans connaître la phrase ; l'ordinateur relit avec la phrase
    await svcPhone.saveNow();
    const env = backup.readEnvelope(mailbox[mailbox.length - 1]);
    assert.strictEqual(env.device, 'Téléphone');
    assert.strictEqual(backup.decrypt(env, backup.deriveKey('phrase très secrète', env.kdf.salt)).accounts[0].email, 'moi@exemple.fr');
  });

  console.log(`\n${n} tests réussis`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
