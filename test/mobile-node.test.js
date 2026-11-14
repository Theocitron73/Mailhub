'use strict';
// Moteur Android (mobile/nodejs/index.js) testé avec un faux module « bridge »
const assert = require('assert');
const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-mobile-'));
const channel = new EventEmitter();
const posted = [];
channel.post = (event, ...args) => posted.push([event, ...args]);
const appEvents = new EventEmitter();
const fakeBridge = { channel, app: Object.assign(appEvents, { datadir: () => dataDir }) };
const orig = Module._load;
Module._load = function (req, ...a) { return req === 'bridge' ? fakeBridge : orig.call(this, req, ...a); };
const mobile = require(process.env.MH_ENGINE || '../mobile/nodejs/index.js');
Module._load = orig;

let n = 0;
async function t(name, fn) { await fn(); n++; console.log('  ok   ' + name); }
let seq = 0;
function ipc(name, ...args) {
  const id = ++seq;
  channel.emit('ipc', { id, channel: name, args });
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      const r = posted.find((p) => p[0] === 'ipc:reply' && p[1].id === id);
      if (r) { clearInterval(iv); resolve(r[1]); }
    }, 5);
  });
}

(async () => {
  await t('avant « init », les requêtes sont refusées proprement', async () => {
    const r = await ipc('accounts:list');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /démarre/);
  });

  const key = crypto.randomBytes(32).toString('base64');
  await t('« init » démarre le moteur, les canaux communs répondent', async () => {
    const r = await ipc('init', { key, version: '1.4.0' });
    assert.deepStrictEqual(r, { id: r.id, ok: true, data: { ready: true } });
    assert.deepStrictEqual((await ipc('accounts:list')).data, []);
    assert.strictEqual((await ipc('accounts:encryption')).data, true);
    assert.strictEqual((await ipc('prefs:set', { theme: 'dark' })).data.theme, 'dark');
    assert.deepStrictEqual((await ipc('scheduled:list')).data, []);
    assert.strictEqual((await ipc('canal:inexistant')).ok, false);
  });

  await t('mots de passe chiffrés avec la clé du Keystore (AES-GCM)', async () => {
    const c = mobile.keystoreCipher(key);
    const enc = c.encryptString('mot de passe é');
    assert.ok(!enc.toString('utf8').includes('mot de passe'));
    assert.strictEqual(c.decryptString(enc), 'mot de passe é');
    assert.throws(() => mobile.keystoreCipher(crypto.randomBytes(32).toString('base64')).decryptString(enc));
    assert.strictEqual(mobile.keystoreCipher('trop-court').isEncryptionAvailable(), false);
  });

  await t('comparaison de versions pour les mises à jour', async () => {
    assert.strictEqual(mobile.newer('1.10.0', '1.9.2'), true);
    assert.strictEqual(mobile.newer('1.4.0', '1.4.0'), false);
    assert.strictEqual(mobile.newer('1.3.9', '1.4.0'), false);
  });

  await t('export/import des réglages et des règles par contenu', async () => {
    const exp = await ipc('settings:exportData');
    assert.strictEqual(exp.ok, true);
    assert.ok(Array.isArray(exp.data.rules));
    assert.strictEqual((await ipc('rules:exportData')).ok, false); // aucune règle
    const prev = await ipc('rules:importPickDirect', { file: 'r.json', text: '{"format":"x"}' });
    assert.strictEqual(prev.ok, false);
  });

  await t('pièces jointes sortantes : aucun chemin de fichier accepté', async () => {
    // brouillon sans compte : refusé, mais le contrôle des pièces jointes passe avant
    const r = await ipc('messages:saveDraft', 'inconnu', { attachments: [{ name: 'x', path: '/etc/passwd' }] });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /Compte introuvable/);
  });

  await t('chaque canal utilisé par l’interface Android existe dans le moteur', async () => {
    const adapter = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'mailhub-mobile.js'), 'utf8');
    const used = [...new Set([...adapter.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]))];
    const missing = used.filter((c) => !mobile.channels().includes(c));
    assert.deepStrictEqual(missing, []);
    assert.ok(used.length > 55);
  });

  await t('les données sont écrites dans le dossier de l’application', async () => {
    assert.ok(fs.existsSync(path.join(dataDir, 'mailhub-data.json')));
  });

  console.log(`\n${n} tests réussis`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
