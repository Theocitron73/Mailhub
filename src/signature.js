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
 * Renvoie { html, text, attachments } ou null s'il n'y a rien à faire (pas d'images).
 */
function buildSignedMessage(text, block, images, html = '') {
  const imgs = (images || []).map((i) => cleanImage(i)).filter(Boolean);
  if (!imgs.length) return null;

  const normText = String(text || '').replace(/\r\n/g, '\n');
  const normBlock = String(block || '').replace(/\r\n/g, '\n');
  const normHtml = String(html || '');

  const hasBlock = normBlock && normText.includes(normBlock);
  const hasPlaceholder = normText.includes(PLACEHOLDER) || normHtml.includes(PLACEHOLDER) || normHtml.includes('data-sig="1"');

  if (normBlock && !hasBlock && !hasPlaceholder) return null;

  const attachments = imgs.map((im, i) => {
    const m = IMG_RE.exec(im.dataUrl);
    const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
    return { filename: `signature-${i + 1}.${ext}`, content: Buffer.from(m[2], 'base64'), contentType: m[1], cid: `sig${i}@mailhub`, contentDisposition: 'inline' };
  });
  const imgHtml = imgs.map((im, i) => `<img src="cid:sig${i}@mailhub" width="${im.width}" alt="" style="max-width:100%;height:auto;display:block;margin:6px 0">`).join('');

  let newHtml = normHtml;
  if (newHtml) {
    if (newHtml.includes(PLACEHOLDER)) {
      newHtml = newHtml.replace(PLACEHOLDER, imgHtml);
    } else if (newHtml.includes('data-sig="1"')) {
      newHtml = newHtml.replace(/<div[^>]*data-sig="1"[^>]*>([\s\S]*?)<\/div>/i, (match, inner) => {
        const replaced = inner.includes(PLACEHOLDER) ? inner.replace(PLACEHOLDER, imgHtml) : (inner + '<br><br>' + imgHtml);
        return `<div class="sig-block" data-sig="1">${replaced}</div>`;
      });
    } else {
      newHtml += `<div class="sig-block" data-sig="1"><br><br>${imgHtml}</div>`;
    }
  } else {
    const at = normBlock ? normText.indexOf(normBlock) : -1;
    const before = at >= 0 ? normText.slice(0, at) : normText;
    const after = at >= 0 ? normText.slice(at + normBlock.length) : '';
    const box = 'font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;white-space:pre-wrap';
    const cleanBlock = normBlock ? normBlock.replace(PLACEHOLDER, '') : '';
    newHtml = `<div style="${box}">${esc(before + cleanBlock)}</div><div>${imgHtml}</div>` + (after.trim() ? `<div style="${box}">${esc(after)}</div>` : '');
  }

  let atText = normBlock ? normText.indexOf(normBlock) : -1;
  if (atText < 0 && normText.includes(PLACEHOLDER)) {
    atText = normText.indexOf(PLACEHOLDER);
  }

  let newText = normText;
  const plainBlock = normBlock ? normBlock.replace(PLACEHOLDER, '').replace(/\n-- \n\s*$/, '') : '';
  if (atText >= 0) {
    const before = normText.slice(0, atText);
    const matchLen = normBlock ? normBlock.length : PLACEHOLDER.length;
    const after = normText.slice(atText + matchLen);
    newText = before + plainBlock + after;
  } else if (plainBlock) {
    newText = normText + '\n' + plainBlock;
  }
  newText = newText.replace(PLACEHOLDER, '').trim();

  return { html: newHtml, text: newText, attachments };
}

module.exports = { PLACEHOLDER, cleanImage, buildSignedMessage };
