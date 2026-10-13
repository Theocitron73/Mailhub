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

module.exports = { attachmentPreview, MAX_PREVIEW };
