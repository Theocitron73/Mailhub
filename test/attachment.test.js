'use strict';
const assert = require('assert');
const { attachmentPreview } = require('../src/attachment');
let n = 0;
function t(name, fn) { fn(); n++; console.log('  ok   ' + name); }
const mk = (filename, contentType, content) => ({ filename, contentType, content: Buffer.from(content) });

t('image : aperçu en data URI', () => {
  const r = attachmentPreview(mk('a.png', 'image/png', 'x'));
  assert.strictEqual(r.kind, 'image');
  assert.ok(r.dataUrl.startsWith('data:image/png;base64,'));
});
t('pdf : reconnu par type ou extension', () => {
  assert.strictEqual(attachmentPreview(mk('a.pdf', 'application/pdf', '%PDF')).kind, 'pdf');
  assert.strictEqual(attachmentPreview(mk('a.pdf', 'application/octet-stream', '%PDF')).kind, 'pdf');
});
t('texte : décodé et tronqué au-delà de 1 Mo', () => {
  assert.strictEqual(attachmentPreview(mk('n.txt', 'text/plain; charset=utf-8', 'é bonjour')).text, 'é bonjour');
  const big = attachmentPreview(mk('l.log', 'text/plain', 'a'.repeat(1024 * 1024 + 10)));
  assert.strictEqual(big.truncated, true);
  assert.strictEqual(big.text.length, 1024 * 1024);
});
t('html joint : montré comme texte, jamais interprété', () => {
  const r = attachmentPreview(mk('x.html', 'text/html', '<script>alert(1)</script>'));
  assert.strictEqual(r.kind, 'text');
});
t('autres types et fichiers trop lourds : pas d’aperçu', () => {
  assert.strictEqual(attachmentPreview(mk('a.docx', 'application/vnd.openxmlformats', 'x')).kind, 'other');
  const huge = { filename: 'g.bin', contentType: 'image/png', content: { length: 21 * 1024 * 1024 } };
  const r = attachmentPreview(huge);
  assert.strictEqual(r.kind, 'other');
  assert.strictEqual(r.tooBig, true);
});
console.log(`\n${n} tests réussis`);
