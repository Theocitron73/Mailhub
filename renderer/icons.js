'use strict';

// Icônes de l'interface (SVG constants, jamais construites à partir de données d'e-mail).
(function () {
  const P = {
    inbox: '<path d="M3 13h5l1.5 2.5h5L16 13h5"/><path d="M5.5 5h13L21 13v6H3v-6z"/>',
    layers: '<path d="M12 3 3 8l9 5 9-5z"/><path d="m3 13 9 5 9-5"/>',
    send: '<path d="M21 3 10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
    draft: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/><path d="M9 14h7M9 17h5"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9"/><path d="M10 13h4"/>',
    junk: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
    folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2.5h7.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/>',
    star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8 6.8 19.6l1-5.8L3.5 9.7l5.9-.9z"/>',
    clip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7L9.2 17.2a1.7 1.7 0 0 1-2.4-2.4L14.5 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.5L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.5L20 15.5"/><path d="M20 20v-4.5h-4.5"/>',
    rules: '<path d="M4 6h10M4 12h6M4 18h10"/><path d="m16 10 3-3 3 3"/><path d="M19 7v10"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    reply: '<path d="M9 8 4 13l5 5"/><path d="M4 13h9a7 7 0 0 1 7 7"/>',
    forward: '<path d="m15 8 5 5-5 5"/><path d="M20 13h-9a7 7 0 0 0-7 7"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    mailopen: '<path d="M3 10 12 4l9 6v9H3z"/><path d="m3 10 9 6 9-6"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
    pencil: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m14.5 7.5 3 3"/>',
    layoutRight: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M10 4.5v15"/>',
    layoutBottom: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 11.5h18"/>',
    layoutFull: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7.5 9.5h9M7.5 13h9M7.5 16h5"/>',
    back: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
    up: '<path d="m6 14 6-6 6 6"/>',
    down: '<path d="m6 10 6 6 6-6"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.8-.4-1.1-.3-.4-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4C21 6.7 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
    sort: '<path d="M7 4v16"/><path d="m3.5 16.5 3.5 3.5 3.5-3.5"/><path d="M17 20V4"/><path d="m13.5 7.5 3.5-3.5 3.5 3.5"/>',
    download: '<path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>',
  };

  window.icon = function icon(name, size) {
    const s = size || 18;
    const fill = name === 'star' ? 'var(--star-fill, none)' : 'none';
    return `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  };
})();
