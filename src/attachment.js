'use strict';

/** Décide comment une pièce jointe est prévisualisée dans un onglet. Le type est déterminé ici, côté principal. */

const MAX_PREVIEW = 20 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml']);
const TEXT_EXT = /\.(txt|csv|tsv|json|xml|md|markdown|log|ini|yaml|yml|ics|vcf|eml|srt|tex|html?|css|js|ts|py|sql)$/i;

function attachmentPreview(att) {
  const type = String(att.contentType || '').toLowerCase().split(';')[0].trim();
  const size = att.content ? att.content.length : 0;
  const base = { filename: att.filename, contentType: type, size };
  if (size > MAX_PREVIEW) return { ...base, kind: 'other', tooBig: true };
  if (IMAGE_TYPES.has(type)) {
    return { ...base, kind: 'image', dataUrl: `data:${type === 'image/jpg' ? 'image/jpeg' : type};base64,${att.content.toString('base64')}` };
  }
  if (type === 'application/pdf' || /\.pdf$/i.test(att.filename)) {
    return { ...base, kind: 'pdf', base64: att.content.toString('base64') };
  }
  if (type.startsWith('text/') || /^application\/(json|xml)$/.test(type) || TEXT_EXT.test(att.filename)) {
    const truncated = size > MAX_TEXT;
    return { ...base, kind: 'text', text: att.content.subarray(0, MAX_TEXT).toString('utf8'), truncated };
  }
  return { ...base, kind: 'other' };
}

// Pièces jointes d'un message à envoyer : seuls les fichiers choisis par l'utilisateur (allowedPaths)
// peuvent être lus sur le disque ; sinon on n'accepte que le contenu transmis (data URI).
// Empêche une interface compromise de faire partir n'importe quel fichier de l'ordinateur.
const MAX_ATTACH_TOTAL = 35 * 1024 * 1024;
function safeOutgoing(mail, allowedPaths, statSize) {
  const m = { ...(mail || {}) };
  let total = 0;
  m.attachments = (Array.isArray(m.attachments) ? m.attachments : []).map((a) => {
    if (!a || typeof a !== 'object') return null;
    const out = {
      name: String(a.name || 'piece-jointe').split(/[\\/]/).pop() || 'piece-jointe',
      contentType: typeof a.contentType === 'string' ? a.contentType : undefined,
    };
    if (typeof a.path === 'string' && allowedPaths.has(a.path)) {
      const size = statSize(a.path);
      if (size === null) return null;
      out.path = a.path;
      total += size;
    } else if (typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:')) {
      out.dataUrl = a.dataUrl;
      total += Math.floor(a.dataUrl.length * 0.75);
    } else return null;
    return out;
  }).filter(Boolean);
  if (total > MAX_ATTACH_TOTAL) throw new Error('Pièces jointes trop lourdes (35 Mo au total au maximum).');
  return m;
}

module.exports = { attachmentPreview, MAX_PREVIEW, safeOutgoing, MAX_ATTACH_TOTAL };
