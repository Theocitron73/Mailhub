'use strict';

/**
 * Signatures avec images : le message part en HTML (texte mis en forme à l'identique) avec les
 * images de la signature insérées juste après le bloc de signature, en pièces jointes intégrées (cid).
 */

const PLACEHOLDER = '(images de la signature)';
const IMG_RE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Valide une image de signature (data URI) ; renvoie null si elle n'est pas acceptable. */
function cleanImage(im, { maxBytes = 1.5 * 1024 * 1024 } = {}) {
  if (!im || typeof im.dataUrl !== 'string') return null;
  const m = IMG_RE.exec(im.dataUrl);
  if (!m) return null;
  if (Math.floor(m[2].length * 3 / 4) > maxBytes) return null;
  const width = Math.max(16, Math.min(800, Math.round(Number(im.width) || 200)));
  return { id: String(im.id || '').slice(0, 40), name: String(im.name || 'image').slice(0, 120), dataUrl: im.dataUrl, width };
}

/**
 * text : corps saisi ; block : le bloc de signature tel qu'inséré dans le texte ; images : images de la signature.
 * Renvoie { html, text, attachments } ou null s'il n'y a rien à faire (pas d'images, ou bloc supprimé par l'utilisateur).
 */
function buildSignedMessage(text, block, images) {
  const imgs = (images || []).map((i) => cleanImage(i)).filter(Boolean);
  const at = block ? String(text).indexOf(block) : -1;
  if (!imgs.length || at < 0) return null;
  const before = text.slice(0, at);
  const after = text.slice(at + block.length);
  const sigText = block.replace(PLACEHOLDER, '').replace(/\n-- \n\s*$/, '');
  const plainBlock = block.replace(PLACEHOLDER, '').replace(/\n-- \n\s*$/, '');

  const attachments = imgs.map((im, i) => {
    const m = IMG_RE.exec(im.dataUrl);
    const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
    return { filename: `signature-${i + 1}.${ext}`, content: Buffer.from(m[2], 'base64'), contentType: m[1], cid: `sig${i}@mailhub`, contentDisposition: 'inline' };
  });
  const imgHtml = imgs.map((im, i) => `<img src="cid:sig${i}@mailhub" width="${im.width}" alt="" style="max-width:100%;height:auto;display:block;margin:6px 0">`).join('');
  const box = 'font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;white-space:pre-wrap';
  const html = `<div style="${box}">${esc(before + sigText)}</div><div>${imgHtml}</div>` + (after.trim() ? `<div style="${box}">${esc(after)}</div>` : '');
  return { html, text: before + plainBlock + after, attachments };
}

module.exports = { PLACEHOLDER, cleanImage, buildSignedMessage };
