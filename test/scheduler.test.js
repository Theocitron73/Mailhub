'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/store');
const { Scheduler } = require('../src/scheduler');

let n = 0;
async function t(name, fn) { await fn(); n++; console.log('  ok   ' + name); }
const tmpStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'mh-sched-')), null);

(async () => {
  await t('un message dû part, les autres attendent', async () => {
    const store = tmpStore();
    const sent = [];
    const events = [];
    const s = new Scheduler(store, async (acc, mail) => { sent.push([acc, mail.subject]); }, (k) => events.push(k));
    s.add('a1', { subject: 'tout de suite', to: 'x@y.fr' }, new Date(Date.now() - 1000).toISOString());
    s.add('a1', { subject: 'plus tard', to: 'x@y.fr' }, new Date(Date.now() + 3600000).toISOString());
    await s.tick();
    assert.deepStrictEqual(sent, [['a1', 'tout de suite']]);
    assert.deepStrictEqual(s.list().map((x) => x.subject), ['plus tard']);
    assert.deepStrictEqual(events, ['sent']);
  });

  await t('échec : nouvel essai plus tard, suspendu après 5 essais', async () => {
    const store = tmpStore();
    const s = new Scheduler(store, async () => { throw new Error('SMTP indisponible'); });
    const it = s.add('a1', { subject: 'x' }, new Date(Date.now() - 1000).toISOString());
    await s.tick();
    let cur = s.list()[0];
    assert.strictEqual(cur.attempts, 1);
    assert.ok(new Date(cur.when) > new Date());
    assert.strictEqual(cur.error, 'SMTP indisponible');
    for (let i = 0; i < 4; i++) { store.updateScheduled(it.id, { when: new Date(Date.now() - 1000).toISOString() }); await s.tick(); }
    cur = s.list()[0];
    assert.strictEqual(cur.paused, true);
    await s.tick(); // suspendu : plus d'essai
    assert.strictEqual(s.list()[0].attempts, 5);
    // reprogrammer relance
    s.reschedule(it.id, new Date(Date.now() + 60000).toISOString());
    assert.strictEqual(s.list()[0].paused, false);
  });

  await t('annuler rend le message complet ; la liste ne montre pas le contenu des pièces jointes', async () => {
    const store = tmpStore();
    const s = new Scheduler(store, async () => {});
    const it = s.add('a1', { subject: 'pj', html: '<p>x</p>', attachments: [{ name: 'a.txt', dataUrl: 'data:text/plain;base64,eA==' }] }, new Date(Date.now() + 60000).toISOString());
    assert.deepStrictEqual(s.list()[0].attachments, ['a.txt']);
    assert.ok(!JSON.stringify(s.list()).includes('base64'));
    const back = s.cancel(it.id);
    assert.strictEqual(back.mail.html, '<p>x</p>');
    assert.strictEqual(s.list().length, 0);
    assert.throws(() => s.cancel(it.id), /introuvable/);
  });

  await t('dates invalides refusées', async () => {
    const s = new Scheduler(tmpStore(), async () => {});
    assert.throws(() => s.add('a1', { subject: 'x' }, 'pas une date'), /invalide/);
    assert.throws(() => s.add('a1', { subject: 'x' }, new Date(Date.now() + 400 * 86400000).toISOString()), /lointaine/);
  });

  console.log(`\n${n} tests réussis`);
})().catch((e) => { console.error(e); process.exit(1); });
