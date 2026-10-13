'use strict';
const assert = require('assert');
const { PLACEHOLDER, cleanImage, buildSignedMessage } = require('../src/signature');
let n = 0;
function t(name, fn) { fn(); n++; console.log('  ok   ' + name); }
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

t('image : types acceptés (png, gif) ; refus de svg, html, données invalides', () => {
  assert.ok(cleanImage({ dataUrl: PNG, width: 120 }));
  assert.ok(cleanImage({ dataUrl: GIF }));
  assert.strictEqual(cleanImage({ dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }), null);
  assert.strictEqual(cleanImage({ dataUrl: 'data:text/html;base64,PGI+' }), null);
  assert.strictEqual(cleanImage({ dataUrl: 'https://x/y.png' }), null);
  assert.strictEqual(cleanImage({ dataUrl: 'data:image/png;base64,@@@' }), null);
});
t('image : largeur bornée, taille maximale', () => {
  assert.strictEqual(cleanImage({ dataUrl: PNG, width: 99999 }).width, 800);
  assert.strictEqual(cleanImage({ dataUrl: PNG, width: 1 }).width, 16);
  assert.strictEqual(cleanImage({ dataUrl: 'data:image/png;base64,' + 'A'.repeat(4000) }, { maxBytes: 1000 }), null);
});
t('message : images insérées juste après la signature, avant le texte cité', () => {
  const block = '\n\n-- \nJean Test\nDirecteur';
  const text = block + '\n\nLe lundi, Paul a écrit :\n\nBonjour <b>';
  const r = buildSignedMessage(text, block, [{ dataUrl: PNG, width: 150 }, { dataUrl: GIF, width: 80 }]);
  assert.ok(r);
  assert.strictEqual(r.attachments.length, 2);
  assert.strictEqual(r.attachments[1].contentType, 'image/gif');
  assert.ok(r.attachments[0].content.length > 20);
  assert.ok(r.html.indexOf('Directecteur') < 0 && r.html.indexOf('Directeur') < r.html.indexOf('cid:sig0@mailhub'));
  assert.ok(r.html.indexOf('cid:sig1@mailhub') < r.html.indexOf('a écrit'));
  assert.ok(r.html.includes('Bonjour &lt;b&gt;'), 'le texte est échappé');
  assert.ok(r.html.includes('width="150"'));
});
t('message : signature faite uniquement d’images (repère retiré du texte)', () => {
  const block = '\n\n-- \n' + PLACEHOLDER;
  const r = buildSignedMessage('Salut' + block, block, [{ dataUrl: PNG }]);
  assert.ok(!r.html.includes('images de la signature') && !r.text.includes('images de la signature'));
  assert.ok(r.html.includes('Salut'));
});
t('rien à faire : sans image, ou bloc supprimé par l’utilisateur', () => {
  assert.strictEqual(buildSignedMessage('x\n\n-- \nA', '\n\n-- \nA', []), null);
  assert.strictEqual(buildSignedMessage('texte sans signature', '\n\n-- \nA', [{ dataUrl: PNG }]), null);
});

console.log(`\n${n} tests réussis`);
