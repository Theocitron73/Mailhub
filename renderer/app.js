'use strict';

/* ==========================================================================
   MailHub – interface
   Toutes les données venant des e-mails sont insérées via textContent (fonction h()),
   jamais via innerHTML. Le seul HTML « externe » est rendu dans un iframe sandboxé.
   ========================================================================== */

const api = window.mailhub;
document.body.classList.toggle('mac', api.platform === 'darwin');

// ------------------------------------------------------------------ utilitaires

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'vars') for (const [name, val] of Object.entries(v)) el.style.setProperty(name, val);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'disabled') el.disabled = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (kid) => {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(add);
    else el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  };
  kids.forEach(add);
  return el;
}

function ico(name, size) {
  const t = document.createElement('template');
  t.innerHTML = window.icon(name, size);
  return t.content.firstChild;
}

const $ = (sel, root) => (root || document).querySelector(sel);
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };

async function call(promise) {
  const r = await promise;
  if (!r.ok) throw new Error(r.error || 'Erreur inconnue');
  return r.data;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const dfDay = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dfMonth = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const dfFull = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'short' });
const dfOld = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

function fmtDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return dfDay.format(d);
  if (d.getFullYear() === now.getFullYear()) return dfMonth.format(d);
  return dfOld.format(d);
}

function fmtSize(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

function plural(n, one, many) { return n > 1 ? many : one; }
function domainOf(addr) { const i = String(addr).lastIndexOf('@'); return i >= 0 ? addr.slice(i + 1).toLowerCase() : ''; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ------------------------------------------------------------------------ état

const state = {
  prefs: { theme: 'auto' },
  accounts: [],
  folders: {},        // accountId -> { folders, prefix }
  folderErrors: {},   // accountId -> message
  status: {},         // accountId -> online | offline | error
  open: {},           // accountId -> bool (section dépliée)
  current: { accountId: 'unified', folder: 'INBOX' },
  messages: [],
  total: 0,
  loading: false,
  loadingMore: false,
  error: '',
  query: '',
  sel: new Set(),
  anchor: null,
  opened: null,       // { msg, detail, loading, error, allowRemote }
  rules: [],
  contacts: [],
  view: 'mail',       // mail | rules | settings | welcome
  tabs: [],           // onglets ouverts (messages, pièces jointes)
  tab: 'list',        // onglet actif ('list' = Messages)
  expanded: false,
  reading: false,     // le panneau de lecture occupe toute la zone
  listScroll: 0,
};

let loadToken = 0;
let unifiedMore = false;
const keyOf = (m) => `${m.accountId}|${m.folder}|${m.uid}`;
const accountById = (id) => state.accounts.find((a) => a.id === id);
const accColor = (id) => (accountById(id) || {}).color || 'var(--line)';

// ------------------------------------------------------------------- dossiers

const SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\All', '\\Flagged', '\\Junk', '\\Trash'];
const SPECIAL_LABEL = {
  '\\Inbox': 'Boîte de réception', '\\Drafts': 'Brouillons', '\\Sent': 'Envoyés', '\\Archive': 'Archives',
  '\\All': 'Tous les messages', '\\Flagged': 'Favoris', '\\Junk': 'Courrier indésirable', '\\Trash': 'Corbeille',
};
const SPECIAL_ICON = {
  '\\Inbox': 'inbox', '\\Drafts': 'draft', '\\Sent': 'send', '\\Archive': 'archive',
  '\\All': 'layers', '\\Flagged': 'star', '\\Junk': 'junk', '\\Trash': 'trash',
};

function folderInfo(accountId, path) {
  const info = state.folders[accountId];
  return info ? info.folders.find((f) => f.path === path) : null;
}

const FOLDER_COLORS = ['#e5484d', '#f76b15', '#f5a524', '#30a46c', '#12a594', '#0091ff', '#5b5bd6', '#8e4ec6', '#d6409f', '#6f6e77'];
const folderColorKey = (accountId, path) => `${accountId}|${path}`;
const folderColor = (accountId, path) => (state.prefs.folderColors || {})[folderColorKey(accountId, path)] || '';
async function setFolderColor(accountId, path, color) {
  const map = { ...(state.prefs.folderColors || {}) };
  if (color) map[folderColorKey(accountId, path)] = color; else delete map[folderColorKey(accountId, path)];
  state.prefs = await call(api.prefs.set({ folderColors: map }));
  renderSidebar();
}

// Dossiers repliés (mémorisés dans les préférences)
function collapsedPaths(accountId) {
  const info = state.folders[accountId];
  const delimOf = (path) => { const f = info && info.folders.find((x) => x.path === path); return f ? f.delimiter : '/'; };
  return (state.prefs.collapsedFolders || []).map((k) => {
    const [aid, ...rest] = k.split('|');
    return aid === accountId ? { path: rest.join('|'), delim: delimOf(rest.join('|')) } : null;
  }).filter(Boolean);
}
async function toggleFolderFold(accountId, path) {
  const key = folderColorKey(accountId, path);
  const set = new Set(state.prefs.collapsedFolders || []);
  if (set.has(key)) set.delete(key); else set.add(key);
  state.prefs = { ...state.prefs, collapsedFolders: [...set] }; // affichage immédiat
  renderSidebar();
  try { state.prefs = await call(api.prefs.set({ collapsedFolders: [...set] })); } catch (err) { toast(err.message, { error: true }); }
}
// non lus cachés dans les sous-dossiers d'un dossier replié
function subUnseen(accountId, f) {
  const info = state.folders[accountId];
  if (!info) return 0;
  return info.folders.filter((x) => x.path.startsWith(f.path + f.delimiter)).reduce((n, x) => n + (x.unseen || 0), 0);
}

function folderLabel(accountId, path) {
  if (!path) return '';
  const f = folderInfo(accountId, path);
  if (f && SPECIAL_LABEL[f.specialUse]) return SPECIAL_LABEL[f.specialUse];
  if (path.toUpperCase() === 'INBOX') return SPECIAL_LABEL['\\Inbox'];
  return f ? f.name : path.split(/[./]/).pop();
}

function layoutFolders(accountId) {
  const info = state.folders[accountId];
  if (!info) return [];
  const { folders, prefix } = info;
  const special = folders.filter((f) => SPECIAL_LABEL[f.specialUse] && f.selectable);
  special.sort((a, b) => SPECIAL_ORDER.indexOf(a.specialUse) - SPECIAL_ORDER.indexOf(b.specialUse));
  const specialPaths = new Set(special.map((f) => f.path));
  const rest = folders.filter((f) => !specialPaths.has(f.path));

  const hasCustomChild = (f) => rest.some((o) => o !== f && o.selectable && o.path.startsWith(f.path + f.delimiter));
  const visible = rest.filter((f) => f.selectable || hasCustomChild(f));
  visible.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  const visibleSet = new Set(visible.map((f) => f.path));

  const withDepth = visible.map((f) => {
    const base = prefix && f.path.startsWith(prefix) ? prefix : '';
    const parts = f.path.slice(base.length).split(f.delimiter);
    let depth = 0;
    for (let i = 1; i < parts.length; i++) {
      if (visibleSet.has(base + parts.slice(0, i).join(f.delimiter))) depth++;
    }
    return { folder: f, depth: Math.min(depth, 3), special: false };
  });
  return [...special.map((f) => ({ folder: f, depth: 0, special: true })), ...withDepth];
}

function unseenOf(accountId, path) {
  const f = folderInfo(accountId, path);
  return f ? f.unseen : 0;
}

function unifiedUnseen() {
  return state.accounts.reduce((n, a) => n + unseenOf(a.id, 'INBOX'), 0);
}

async function loadFolders(accountId) {
  try {
    state.folders[accountId] = await call(api.folders.list(accountId));
    delete state.folderErrors[accountId];
  } catch (err) {
    state.folderErrors[accountId] = err.message;
  }
  renderSidebar();
}

// --------------------------------------------------------------------- toasts

function toast(message, opts = {}) {
  const root = $('#toasts');
  const el = h('div', { class: 'toast' + (opts.error ? ' error' : '') }, h('span', null, message));
  const remove = () => { if (el.parentNode) el.parentNode.removeChild(el); };
  (opts.actions || []).forEach((a) => {
    el.appendChild(h('button', { on: { click: () => { remove(); a.onClick(); } } }, a.label));
  });
  root.appendChild(el);
  setTimeout(remove, opts.timeout || (opts.actions ? 12000 : opts.error ? 8000 : 4500));
}

// ------------------------------------------------------------ fenêtres modales

function openDialog({ title, subtitle, body, buttons, large, onClose }) {
  const root = $('#modal-root');
  const previousFocus = document.activeElement;
  const overlay = h('div', { class: 'overlay' });
  const errorSlot = h('div', { class: 'grow' });
  const foot = h('div', { class: 'dialog-foot' }, errorSlot);
  const dialog = h('div', { class: 'dialog' + (large ? ' large' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'dialog-head' }, h('h2', null, title), subtitle ? h('p', null, subtitle) : null),
    h('div', { class: 'dialog-body' }, body),
    foot
  );
  overlay.appendChild(dialog);

  const api2 = {
    el: dialog,
    close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener('keydown', onKey, true);
      if (previousFocus && previousFocus.focus) previousFocus.focus();
      if (onClose) onClose();
    },
    error(msg) { errorSlot.textContent = msg || ''; },
    buttons: {},
  };
  (buttons || []).forEach((b) => {
    const btn = h('button', { class: b.kind || 'ghost', on: { click: () => b.onClick(api2, btn) } }, b.label);
    api2.buttons[b.id || b.label] = btn;
    foot.appendChild(btn);
  });

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); api2.close(); }
  }
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) api2.close(); });
  root.appendChild(overlay);
  const first = dialog.querySelector('input:not([type=checkbox]):not([type=radio]), textarea, select');
  (first || dialog.querySelector('button')).focus();
  return api2;
}

function confirmDialog({ title, body, confirm, danger }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    openDialog({
      title,
      body: h('p', { style: 'margin:0' }, body),
      onClose: () => finish(false),
      buttons: [
        { label: 'Annuler', onClick: (d) => d.close() },
        { label: confirm, kind: danger ? 'danger' : 'primary', onClick: (d) => { finish(true); d.close(); } },
      ],
    });
  });
}

function askText({ title, label, value, confirm, hint }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const input = h('input', { type: 'text', value: value || '', spellcheck: 'false' });
    const submit = (d) => {
      const v = input.value.trim();
      if (!v) { d.error('Saisissez un nom.'); return; }
      finish(v);
      d.close();
    };
    const dlg = openDialog({
      title,
      body: h('div', { class: 'field' }, h('label', null, label), input, hint ? h('small', null, hint) : null),
      onClose: () => finish(null),
      buttons: [
        { label: 'Annuler', onClick: (d) => d.close() },
        { label: confirm, kind: 'primary', onClick: submit },
      ],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(dlg); });
    input.focus();
    input.select();
  });
}

function showMenu(x, y, items) {
  closeMenu();
  const menu = h('div', { class: 'menu', id: 'ctx-menu' },
    items.map((it) => {
      if (it.separator) return h('div', { class: 'menu-divider' });
      return h('button', {
        class: it.danger ? 'danger-item' : '',
        on: { click: () => { closeMenu(); it.onClick(); } },
      }, it.icon ? ico(it.icon, 16) : null, it.label, it.shortcut ? h('span', { class: 'menu-shortcut' }, it.shortcut) : null);
    }));
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  const outside = (e) => {
    if (menu.contains(e.target)) return;
    document.removeEventListener('mousedown', outside, true);
    closeMenu();
  };
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}
function closeMenu() { const m = $('#ctx-menu'); if (m) m.remove(); }

// ------------------------------------------------------------- barre latérale

function renderSidebar() {
  const nav = $('#sb-nav');
  const scroll = nav.scrollTop;
  clear(nav);

  const isUnified = state.view === 'mail' && state.current.accountId === 'unified';
  const unseen = unifiedUnseen();
  nav.appendChild(h('button', {
    class: 'folder' + (isUnified ? ' active' : '') + (unseen ? ' unread' : ''),
    on: { click: () => selectFolder('unified', 'INBOX') },
  }, ico('layers'), h('span', { class: 'name' }, 'Boîte unifiée'), unseen ? h('span', { class: 'count' }, unseen) : null));

  const isFav = state.view === 'mail' && state.current.accountId === 'favorites';
  nav.appendChild(h('button', {
    class: 'folder' + (isFav ? ' active' : ''), title: 'Messages marqués d’une étoile, tous comptes confondus',
    on: { click: () => selectFolder('favorites', '') },
  }, ico('star'), h('span', { class: 'name' }, 'Favoris')));

  state.accounts.forEach((acc) => {
    const open = state.open[acc.id] !== false;
    const status = state.status[acc.id] || '';
    const section = h('div', { class: 'account' + (open ? ' open' : ''), vars: { '--acc': acc.color } });
    section.appendChild(h('div', { class: 'account-head', on: { contextmenu: (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, [
      { label: 'Modifier le compte…', icon: 'gear', onClick: () => openAddAccount(acc) },
      { label: 'Nouveau dossier', icon: 'plus', onClick: () => openNewFolderDialog(acc.id) },
      { label: 'Tout marquer comme lu', icon: 'mailopen', onClick: async () => {
        try {
          if (state.folders[acc.id] && state.folders[acc.id].folders) {
            state.folders[acc.id].folders.forEach((f) => { f.unseen = 0; });
          }
          if (state.current.accountId === acc.id) {
            state.messages.forEach((m) => { m.seen = true; });
            renderList();
          } else if (state.current.accountId === 'unified') {
            state.messages.forEach((m) => { if (m.accountId === acc.id) m.seen = true; });
            renderList();
          }
          renderSidebar();
          await call(api.messages.markAllReadInAccount(acc.id));
          toast('Tous les messages du compte marqués comme lus.');
          await loadFolders(acc.id);
          renderSidebar();
          if (state.current.accountId === acc.id || state.current.accountId === 'unified') {
            loadMessages({ silent: true });
          }
        } catch (err) { toast(err.message, { error: true }); }
      }},
    ]); } } },
      h('button', { class: 'toggle', title: open ? 'Replier' : 'Déplier', 'aria-label': open ? 'Replier' : 'Déplier', on: { click: () => { state.open[acc.id] = !open; renderSidebar(); } } }, ico('chevron', 14)),
      h('span', { class: 'swatch' }),
      h('span', { class: 'acc-name', title: acc.email }, acc.name),
      h('span', { class: 'state ' + status, title: status === 'online' ? 'Connecté' : status === 'error' ? 'Erreur de connexion' : status === 'offline' ? 'Hors ligne' : 'Connexion…' }),
      h('button', { class: 'icon-btn', title: 'Nouveau dossier', 'aria-label': 'Nouveau dossier', on: { click: () => openNewFolderDialog(acc.id) } }, ico('plus', 16))
    ));

    const list = h('div', { class: 'account-folders' });
    if (state.folderErrors[acc.id]) {
      list.appendChild(h('div', { class: 'notice', style: 'margin:6px 4px;font-size:12.5px' }, state.folderErrors[acc.id],
        ' ', h('button', { class: 'subtle', on: { click: () => loadFolders(acc.id) } }, 'Réessayer')));
    } else if (!state.folders[acc.id]) {
      list.appendChild(h('div', { class: 'loading', style: 'padding:6px 12px' }, 'Chargement…'));
    } else {
      let sawCustom = false;
      const all = layoutFolders(acc.id);
      const collapsed = collapsedPaths(acc.id);
      all.forEach(({ folder: f, depth, special }, idx) => {
        if (!special && collapsed.some((c) => f.path.startsWith(c.path + c.delim))) return; // caché par un dossier replié
        const nxt = all[idx + 1];
        const hasKids = !special && !!nxt && !nxt.special && nxt.folder.path.startsWith(f.path + f.delimiter);
        const isCollapsed = hasKids && collapsed.some((c) => c.path === f.path);
        if (!special && !sawCustom) {
          sawCustom = true;
          list.appendChild(h('div', { class: 'folder-group' }, h('span', null, 'Mes dossiers')));
        }
        const active = state.view === 'mail' && state.current.accountId === acc.id && state.current.folder === f.path;
        const label = special ? SPECIAL_LABEL[f.specialUse] : f.name;
        const fc = folderColor(acc.id, f.path);
        const row = h('button', {
          class: `folder depth-${depth}` + (special ? ' is-default' : ' is-custom') + (active ? ' active' : '') + (f.unseen ? ' unread' : '') + (f.selectable ? '' : ' disabled') + (fc ? ' colored' : ''),
          title: f.path,
          vars: fc ? { '--fc': fc } : null,
          'data-account': acc.id, 'data-path': f.path,
          on: {
            click: () => f.selectable && selectFolder(acc.id, f.path),
            contextmenu: (e) => { e.preventDefault(); openFolderMenu(e, acc, f, special); },
          },
        }, hasKids
          ? h('span', { class: 'fold' + (isCollapsed ? ' closed' : ''), role: 'button', title: isCollapsed ? 'Déplier' : 'Replier', 'aria-label': (isCollapsed ? 'Déplier ' : 'Replier ') + label, 'aria-expanded': String(!isCollapsed),
            on: { click: (e) => { e.stopPropagation(); e.preventDefault(); toggleFolderFold(acc.id, f.path); } } }, ico('chevron', 12))
          : (special ? null : h('span', { class: 'fold none' })),
        ico(special ? SPECIAL_ICON[f.specialUse] : 'folder'), h('span', { class: 'name' }, label), isCollapsed && subUnseen(acc.id, f) ? h('span', { class: 'count sub', title: 'Messages non lus dans les sous-dossiers' }, subUnseen(acc.id, f)) : null, f.unseen ? h('span', { class: 'count' }, f.unseen) : null);

        if (f.selectable) {
          if (!special && f.path.toUpperCase() !== 'INBOX') {
            row.setAttribute('draggable', 'true');
            row.addEventListener('dragstart', (e) => {
              e.dataTransfer.setData('application/x-mailhub-folder', JSON.stringify({ accountId: acc.id, path: f.path, name: f.name, delimiter: f.delimiter }));
            });
          }
          row.addEventListener('dragover', (e) => {
            if (e.dataTransfer.types.includes('application/x-mailhub') || e.dataTransfer.types.includes('application/x-mailhub-folder')) {
              e.preventDefault();
              row.classList.add('drop-target');
            }
          });
          row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
          row.addEventListener('drop', async (e) => {
            e.preventDefault();
            row.classList.remove('drop-target');
            if (e.dataTransfer.types.includes('application/x-mailhub-folder')) {
              try {
                const data = JSON.parse(e.dataTransfer.getData('application/x-mailhub-folder'));
                if (data.accountId !== acc.id) return;
                if (data.path === f.path || f.path.startsWith(data.path + (data.delimiter || '/'))) return;
                const delim = f.delimiter || '/';
                const newPath = f.path + delim + data.name;
                await call(api.folders.rename(acc.id, data.path, newPath));
                await loadFolders(acc.id);
                toast('Dossier déplacé en sous-dossier.');
              } catch (err) { toast(err.message, { error: true }); }
            } else {
              handleDrop(e, acc.id, f.path);
            }
          });
        }
        list.appendChild(row);
      });
    }
    section.appendChild(list);
    nav.appendChild(section);
  });
  nav.scrollTop = scroll;

  $('#nav-rules').className = 'sb-link' + (state.view === 'rules' ? ' active' : '');
  $('#nav-settings').className = 'sb-link' + (state.view === 'settings' ? ' active' : '');
}

function openFolderMenu(e, acc, f, special) {
  const items = [
    { label: 'Tout marquer comme lu', icon: 'mailopen', onClick: async () => {
      try {
        f.unseen = 0;
        if (state.current.accountId === acc.id && state.current.folder === f.path) {
          state.messages.forEach((m) => { m.seen = true; });
          renderList();
        } else if (state.current.accountId === 'unified' && f.path.toUpperCase() === 'INBOX') {
          state.messages.forEach((m) => { if (m.accountId === acc.id) m.seen = true; });
          renderList();
        }
        renderSidebar();
        await call(api.messages.markAllRead(acc.id, f.path));
        toast('Dossier marqué comme lu.');
        await loadFolders(acc.id);
        renderSidebar();
        if ((state.current.accountId === acc.id && state.current.folder === f.path) || (state.current.accountId === 'unified' && f.path.toUpperCase() === 'INBOX')) {
          loadMessages({ silent: true });
        }
      } catch (err) { toast(err.message, { error: true }); }
    }},
    { label: 'Vider le dossier (supprimer tous les messages)', icon: 'trash', danger: true, onClick: async () => {
      const ok = await confirmDialog({
        title: `Vider « ${f.name} » ?`,
        body: 'Tous les messages de ce dossier seront définitivement supprimés.',
        confirm: 'Vider le dossier',
        danger: true,
      });
      if (!ok) return;
      try {
        await call(api.messages.deleteAllInFolder(acc.id, f.path));
        toast('Dossier vidé avec succès.');
        await loadFolders(acc.id);
        if (state.current.accountId === acc.id && state.current.folder === f.path) {
          state.messages = [];
          renderList();
          renderReader();
        }
      } catch (err) { toast(err.message, { error: true }); }
    }},
    { separator: true },
    { label: 'Nouveau sous-dossier', icon: 'plus', onClick: () => openNewFolderDialog(acc.id, f.path) },
    { label: 'Déplacer dans un autre dossier…', icon: 'folder', disabled: special, onClick: () => openMoveFolderDialog(acc, f) },
    { label: 'Appliquer les règles de tri', icon: 'rules', onClick: () => applyRules(acc.id, f.path) },
    { label: 'Couleur du dossier…', icon: 'palette', onClick: () => openColorDialog(acc, f, special) },
  ];
  if (!special && f.path.toUpperCase() !== 'INBOX') {
    items.push({ label: 'Renommer', icon: 'pencil', onClick: () => renameFolder(acc, f) });
    items.push({ label: 'Supprimer', icon: 'trash', danger: true, onClick: () => deleteFolder(acc, f) });
  }
  showMenu(e.clientX, e.clientY, items);
}

function reportSort(res) {
  const failed = res.failed || [];
  if (res.noRules) { toast('Vous n’avez aucune règle active : créez-en une (ou glissez un message dans un dossier).', { error: true }); return; }
  const base = res.moved
    ? `${res.moved} ${plural(res.moved, 'message rangé', 'messages rangés')} selon vos règles (${res.scanned} examinés).`
    : `Aucun message ne correspond à vos règles (${res.scanned} examinés).`;
  if (failed.length) {
    toast(`${base} Échec : ${failed.map((f) => `« ${f.folder} » (${f.message})`).join(' ; ')}`, { error: true, timeout: 12000 });
  } else toast(base);
}

async function applyRules(accountId, folder) {
  try {
    const res = await call(api.rules.applyToFolder(accountId, folder));
    reportSort(res);
    await loadFolders(accountId);
    if (['unified', 'favorites', accountId].includes(state.current.accountId)) loadMessages({ silent: true });
  } catch (err) { toast(err.message, { error: true }); }
}

// « Trier maintenant » : force l'application des règles, sans attendre l'arrivée d'un message
async function sortNow() {
  const { accountId, folder } = state.current;
  const btn = $('#btn-sortnow');
  btn.disabled = true;
  try {
    let res;
    if (accountId === 'unified' || accountId === 'favorites') res = await call(api.rules.applyAll());
    else res = await call(api.rules.applyToFolder(accountId, folder));
    reportSort(res);
    await Promise.all(state.accounts.map((a) => loadFolders(a.id)));
    await loadMessages({ silent: true });
  } catch (err) { toast(err.message, { error: true }); }
  finally { btn.disabled = false; }
}

const HEX_RE = /^#[0-9a-f]{6}$/;
function normalizeHex(v) {
  let x = String(v || '').trim().toLowerCase();
  if (!x.startsWith('#')) x = '#' + x;
  if (/^#[0-9a-f]{3}$/.test(x)) x = '#' + x[1] + x[1] + x[2] + x[2] + x[3] + x[3];
  return HEX_RE.test(x) ? x : '';
}

function openColorDialog(acc, f, special) {
  const current = folderColor(acc.id, f.path);
  const label = special ? SPECIAL_LABEL[f.specialUse] : f.name;
  const grid = h('div', { class: 'color-grid' });
  const mine = h('div', { class: 'color-grid' });
  const mineBox = h('div', { class: 'field' }, h('label', null, 'Mes couleurs'), mine);
  const picker = h('input', { type: 'color', value: current && HEX_RE.test(current) ? current : '#6366f1', 'aria-label': 'Choisir une couleur', class: 'color-input' });
  const hex = h('input', { type: 'text', value: current || '', placeholder: '#1e90ff', maxlength: '7', spellcheck: 'false', 'aria-label': 'Code couleur hexadécimal', class: 'hex-input' });
  const preview = h('span', { class: 'color-preview' });
  const apply = h('button', { class: 'primary' }, 'Utiliser cette couleur');
  const dlg = openDialog({
    title: `Couleur de « ${label} »`, subtitle: 'La couleur colore l’icône du dossier dans la barre latérale.',
    body: h('div', { style: 'display:grid;gap:16px' },
      h('div', { class: 'field' }, h('label', null, 'Couleurs proposées'), grid),
      mineBox,
      h('div', { class: 'field' }, h('label', null, 'Couleur personnalisée'),
        h('div', { class: 'custom-color' }, picker, hex, preview, apply),
        h('small', null, 'Choisissez avec le sélecteur, ou saisissez un code (ex. #1e90ff).'))),
    buttons: [{ label: 'Fermer', onClick: (d) => d.close() }],
  });
  const pick = async (c) => {
    try { await setFolderColor(acc.id, f.path, c); dlg.close(); } catch (err) { dlg.error(err.message); }
  };
  const dot = (c, cls = '') => h('button', { class: 'color-dot' + (c === current ? ' on' : '') + cls, vars: { '--c': c }, title: c, 'aria-label': 'Couleur ' + c, on: { click: () => pick(c) } });
  FOLDER_COLORS.forEach((c) => grid.appendChild(dot(c)));
  grid.appendChild(h('button', { class: 'color-dot none' + (!current ? ' on' : ''), title: 'Aucune couleur', on: { click: () => pick('') } }, 'Aucune'));

  const saved = [...(state.prefs.customColors || [])];
  if (current && HEX_RE.test(current) && !FOLDER_COLORS.includes(current) && !saved.includes(current)) saved.unshift(current);
  saved.forEach((c) => mine.appendChild(dot(c)));
  mineBox.hidden = !saved.length;

  const sync = (from) => {
    const v = normalizeHex(from === 'picker' ? picker.value : hex.value);
    preview.style.background = v || 'transparent';
    apply.disabled = !v;
    if (v && from === 'picker') hex.value = v;
    if (v && from === 'hex') picker.value = v;
  };
  picker.addEventListener('input', () => sync('picker'));
  hex.addEventListener('input', () => sync('hex'));
  hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply.click(); } });
  apply.addEventListener('click', async () => {
    const v = normalizeHex(hex.value || picker.value);
    if (!v) { dlg.error('Code couleur invalide : utilisez par exemple #1e90ff.'); return; }
    try {
      if (!FOLDER_COLORS.includes(v)) {
        const list = [v, ...(state.prefs.customColors || []).filter((x) => x !== v)].slice(0, 10);
        state.prefs = await call(api.prefs.set({ customColors: list }));
      }
      await setFolderColor(acc.id, f.path, v);
      dlg.close();
    } catch (err) { dlg.error(err.message); }
  });
  sync(hex.value ? 'hex' : 'picker');
  if (!hex.value) { hex.value = ''; apply.disabled = false; preview.style.background = picker.value; hex.value = picker.value; }
}

async function renameFolder(acc, f) {
  const name = await askText({ title: 'Renommer le dossier', label: 'Nouveau nom', value: f.name, confirm: 'Renommer' });
  if (!name || name === f.name) return;
  const idx = f.path.lastIndexOf(f.delimiter);
  const to = idx >= 0 ? f.path.slice(0, idx + 1) + name : name;
  try {
    await call(api.folders.rename(acc.id, f.path, to));
    // les règles qui visaient l'ancien chemin suivent le dossier
    for (const r of state.rules.filter((x) => x.accountId === acc.id && (x.folder === f.path || x.folder.startsWith(f.path + f.delimiter)))) {
      await call(api.rules.update({ ...r, folder: to + r.folder.slice(f.path.length) }));
    }
    state.rules = await call(api.rules.list());
    const colors = { ...(state.prefs.folderColors || {}) };
    let moved = false;
    for (const key of Object.keys(colors)) {
      const [aid, ...rest] = key.split('|');
      const fp = rest.join('|');
      if (aid === acc.id && (fp === f.path || fp.startsWith(f.path + f.delimiter))) {
        colors[`${aid}|${to}${fp.slice(f.path.length)}`] = colors[key];
        delete colors[key];
        moved = true;
      }
    }
    if (moved) state.prefs = await call(api.prefs.set({ folderColors: colors }));
    if (state.current.accountId === acc.id && state.current.folder === f.path) state.current.folder = to;
    await loadFolders(acc.id);
    toast(`Dossier renommé en « ${name} ».`);
  } catch (err) { toast(err.message, { error: true }); }
}

async function deleteFolder(acc, f) {
  const ok = await confirmDialog({
    title: `Supprimer « ${f.name} » ?`,
    body: 'Le dossier et les messages qu’il contient seront supprimés du serveur. Les règles de tri qui y mènent seront désactivées.',
    confirm: 'Supprimer le dossier', danger: true,
  });
  if (!ok) return;
  try {
    await call(api.folders.remove(acc.id, f.path));
    for (const r of state.rules.filter((x) => x.accountId === acc.id && x.folder === f.path)) {
      await call(api.rules.update({ ...r, enabled: false }));
    }
    state.rules = await call(api.rules.list());
    if (folderColor(acc.id, f.path)) await setFolderColor(acc.id, f.path, '');
    if (state.current.accountId === acc.id && state.current.folder === f.path) { await selectFolder(acc.id, 'INBOX'); }
    await loadFolders(acc.id);
    toast(`Dossier « ${f.name} » supprimé.`);
  } catch (err) { toast(err.message, { error: true }); }
}

function openMoveFolderDialog(acc, f) {
  const info = state.folders[acc.id];
  const folders = (info ? info.folders : []).filter((x) => x.selectable && x.path !== f.path && !x.path.startsWith(f.path + f.delimiter));
  const select = h('select', null,
    h('option', { value: '' }, '(Dossier racine)'),
    folders.map((x) => h('option', { value: x.path }, x.path))
  );
  const dlg = openDialog({
    title: `Déplacer « ${f.name} »`,
    subtitle: 'Choisissez le dossier parent de destination',
    body: h('div', { class: 'field' }, h('label', null, 'Dossier parent'), select),
    buttons: [
      { label: 'Annuler', onClick: (d) => d.close() },
      { label: 'Déplacer', kind: 'primary', onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          const parentPath = select.value;
          const delim = f.delimiter || '/';
          const newPath = parentPath ? parentPath + delim + f.name : f.name;
          await call(api.folders.rename(acc.id, f.path, newPath));
          d.close();
          await loadFolders(acc.id);
          if (state.current.accountId === acc.id && state.current.folder === f.path) {
            selectFolder(acc.id, newPath);
          } else {
            loadMessages({ silent: true });
          }
          toast('Dossier déplacé.');
        } catch (err) { btn.disabled = false; d.error(err.message); }
      }}
    ]
  });
}

function folderOptions(accountId, { includeNone, noneLabel } = {}) {
  const opts = [];
  if (includeNone) opts.push(h('option', { value: '' }, noneLabel || 'Aucun'));
  layoutFolders(accountId).filter((x) => x.folder.selectable).forEach(({ folder: f, special }) => {
    opts.push(h('option', { value: f.path }, special ? SPECIAL_LABEL[f.specialUse] : f.path.replace(new RegExp('\\' + f.delimiter, 'g'), ' / ')));
  });
  return opts;
}

function openNewFolderDialog(accountId, parentPath) {
  const info = state.folders[accountId];
  if (!info) { toast('Les dossiers de ce compte ne sont pas encore chargés.', { error: true }); return; }
  const nameInput = h('input', { type: 'text', placeholder: 'Factures, Voyages, Clients…', spellcheck: 'false' });
  const parentSel = h('select', null, folderOptions(accountId, { includeNone: true, noneLabel: 'Aucun (dossier principal)' }));
  parentSel.value = parentPath || '';
  const submit = async (d) => {
    const name = nameInput.value.trim();
    if (!name) { d.error('Saisissez un nom de dossier.'); return; }
    const parent = parentSel.value ? folderInfo(accountId, parentSel.value) : null;
    const delim = parent ? parent.delimiter : (info.folders[0] ? info.folders[0].delimiter : '/');
    if (name.includes(delim)) { d.error(`Le nom ne peut pas contenir « ${delim} ».`); return; }
    const path = parent ? parent.path + delim + name : info.prefix + name;
    d.buttons.Créer.disabled = true;
    try {
      await call(api.folders.create(accountId, path));
      await loadFolders(accountId);
      d.close();
      toast(`Dossier « ${name} » créé.`);
    } catch (err) {
      d.buttons.Créer.disabled = false;
      d.error(err.message);
    }
  };
  const dlg = openDialog({
    title: 'Nouveau dossier',
    subtitle: accountById(accountId).email,
    body: [
      h('div', { class: 'field' }, h('label', null, 'Nom'), nameInput),
      h('div', { class: 'field' }, h('label', null, 'Placer dans'), parentSel),
    ],
    buttons: [
      { label: 'Annuler', onClick: (d) => d.close() },
      { id: 'Créer', label: 'Créer', kind: 'primary', onClick: submit },
    ],
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(dlg); });
}

// ---------------------------------------------------------------- navigation

async function selectFolder(accountId, folder) {
  setView('mail');
  showTab('list');
  state.expanded = false;
  state.current = { accountId, folder };
  state.query = '';
  $('#search').value = '';
  state.sel.clear();
  state.opened = null;
  state.messages = [];
  renderSidebar();
  renderReader();
  updateTitle();
  await loadMessages();
}

function updateTitle() {
  const { accountId, folder } = state.current;
  $('#list-title').textContent = accountId === 'unified' ? 'Boîte unifiée' : accountId === 'favorites' ? 'Favoris' : folderLabel(accountId, folder);
  $('#btn-sortnow').hidden = accountId === 'favorites';
  $('#btn-sortnow').title = accountId === 'unified'
    ? 'Applique vos règles de tri à la boîte de réception de chaque compte'
    : 'Applique vos règles de tri aux messages déjà présents dans ce dossier';
}

// Une seule source de vérité : la classe du body décide quelle vue est visible.
// (Garder un drapeau séparé pour le panneau laissait l'écran d'accueil par-dessus la liste.)
function setView(view) {
  state.view = view;
  document.body.classList.toggle('view-mail', view === 'mail');
  document.body.classList.toggle('view-panel', view !== 'mail');
}

function showPanel(view) {
  setView(view);
  showTab('list');
  renderSidebar();
  if (view === 'rules') renderRulesPanel();
  else if (view === 'settings') renderSettingsPanel();
  else if (view === 'welcome') renderWelcome();
}

function showMail() {
  setView('mail');
  showTab('list');
  renderSidebar();
}

// ------------------------------------------------------------ disposition

const LAYOUTS = [
  { id: 'right', label: 'Lecture à côté de la liste', short: 'À côté de la liste', icon: 'layoutRight' },
  { id: 'bottom', label: 'Lecture sous la liste', short: 'Sous la liste', icon: 'layoutBottom' },
  { id: 'full', label: 'Lecture en plein écran', short: 'Plein écran', icon: 'layoutFull' },
];
const layoutPref = () => (LAYOUTS.some((l) => l.id === state.prefs.layout) ? state.prefs.layout : 'right');

// « Graphite » : thème gris / noir neutre (le thème sombre bleuté reste disponible)
function applyTheme() {
  document.documentElement.dataset.theme = state.prefs.theme === 'graphite' ? 'graphite' : '';
}

function applySizes() {
  const main = $('#main');
  if (state.prefs.listWidth) main.style.setProperty('--list-w', state.prefs.listWidth + 'px');
  else main.style.removeProperty('--list-w');
  if (state.prefs.listHeight) main.style.setProperty('--list-h', state.prefs.listHeight + 'px');
  else main.style.removeProperty('--list-h');
  if (state.prefs.listFromWidth) main.style.setProperty('--list-from-w', state.prefs.listFromWidth + 'px');
  else main.style.removeProperty('--list-from-w');
}

function applyLayout() {
  const pref = layoutPref();
  state.expanded = false;
  const reading = false; // le plein écran passe désormais par les onglets
  const mode = pref === 'full' || reading ? 'full' : pref;
  const rows = $('#list-rows');
  if (reading && !state.reading) state.listScroll = rows.scrollTop; // la liste va être masquée
  $('#main').className = `mode-${mode}` + (reading ? ' reading' : '');
  if (!reading && state.reading) rows.scrollTop = state.listScroll;
  state.reading = reading;
  $('#splitter').setAttribute('aria-orientation', mode === 'bottom' ? 'horizontal' : 'vertical');
  document.querySelectorAll('#layout-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === pref)));
}

async function setLayout(id) {
  try {
    state.prefs = await call(api.prefs.set({ layout: id }));
  } catch (err) { toast(err.message, { error: true }); return; }
  state.expanded = false;
  renderReader();
}

function closeReader() {
  state.opened = null;
  state.expanded = false;
  renderList();
  renderReader();
}

function renderLayoutSwitch() {
  const box = $('#layout-switch');
  clear(box);
  LAYOUTS.forEach((l) => box.appendChild(h('button', {
    title: l.label, 'aria-label': l.label, 'data-layout': l.id, 'aria-pressed': 'false',
    on: { click: () => setLayout(l.id) },
  }, ico(l.icon, 17))));
}

function initSidebarSplitter() {
  const handle = $('#sb-splitter');
  const root = document.documentElement;
  const MIN = 190, MAX = 480;
  const apply = (px) => root.style.setProperty('--sidebar-w', Math.round(Math.max(MIN, Math.min(MAX, px))) + 'px');
  const current = () => Math.round($('#sidebar').getBoundingClientRect().width);
  const save = debounce((v) => { api.prefs.set({ sidebarWidth: v }).then((r) => { if (r.ok) state.prefs = r.data; }); }, 300);
  window.applySidebarWidth = () => { if (state.prefs.sidebarWidth) apply(state.prefs.sidebarWidth); else root.style.removeProperty('--sidebar-w'); };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { /* sans importance */ }
    handle.classList.add('dragging');
    document.body.classList.add('resizing', 'col');
    const move = (ev) => apply(ev.clientX);
    const stop = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
      window.removeEventListener('mouseup', stop, true);
      window.removeEventListener('blur', stop);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing', 'col');
      save(current());
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', stop, true);
    window.addEventListener('mouseup', stop, true);
    window.addEventListener('blur', stop);
  });
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    apply(current() + (e.key === 'ArrowLeft' ? -step : step));
    save(current());
  });
  handle.addEventListener('dblclick', () => {
    root.style.removeProperty('--sidebar-w');
    api.prefs.set({ sidebarWidth: 0 }).then((r) => { if (r.ok) state.prefs = r.data; });
  });
}

function initSplitter() {
  const splitter = $('#splitter');
  const main = $('#main');
  const list = $('#list-pane');
  const isBottom = () => main.classList.contains('mode-bottom');
  const current = () => Math.round(isBottom() ? list.getBoundingClientRect().height : list.getBoundingClientRect().width);

  const saveSize = debounce((patch) => {
    api.prefs.set(patch).then((r) => { if (r.ok) state.prefs = r.data; });
  }, 300);

  function setSize(px, persist) {
    const bottom = isBottom();
    const box = main.getBoundingClientRect();
    const min = bottom ? 140 : 280;
    const max = Math.max(min, (bottom ? box.height : box.width) - (bottom ? 200 : 380));
    const value = Math.round(Math.max(min, Math.min(max, px)));
    main.style.setProperty(bottom ? '--list-h' : '--list-w', value + 'px');
    if (persist) saveSize(bottom ? { listHeight: value } : { listWidth: value });
  }

  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const bottom = isBottom();
    const start = list.getBoundingClientRect();
    try { splitter.setPointerCapture(e.pointerId); } catch { /* sans importance : les écouteurs sont sur window */ }
    splitter.classList.add('dragging');
    document.body.classList.add('resizing', bottom ? 'row' : 'col');
    const move = (ev) => setSize(bottom ? ev.clientY - start.top : ev.clientX - start.left, false);
    const stop = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
      window.removeEventListener('mouseup', stop, true);
      window.removeEventListener('blur', stop);
      splitter.classList.remove('dragging');
      document.body.classList.remove('resizing', 'row', 'col');
      setSize(current(), true);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', stop, true);
    window.addEventListener('mouseup', stop, true);
    window.addEventListener('blur', stop);
  });

  splitter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 24;
    const keys = isBottom() ? { ArrowUp: -step, ArrowDown: step } : { ArrowLeft: -step, ArrowRight: step };
    if (!(e.key in keys)) return;
    e.preventDefault();
    setSize(current() + keys[e.key], true);
  });

  splitter.addEventListener('dblclick', () => {
    const key = isBottom() ? 'listHeight' : 'listWidth';
    api.prefs.set({ [key]: 0 }).then((r) => { if (r.ok) { state.prefs = r.data; applySizes(); } });
  });
}

// Indication pendant un glisser-déposer
function showDragHint(count) {
  const hint = $('#drag-hint');
  const what = count > 1 ? `Ces ${count} messages seront rangés` : 'Le message sera rangé';
  hint.textContent = state.prefs.autoRuleOnDrop !== false
    ? `${what} dans le dossier choisi, et les prochains messages de cette adresse iront aussi dedans.`
    : `${what} dans le dossier choisi.`;
  hint.hidden = false;
}
function hideDragHint() { $('#drag-hint').hidden = true; }
document.addEventListener('dragend', hideDragHint);
document.addEventListener('drop', hideDragHint, true);

// ------------------------------------------------------------------ messages

async function loadMessages({ append = false, silent = false } = {}) {
  if (!state.accounts.length) return;
  const token = ++loadToken;
  const { accountId, folder } = state.current;
  if (!silent) { state.loading = true; state.error = ''; renderList(); }
  try {
    let messages = [];
    let total = 0;
    if (accountId === 'favorites') {
      const all = await call(api.messages.flagged());
      const q = state.query.toLowerCase();
      messages = q ? all.filter((m) => `${m.fromName} ${m.from} ${m.subject}`.toLowerCase().includes(q)) : all;
      total = messages.length;
    } else if (accountId === 'unified') {
      if (state.query) {
        const parts = await Promise.all(state.accounts.map(async (a) => {
          try {
            const r = await call(api.messages.search(a.id, 'INBOX', state.query));
            return r.messages.map((m) => ({ ...m, accountId: a.id, folder: 'INBOX' }));
          } catch (_) { return []; }
        }));
        messages = parts.flat();
      } else {
        const want = append ? state.messages.length + 60 : 60;
        const data = await call(api.messages.unified(want));
        messages = data.map((m) => ({ ...m, folder: 'INBOX' }));
        unifiedMore = data.length >= want; // il en reste probablement
      }
      total = messages.length + (unifiedMore && !state.query ? 1 : 0);
    } else if (state.query) {
      const r = await call(api.messages.search(accountId, folder, state.query));
      messages = r.messages.map((m) => ({ ...m, accountId, folder }));
      total = r.total;
    } else {
      const offset = append ? state.messages.length : 0;
      const r = await call(api.messages.list(accountId, folder, { limit: 50, offset }));
      messages = r.messages.map((m) => ({ ...m, accountId, folder }));
      total = r.total;
      if (append) messages = [...state.messages, ...messages];
    }
    if (token !== loadToken) return;
    state.messages = sortMessages(messages);
    state.total = total;
    state.error = '';
    // on garde uniquement les sélections qui existent encore
    const keys = new Set(messages.map(keyOf));
    state.sel = new Set([...state.sel].filter((k) => keys.has(k)));
  } catch (err) {
    if (token !== loadToken) return;
    state.error = err.message;
  } finally {
    if (token === loadToken) { state.loading = false; state.loadingMore = false; renderList(); }
    else if (append) state.loadingMore = false;
  }
}

// Défilement infini : les messages plus anciens se chargent seuls en approchant du bas de la liste
const canLoadMore = () => !state.query && !['favorites'].includes(state.current.accountId) && state.messages.length > 0 && state.messages.length < state.total;
function loadMoreIfNeeded() {
  if (state.loading || state.loadingMore || state.error || !canLoadMore() || state.view !== 'mail') return;
  const rows = $('#list-rows');
  if (rows.clientHeight === 0) return; // liste masquée (onglet ouvert, plein écran…)
  if (rows.scrollHeight - rows.scrollTop - rows.clientHeight > 400) return;
  state.loadingMore = true;
  renderList();
  loadMessages({ append: true, silent: true });
}

// ---- tri de la liste (date, correspondant, objet) ----
const SORTS = ['date', 'from', 'subject'];
const sortBy = () => (SORTS.includes(state.prefs.sortBy) ? state.prefs.sortBy : 'date');
const sortDir = () => (state.prefs.sortDir === 'asc' ? 'asc' : (state.prefs.sortDir === 'desc' || sortBy() === 'date' ? 'desc' : 'asc'));

// Dans Envoyés et Brouillons, le « correspondant » est le destinataire
function isOutgoing(m) {
  const f = folderInfo(m.accountId, m.folder);
  return !!f && (f.specialUse === '\\Sent' || f.specialUse === '\\Drafts');
}
function correspondentLabel(m) {
  if (isOutgoing(m)) {
    const list = String(m.to || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!list.length) return '(sans destinataire)';
    return 'À : ' + list[0] + (list.length > 1 ? ` +${list.length - 1}` : '');
  }
  const name = (m.fromName || '').trim();
  const email = (m.from || '').trim();
  if (name && email && name.toLowerCase() !== email.toLowerCase()) {
    return [name, h('small', { style: 'color:var(--ink-3);margin-left:6px;font-weight:normal;' }, `<${email}>`)];
  }
  return email || name || '(inconnu)';
}
const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
function sortMessages(list) {
  const by = sortBy();
  const dir = sortDir() === 'asc' ? 1 : -1;
  const keyOfMsg = (m) => by === 'from'
    ? (isOutgoing(m) ? String(m.to || '').split(',')[0] : (m.fromName || m.from || '')).trim()
    : by === 'subject' ? String(m.subject || '').replace(/^\s*((re|réf|tr|fwd?|fw)\s*:\s*)+/i, '').trim() : '';
  return list.map((m, i) => ({ m, i })).sort((a, b) => {
    let c = by === 'date' ? new Date(a.m.date) - new Date(b.m.date) : collator.compare(keyOfMsg(a.m), keyOfMsg(b.m));
    if (c === 0) c = new Date(b.m.date) - new Date(a.m.date) || a.i - b.i; // à égalité : le plus récent d'abord
    else c *= dir;
    return by === 'date' ? c : c;
  }).map((x) => x.m);
}
function renderSortRow() {
  $('#sort-by').value = sortBy();
  const asc = sortDir() === 'asc';
  const btn = $('#sort-dir');
  clear(btn);
  btn.appendChild(ico(asc ? 'up' : 'down', 16));
  const labels = { date: asc ? 'Du plus ancien au plus récent' : 'Du plus récent au plus ancien', from: asc ? 'A → Z' : 'Z → A', subject: asc ? 'A → Z' : 'Z → A' };
  btn.title = labels[sortBy()] + ' (cliquer pour inverser)';
  const partial = sortBy() !== 'date' && !state.query && !['unified', 'favorites'].includes(state.current.accountId) && state.messages.length < state.total;
  $('#sort-note').textContent = partial ? `parmi les ${state.messages.length} chargés` : '';
}
async function setSort(by, dir) {
  try { state.prefs = await call(api.prefs.set({ sortBy: by, sortDir: dir })); } catch (err) { toast(err.message, { error: true }); return; }
  state.messages = sortMessages(state.messages);
  renderList();
}

function renderList() {
  const rows = $('#list-rows');
  const top = rows.scrollTop;
  clear(rows);
  const unified = state.current.accountId === 'unified' || state.current.accountId === 'favorites';

  renderSortRow();
  renderSelectionBar();

  if (state.loading && !state.messages.length) {
    rows.appendChild(h('div', { class: 'loading' }, 'Chargement des messages…'));
    return;
  }
  if (state.error) {
    rows.appendChild(h('div', { class: 'empty' }, h('h2', null, 'Impossible de charger les messages'), h('p', null, state.error),
      h('button', { class: 'ghost', on: { click: () => loadMessages() } }, 'Réessayer')));
    return;
  }
  if (!state.messages.length) {
    rows.appendChild(h('div', { class: 'empty' },
      h('h2', null, state.query ? 'Aucun résultat' : state.current.accountId === 'favorites' ? 'Aucun favori' : 'Ce dossier est vide'),
      h('p', null, state.query ? `Aucun message ne contient « ${state.query} » dans l’expéditeur, le destinataire ou l’objet.` : state.current.accountId === 'favorites' ? 'Cliquez sur l’étoile d’un message pour le retrouver ici, quel que soit son dossier.' : 'Les nouveaux messages apparaîtront ici dès leur arrivée.')));
    return;
  }

  state.messages.forEach((m) => {
    const key = keyOf(m);
    const selected = state.sel.has(key);
    const row = h('div', {
      class: 'row' + (m.seen ? '' : ' unread') + (selected ? ' selected' : '') + (unified ? ' has-acc' : ''),
      draggable: 'true', role: 'option', 'aria-selected': selected ? 'true' : 'false',
      vars: { '--acc': accColor(m.accountId) },
      on: {
        click: (e) => onRowClick(e, m),
        dblclick: () => onRowDblClick(m),
        contextmenu: (e) => onRowContextMenu(e, m),
        auxclick: (e) => { if (e.button === 1) { e.preventDefault(); selectOnly(m); renderList(); openInTab(m); } },
        dragstart: (e) => onRowDrag(e, m, row),
        dragend: () => { row.classList.remove('dragging'); hideDragHint(); },
      },
    },
    h('div', { class: 'from' }, h('span', { class: 'dot' }), h('span', { class: 'who' }, correspondentLabel(m))),
    h('div', { class: 'date' }, fmtDate(m.date)),
    h('div', { class: 'subject' }, m.subject),
    h('div', { class: 'marks' },
      m.hasAttachment ? h('span', { title: 'Pièce jointe' }, ico('clip', 15)) : null,
      h('button', {
        class: 'icon-btn star-btn' + (m.flagged ? ' on' : ''), title: m.flagged ? 'Retirer des favoris' : 'Ajouter aux favoris', 'aria-label': m.flagged ? 'Retirer des favoris' : 'Ajouter aux favoris',
        style: m.flagged ? '--star-fill: currentColor' : '',
        on: { click: (e) => { e.stopPropagation(); toggleFlag(m); } },
      }, ico('star', 16))),
    unified ? h('div', { class: 'acc-tag' }, h('i'), (accountById(m.accountId) || {}).name || '') : null);
    rows.appendChild(row);
  });

  if (canLoadMore()) {
    rows.appendChild(h('div', { class: 'more-row', role: 'status' }, state.loadingMore ? 'Chargement des messages plus anciens…' : 'Faites défiler pour charger les messages plus anciens'));
  }
  rows.scrollTop = top;
  requestAnimationFrame(loadMoreIfNeeded); // la liste ne remplit pas l'écran : on continue
}

function renderSelectionBar() {
  const bar = $('#selection-bar');
  const sel = selectedMessages();
  if (sel.length < 2) { bar.hidden = true; return; }
  bar.hidden = false;
  clear(bar);
  const anyUnread = sel.some((m) => !m.seen);
  bar.append(
    h('span', { class: 'sel-count' }, `${sel.length} sélectionnés`),
    h('button', { class: 'subtle', on: { click: () => openFilePicker(sel) } }, ico('folder', 16), 'Ranger…'),
    h('button', { class: 'subtle', on: { click: () => setSeen(sel, anyUnread) } }, ico('mailopen', 16), anyUnread ? 'Lu' : 'Non lu'),
    h('button', { class: 'subtle', on: { click: () => deleteMessages(sel) } }, ico('trash', 16), 'Supprimer'),
    h('button', { class: 'icon-btn', title: 'Annuler la sélection', 'aria-label': 'Annuler la sélection', on: { click: () => { state.sel.clear(); renderList(); } } }, ico('close', 16))
  );
}

const selectedMessages = () => state.messages.filter((m) => state.sel.has(keyOf(m)));

let lastClickTime = 0;
let lastClickKey = null;

function onRowClick(e, m) {
  const key = keyOf(m);
  const now = Date.now();
  if (e.detail === 2 || (lastClickKey === key && now - lastClickTime < 500)) {
    lastClickTime = 0;
    lastClickKey = null;
    onRowDblClick(m);
    return;
  }
  lastClickTime = now;
  lastClickKey = key;

  if (e.metaKey || e.ctrlKey) {
    if (state.sel.has(key)) state.sel.delete(key); else state.sel.add(key);
    state.anchor = key;
    renderList();
    return;
  }
  if (e.shiftKey && state.anchor) {
    const keys = state.messages.map(keyOf);
    const a = keys.indexOf(state.anchor);
    const b = keys.indexOf(key);
    if (a >= 0 && b >= 0) {
      state.sel = new Set(keys.slice(Math.min(a, b), Math.max(a, b) + 1));
      renderList();
      return;
    }
  }
  selectOnly(m);
  // Mode « plein écran » : un simple clic sélectionne seulement, c'est le double-clic qui ouvre.
  if (layoutPref() === 'full') { renderList(); return; }
  // même message déjà ouvert (premier clic d'un double-clic) : on ne recharge pas
  if (state.opened && keyOf(state.opened.msg) === key && !state.opened.error) { renderList(); return; }
  openMessage(m);
}

// Double-clic (ou Entrée, clic molette) : le message s'ouvre dans un onglet, quelle que soit la disposition
function onRowDblClick(m) {
  selectOnly(m);
  renderList();
  openInTab(m);
}

function onRowContextMenu(e, m) {
  e.preventDefault();
  const key = keyOf(m);
  if (!state.sel.has(key)) {
    selectOnly(m);
    renderList();
  }
  const sel = selectedMessages();
  const isMultiple = sel.length > 1;
  const anyUnread = sel.some((x) => !x.seen);
  const anyUnflagged = sel.some((x) => !x.flagged);

  const items = [
    {
      label: isMultiple ? `Ouvrir les ${sel.length} messages` : 'Ouvrir',
      icon: 'mailopen',
      onClick: () => {
        if (!isMultiple) {
          if (layoutPref() === 'full') openInTab(m);
          else openMessage(m);
        } else {
          sel.slice(0, 5).forEach((x) => openInTab(x));
        }
      },
    },
    {
      label: 'Ouvrir dans un nouvel onglet',
      icon: 'layoutFull',
      shortcut: 'Double-clic',
      onClick: () => {
        sel.forEach((x) => openInTab(x));
      },
    },
    { separator: true },
    {
      label: anyUnread ? 'Marquer comme lu' : 'Marquer comme non lu',
      icon: anyUnread ? 'mailopen' : 'mail',
      shortcut: 'U',
      onClick: () => setSeen(sel, anyUnread),
    },
    {
      label: anyUnflagged ? 'Ajouter aux favoris' : 'Retirer des favoris',
      icon: 'star',
      shortcut: 'S',
      onClick: () => {
        sel.forEach((x) => {
          if (!!x.flagged !== anyUnflagged) toggleFlag(x);
        });
      },
    },
    { separator: true },
    ...(!isMultiple ? [
      {
        label: 'Répondre',
        icon: 'reply',
        shortcut: 'R',
        onClick: async () => {
          try {
            const detail = (state.opened && keyOf(state.opened.msg) === key && state.opened.detail)
              ? state.opened.detail
              : await call(api.messages.get(m.accountId, m.folder, m.uid));
            replyTo({ msg: m, detail });
          } catch (err) {
            toast(err.message, { error: true });
          }
        },
      },
      {
        label: 'Transférer',
        icon: 'forward',
        onClick: async () => {
          try {
            const detail = (state.opened && keyOf(state.opened.msg) === key && state.opened.detail)
              ? state.opened.detail
              : await call(api.messages.get(m.accountId, m.folder, m.uid));
            forward({ msg: m, detail });
          } catch (err) {
            toast(err.message, { error: true });
          }
        },
      },
      { separator: true },
    ] : []),
    {
      label: 'Ranger dans un dossier…',
      icon: 'folder',
      shortcut: 'M',
      onClick: () => openFilePicker(sel),
    },
    ...(!isMultiple ? [
      {
        label: `Toujours ranger « ${m.from} »…`,
        icon: 'rules',
        onClick: () => openFilePicker(sel, { from: m.from, offerRule: true }),
      },
    ] : []),
    { separator: true },
    {
      label: isMultiple ? `Supprimer les ${sel.length} messages` : 'Supprimer',
      icon: 'trash',
      shortcut: 'Suppr',
      danger: true,
      onClick: () => deleteMessages(sel),
    },
  ];

  showMenu(e.clientX, e.clientY, items);
}

function selectOnly(m) {
  state.sel = new Set([keyOf(m)]);
  state.anchor = keyOf(m);
}

function onRowDrag(e, m, row) {
  const key = keyOf(m);
  if (!state.sel.has(key)) selectOnly(m);
  const keys = [...state.sel];
  e.dataTransfer.setData('application/x-mailhub', JSON.stringify(keys));
  e.dataTransfer.effectAllowed = 'move';
  row.classList.add('dragging');
  showDragHint(keys.length);
}

function handleDrop(e, accountId, path) {
  let keys;
  try { keys = JSON.parse(e.dataTransfer.getData('application/x-mailhub')); } catch (_) { return; }
  const set = new Set(keys);
  const msgs = state.messages.filter((m) => set.has(keyOf(m)));
  if (!msgs.length) return;
  hideDragHint();
  if (msgs.some((m) => m.accountId !== accountId)) {
    toast('Un message ne peut être rangé que dans un dossier du même compte.', { error: true });
    return;
  }
  fileMessages(msgs, accountId, path, { offerRule: true, drop: true });
}

async function toggleFlag(m) {
  const on = !m.flagged;
  m.flagged = on;
  renderList();
  try {
    await call(api.messages.flag(m.accountId, m.folder, [m.uid], 'flagged', on));
    if (!on && state.current.accountId === 'favorites') { state.messages = state.messages.filter((x) => x !== m); state.sel.delete(keyOf(m)); renderList(); }
  } catch (err) { m.flagged = !on; renderList(); toast(err.message, { error: true }); }
}

function groupByFolder(msgs) {
  const groups = new Map();
  msgs.forEach((m) => {
    const k = m.accountId + '|' + m.folder;
    if (!groups.has(k)) groups.set(k, { accountId: m.accountId, folder: m.folder, uids: [] });
    groups.get(k).uids.push(m.uid);
  });
  return [...groups.values()];
}

async function setSeen(msgs, seen) {
  try {
    for (const g of groupByFolder(msgs)) await call(api.messages.flag(g.accountId, g.folder, g.uids, 'seen', seen));
    msgs.forEach((m) => {
      if (m.seen !== seen) {
        const f = folderInfo(m.accountId, m.folder);
        if (f) f.unseen = Math.max(0, f.unseen + (seen ? -1 : 1));
      }
      m.seen = seen;
    });
    renderList();
    renderSidebar();
  } catch (err) { toast(err.message, { error: true }); }
}

// retire les messages de la liste et ouvre le suivant (tri en continu)
function afterRemoved(msgs) {
  const keys = new Set(msgs.map(keyOf));
  const openedKey = state.opened ? keyOf(state.opened.msg) : null;
  const firstIdx = state.messages.findIndex((m) => keys.has(keyOf(m)));
  state.messages = state.messages.filter((m) => !keys.has(keyOf(m)));
  state.total = Math.max(0, state.total - msgs.length);
  keys.forEach((k) => state.sel.delete(k));
  [...state.tabs].filter((t) => keys.has(keyOf(t.msg))).forEach((t) => closeTab(t.id));
  if (openedKey && keys.has(openedKey)) {
    const next = state.messages[Math.min(firstIdx, state.messages.length - 1)];
    if (next && layoutPref() !== 'full') { selectOnly(next); openMessage(next); }
    else { state.opened = null; state.expanded = false; }
  }
  renderList();
  renderReader();
}

function pushRecent(accountId, path) {
  try {
    const k = 'recent:' + accountId;
    const list = JSON.parse(localStorage.getItem(k) || '[]').filter((p) => p !== path);
    list.unshift(path);
    localStorage.setItem(k, JSON.stringify(list.slice(0, 8)));
  } catch (_) { /* ignore */ }
}
function recentFolders(accountId) {
  try { return JSON.parse(localStorage.getItem('recent:' + accountId) || '[]'); } catch (_) { return []; }
}

function ruleFor(accountId, from, dest) {
  return state.rules.find((r) => r.accountId === accountId && r.enabled !== false && (!dest || r.folder === dest) &&
    r.conditions.some((c) => (c.field === 'from' && String(from).toLowerCase().includes(String(c.value).toLowerCase())) ||
      (c.field === 'domain' && domainOf(from) === String(c.value).toLowerCase())));
}

const NO_AUTO_RULE = new Set(['\\Trash', '\\Drafts', '\\Sent', '\\Inbox']);

// Pas de règle automatique vers la corbeille, les brouillons, les envoyés ou la boîte de réception :
// « toujours jeter ce expéditeur » ne doit jamais se décider par un simple glisser.
function autoRuleAllowed(accountId, dest) {
  if (dest.toUpperCase() === 'INBOX') return false;
  const f = folderInfo(accountId, dest);
  return !(f && NO_AUTO_RULE.has(f.specialUse));
}

async function undoAutoRules(results, accountId) {
  try {
    for (const r of results) {
      if (!r.rule) continue;
      if (r.created) await call(api.rules.remove(r.rule.id));
      else await call(api.rules.update({ ...r.rule, folder: r.previousFolder, enabled: r.previousEnabled !== false }));
    }
    state.rules = await call(api.rules.list());
    if (state.view === 'rules') renderRulesPanel();
    toast(results.length > 1 ? 'Règles annulées. Les messages déjà rangés restent à leur place.' : 'Règle annulée. Le message déjà rangé reste à sa place.');
  } catch (err) { toast(err.message, { error: true }); }
}

function announceAutoRules(results, { accountId, dest, origin, base }) {
  const label = folderLabel(accountId, dest);
  const created = results.filter((r) => r.rule && r.created);
  const updated = results.filter((r) => r.rule && !r.created && (r.previousFolder !== dest || r.previousEnabled === false));
  const changed = [...created, ...updated];
  if (!changed.length) {
    toast(results.length === 1 ? `${base} Cette adresse était déjà rangée ici automatiquement.` : base);
    return;
  }
  const actions = [{ label: changed.length > 1 ? 'Annuler les règles' : 'Annuler la règle', onClick: () => undoAutoRules(changed, accountId) }];
  let text;
  if (changed.length === 1) {
    const r = changed[0];
    text = r.created
      ? `${base} Les prochains messages de ${r.from} iront aussi dedans.`
      : `${base} Règle mise à jour : ${r.from} ira désormais dans « ${label} » (avant : « ${folderLabel(accountId, r.previousFolder)} »).`;
    actions.push({
      label: 'Ranger aussi les anciens',
      onClick: async () => {
        try {
          const res = await call(api.rules.sortSender({ accountId, folder: origin, uids: [], from: r.from, dest, createRule: false, scope: 'address', moveExisting: true }));
          toast(res.moved ? `${res.moved} ${plural(res.moved, 'ancien message rangé', 'anciens messages rangés')} dans « ${label} ».` : `Aucun autre message de ${r.from} dans ce dossier.`);
          loadFolders(accountId);
          if (res.moved) loadMessages({ silent: true });
        } catch (err) { toast(err.message, { error: true }); }
      },
    });
  } else {
    text = `${base} ${changed.length} règles de tri enregistrées pour ces adresses.`;
  }
  toast(text, { actions, timeout: 14000 });
}

async function fileMessages(msgs, accountId, dest, { offerRule, drop } = {}) {
  const movable = msgs.filter((m) => m.folder !== dest);
  if (!movable.length) return;
  const origin = movable[0].folder;
  try {
    for (const g of groupByFolder(movable)) await call(api.messages.move(g.accountId, g.folder, g.uids, dest));
  } catch (err) { toast(err.message, { error: true }); return; }

  pushRecent(accountId, dest);
  afterRemoved(movable);
  loadFolders(accountId);

  // glisser-déposer : la règle « cette adresse -> ce dossier » se crée toute seule
  if (drop && state.prefs.autoRuleOnDrop !== false && autoRuleAllowed(accountId, dest)) {
    const base = `${movable.length} ${plural(movable.length, 'message rangé', 'messages rangés')} dans « ${folderLabel(accountId, dest)} ».`;
    try {
      const results = await call(api.rules.autoSender({ accountId, senders: movable.map((m) => m.from), folder: dest }));
      state.rules = await call(api.rules.list());
      if (state.view === 'rules') renderRulesPanel();
      announceAutoRules(results, { accountId, dest, origin, base });
    } catch (err) {
      toast(`${base} La règle de tri n’a pas pu être créée : ${err.message}`, { error: true });
    }
    return;
  }

  const senders = new Set(movable.map((m) => m.from));
  const from = movable[0].from;
  const actions = [];
  if (offerRule && senders.size === 1 && from && !ruleFor(accountId, from, dest)) {
    const origin = movable[0].folder;
    actions.push({ label: 'Toujours ranger ici', onClick: () => openAutoRuleDialog({ accountId, from, origin, dest }) });
  }
  toast(`${movable.length} ${plural(movable.length, 'message rangé', 'messages rangés')} dans « ${folderLabel(accountId, dest)} ».`, { actions });
}

async function deleteMessages(msgs) {
  if (!msgs.length) return;
  const inTrash = msgs.every((m) => { const f = folderInfo(m.accountId, m.folder); return f && f.specialUse === '\\Trash'; });
  if (inTrash) {
    const ok = await confirmDialog({
      title: 'Supprimer définitivement ?',
      body: `${msgs.length} ${plural(msgs.length, 'message sera supprimé', 'messages seront supprimés')} sans possibilité de retour.`,
      confirm: 'Supprimer', danger: true,
    });
    if (!ok) return;
  }
  try {
    for (const g of groupByFolder(msgs)) await call(api.messages.remove(g.accountId, g.folder, g.uids));
  } catch (err) { toast(err.message, { error: true }); return; }
  const accs = new Set(msgs.map((m) => m.accountId));
  afterRemoved(msgs);
  accs.forEach((id) => loadFolders(id));
  toast(inTrash ? 'Message supprimé.' : `${msgs.length} ${plural(msgs.length, 'message déplacé', 'messages déplacés')} dans la corbeille.`);
}

// ---------------------------------------------------------- règle automatique

function openAutoRuleDialog({ accountId, from, origin, dest }) {
  const domain = domainOf(from);
  const scopeAddr = h('input', { type: 'radio', name: 'scope', value: 'address', checked: true });
  const scopeDom = h('input', { type: 'radio', name: 'scope', value: 'domain' });
  const existing = h('input', { type: 'checkbox', checked: true });
  openDialog({
    title: 'Ranger automatiquement',
    subtitle: `Les prochains messages iront dans « ${folderLabel(accountId, dest)} » dès leur arrivée.`,
    body: [
      h('div', { class: 'field' },
        h('span', { class: 'label' }, 'Quels messages ?'),
        h('label', { class: 'check' }, scopeAddr, h('span', null, 'Ceux de ', h('b', null, from))),
        h('label', { class: 'check' }, scopeDom, h('span', null, 'Tous ceux de ', h('b', null, '@' + domain)))),
      h('label', { class: 'check' }, existing, h('span', null, `Ranger aussi les messages déjà présents dans « ${folderLabel(accountId, origin)} »`)),
    ],
    buttons: [
      { label: 'Plus tard', onClick: (d) => d.close() },
      {
        id: 'ok', label: 'Créer la règle', kind: 'primary',
        onClick: async (d, btn) => {
          btn.disabled = true;
          try {
            const res = await call(api.rules.sortSender({
              accountId, folder: origin, uids: [], from, dest, createRule: true,
              scope: scopeDom.checked ? 'domain' : 'address', moveExisting: existing.checked,
            }));
            state.rules = await call(api.rules.list());
            d.close();
            toast(res.moved ? `Règle créée, ${res.moved} ${plural(res.moved, 'message rangé', 'messages rangés')} en plus.` : 'Règle créée. Les prochains messages seront rangés automatiquement.');
            loadFolders(accountId);
            if (res.moved) loadMessages({ silent: true });
          } catch (err) { btn.disabled = false; d.error(err.message); }
        },
      },
    ],
  });
}

// ------------------------------------------------------------ sélecteur de dossier

function openFilePicker(msgs) {
  const accountId = msgs[0].accountId;
  if (msgs.some((m) => m.accountId !== accountId || m.folder !== msgs[0].folder)) {
    toast('Sélectionnez des messages d’un seul compte et d’un seul dossier.', { error: true });
    return;
  }
  const info = state.folders[accountId];
  if (!info) { toast('Les dossiers de ce compte ne sont pas encore chargés.', { error: true }); return; }

  const origin = msgs[0].folder;
  const senders = new Set(msgs.map((m) => m.from));
  const from = senders.size === 1 ? msgs[0].from : '';
  let chosen = null;
  let query = '';

  const search = h('input', { type: 'search', placeholder: 'Chercher ou créer un dossier', spellcheck: 'false' });
  const list = h('div', { class: 'picker-list', role: 'listbox' });
  const confirmBtnLabel = `Ranger ${msgs.length > 1 ? msgs.length + ' messages' : 'le message'}`;

  const ruleCheck = h('input', { type: 'checkbox', checked: !!from });
  const scopeSel = h('select', null, h('option', { value: 'address' }, from ? `Cette adresse (${from})` : 'Cette adresse'), h('option', { value: 'domain' }, from ? `Tout le domaine (@${domainOf(from)})` : 'Tout le domaine'));
  const existingCheck = h('input', { type: 'checkbox', checked: true });
  const ruleBox = h('div', { class: 'field' },
    h('label', { class: 'check' }, ruleCheck, h('span', null, 'Toujours ranger les prochains messages de cet expéditeur dans ce dossier')),
    h('div', { class: 'rule-opts', style: 'display:grid;gap:8px;margin-left:24px' }, scopeSel,
      h('label', { class: 'check' }, existingCheck, h('span', null, 'Ranger aussi ceux déjà reçus'))));
  const syncRuleBox = () => { $('.rule-opts', ruleBox).style.display = ruleCheck.checked ? 'grid' : 'none'; };
  ruleCheck.addEventListener('change', syncRuleBox);
  syncRuleBox();

  const dlg = openDialog({
    title: msgs.length > 1 ? `Ranger ${msgs.length} messages` : 'Ranger le message',
    subtitle: from ? `De ${from}` : undefined,
    body: [h('div', { class: 'field' }, h('label', null, 'Dossier'), search, list), from ? ruleBox : null],
    buttons: [
      { label: 'Annuler', onClick: (d) => d.close() },
      { id: 'ok', label: confirmBtnLabel, kind: 'primary', onClick: (d, btn) => submit(d, btn) },
    ],
  });
  dlg.buttons.ok.disabled = true;

  function renderItems() {
    clear(list);
    const q = query.trim().toLowerCase();
    const items = layoutFolders(accountId).filter(({ folder: f }) => f.selectable && f.path !== origin);
    const shown = items.filter(({ folder: f, special }) => !q || (special ? SPECIAL_LABEL[f.specialUse] : f.path).toLowerCase().includes(q));
    const exact = items.some(({ folder: f }) => f.name.toLowerCase() === q);
    if (q && !exact) {
      list.appendChild(h('button', { class: 'picker-item', on: { click: () => createAndChoose(query.trim()) } },
        ico('plus', 16), h('span', null, 'Créer le dossier « ' + query.trim() + ' »')));
    }
    shown.forEach(({ folder: f, special }) => {
      list.appendChild(h('button', {
        class: 'picker-item' + (chosen === f.path ? ' on' : ''), role: 'option', 'aria-selected': chosen === f.path ? 'true' : 'false',
        on: { click: () => { chosen = f.path; dlg.buttons.ok.disabled = false; renderItems(); }, dblclick: () => submit(dlg, dlg.buttons.ok) },
      }, ico(special ? SPECIAL_ICON[f.specialUse] : 'folder', 16), h('span', null, special ? SPECIAL_LABEL[f.specialUse] : f.name),
      !special && f.path !== f.name ? h('span', { class: 'path' }, f.path) : null));
    });
    if (!list.firstChild) list.appendChild(h('div', { class: 'loading', style: 'padding:14px' }, 'Aucun dossier.'));
  }

  async function createAndChoose(name) {
    const delim = info.folders[0] ? info.folders[0].delimiter : '/';
    if (name.includes(delim)) { dlg.error(`Le nom ne peut pas contenir « ${delim} ».`); return; }
    try {
      const res = await call(api.folders.create(accountId, info.prefix + name));
      await loadFolders(accountId);
      chosen = res.path;
      dlg.buttons.ok.disabled = false;
      query = '';
      search.value = '';
      dlg.error('');
      renderItems();
    } catch (err) { dlg.error(err.message); }
  }

  async function submit(d, btn) {
    if (!chosen) return;
    btn.disabled = true;
    try {
      const wantRule = !!from && ruleCheck.checked;
      const res = await call(api.rules.sortSender({
        accountId, folder: origin, uids: msgs.map((m) => m.uid), from, dest: chosen,
        createRule: wantRule, scope: scopeSel.value, moveExisting: wantRule && existingCheck.checked,
      }));
      d.close();
      pushRecent(accountId, chosen);
      afterRemoved(msgs);
      if (res.rule) state.rules = await call(api.rules.list());
      loadFolders(accountId);
      if (res.moved > msgs.length) loadMessages({ silent: true });
      toast(wantRule
        ? `Rangé dans « ${folderLabel(accountId, chosen)} ». Les prochains messages seront rangés automatiquement.`
        : `${msgs.length} ${plural(msgs.length, 'message rangé', 'messages rangés')} dans « ${folderLabel(accountId, chosen)} ».`);
    } catch (err) { btn.disabled = false; d.error(err.message); }
  }

  search.addEventListener('input', () => { query = search.value; renderItems(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = $('.picker-item', list);
      if (first) first.click();
    }
  });
  renderItems();
  search.focus();
}

// -------------------------------------------------------------------- lecture

const newOpened = (m) => ({ msg: m, detail: null, loading: true, error: '', allowRemote: state.prefs.remoteContent === 'always' });

// Charge le contenu d'un message ouvert (volet de lecture ou onglet) ; renvoie false s'il a été abandonné entre-temps.
async function loadDetail(o, stillWanted) {
  const m = o.msg;
  try {
    const detail = await call(api.messages.get(m.accountId, m.folder, m.uid));
    if (!stillWanted()) return false;
    o.detail = detail;
    o.loading = false;
    if (!m.seen) {
      m.seen = true;
      const f = folderInfo(m.accountId, m.folder);
      if (f) f.unseen = Math.max(0, f.unseen - 1);
      renderSidebar();
      renderList();
    }
  } catch (err) {
    if (!stillWanted()) return false;
    o.loading = false;
    o.error = err.message;
  }
  return true;
}

async function openMessage(m) {
  state.opened = newOpened(m);
  renderList();
  renderReader();
  const mine = state.opened;
  if (await loadDetail(mine, () => state.opened === mine)) renderReader();
}

// ------------------------------------------------------------------- onglets
// L'onglet « Messages » (liste, règles, réglages) est toujours là ; les messages ouverts en grand
// et les pièces jointes ouvrent chacun un onglet que l'on ferme avec sa croix (ou Ctrl/Cmd+W, clic molette).

const MAX_TABS = 20;
let tabSeq = 0;
const activeTabObj = () => state.tabs.find((t) => t.id === state.tab) || null;

function releaseTab(t) { if (t && t.blobUrl) { try { URL.revokeObjectURL(t.blobUrl); } catch (_) { /* ignore */ } t.blobUrl = null; } }

function showTab(id) {
  state.tab = state.tabs.some((t) => t.id === id) ? id : 'list';
  document.body.classList.toggle('tab-view', state.tab !== 'list');
  renderTabs();
  renderTabContent();
}

function closeTab(id) {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  releaseTab(state.tabs[i]);
  state.tabs.splice(i, 1);
  if (state.tab === id) {
    const next = state.tabs[Math.min(i, state.tabs.length - 1)];
    showTab(next ? next.id : 'list');
  } else renderTabs();
}

function closeActiveTab() { if (state.tab !== 'list') closeTab(state.tab); }

function openTab(tab) {
  const same = state.tabs.find((t) => t.key === tab.key);
  if (same) { showTab(same.id); return same; }
  if (state.tabs.length >= MAX_TABS) { toast(`${MAX_TABS} onglets au maximum : fermez-en un avant d’en ouvrir un autre.`, { error: true }); return null; }
  tab.id = 't' + (++tabSeq);
  state.tabs.push(tab);
  showTab(tab.id);
  return tab;
}

async function openInTab(m) {
  const tab = openTab({ key: 'm|' + keyOf(m), kind: 'mail', msg: m, o: newOpened(m) });
  if (!tab || tab.loaded) return;
  tab.loaded = true;
  const ok = await loadDetail(tab.o, () => state.tabs.includes(tab));
  if (ok && state.tab === tab.id) renderTabContent();
  else if (ok) renderTabs();
}

async function openAttachmentTab(m, a) {
  const tab = openTab({ key: 'a|' + keyOf(m) + '|' + a.index, kind: 'att', msg: m, att: a, data: null, loading: true, error: '' });
  if (!tab || tab.loaded) return;
  tab.loaded = true;
  try {
    tab.data = await call(api.messages.attachmentData(m.accountId, m.folder, m.uid, a.index));
    if (tab.data.kind === 'pdf') {
      const bytes = Uint8Array.from(atob(tab.data.base64), (c) => c.charCodeAt(0));
      tab.blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      tab.data.base64 = '';
    }
  } catch (err) { tab.error = err.message; }
  tab.loading = false;
  if (!state.tabs.includes(tab)) { releaseTab(tab); return; }
  if (state.tab === tab.id) renderTabContent();
}

function tabTitle(t) {
  if (t.kind === 'att') return t.att.filename;
  return (t.o.detail && t.o.detail.subject) || t.msg.subject || 'Message';
}

function renderTabs() {
  const bar = $('#tabbar');
  clear(bar);
  const any = state.tabs.length > 0;
  bar.hidden = !any;
  document.body.classList.toggle('has-tabs', any);
  if (!any) return;
  const tabEl = (id, icon, title, closable) => {
    const el = h('div', {
      class: 'tab-item' + (state.tab === id ? ' active' : ''), role: 'tab', 'aria-selected': String(state.tab === id), tabindex: '0', title,
      on: {
        click: () => showTab(id),
        auxclick: (e) => { if (e.button === 1 && closable) { e.preventDefault(); closeTab(id); } },
        mousedown: (e) => { if (e.button === 1) e.preventDefault(); },
        keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showTab(id); } },
      },
    }, ico(icon, 15), h('span', { class: 'tab-title' }, title));
    if (closable) {
      el.appendChild(h('button', { class: 'tab-close', title: 'Fermer l’onglet', 'aria-label': 'Fermer l’onglet ' + title, tabindex: '-1', on: { click: (e) => { e.stopPropagation(); closeTab(id); } } }, ico('close', 13)));
    }
    return el;
  };
  bar.appendChild(tabEl('list', 'inbox', 'Messages', false));
  state.tabs.forEach((t) => bar.appendChild(tabEl(t.id, t.kind === 'att' ? 'clip' : 'mail', tabTitle(t), true)));
}

function cycleTab(delta) {
  const ids = ['list', ...state.tabs.map((t) => t.id)];
  const i = ids.indexOf(state.tab);
  showTab(ids[(i + delta + ids.length) % ids.length]);
}

function renderTabContent() {
  const view = $('#tabview');
  clear(view);
  const t = activeTabObj();
  if (!t) return;
  try {
    if (t.kind === 'mail') renderMailInto(view, t.o, () => { renderTabContent(); });
    else renderAttachmentInto(view, t);
  } catch (err) {
    console.error(err);
    view.appendChild(h('div', { class: 'empty' }, h('h2', null, 'Affichage impossible'), h('p', null, err.message || String(err))));
  }
}

const BLOCKED_OPEN = /\.(exe|bat|cmd|com|scr|msi|msp|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|sh|command|app|jar|dmg|pkg|lnk|hta|reg|cpl|scf|pif|gadget|appimage|deb|rpm|apk|url|iso)$/i;

function renderAttachmentInto(view, t) {
  const a = t.att;
  const m = t.msg;
  const bar = h('div', { class: 'att-head' },
    h('div', { class: 'att-title' }, ico('clip', 18), h('div', null, h('h2', null, a.filename), h('small', null, `${fmtSize(a.size)}${a.contentType ? ' · ' + a.contentType : ''} · pièce jointe de « ${m.subject} »`))),
    h('div', { class: 'att-actions' },
      h('button', { class: 'ghost', on: { click: () => openInTab(m) } }, ico('mail', 16), 'Voir le message'),
      h('button', { class: 'ghost', on: { click: () => saveAttachment(m, a) } }, ico('download', 16), 'Enregistrer…'),
      BLOCKED_OPEN.test(a.filename) ? null : h('button', { class: 'ghost', title: 'L’ouvre avec l’application associée à ce type de fichier', on: { click: async () => {
        try { await call(api.messages.openAttachment(m.accountId, m.folder, m.uid, a.index)); } catch (err) { toast(err.message, { error: true }); }
      } } }, 'Ouvrir avec l’application')));
  view.appendChild(bar);
  const body = h('div', { class: 'att-body' });
  view.appendChild(body);
  if (t.loading) { body.appendChild(h('div', { class: 'loading' }, 'Chargement de la pièce jointe…')); return; }
  if (t.error) { body.appendChild(h('div', { class: 'empty' }, h('h2', null, 'Pièce jointe illisible'), h('p', null, t.error))); return; }
  const d = t.data;
  if (d.kind === 'image') {
    const img = h('img', { src: d.dataUrl, alt: a.filename, class: 'att-img fit', title: 'Cliquer pour afficher en taille réelle' });
    img.addEventListener('click', () => img.classList.toggle('fit'));
    body.appendChild(h('div', { class: 'att-imgwrap' }, img));
  } else if (d.kind === 'pdf' && t.blobUrl) {
    body.appendChild(h('iframe', { class: 'att-pdf', src: t.blobUrl, title: a.filename }));
  } else if (d.kind === 'text') {
    body.appendChild(h('pre', { class: 'att-text' }, d.text + (d.truncated ? '\n\n… (aperçu limité au début du fichier)' : '')));
  } else {
    body.appendChild(h('div', { class: 'empty' }, h('h2', null, 'Aperçu non disponible'),
      h('p', null, d.tooBig ? 'Ce fichier est trop volumineux pour être prévisualisé.' : 'MailHub ne sait pas afficher ce type de fichier. Enregistrez-le ou ouvrez-le avec l’application associée.')));
  }
}

function hasRemoteContent(html) {
  return !!html && /(?:src|background|poster)\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:|@import/i.test(html);
}

function buildMailDoc(detail, allowRemote) {
  const csp = `default-src 'none'; img-src data: ${allowRemote ? 'https: http:' : ''}; style-src 'unsafe-inline'; font-src data:`;
  const safeHtml = detail.html ? detail.html.replace(/<\s*(?:meta|base|link)\b[^>]*>/gi, '') : '';
  const body = detail.html ? safeHtml : `<pre style="white-space:pre-wrap;font:inherit;margin:0">${esc(detail.text || '')}</pre>`;
  return '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">` +
    '<style>html{color-scheme:light}body{margin:0;padding:20px 28px 36px;font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1a1a1a;background:#fff;overflow-wrap:anywhere}' +
    'img{max-width:100%;height:auto}table{max-width:100%}blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #d0d7de;color:#555}a{color:#1a56c4}</style>' +
    `</head><body>${body}</body></html>`;
}

function suggestFolders(m) {
  const info = state.folders[m.accountId];
  if (!info) return [];
  const out = [];
  const push = (path) => {
    const f = info.folders.find((x) => x.path === path);
    if (f && f.selectable && path !== m.folder && !out.includes(path)) out.push(path);
  };
  state.rules.filter((r) => r.accountId === m.accountId && r.enabled !== false).forEach((r) => {
    if (r.conditions.some((c) => (c.field === 'from' && m.from.includes(String(c.value).toLowerCase())) || (c.field === 'domain' && domainOf(m.from) === String(c.value).toLowerCase()))) push(r.folder);
  });
  recentFolders(m.accountId).forEach(push);
  const skip = new Set(['\\Inbox', '\\Trash', '\\Junk', '\\Drafts', '\\Sent']);
  layoutFolders(m.accountId).forEach(({ folder: f }) => { if (!skip.has(f.specialUse)) push(f.path); });
  return out.slice(0, 5);
}

function renderReader() {
  applyLayout();
  try {
    renderReaderContent();
  } catch (err) {
    console.error(err);
    const reader = $('#reader');
    clear(reader);
    reader.appendChild(h('div', { class: 'empty' }, h('h2', null, 'Affichage impossible'), h('p', null, err.message || String(err))));
  }
}

function renderReaderContent() {
  const reader = $('#reader');
  clear(reader);
  const o = state.opened;
  if (!o) {
    reader.appendChild(h('div', { class: 'reader-empty' }, ico('mail', 40), h('div', null, 'Sélectionnez un message pour le lire')));
    return;
  }
  renderMailInto(reader, o, renderReader);
}

// Contenu d'un message (en-tête, pièces jointes, rangement, corps) dans un conteneur : volet de lecture ou onglet.
function renderMailInto(reader, o, redraw) {
  const m = o.msg;
  if (o.loading) { reader.appendChild(h('div', { class: 'loading' }, 'Ouverture du message…')); return; }
  if (o.error) {
    reader.appendChild(h('div', { class: 'empty' }, h('h2', null, 'Message illisible'), h('p', null, o.error)));
    return;
  }
  const d = o.detail;
  const acc = accountById(m.accountId);
  const fmtAddr = (a) => (a.name ? `${a.name} <${a.address}>` : a.address);

  reader.appendChild(h('div', { class: 'reader-head' },
    h('h2', null, d.subject),
    h('div', { class: 'reader-meta' },
      h('div', null,
        h('div', { class: 'sender-line' }, d.from.name || d.from.address, d.from.name ? h('span', { class: 'sender-addr' }, d.from.address) : null),
        h('div', { class: 'recipients' }, 'À ' + (d.to.map(fmtAddr).join(', ') || (acc ? acc.email : '')), d.cc.length ? ' · Cc ' + d.cc.map(fmtAddr).join(', ') : '')),
      h('div', null,
        h('div', { class: 'reader-actions' },
          (() => {
            const b = h('button', { class: 'icon-btn' + (m.flagged ? ' star-on' : ''), title: 'Favori', 'aria-label': 'Favori', 'aria-pressed': String(!!m.flagged) });
            b.appendChild(ico('star'));
            b.addEventListener('click', async () => { await toggleFlag(m); b.classList.toggle('star-on', !!m.flagged); b.setAttribute('aria-pressed', String(!!m.flagged)); });
            return b;
          })(),
          (!reader.closest || !reader.closest('#tabview'))
            ? h('button', { class: 'icon-btn', title: 'Ouvrir dans un nouvel onglet', 'aria-label': 'Ouvrir dans un nouvel onglet', on: { click: () => openInTab(m) } }, ico('layoutFull'))
            : null,
          h('button', { class: 'icon-btn', title: 'Répondre', 'aria-label': 'Répondre', on: { click: () => replyTo(o) } }, ico('reply')),
          h('button', { class: 'icon-btn', title: 'Transférer', 'aria-label': 'Transférer', on: { click: () => forward(o) } }, ico('forward')),
          h('button', { class: 'icon-btn', title: 'Marquer comme non lu', 'aria-label': 'Marquer comme non lu', on: { click: () => setSeen([m], false) } }, ico('mailopen')),
          h('button', { class: 'icon-btn', title: 'Supprimer', 'aria-label': 'Supprimer', on: { click: () => deleteMessages([m]) } }, ico('trash'))),
        h('div', { class: 'reader-date' }, dfFull.format(new Date(d.date)))))));

  if (d.attachments.length) {
    reader.appendChild(h('div', { class: 'attachments' }, d.attachments.map((a) =>
      h('span', { class: 'att-chip' },
        h('button', { class: 'att-open', title: 'Ouvrir dans un onglet', on: { click: () => openAttachmentTab(m, a) } }, ico('clip', 15), a.filename, h('span', { class: 'size' }, fmtSize(a.size))),
        h('button', { class: 'att-save', title: 'Enregistrer', 'aria-label': 'Enregistrer ' + a.filename, on: { click: () => saveAttachment(m, a) } }, ico('download', 15))))));
  }

  // bandeau de rangement
  const strip = h('div', { class: 'strip', vars: { '--acc': accColor(m.accountId) } }, h('span', { class: 'strip-lead' }, 'Ranger dans'));
  suggestFolders(m).forEach((path) => {
    const f = folderInfo(m.accountId, path);
    strip.appendChild(h('button', { class: 'tab', title: path, on: { click: () => fileMessages([m], m.accountId, path, { offerRule: true }) } },
      ico(SPECIAL_ICON[f.specialUse] || 'folder', 15), folderLabel(m.accountId, path)));
  });
  strip.appendChild(h('button', { class: 'tab auto', on: { click: () => openFilePicker([m]) } }, ico('plus', 15), 'Autre dossier'));
  reader.appendChild(strip);

  if (d.html && hasRemoteContent(d.html) && !o.allowRemote) {
    reader.appendChild(h('div', { class: 'remote-banner' }, h('span', null, 'Les images distantes sont masquées pour protéger votre vie privée.'),
      h('button', { class: 'ghost', on: { click: () => { o.allowRemote = true; redraw(); } } }, 'Afficher les images')));
  }

  const frame = h('iframe', { class: 'mail-frame', sandbox: 'allow-popups', title: 'Contenu du message', referrerpolicy: 'no-referrer' });
  frame.srcdoc = buildMailDoc(d, o.allowRemote);
  reader.appendChild(frame);
}

async function saveAttachment(m, a) {
  try {
    const res = await call(api.messages.saveAttachment(m.accountId, m.folder, m.uid, a.index));
    if (res.saved) toast(`« ${a.filename} » enregistré.`);
  } catch (err) { toast(err.message, { error: true }); }
}

// --------------------------------------------------------------------- écriture

function quoteText(d) {
  const who = d.from.name || d.from.address;
  const head = `Le ${dfFull.format(new Date(d.date))}, ${who} a écrit :`;
  // Texte du message d'origine repris tel quel, sans « > » (on retire aussi ceux des citations imbriquées)
  const original = (d.text || '').split('\n').map((l) => l.replace(/^(?:\s*>)+ ?/, '')).join('\n').replace(/\s+$/, '');
  return '\n\n' + head + '\n\n' + original;
}

function replyTo(o) {
  const d = o.detail;
  const target = d.replyTo || d.from;
  openCompose({
    accountId: o.msg.accountId,
    to: target.address,
    subject: /^(re|réf)\s*:/i.test(d.subject) ? d.subject : 'Re: ' + d.subject,
    body: quoteText(d),
    inReplyTo: d.messageId,
    references: [...(d.references || []), d.messageId].filter(Boolean),
  });
}

function forward(o) {
  const d = o.detail;
  const head = `\n\n---------- Message transféré ----------\nDe : ${d.from.name ? d.from.name + ' <' + d.from.address + '>' : d.from.address}\nDate : ${dfFull.format(new Date(d.date))}\nObjet : ${d.subject}\n\n`;
  openCompose({
    accountId: o.msg.accountId,
    subject: /^(tr|fwd?)\s*:/i.test(d.subject) ? d.subject : 'Tr: ' + d.subject,
    body: head + (d.text || ''),
  });
}

// Autocomplétion des destinataires à partir du carnet d'adresses
function attachAutocomplete(input) {
  const box = h('div', { class: 'suggest', hidden: true, role: 'listbox' });
  input.parentNode.appendChild(box);
  let items = [];
  let active = 0;
  const tokenStart = () => Math.max(input.value.lastIndexOf(',', input.selectionStart - 1), input.value.lastIndexOf(';', input.selectionStart - 1)) + 1;
  const hide = () => { box.hidden = true; items = []; };
  const norm = (t) => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  function show() {
    const q = norm(input.value.slice(tokenStart(), input.selectionStart).trim());
    if (q.length < 1) { hide(); return; }
    const taken = new Set(input.value.toLowerCase().match(/[^\s,;<>"]+@[^\s,;<>"]+/g) || []);
    const scored = [];
    for (const c of state.contacts) {
      if (taken.has(c.email)) continue;
      const mail = c.email, name = norm(c.name || '');
      let score = -1;
      if (mail.startsWith(q)) score = 3;
      else if (name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q))) score = 3;
      else if (mail.includes(q) || name.includes(q)) score = 1;
      if (score >= 0) scored.push({ c, score });
    }
    scored.sort((a, b) => b.score - a.score || b.c.count - a.c.count || (b.c.last || '').localeCompare(a.c.last || ''));
    items = scored.slice(0, 7).map((x) => x.c);
    active = 0;
    draw();
  }
  function draw() {
    clear(box);
    if (!items.length) { box.hidden = true; return; }
    items.forEach((c, i) => box.appendChild(h('button', {
      type: 'button', class: i === active ? 'on' : '', role: 'option', 'aria-selected': String(i === active),
      on: { mousedown: (e) => { e.preventDefault(); choose(c); } },
    }, c.name ? h('span', { class: 's-name' }, c.name) : null, h('span', c.name ? { class: 's-mail' } : { class: 's-name' }, c.email))));
    box.hidden = false;
  }
  function choose(c) {
    const start = tokenStart();
    const before = input.value.slice(0, start).replace(/\s*$/, '');
    const after = input.value.slice(input.selectionStart).replace(/^\s*[,;]?\s*/, '');
    const label = c.name ? `"${c.name.replace(/["<>,;]/g, ' ').replace(/\s+/g, ' ').trim()}" <${c.email}>` : c.email;
    input.value = (before ? before + ' ' : '') + label + ', ' + after;
    const pos = input.value.length - after.length;
    input.setSelectionRange(pos, pos);
    hide();
  }
  input.addEventListener('input', show);
  input.addEventListener('blur', () => setTimeout(hide, 120));
  input.addEventListener('keydown', (e) => {
    if (box.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; draw(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') { e.stopPropagation(); hide(); }
  }, true);
}

const SIG_DELIM = '\n\n-- \n';
const SIG_PLACEHOLDER = '(images de la signature)'; // remplacé par les images à l'envoi
const sigBlock = (sig) => {
  if (!sig) return '';
  const text = sig.text.replace(/\s+$/, '');
  const hasImgs = (sig.images || []).length > 0;
  if (text.trim() && hasImgs) return SIG_DELIM + text + '\n\n' + SIG_PLACEHOLDER;
  if (text.trim()) return SIG_DELIM + text;
  if (hasImgs) return SIG_DELIM + SIG_PLACEHOLDER;
  return '';
};

function openCompose(init = {}) {
  if (!state.accounts.length) { toast('Ajoutez d’abord un compte.', { error: true }); return; }
  const defaultAcc = init.accountId || (!['unified', 'favorites'].includes(state.current.accountId) ? state.current.accountId : state.accounts[0].id);
  const from = h('select', null, state.accounts.map((a) => h('option', { value: a.id }, `${a.name} <${a.email}>`)));
  from.value = defaultAcc;
  const to = h('input', { type: 'text', value: init.to || '', placeholder: 'destinataire@exemple.com', spellcheck: 'false', autocomplete: 'off' });
  const cc = h('input', { type: 'text', value: init.cc || '', spellcheck: 'false', autocomplete: 'off' });
  const subject = h('input', { type: 'text', value: init.subject || '' });

  // Éditeur riche (contenteditable)
  const editor = h('div', {
    class: 'compose-editor',
    contenteditable: 'true',
    spellcheck: 'true',
    role: 'textbox',
    'aria-multiline': 'true',
  });

  const exec = (cmd, val = null) => {
    editor.focus();
    document.execCommand(cmd, false, val);
  };

  // Gestion des tailles de police
  let curFontSize = 3;
  const setFontSize = (size) => {
    curFontSize = Math.max(1, Math.min(6, size));
    sizeSelect.value = String(curFontSize);
    exec('fontSize', String(curFontSize));
  };
  const sizeSelect = h('select', {
    class: 'fmt-select',
    title: 'Taille du texte',
    on: { change: (e) => setFontSize(parseInt(e.target.value, 10)) },
  },
    h('option', { value: '2' }, 'Petit (12px)'),
    h('option', { value: '3', selected: true }, 'Normal (14px)'),
    h('option', { value: '4' }, 'Grand (18px)'),
    h('option', { value: '5' }, 'Très grand (24px)')
  );

  // Popover couleur
  let colorPop = null;
  const closeColorPop = () => { if (colorPop) { colorPop.remove(); colorPop = null; } };
  const toggleColorPop = (anchorBtn) => {
    if (colorPop) { closeColorPop(); return; }
    closeEmojiPop();
    const colors = ['#17212e', '#5a6677', '#2f4b8a', '#12a594', '#30a46c', '#f5a524', '#f76b15', '#e5484d', '#8e4ec6', '#d6409f'];
    const customInput = h('input', {
      type: 'color', value: '#2f4b8a',
      on: { input: (e) => { exec('foreColor', e.target.value); closeColorPop(); } },
    });
    colorPop = h('div', { class: 'color-popover' },
      h('div', { class: 'color-popover-grid' },
        colors.map((c) => h('button', {
          type: 'button', class: 'color-popover-btn', style: `background:${c}`, title: c,
          on: { mousedown: (e) => { e.preventDefault(); exec('foreColor', c); closeColorPop(); } },
        }))
      ),
      h('label', { class: 'color-popover-custom' }, customInput, 'Couleur libre…')
    );
    anchorBtn.parentNode.appendChild(colorPop);
    const outside = (e) => {
      if (colorPop && !colorPop.contains(e.target) && e.target !== anchorBtn) {
        closeColorPop();
        document.removeEventListener('mousedown', outside, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  };

  // Popover Emojis
  let emojiPop = null;
  const closeEmojiPop = () => { if (emojiPop) { emojiPop.remove(); emojiPop = null; } };
  const toggleEmojiPop = (anchorBtn) => {
    if (emojiPop) { closeEmojiPop(); return; }
    closeColorPop();
    const groups = [
      {
        title: 'Émotions & Visages',
        list: ['😊', '😂', '😃', '😉', '😍', '🥰', '😎', '🤔', '🤫', '🥳', '😴', '😇', '👍', '👎', '👏', '🙌', '❤️', '🔥', '✨', '🎉', '🚀'],
      },
      {
        title: 'Bureau & Courrier',
        list: ['✉️', '📧', '📎', '📁', '📂', '📅', '📆', '📊', '📈', '📌', '📝', '💼', '💻', '💡', '🎯', '✅', '❌', '⚠️', '💬', '🏷️', '🔒'],
      },
      {
        title: 'Symboles & Extras',
        list: ['⭐', '🌟', '💯', '🔔', '⏰', '⏱️', '☕', '🥐', '🌍', '🏠', '📞', '🤝', '💪', '🙏', '👀', '⚡', '🌈', '🎁', '🏆', '💎', '☀️'],
      },
    ];
    emojiPop = h('div', { class: 'emoji-popover' },
      groups.map((g) => h('div', null,
        h('div', { class: 'emoji-group-title' }, g.title),
        h('div', { class: 'emoji-grid' },
          g.list.map((emo) => h('button', {
            type: 'button', class: 'emoji-btn',
            on: { mousedown: (e) => { e.preventDefault(); exec('insertText', emo); closeEmojiPop(); } },
          }, emo))
        )
      ))
    );
    anchorBtn.parentNode.appendChild(emojiPop);
    const outside = (e) => {
      if (emojiPop && !emojiPop.contains(e.target) && e.target !== anchorBtn) {
        closeEmojiPop();
        document.removeEventListener('mousedown', outside, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  };

  // Boîte de dialogue pour insérer un lien avec texte personnalisé
  const promptLinkDialog = () => {
    closeColorPop();
    closeEmojiPop();
    const sel = window.getSelection();
    let savedRange = null;
    let initialText = '';
    if (sel && sel.rangeCount > 0) {
      savedRange = sel.getRangeAt(0).cloneRange();
      initialText = sel.toString();
    }
    const textInput = h('input', { type: 'text', value: initialText, placeholder: 'Ex : Notre documentation' });
    const urlInput = h('input', { type: 'text', value: 'https://', placeholder: 'https://exemple.fr' });
    const linkDlg = openDialog({
      title: 'Insérer un lien',
      subtitle: 'Personnalisez le texte affiché et l’adresse URL',
      body: h('div', { class: 'field-group', style: 'display:grid;gap:12px' },
        h('div', { class: 'field' }, h('label', null, 'Texte à afficher'), textInput),
        h('div', { class: 'field' }, h('label', null, 'Adresse web (URL)'), urlInput)
      ),
      buttons: [
        { label: 'Annuler', onClick: (d) => d.close() },
        {
          label: 'Insérer le lien', kind: 'primary',
          onClick: (d) => {
            let url = urlInput.value.trim();
            if (!url) return;
            if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) url = 'https://' + url;
            const text = textInput.value.trim() || url;
            d.close();
            if (savedRange) {
              const s = window.getSelection();
              s.removeAllRanges();
              s.addRange(savedRange);
            }
            editor.focus();
            const a = document.createElement('a');
            a.href = url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = text;
            if (savedRange && !savedRange.collapsed) {
              savedRange.deleteContents();
              savedRange.insertNode(a);
            } else {
              document.execCommand('insertHTML', false, a.outerHTML);
            }
          },
        },
      ],
    });
    (initialText ? urlInput : textInput).focus();
    urlInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') linkDlg.buttons[1].onClick(linkDlg);
    });
  };

  // Barre d'outils de formatage
  const colorBtn = h('button', {
    type: 'button', class: 'fmt-btn', title: 'Couleur du texte',
    on: { click: (e) => { e.preventDefault(); toggleColorPop(colorBtn); } },
  }, ico('palette', 15));

  const emojiBtn = h('button', {
    type: 'button', class: 'fmt-btn', title: 'Insérer un emoji',
    on: { click: (e) => { e.preventDefault(); toggleEmojiPop(emojiBtn); } },
  }, ico('smile', 16));

  const toolbar = h('div', { class: 'compose-toolbar' },
    h('button', { type: 'button', class: 'fmt-btn', title: 'Gras (Ctrl+B)', on: { mousedown: (e) => { e.preventDefault(); exec('bold'); } } }, ico('bold', 15)),
    h('button', { type: 'button', class: 'fmt-btn', title: 'Italique (Ctrl+I)', on: { mousedown: (e) => { e.preventDefault(); exec('italic'); } } }, ico('italic', 15)),
    h('button', { type: 'button', class: 'fmt-btn', title: 'Souligné (Ctrl+U)', on: { mousedown: (e) => { e.preventDefault(); exec('underline'); } } }, ico('underline', 15)),
    h('button', { type: 'button', class: 'fmt-btn', title: 'Barré', on: { mousedown: (e) => { e.preventDefault(); exec('strikeThrough'); } } }, ico('strike', 15)),
    h('span', { class: 'tb-sep' }),
    h('button', { type: 'button', class: 'fmt-btn', title: 'Diminuer la taille', on: { mousedown: (e) => { e.preventDefault(); setFontSize(curFontSize - 1); } } }, 'A-'),
    h('button', { type: 'button', class: 'fmt-btn', title: 'Augmenter la taille', on: { mousedown: (e) => { e.preventDefault(); setFontSize(curFontSize + 1); } } }, 'A+'),
    sizeSelect,
    h('span', { class: 'tb-sep' }),
    colorBtn,
    h('span', { class: 'tb-sep' }),
    h('button', { type: 'button', class: 'fmt-btn', title: 'Aligner à gauche', on: { mousedown: (e) => { e.preventDefault(); exec('justifyLeft'); } } }, ico('alignLeft', 15)),
    h('button', { type: 'button', class: 'fmt-btn', title: 'Centrer', on: { mousedown: (e) => { e.preventDefault(); exec('justifyCenter'); } } }, ico('alignCenter', 15)),
    h('button', { type: 'button', class: 'fmt-btn', title: 'Aligner à droite', on: { mousedown: (e) => { e.preventDefault(); exec('justifyRight'); } } }, ico('alignRight', 15)),
    h('span', { class: 'tb-sep' }),
    h('button', { type: 'button', class: 'fmt-btn', title: 'Liste à puces', on: { mousedown: (e) => { e.preventDefault(); exec('insertUnorderedList'); } } }, ico('listBullet', 15)),
    h('button', { type: 'button', class: 'fmt-btn', title: 'Liste numérotée', on: { mousedown: (e) => { e.preventDefault(); exec('insertOrderedList'); } } }, ico('listNumber', 15)),
    h('span', { class: 'tb-sep' }),
    h('button', { type: 'button', class: 'fmt-btn', title: 'Insérer un lien personnalisé (Ctrl+K)', on: { click: (e) => { e.preventDefault(); promptLinkDialog(); } } }, ico('link', 15)),
    emojiBtn
  );

  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      promptLinkDialog();
    }
  });

  const composeBox = h('div', { class: 'compose-box' }, toolbar, editor);

  // Signatures
  const sigSel = h('select', { 'aria-label': 'Signature' });
  const sigImgs = h('div', { class: 'sig-images', hidden: true });
  const sigsOf = () => (accountById(from.value) || {}).signatures || [];
  let currentBlock = '';
  const fillSigSelect = (preferred) => {
    clear(sigSel);
    sigSel.appendChild(h('option', { value: '' }, 'Aucune'));
    sigsOf().forEach((sg) => sigSel.appendChild(h('option', { value: sg.id }, sg.name)));
    sigSel.value = sigsOf().some((x) => x.id === preferred) ? preferred : '';
  };
  const applySig = (first) => {
    const sig = sigsOf().find((x) => x.id === sigSel.value);
    const next = sigBlock(sig);
    if (first) {
      const initialHtml = init.bodyHtml
        ? init.bodyHtml
        : (init.body ? esc(init.body).replace(/\n/g, '<br>') : '');
      const sigHtml = next ? '<div class="sig-block" data-sig="1"><br><br>' + esc(next).replace(/\n/g, '<br>') + '</div>' : '';
      editor.innerHTML = initialHtml + sigHtml;
      currentBlock = next;
      return;
    }
    const curSigEl = editor.querySelector('[data-sig="1"]');
    if (curSigEl) {
      if (next) curSigEl.innerHTML = '<br><br>' + esc(next).replace(/\n/g, '<br>');
      else curSigEl.remove();
    } else if (next) {
      editor.insertAdjacentHTML('beforeend', '<div class="sig-block" data-sig="1"><br><br>' + esc(next).replace(/\n/g, '<br>') + '</div>');
    }
    currentBlock = next;
  };
  const drawSigImgs = () => {
    clear(sigImgs);
    const sig = sigsOf().find((x) => x.id === sigSel.value);
    const imgs = sig ? sig.images || [] : [];
    sigImgs.hidden = !imgs.length;
    if (!imgs.length) return;
    sigImgs.appendChild(h('small', null, `${imgs.length} ${plural(imgs.length, 'image', 'images')} de signature, ajoutée${imgs.length > 1 ? 's' : ''} sous la signature à l’envoi :`));
    imgs.forEach((im) => sigImgs.appendChild(h('img', { src: im.dataUrl, alt: im.name, title: im.name })));
  };
  fillSigSelect((accountById(from.value) || {}).defaultSignature);
  applySig(true);
  drawSigImgs();
  sigSel.addEventListener('change', () => { applySig(false); drawSigImgs(); });
  from.addEventListener('change', () => { fillSigSelect((accountById(from.value) || {}).defaultSignature); applySig(false); drawSigImgs(); });

  let files = [];
  const attBox = h('div', { class: 'att-list' });
  const renderAtt = () => {
    clear(attBox);
    files.forEach((f, i) => attBox.appendChild(h('span', { class: 'att-chip' }, ico('clip', 15), f.name, h('span', { class: 'size' }, fmtSize(f.size)),
      h('button', { class: 'icon-btn', style: 'width:22px;height:22px', 'aria-label': 'Retirer', on: { click: () => { files.splice(i, 1); renderAtt(); } } }, ico('close', 14)))));
  };

  const dlg = openDialog({
    title: 'Nouveau message',
    large: true,
    body: h('div', { class: 'compose-grid' },
      h('div', { class: 'row-line' }, h('label', null, 'De'), from),
      h('div', { class: 'row-line' }, h('label', null, 'Signature'), sigSel),
      h('div', { class: 'row-line' }, h('label', null, 'À'), to),
      h('div', { class: 'row-line' }, h('label', null, 'Cc'), cc),
      h('div', { class: 'row-line' }, h('label', null, 'Objet'), subject),
      composeBox,
      sigImgs,
      h('div', null,
        h('button', { class: 'subtle', on: { click: async () => {
          try { files = files.concat(await call(api.messages.pickAttachments())); renderAtt(); } catch (err) { dlg.error(err.message); }
        } } }, ico('clip', 16), 'Joindre un fichier (ou glissez-déposez ici)'),
        attBox
      )
    ),
    buttons: [
      { label: 'Annuler', onClick: (d) => {
          const hasContent = to.value.trim() || cc.value.trim() || subject.value.trim() || editor.innerHTML.trim() || files.length > 0;
          if (!hasContent) { d.close(); return; }
          openDialog({
            title: 'Fermer sans envoyer ?',
            body: h('p', { style: 'margin:0' }, 'Voulez-vous enregistrer ce message comme brouillon ?'),
            buttons: [
              { label: 'Supprimer', kind: 'danger', onClick: (d2) => { d2.close(); d.close(); } },
              { label: 'Annuler', onClick: (d2) => d2.close() },
              { label: 'Enregistrer', kind: 'primary', onClick: async (d2) => {
                 try {
                    await call(api.messages.saveDraft(from.value, {
                        to: to.value.trim(), cc: cc.value.trim(), subject: subject.value,
                        html: editor.innerHTML, text: editor.innerText || editor.textContent || '',
                        attachments: files, signatureId: sigSel.value || undefined, signatureBlock: currentBlock,
                    }));
                    toast('Brouillon enregistré.');
                    d2.close();
                    d.close();
                 } catch (err) { d2.error(err.message); }
              } },
            ]
          });
      } },

      {
        id: 'send', label: 'Envoyer', kind: 'primary',
        onClick: async (d, btn) => {
          if (!to.value.trim()) { d.error('Indiquez au moins un destinataire.'); return; }
          btn.disabled = true;
          d.error('');
          try {
            await call(api.messages.send(from.value, {
              to: to.value.trim(), cc: cc.value.trim(), subject: subject.value,
              html: editor.innerHTML, text: editor.innerText || editor.textContent || '',
              attachments: files, inReplyTo: init.inReplyTo, references: init.references,
              signatureId: sigSel.value || undefined, signatureBlock: currentBlock,
            }));
            d.close();
            toast('Message envoyé.');
            call(api.contacts.list()).then((c) => { state.contacts = c; }).catch(() => {});
          } catch (err) { btn.disabled = false; d.error(err.message); }
        },
      },
    ],
  });

  // Glisser-déposer de pièces jointes directement sur la fenêtre du message
  const dropOverlay = h('div', { class: 'compose-dropzone-overlay', hidden: true },
    ico('clip', 36),
    h('span', null, 'Déposez vos fichiers pour les joindre au message')
  );
  dlg.el.classList.add('compose-dropzone-active');
  dlg.el.appendChild(dropOverlay);

  let dragDepth = 0;
  dlg.el.addEventListener('dragenter', (e) => {
    if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      dragDepth++;
      dropOverlay.hidden = false;
    }
  });
  dlg.el.addEventListener('dragover', (e) => {
    if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  dlg.el.addEventListener('dragleave', () => {
    dragDepth--;
    if (dragDepth <= 0) {
      dragDepth = 0;
      dropOverlay.hidden = true;
    }
  });
  dlg.el.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    const dtFiles = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
    if (!dtFiles.length) return;
    for (const f of dtFiles) {
      let diskPath = '';
      if (api && api.getPathForFile) {
        try { diskPath = api.getPathForFile(f); } catch (_) {}
      }
      if (!diskPath && f.path) diskPath = f.path;
      const b64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(f);
      });
      files.push({ name: f.name, size: f.size, dataUrl: b64, path: diskPath || '' });
    }
    renderAtt();
    toast(`${dtFiles.length} ${plural(dtFiles.length, 'fichier ajouté', 'fichiers ajoutés')} en pièce jointe.`);
  });

  attachAutocomplete(to);
  attachAutocomplete(cc);
  (init.to ? editor : to).focus();
}

// ----------------------------------------------------------------------- règles

const FIELD_LABEL = {
  from: 'l’expéditeur', to: 'le destinataire', cc: 'la copie (Cc)', tocc: 'le destinataire ou la copie',
  subject: 'l’objet', domain: 'le domaine de l’expéditeur',
};
const OP_LABEL = {
  contains: 'contient', notContains: 'ne contient pas', equals: 'est', notEquals: 'n’est pas',
  startsWith: 'commence par', endsWith: 'se termine par',
};

function describeRule(r) {
  const parts = [];
  r.conditions.forEach((c, i) => {
    if (i) parts.push(r.match === 'any' ? ' ou ' : ' et ');
    parts.push(`${FIELD_LABEL[c.field] || c.field} ${OP_LABEL[c.op] || c.op} `, h('b', null, `« ${c.value} »`));
  });
  return parts;
}

function renderRulesPanel() {
  const panel = $('#panel');
  clear(panel);
  const inner = h('div', { class: 'panel-inner' },
    h('h1', null, 'Règles de tri'),
    h('p', { class: 'lead' }, 'Chaque nouveau message qui arrive dans une boîte de réception est comparé à ces règles, puis rangé dans le dossier choisi. Les règles sont appliquées dans l’ordre de la liste, la première qui correspond l’emporte.'),
    h('div', { class: 'toolbar-row' },
      h('button', { class: 'primary', disabled: !state.accounts.length, on: { click: () => openRuleEditor() } }, ico('plus', 16), 'Nouvelle règle'),
      h('button', { class: 'ghost', disabled: !state.accounts.length, on: { click: openThunderbirdImport } }, ico('download', 16), 'Importer depuis Thunderbird'),
      h('button', { class: 'ghost', disabled: !state.rules.length, title: 'Enregistre vos règles dans un fichier, pour les retrouver sur un autre ordinateur', on: { click: exportRules } }, ico('up', 16), 'Exporter mes règles'),
      h('button', { class: 'ghost', disabled: !state.accounts.length, title: 'Charge un fichier de règles exporté depuis MailHub', on: { click: openRulesImport } }, ico('download', 16), 'Importer un fichier de règles'),
      h('button', { class: 'ghost', disabled: !state.accounts.length, title: 'Force le tri : applique les règles aux 1000 derniers messages de la boîte de réception de chaque compte', on: { click: async (e) => {
        e.currentTarget.disabled = true;
        try { reportSort(await call(api.rules.applyAll())); await Promise.all(state.accounts.map((a) => loadFolders(a.id))); }
        catch (err) { toast(err.message, { error: true }); }
        renderRulesPanel();
      } } }, ico('rules', 16), 'Trier maintenant toutes les boîtes'),
      state.accounts.length > 1 ? state.accounts.map((a) => h('button', { class: 'ghost', title: 'Range maintenant les 1000 derniers messages de la boîte de réception', on: { click: () => applyRules(a.id, 'INBOX') } }, `Appliquer à ${a.name}`)) : null));

  if (!state.rules.length) {
    inner.appendChild(h('div', { class: 'empty', style: 'padding:24px 0' },
      h('h2', null, 'Aucune règle pour l’instant'),
      h('p', null, 'Rangez un message dans un dossier depuis le bandeau de lecture, puis choisissez « Toujours ranger ici ». Vous pouvez aussi écrire une règle à la main.')));
  }

  state.rules.forEach((r, i) => {
    const acc = accountById(r.accountId);
    const toggle = h('input', { type: 'checkbox', checked: r.enabled !== false, 'aria-label': 'Activer la règle', on: { change: async () => {
      try { const upd = { ...r, enabled: toggle.checked }; await call(api.rules.update(upd)); r.enabled = toggle.checked; }
      catch (err) { toast(err.message, { error: true }); toggle.checked = !toggle.checked; }
    } } });
    inner.appendChild(h('div', { class: 'rule', vars: { '--acc': acc ? acc.color : 'var(--line)' } },
      h('label', { class: 'switch' }, toggle, h('span')),
      h('div', { class: 'summary' },
        h('div', null, 'Si ', describeRule(r), ' → ', h('span', { class: 'dest' }, ico('folder', 14), folderLabel(r.accountId, r.folder))),
        h('div', { class: 'meta' }, h('i'), acc ? acc.email : 'Compte supprimé', r.source === 'thunderbird' ? ` · filtre Thunderbird « ${r.name} »` : '')),
      h('div', { class: 'rule-actions' },
        h('button', { class: 'icon-btn', title: 'Appliquer plus tôt', 'aria-label': 'Appliquer plus tôt', disabled: i === 0, on: { click: () => reorderRule(r, -1) } }, ico('up', 16)),
        h('button', { class: 'icon-btn', title: 'Appliquer plus tard', 'aria-label': 'Appliquer plus tard', disabled: i === state.rules.length - 1, on: { click: () => reorderRule(r, 1) } }, ico('down', 16)),
        h('button', { class: 'icon-btn', title: 'Modifier', 'aria-label': 'Modifier', on: { click: () => openRuleEditor(r) } }, ico('pencil')),
        h('button', { class: 'icon-btn', title: 'Supprimer', 'aria-label': 'Supprimer', on: { click: async () => {
          if (!(await confirmDialog({ title: 'Supprimer cette règle ?', body: 'Les messages déjà rangés ne bougent pas.', confirm: 'Supprimer', danger: true }))) return;
          try { await call(api.rules.remove(r.id)); state.rules = state.rules.filter((x) => x.id !== r.id); renderRulesPanel(); }
          catch (err) { toast(err.message, { error: true }); }
        } } }, ico('trash')))));
  });
  panel.appendChild(inner);
}

async function reorderRule(rule, delta) {
  try {
    state.rules = await call(api.rules.move(rule.id, delta));
    renderRulesPanel();
  } catch (err) { toast(err.message, { error: true }); }
}

function openRuleEditor(existing) {
  const rule = existing ? JSON.parse(JSON.stringify(existing)) : { id: null, accountId: state.accounts[0].id, name: '', enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: '' }], folder: '' };
  const accSel = h('select', null, state.accounts.map((a) => h('option', { value: a.id }, `${a.name} <${a.email}>`)));
  accSel.value = rule.accountId;
  const matchSel = h('select', null, h('option', { value: 'all' }, 'toutes les conditions sont vraies'), h('option', { value: 'any' }, 'au moins une condition est vraie'));
  matchSel.value = rule.match;
  const folderSel = h('select');
  const fillFolders = () => {
    clear(folderSel);
    folderOptions(accSel.value).forEach((o) => folderSel.appendChild(o));
    folderSel.value = rule.folder && folderInfo(accSel.value, rule.folder) ? rule.folder : (folderSel.options[0] ? folderSel.options[0].value : '');
  };
  fillFolders();
  accSel.addEventListener('change', () => { rule.folder = ''; fillFolders(); });

  const condBox = h('div', { style: 'display:grid;gap:8px' });
  const renderConds = () => {
    clear(condBox);
    rule.conditions.forEach((c, i) => {
      const field = h('select', { on: { change: () => { c.field = field.value; } } }, Object.entries({ from: 'Expéditeur', to: 'Destinataire', cc: 'Copie (Cc)', tocc: 'Destinataire ou copie', subject: 'Objet', domain: 'Domaine de l’expéditeur' }).map(([v, l]) => h('option', { value: v }, l)));
      field.value = c.field;
      const op = h('select', { on: { change: () => { c.op = op.value; } } }, Object.entries({ contains: 'contient', notContains: 'ne contient pas', equals: 'est exactement', notEquals: 'n’est pas', startsWith: 'commence par', endsWith: 'se termine par' }).map(([v, l]) => h('option', { value: v }, l)));
      op.value = c.op;
      const val = h('input', { type: 'text', value: c.value, placeholder: 'texte à rechercher', spellcheck: 'false', on: { input: () => { c.value = val.value; } } });
      condBox.appendChild(h('div', { class: 'cond' }, field, op, val,
        h('button', { class: 'icon-btn', title: 'Retirer', 'aria-label': 'Retirer la condition', disabled: rule.conditions.length < 2, on: { click: () => { rule.conditions.splice(i, 1); renderConds(); } } }, ico('close', 16))));
    });
  };
  renderConds();

  openDialog({
    title: existing ? 'Modifier la règle' : 'Nouvelle règle',
    large: true,
    body: [
      h('div', { class: 'field' }, h('label', null, 'Compte'), accSel),
      h('div', { class: 'field' }, h('label', null, 'Appliquer quand'), matchSel),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Conditions'), condBox,
        h('div', null, h('button', { class: 'subtle', on: { click: () => { rule.conditions.push({ field: 'from', op: 'contains', value: '' }); renderConds(); } } }, ico('plus', 16), 'Ajouter une condition'))),
      h('div', { class: 'field' }, h('label', null, 'Ranger dans'), folderSel,
        h('small', null, 'Le dossier n’existe pas encore ? Créez-le avec le bouton + de la barre latérale.')),
    ],
    buttons: [
      { label: 'Annuler', onClick: (d) => d.close() },
      {
        id: 'save', label: 'Enregistrer', kind: 'primary',
        onClick: async (d, btn) => {
          const conditions = rule.conditions.filter((c) => c.value.trim());
          if (!conditions.length) { d.error('Renseignez au moins une condition.'); return; }
          if (!folderSel.value) { d.error('Choisissez un dossier de destination.'); return; }
          const finalRule = {
            ...rule, accountId: accSel.value, match: matchSel.value, conditions, folder: folderSel.value,
            name: conditions.map((c) => c.value).join(', '),
          };
          btn.disabled = true;
          try {
            if (existing) await call(api.rules.update(finalRule));
            else {
              finalRule.id = 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
              await call(api.rules.add(finalRule));
            }
            state.rules = await call(api.rules.list());
            d.close();
            renderRulesPanel();
            toast('Règle enregistrée.');
          } catch (err) { btn.disabled = false; d.error(err.message); }
        },
      },
    ],
  });
}

// -------------------------------------------------------------------- réglages

async function renderSettingsPanel() {
  const panel = $('#panel');
  clear(panel);
  let encryption = true;
  try { encryption = await call(api.accounts.encryptionAvailable()); } catch (_) { /* ignore */ }

  const themeBtn = (value, label) => h('button', { class: state.prefs.theme === value ? 'on' : '', on: { click: async () => {
    state.prefs = await call(api.prefs.set({ theme: value }));
    applyTheme();
    renderSettingsPanel();
  } } }, label);

  panel.appendChild(h('div', { class: 'panel-inner' },
    h('h1', null, 'Réglages'),
    h('p', { class: 'lead' }, 'Apparence et comptes connectés.'),
    h('h3', null, 'Apparence'),
    h('div', { class: 'seg' }, themeBtn('auto', 'Automatique'), themeBtn('light', 'Clair'), themeBtn('dark', 'Sombre'), themeBtn('graphite', 'Graphite')),
    h('h3', null, 'Lecture des messages'),
    h('div', { class: 'seg' }, LAYOUTS.map((l) => h('button', { class: layoutPref() === l.id ? 'on' : '', on: { click: async () => { await setLayout(l.id); renderSettingsPanel(); } } }, l.short))),
    h('div', { class: 'field', style: 'margin-top:10px' },
      h('label', null, 'Largeur des correspondants (px)'),
      h('input', { type: 'number', value: state.prefs.listFromWidth || 230, on: { change: async (e) => {
        state.prefs = await call(api.prefs.set({ listFromWidth: Number(e.target.value) }));
        applySizes();
      } } })),
    h('p', { class: 'lead', style: 'margin:8px 0 0' }, 'Ce choix est aussi disponible en haut de la liste des messages. Un double-clic sur un message l’ouvre en plein écran, quelle que soit la disposition (en mode plein écran, un simple clic sélectionne seulement).'),
    h('h3', null, 'Contenu distant (images des e-mails)'),
    h('div', { class: 'seg' },
      [['ask', 'Demander à chaque message'], ['always', 'Toujours afficher']].map(([v, label]) => h('button', {
        class: (state.prefs.remoteContent === 'always' ? 'always' : 'ask') === v ? 'on' : '',
        on: { click: async () => { state.prefs = await call(api.prefs.set({ remoteContent: v })); renderSettingsPanel(); } },
      }, label))),
    h('p', { class: 'lead', style: 'margin:8px 0 0' }, 'Les images distantes peuvent signaler à l’expéditeur que vous avez ouvert son message. Elles ne sont jamais chargées tant que vous ne l’avez pas autorisé ici ou dans le message.'),
    h('h3', null, 'Tri'),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: state.prefs.autoRuleOnDrop !== false, on: { change: async (e) => {
        try { state.prefs = await call(api.prefs.set({ autoRuleOnDrop: e.target.checked })); }
        catch (err) { e.target.checked = !e.target.checked; toast(err.message, { error: true }); }
      } } }),
      h('span', null, 'Créer une règle de tri quand je glisse un message dans un dossier : les prochains messages de la même adresse y seront rangés automatiquement.')),
    h('h3', null, 'Carnet d’adresses'),
    h('p', { class: 'lead', style: 'margin:0 0 10px' }, 'MailHub retient les personnes à qui vous écrivez et vous les propose quand vous saisissez un destinataire.'),
    contactsSection(),
    h('h3', null, 'Notifications'),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: state.prefs.notifications !== false, on: { change: async (e) => {
        try {
          state.prefs = await call(api.prefs.set({ notifications: e.target.checked }));
          if (e.target.checked && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
            Notification.requestPermission();
          }
        } catch (err) { e.target.checked = !e.target.checked; toast(err.message, { error: true }); }
      } } }),
      h('span', null, 'Activer les notifications système pour les nouveaux e-mails et les messages rangés automatiquement.')),
    h('h3', null, 'Démarrage'),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: !!state.prefs.openAtLogin, on: { change: async (e) => {
        try { state.prefs = await call(api.prefs.set({ openAtLogin: e.target.checked })); }
        catch (err) { e.target.checked = !e.target.checked; toast(err.message, { error: true }); }
      } } }),
      h('span', null, 'Lancer MailHub à l’ouverture de session, sans fenêtre. Le tri automatique ne fonctionne que lorsque MailHub est en marche.')),
    h('h3', null, 'Mises à jour'),
    h('div', { class: 'toolbar-row', style: 'align-items:center; gap:12px; margin-bottom:12px;' },
      h('button', { class: 'ghost', on: { click: async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = 'Vérification…';
        try {
          const res = await call(api.updates.check());
          if (res.dev) {
            toast('Mode développement : les mises à jour automatiques sont désactivées.');
          } else if (res.noRelease) {
            toast(res.message || 'Aucune mise à jour publiée pour cette plateforme.');
          } else if (res.update) {
            toast(`Mise à jour disponible (${res.latest || res.info?.version}) !`, {
              timeout: 20000,
              actions: [
                {
                  label: 'Télécharger sur GitHub',
                  onClick: () => window.open('https://github.com/Theocitron73/Mailhub/releases/latest', '_blank'),
                },
              ],
            });
          } else {
            toast('MailHub est à jour.');
          }
        } catch (err) {
          toast(err.message, { error: true });
        } finally {
          btn.disabled = false;
          btn.textContent = 'Vérifier les mises à jour';
        }
      } } }, 'Vérifier les mises à jour')),
    h('h3', null, 'Sauvegarde et migration'),
    h('div', { class: 'toolbar-row', style: 'align-items:center; gap:12px; margin-bottom:12px;' },
      h('button', { class: 'ghost', on: { click: async () => {
        try {
          const res = await call(api.settings.export());
          if (res.saved) toast('Réglages exportés avec succès !');
        } catch (err) { toast(err.message, { error: true }); }
      } } }, 'Exporter les réglages'),
      h('button', { class: 'ghost', on: { click: async () => {
        try {
          const res = await call(api.settings.import());
          if (res.imported) {
            toast('Réglages importés avec succès ! Redémarrage nécessaire.');
            window.location.reload();
          }
        } catch (err) { toast(err.message, { error: true }); }
      } } }, 'Importer les réglages')),
    h('h3', null, 'Comptes'),
    !encryption ? h('div', { class: 'notice' }, 'Le chiffrement du système (Trousseau macOS ou Windows) n’est pas disponible : les mots de passe sont enregistrés avec un simple encodage. Utilisez des mots de passe d’application.') : null,
    state.accounts.map((a) => h('div', { class: 'acc-row', vars: { '--acc': a.color } },
      h('span', { class: 'swatch' }),
      h('div', { class: 'info' }, h('b', null, a.name), h('small', null, `${a.email} · ${a.imap.host}:${a.imap.port}`),
        h('small', null, (a.signatures || []).length ? `${a.signatures.length} ${plural(a.signatures.length, 'signature', 'signatures')}` : 'Aucune signature')),
      h('button', { class: 'ghost', on: { click: () => openAddAccount(a) } }, 'Modifier…'),
      h('button', { class: 'ghost', on: { click: () => openSignatures(a) } }, 'Signatures…'),
      h('button', { class: 'danger', on: { click: () => removeAccount(a) } }, 'Retirer'))),
    h('div', { class: 'toolbar-row', style: 'margin-top:16px' },
      h('button', { class: 'primary', on: { click: () => openAddAccount() } }, ico('plus', 16), 'Ajouter un compte'))));
}

function contactsSection() {
  const wrap = h('div');
  const list = h('div', { class: 'contact-list' });
  const filter = h('input', { type: 'search', placeholder: 'Filtrer le carnet', autocomplete: 'off', spellcheck: 'false' });
  const count = h('span', { class: 'lead', style: 'margin:0' });
  const draw = () => {
    clear(list);
    const q = filter.value.trim().toLowerCase();
    const shown = state.contacts.filter((c) => !q || `${c.name} ${c.email}`.toLowerCase().includes(q));
    count.textContent = `${state.contacts.length} ${plural(state.contacts.length, 'contact', 'contacts')}`;
    list.hidden = !shown.length;
    shown.slice(0, 200).forEach((c) => list.appendChild(h('div', { class: 'contact-row' },
      h('div', { class: 'info' }, c.name || c.email, c.name ? h('small', null, c.email) : null),
      h('button', { class: 'icon-btn', title: 'Retirer du carnet', 'aria-label': 'Retirer ' + c.email, on: { click: async () => {
        try { state.contacts = await call(api.contacts.remove(c.email)); draw(); } catch (err) { toast(err.message, { error: true }); }
      } } }, ico('close', 15)))));
  };
  const importBtn = h('button', { class: 'ghost', on: { click: async () => {
    importBtn.disabled = true;
    try {
      const r = await call(api.contacts.importSent());
      state.contacts = r.contacts;
      toast(r.added ? `${r.added} ${plural(r.added, 'contact ajouté', 'contacts ajoutés')} depuis vos messages envoyés.` : 'Aucun nouveau contact trouvé dans vos messages envoyés.');
      draw();
    } catch (err) { toast(err.message, { error: true }); }
    importBtn.disabled = false;
  } } }, 'Importer depuis mes messages envoyés');
  filter.addEventListener('input', draw);
  wrap.append(h('div', { class: 'toolbar-row', style: 'margin-bottom:0' }, importBtn, count), filter, list);
  draw();
  return wrap;
}

function openSignatures(acc) {
  let sigs = (acc.signatures || []).map((x) => ({ ...x }));
  let def = acc.defaultSignature || '';
  let sel = sigs[0] ? sigs[0].id : '';
  const listBox = h('div', { class: 'sig-list' });
  const form = h('div', { class: 'sig-form' });
  const draw = () => {
    clear(listBox);
    sigs.forEach((sg) => listBox.appendChild(h('button', { class: sg.id === sel ? 'on' : '', on: { click: () => { sel = sg.id; draw(); } } },
      h('span', null, sg.name || 'Sans nom'), sg.id === def ? h('span', { class: 'tag' }, 'par défaut') : null)));
    listBox.appendChild(h('button', { on: { click: () => {
      const sg = { id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: 'Signature ' + (sigs.length + 1), text: '' };
      sigs.push(sg); sel = sg.id; if (!def) def = sg.id; draw();
    } } }, h('span', null, '+ Nouvelle signature')));
    clear(form);
    const cur = sigs.find((x) => x.id === sel);
    if (!cur) { form.appendChild(h('p', { class: 'lead', style: 'margin:0' }, 'Aucune signature pour ce compte. Créez-en une, par exemple « Professionnelle » et « Personnelle ». Vous pourrez choisir laquelle utiliser à chaque nouveau message.')); return; }
    const name = h('input', { type: 'text', value: cur.name, maxlength: '80' });
    const text = h('textarea', { rows: '6', placeholder: 'Cordialement,\nPrénom Nom' });
    text.value = cur.text;
    cur.images = cur.images || [];
    const imgBox = h('div', { class: 'sig-imgs' });
    const drawImgs = () => {
      clear(imgBox);
      cur.images.forEach((im, i) => {
        const w = h('input', { type: 'number', min: '16', max: '800', value: String(im.width || 200), 'aria-label': 'Largeur en pixels' });
        w.addEventListener('input', () => { im.width = Math.max(16, Math.min(800, Number(w.value) || 200)); });
        imgBox.appendChild(h('div', { class: 'sig-img' },
          h('img', { src: im.dataUrl, alt: im.name }),
          h('div', { class: 'meta' }, h('span', { class: 'nm', title: im.name }, im.name), h('label', null, 'Largeur ', w, ' px')),
          h('button', { class: 'icon-btn', title: 'Retirer l’image', 'aria-label': 'Retirer l’image', on: { click: () => { cur.images.splice(i, 1); drawImgs(); } } }, ico('close', 15))));
      });
    };
    drawImgs();
    const addImg = h('button', { class: 'subtle', on: { click: async () => {
      if (cur.images.length >= 6) { dlg.error('6 images au maximum par signature.'); return; }
      try {
        const im = await call(api.signatures.pickImage());
        if (!im) return;
        dlg.error('');
        const natural = await new Promise((resolve) => { const t = new Image(); t.onload = () => resolve(t.naturalWidth); t.onerror = () => resolve(200); t.src = im.dataUrl; });
        im.width = Math.min(natural || 200, 300);
        cur.images.push(im);
        drawImgs();
      } catch (err) { dlg.error(err.message); }
    } } }, ico('plus', 15), 'Ajouter une image ou un GIF…');
    name.addEventListener('input', () => { cur.name = name.value; const b = listBox.querySelector('button.on span'); if (b) b.textContent = name.value || 'Sans nom'; });
    text.addEventListener('input', () => { cur.text = text.value; });
    form.append(
      h('div', { class: 'field' }, h('label', null, 'Nom (visible dans la liste)'), name),
      h('div', { class: 'field' }, h('label', null, 'Texte de la signature'), text),
      h('div', { class: 'field' }, h('label', null, 'Images (logo, GIF…)'), imgBox, h('div', null, addImg),
        h('small', null, 'png, jpg, gif ou webp, 1,5 Mo maximum chacune. Avec des images, le message part en HTML ; les GIF restent animés chez les destinataires qui les affichent.')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: def === cur.id, on: { change: (e) => { def = e.target.checked ? cur.id : (def === cur.id ? '' : def); draw(); } } }),
        h('span', null, 'Utiliser par défaut pour les nouveaux messages de ce compte')),
      h('div', null, h('button', { class: 'danger', on: { click: () => {
        sigs = sigs.filter((x) => x.id !== cur.id); if (def === cur.id) def = ''; sel = sigs[0] ? sigs[0].id : ''; draw();
      } } }, 'Supprimer cette signature')));
  };
  const dlg = openDialog({
    title: `Signatures · ${acc.email}`, large: true,
    subtitle: 'Plusieurs signatures par adresse. Dans la rédaction d’un message, une liste « Signature » permet de choisir.',
    body: h('div', { class: 'sig-editor' }, listBox, form),
    buttons: [
      { label: 'Annuler', onClick: (d) => d.close() },
      { label: 'Enregistrer', kind: 'primary', onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          const updated = await call(api.accounts.update(acc.id, { signatures: sigs, defaultSignature: def }));
          const i = state.accounts.findIndex((x) => x.id === acc.id);
          if (i >= 0) state.accounts[i] = updated;
          d.close();
          renderSettingsPanel();
          toast('Signatures enregistrées.');
        } catch (err) { btn.disabled = false; d.error(err.message); }
      } },
    ],
  });
  draw();
}

async function removeAccount(a) {
  const ok = await confirmDialog({
    title: `Retirer ${a.email} ?`,
    body: 'Le compte et ses règles de tri sont supprimés de MailHub. Vos messages restent sur le serveur.',
    confirm: 'Retirer le compte', danger: true,
  });
  if (!ok) return;
  try {
    await call(api.accounts.remove(a.id));
    state.accounts = state.accounts.filter((x) => x.id !== a.id);
    delete state.folders[a.id];
    state.rules = await call(api.rules.list());
    if (state.current.accountId === a.id) { state.current = { accountId: 'unified', folder: 'INBOX' }; }
    if (!state.accounts.length) { showPanel('welcome'); return; }
    renderSettingsPanel();
    renderSidebar();
    toast('Compte retiré.');
  } catch (err) { toast(err.message, { error: true }); }
}

function renderWelcome() {
  const panel = $('#panel');
  clear(panel);
  panel.appendChild(h('div', { style: 'display:flex;height:100%' }, h('div', { class: 'welcome' },
    h('h2', null, 'Toutes vos boîtes mail, un seul tri.'),
    h('p', null, 'Ajoutez vos comptes IMAP. MailHub récupère vos dossiers existants, et apprend à ranger vos prochains messages au fil de vos choix.'),
    h('button', { class: 'primary', on: { click: () => openAddAccount() } }, ico('plus', 16), 'Ajouter un compte'))));
}

// --------------------------------------------------------------- ajout de compte

const PRESETS = [
  { domains: ['gmail.com', 'googlemail.com'], imap: ['imap.gmail.com', 993, true], smtp: ['smtp.gmail.com', 465, true], note: 'Gmail demande un mot de passe d’application : activez la validation en deux étapes, puis créez-le sur myaccount.google.com/apppasswords.' },
  { domains: ['icloud.com', 'me.com', 'mac.com'], imap: ['imap.mail.me.com', 993, true], smtp: ['smtp.mail.me.com', 587, false], note: 'iCloud demande un mot de passe d’application, à créer sur appleid.apple.com.' },
  { domains: ['yahoo.com', 'yahoo.fr', 'ymail.com'], imap: ['imap.mail.yahoo.com', 993, true], smtp: ['smtp.mail.yahoo.com', 465, true], note: 'Yahoo demande un mot de passe d’application, à créer dans la sécurité du compte.' },
  { domains: ['outlook.com', 'hotmail.com', 'hotmail.fr', 'live.com', 'live.fr', 'msn.com'], imap: ['outlook.office365.com', 993, true], smtp: ['smtp-mail.outlook.com', 587, false], warn: 'Microsoft a désactivé les mots de passe pour IMAP sur les comptes Outlook.com et Hotmail : la connexion échouera tant que l’authentification OAuth2 n’est pas prise en charge par MailHub.' },
  { domains: ['orange.fr', 'wanadoo.fr'], imap: ['imap.orange.fr', 993, true], smtp: ['smtp.orange.fr', 465, true] },
  { domains: ['free.fr'], imap: ['imap.free.fr', 993, true], smtp: ['smtp.free.fr', 465, true] },
  { domains: ['sfr.fr', 'neuf.fr'], imap: ['imap.sfr.fr', 993, true], smtp: ['smtp.sfr.fr', 465, true] },
  { domains: ['laposte.net'], imap: ['imap.laposte.net', 993, true], smtp: ['smtp.laposte.net', 465, true] },
  { domains: ['gmx.com', 'gmx.fr', 'gmx.net'], imap: ['imap.gmx.com', 993, true], smtp: ['mail.gmx.com', 587, false] },
  { domains: ['aol.com'], imap: ['imap.aol.com', 993, true], smtp: ['smtp.aol.com', 465, true] },
  { domains: ['zoho.com'], imap: ['imap.zoho.com', 993, true], smtp: ['smtp.zoho.com', 465, true] },
  { domains: ['fastmail.com', 'fastmail.fm'], imap: ['imap.fastmail.com', 993, true], smtp: ['smtp.fastmail.com', 465, true] },
  { domains: ['proton.me', 'protonmail.com', 'pm.me'], imap: ['127.0.0.1', 1143, false], smtp: ['127.0.0.1', 1025, false], note: 'Proton Mail passe par Proton Mail Bridge, qui doit être installé et lancé sur cet ordinateur. Utilisez le mot de passe fourni par Bridge.' },
];

function colorPicker(initial) {
  let value = initial;
  const box = h('div', { class: 'color-grid' });
  const custom = h('input', { type: 'color', value: HEX_RE.test(initial) ? initial : '#6366f1', 'aria-label': 'Couleur personnalisée', class: 'color-input' });
  const draw = () => {
    clear(box);
    FOLDER_COLORS.forEach((c) => box.appendChild(h('button', { type: 'button', class: 'color-dot' + (c === value ? ' on' : ''), vars: { '--c': c }, title: c, 'aria-label': 'Couleur ' + c, on: { click: () => { value = c; custom.value = c; draw(); } } })));
    box.appendChild(h('label', { class: 'color-custom', title: 'Couleur personnalisée' }, custom, h('span', null, 'Autre…')));
  };
  custom.addEventListener('input', () => { value = custom.value.toLowerCase(); draw(); });
  draw();
  return { el: box, get: () => value };
}

function openAddAccount(existing) {
  const editing = !!existing;
  const color = colorPicker(editing ? (existing.color || FOLDER_COLORS[0]) : FOLDER_COLORS[5]);
  const email = h('input', { type: 'email', placeholder: 'vous@exemple.com', spellcheck: 'false', autocomplete: 'off' });
  const password = h('input', { type: 'password', autocomplete: 'off', placeholder: editing ? 'Laisser vide pour conserver le mot de passe actuel' : '' });
  const name = h('input', { type: 'text', placeholder: 'Perso, Travail…' });
  const note = h('div', { class: 'notice info', hidden: true });
  const imapHost = h('input', { type: 'text', placeholder: 'imap.exemple.com', spellcheck: 'false' });
  const imapPort = h('input', { type: 'number', value: '993' });
  const imapSec = h('select', null, h('option', { value: 'ssl' }, 'SSL/TLS'), h('option', { value: 'starttls' }, 'STARTTLS'));
  const user = h('input', { type: 'text', placeholder: 'Identique à l’adresse e-mail', spellcheck: 'false' });
  const smtpHost = h('input', { type: 'text', placeholder: 'smtp.exemple.com', spellcheck: 'false' });
  const smtpPort = h('input', { type: 'number', value: '465' });
  const smtpSec = h('select', null, h('option', { value: 'ssl' }, 'SSL/TLS'), h('option', { value: 'starttls' }, 'STARTTLS'));
  const adv = h('details', { class: 'adv' }, h('summary', null, 'Paramètres du serveur'),
    h('div', { style: 'display:grid;gap:12px' },
      h('div', { class: 'grid3' }, h('div', { class: 'field' }, h('label', null, 'Serveur IMAP'), imapHost), h('div', { class: 'field' }, h('label', null, 'Port'), imapPort), h('div', { class: 'field' }, h('label', null, 'Chiffrement'), imapSec)),
      h('div', { class: 'field' }, h('label', null, 'Identifiant'), user),
      h('div', { class: 'grid3' }, h('div', { class: 'field' }, h('label', null, 'Serveur SMTP (envoi)'), smtpHost), h('div', { class: 'field' }, h('label', null, 'Port'), smtpPort), h('div', { class: 'field' }, h('label', null, 'Chiffrement'), smtpSec))));

  const applyPreset = () => {
    const domain = domainOf(email.value.trim());
    if (!domain) return;
    const p = PRESETS.find((x) => x.domains.includes(domain));
    if (p) {
      [imapHost.value, imapPort.value] = [p.imap[0], String(p.imap[1])];
      imapSec.value = p.imap[2] ? 'ssl' : 'starttls';
      [smtpHost.value, smtpPort.value] = [p.smtp[0], String(p.smtp[1])];
      smtpSec.value = p.smtp[2] ? 'ssl' : 'starttls';
      const text = p.warn || p.note;
      note.hidden = !text;
      note.textContent = text || '';
      note.className = 'notice' + (p.warn ? '' : ' info');
    } else {
      imapHost.value = 'imap.' + domain; imapPort.value = '993'; imapSec.value = 'ssl';
      smtpHost.value = 'smtp.' + domain; smtpPort.value = '465'; smtpSec.value = 'ssl';
      note.hidden = false;
      note.className = 'notice info';
      note.textContent = 'Serveur inconnu : vérifiez les paramètres ci-dessous auprès de votre hébergeur.';
      adv.open = true;
    }
  };
  if (editing) {
    email.value = existing.email;
    name.value = existing.name;
    imapHost.value = existing.imap.host; imapPort.value = String(existing.imap.port); imapSec.value = existing.imap.secure ? 'ssl' : 'starttls';
    user.value = existing.imap.user === existing.email ? '' : existing.imap.user;
    if (existing.smtp) { smtpHost.value = existing.smtp.host; smtpPort.value = String(existing.smtp.port); smtpSec.value = existing.smtp.secure ? 'ssl' : 'starttls'; }
    else { smtpHost.value = ''; }
    adv.open = true;
  }
  // en modification, les serveurs ne sont réécrits que si le domaine de l'adresse change
  email.addEventListener('change', () => { if (!editing || domainOf(email.value.trim()) !== domainOf(existing.email)) applyPreset(); });

  const dlg = openDialog({
    title: editing ? 'Modifier le compte' : 'Ajouter un compte',
    subtitle: editing ? 'Les paramètres sont vérifiés auprès du serveur avant d’être enregistrés.' : 'Connexion IMAP. Le mot de passe est chiffré sur cet ordinateur.',
    body: [
      h('div', { class: 'field' }, h('label', null, 'Adresse e-mail'), email),
      h('div', { class: 'field' }, h('label', null, 'Mot de passe'), password),
      h('div', { class: 'field' }, h('label', null, editing ? 'Nom du compte' : 'Nom du compte (facultatif)'), name),
      h('div', { class: 'field' }, h('label', null, 'Couleur du compte'), color.el),
      note, adv,
    ],
    buttons: [
      { label: 'Annuler', onClick: (d) => d.close() },
      {
        id: 'add', label: editing ? 'Enregistrer' : 'Se connecter', kind: 'primary',
        onClick: async (d, btn) => {
          const addr = email.value.trim();
          if (editing) { await saveEdit(d, btn, addr); return; }
          if (!addr.includes('@') || !password.value) { d.error('Saisissez l’adresse e-mail et le mot de passe.'); return; }
          if (!imapHost.value.trim()) applyPreset();
          if (!imapHost.value.trim()) { d.error('Indiquez le serveur IMAP.'); return; }
          btn.disabled = true;
          btn.textContent = 'Connexion…';
          d.error('');
          const cfg = {
            name: name.value.trim() || addr, email: addr, password: password.value, color: color.get(),
            imap: { host: imapHost.value.trim(), port: Number(imapPort.value) || 993, secure: imapSec.value === 'ssl', user: user.value.trim() || addr },
            smtp: smtpHost.value.trim() ? { host: smtpHost.value.trim(), port: Number(smtpPort.value) || 465, secure: smtpSec.value === 'ssl', user: user.value.trim() || addr } : null,
          };
          try {
            const acc = await call(api.accounts.add(cfg));
            state.accounts.push(acc);
            state.open[acc.id] = true;
            d.close();
            await loadFolders(acc.id);
            toast(`${acc.email} est connecté.`);
            await selectFolder(state.accounts.length > 1 ? 'unified' : acc.id, 'INBOX');
          } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Se connecter';
            d.error(err.message);
          }
        },
      },
    ],
  });
  async function saveEdit(d, btn, addr) {
    if (!addr.includes('@')) { d.error('Saisissez une adresse e-mail valide.'); return; }
    if (!imapHost.value.trim()) { d.error('Indiquez le serveur IMAP.'); return; }
    const login = user.value.trim() || addr;
    const imap = { host: imapHost.value.trim(), port: Number(imapPort.value) || 993, secure: imapSec.value === 'ssl', user: login };
    const smtp = smtpHost.value.trim() ? { host: smtpHost.value.trim(), port: Number(smtpPort.value) || 465, secure: smtpSec.value === 'ssl', user: login } : null;
    const patch = { name: name.value.trim() || addr, color: color.get(), smtp };
    const serverChanged = addr !== existing.email || JSON.stringify(imap) !== JSON.stringify(existing.imap) || !!password.value;
    if (serverChanged) { patch.email = addr; patch.imap = imap; }
    if (password.value) patch.password = password.value;
    btn.disabled = true;
    btn.textContent = serverChanged ? 'Vérification…' : 'Enregistrement…';
    d.error('');
    try {
      const updated = await call(api.accounts.update(existing.id, patch));
      const i = state.accounts.findIndex((x) => x.id === existing.id);
      if (i >= 0) state.accounts[i] = updated;
      d.close();
      renderSidebar();
      renderList();
      if (state.view === 'settings') renderSettingsPanel();
      if (state.view === 'rules') renderRulesPanel();
      toast('Compte mis à jour.');
      if (serverChanged) { await loadFolders(existing.id); if (state.current.accountId === existing.id || state.current.accountId === 'unified') loadMessages({ silent: true }); }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Enregistrer';
      d.error(err.message);
    }
  }
  email.focus();
}


// ------------------------------------------------------ import Thunderbird

async function exportRules() {
  try {
    const r = await call(api.rules.export());
    if (r.saved) toast(`${r.count} ${plural(r.count, 'règle exportée', 'règles exportées')} dans « ${r.path.split(/[\\/]/).pop()} ».`);
  } catch (err) { toast(err.message, { error: true }); }
}

async function openRulesImport() {
  let data;
  try { data = await call(api.rules.importPick()); } catch (err) { toast(err.message, { error: true }); return; }
  if (!data) return;
  if (!data.rules.length) { toast(`Aucune règle valide dans « ${data.file} ».`, { error: true }); return; }
  const mapping = { ...data.mapping };
  const items = data.rules.map((r) => ({ ...r }));
  const boxes = [];
  const listBox = h('div', { class: 'import-list' });
  const mapBox = h('div', { class: 'field' });
  const countLabel = h('span');

  const accOptions = (sel) => [h('option', { value: '' }, 'Ne pas importer'), ...state.accounts.map((a) => h('option', { value: a.id }, `${a.name} <${a.email}>`))];
  data.emails.forEach((email) => {
    const sel = h('select', null, accOptions());
    sel.value = mapping[email] || '';
    sel.addEventListener('change', async () => { mapping[email] = sel.value; await refresh(); });
    mapBox.appendChild(h('div', { class: 'row-line', style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center;margin-top:6px' }, h('span', null, email), sel));
  });

  async function refresh() {
    const payload = items.map((it) => ({ ...it, accountId: mapping[it.accountEmail] || '' }));
    let dup = [];
    try { dup = await call(api.rules.duplicates(payload)); } catch (_) { /* on garde l'affichage */ }
    clear(listBox);
    boxes.length = 0;
    items.forEach((it, i) => {
      const accId = mapping[it.accountEmail];
      const skip = !accId;
      const isDup = !!dup[i];
      const box = h('input', { type: 'checkbox', checked: !skip && !isDup, disabled: skip });
      box.addEventListener('change', update);
      boxes.push(box);
      listBox.appendChild(h('label', { class: 'import-item' + (skip || isDup ? ' off' : '') }, box,
        h('div', null,
          h('div', null, 'Si ', describeRule(it), ' → ', h('span', { class: 'dest' }, ico('folder', 14), it.folder)),
          h('small', null, skip ? 'Compte non associé' : isDup ? 'Déjà présente' : (it.enabled ? '' : 'Désactivée dans le fichier')))));
    });
    update();
  }
  function update() {
    const n = boxes.filter((b) => b.checked).length;
    countLabel.textContent = `${n} ${plural(n, 'règle sera importée', 'règles seront importées')}`;
    dlg.buttons.go.disabled = n === 0;
    dlg.buttons.go.textContent = `Importer ${n} ${plural(n, 'règle', 'règles')}`;
  }

  const dlg = openDialog({
    title: 'Importer des règles de tri', large: true,
    subtitle: `Fichier « ${data.file} » : ${data.rules.length} ${plural(data.rules.length, 'règle', 'règles')}${data.skipped ? `, ${data.skipped} ignorée${data.skipped > 1 ? 's' : ''} (invalide${data.skipped > 1 ? 's' : ''})` : ''}. Les règles sont ajoutées à la suite des vôtres ; un dossier absent sera créé au premier message rangé.`,
    body: h('div', { style: 'display:grid;gap:12px' },
      h('div', { class: 'field' }, h('label', null, 'Comptes'), h('small', null, 'Associez chaque adresse du fichier à un compte de cet ordinateur.'), mapBox),
      listBox, countLabel),
    buttons: [
      { label: 'Annuler', onClick: (d) => d.close() },
      { id: 'go', label: 'Importer', kind: 'primary', onClick: async (d, btn) => {
        const chosen = items.filter((it, i) => boxes[i] && boxes[i].checked);
        if (!chosen.length) return;
        btn.disabled = true;
        try {
          await call(api.rules.addMany(chosen.map((it) => ({
            accountId: mapping[it.accountEmail], name: it.name, enabled: it.enabled, match: it.match, folder: it.folder, conditions: it.conditions, source: 'import',
          }))));
          state.rules = await call(api.rules.list());
          d.close();
          showPanel('rules');
          toast(`${chosen.length} ${plural(chosen.length, 'règle importée', 'règles importées')}.`);
        } catch (err) { btn.disabled = false; d.error(err.message); }
      } },
    ],
  });
  await refresh();
}

async function openThunderbirdImport() {
  if (!state.accounts.length) { toast('Ajoutez d’abord un compte.', { error: true }); return; }
  let files = [];
  let chosen = null;
  const listBox = h('div', { style: 'display:grid;gap:8px' }, h('div', { class: 'loading', style: 'padding:0' }, 'Recherche de votre profil Thunderbird…'));
  const accSel = h('select', null, state.accounts.map((a) => h('option', { value: a.id }, `${a.name} <${a.email}>`)));
  const help = h('small', null);

  const renderFiles = () => {
    clear(listBox);
    if (!files.length) {
      listBox.appendChild(h('div', { class: 'notice info' }, 'Aucun profil Thunderbird trouvé à l’emplacement habituel. Choisissez le fichier vous-même.'));
      help.textContent = 'Le fichier s’appelle msgFilterRules.dat. Dans Thunderbird : menu ≡, Aide, Plus d’informations de dépannage, Dossier du profil, Ouvrir le dossier. Il se trouve ensuite dans ImapMail, puis dans le dossier du serveur de votre compte.';
      return;
    }
    files.forEach((f) => {
      const radio = h('input', { type: 'radio', name: 'tbfile', checked: chosen === f, on: { change: () => {
        chosen = f;
        if (f.suggestedAccountId) accSel.value = f.suggestedAccountId;
        dlg.buttons.next.disabled = false;
      } } });
      listBox.appendChild(h('label', { class: 'file-option' }, radio,
        h('span', null, h('b', null, f.server), h('small', null, `${f.filters} ${plural(f.filters, 'filtre', 'filtres')}${f.profile ? ' · profil ' + f.profile : ''}`))));
    });
    help.textContent = 'Vous ne voyez pas le bon compte ? Choisissez le fichier msgFilterRules.dat vous-même.';
  };

  const pick = async () => {
    try {
      const f = await call(api.thunderbird.pick());
      if (!f) return;
      files = files.filter((x) => x.file !== f.file).concat(f);
      chosen = f;
      if (f.suggestedAccountId) accSel.value = f.suggestedAccountId;
      renderFiles();
      dlg.buttons.next.disabled = false;
      dlg.error('');
    } catch (err) { dlg.error(err.message); }
  };

  const dlg = openDialog({
    title: 'Importer des filtres Thunderbird',
    subtitle: 'MailHub lit le fichier de filtres de Thunderbird sans le modifier. Vous vérifiez la liste avant tout import.',
    large: true,
    body: [
      listBox,
      h('div', null, h('button', { class: 'ghost', on: { click: pick } }, ico('folder', 16), 'Choisir un fichier…')),
      h('div', { class: 'field' }, h('label', null, 'Importer dans le compte'), accSel, help),
    ],
    buttons: [
      { label: 'Annuler', onClick: (d) => d.close() },
      { id: 'next', label: 'Voir les filtres', kind: 'primary', onClick: (d) => { if (!chosen) return; const file = chosen.file; d.close(); openImportPreview(file, accSel.value); } },
    ],
  });
  dlg.buttons.next.disabled = true;

  try {
    files = await call(api.thunderbird.scan());
    if (files.length === 1) { chosen = files[0]; if (chosen.suggestedAccountId) accSel.value = chosen.suggestedAccountId; dlg.buttons.next.disabled = false; }
  } catch (err) { files = []; dlg.error(err.message); }
  renderFiles();
}

async function openImportPreview(file, accountId) {
  const acc = accountById(accountId);
  const listBox = h('div', { class: 'loading', style: 'padding:0' }, 'Lecture des filtres et comparaison avec les dossiers de ce compte…');
  const summary = h('div', { class: 'import-summary' });
  const boxes = [];
  let items = [];

  const refresh = () => {
    const n = boxes.filter((b) => b.checked).length;
    dlg.buttons.go.textContent = n ? `Importer ${n} ${plural(n, 'règle', 'règles')}` : 'Rien à importer';
    dlg.buttons.go.disabled = n === 0;
  };

  const dlg = openDialog({
    title: 'Filtres à importer',
    subtitle: `Vers ${acc.email}`,
    large: true,
    body: [summary, listBox],
    buttons: [
      { label: 'Annuler', onClick: (d) => d.close() },
      {
        id: 'go', label: 'Importer', kind: 'primary',
        onClick: async (d, btn) => {
          const chosenItems = items.filter((it, i) => boxes[i] && boxes[i].checked);
          if (!chosenItems.length) return;
          btn.disabled = true;
          d.error('');
          try {
            const missing = [...new Set(chosenItems.filter((it) => it.folder.status === 'missing').map((it) => it.folder.path))];
            for (const path of missing) {
              try { await call(api.folders.create(accountId, path)); }
              catch (err) { if (!/exist/i.test(err.message)) throw new Error(`Création du dossier « ${path} » impossible : ${err.message}`); }
            }
            if (missing.length) await loadFolders(accountId);
            await call(api.rules.addMany(chosenItems.map((it) => it.rule)));
            state.rules = await call(api.rules.list());
            d.close();
            showPanel('rules');
            toast(`${chosenItems.length} ${plural(chosenItems.length, 'règle importée', 'règles importées')} depuis Thunderbird${missing.length ? `, ${missing.length} ${plural(missing.length, 'dossier créé', 'dossiers créés')}` : ''}.`);
          } catch (err) { btn.disabled = false; d.error(err.message); }
        },
      },
    ],
  });
  dlg.buttons.go.disabled = true;

  try {
    items = await call(api.thunderbird.preview(file, accountId));
  } catch (err) { clear(listBox); listBox.className = ''; listBox.appendChild(h('div', { class: 'notice' }, err.message)); return; }

  const ok = items.filter((it) => it.rule);
  const dup = ok.filter((it) => it.duplicate).length;
  const skipped = items.length - ok.length;
  summary.textContent = `${items.length} ${plural(items.length, 'filtre trouvé', 'filtres trouvés')} : ${ok.length} ${plural(ok.length, 'reprenable', 'reprenables')}` +
    (skipped ? `, ${skipped} ${plural(skipped, 'ignoré', 'ignorés')} (voir la raison sous chacun)` : '') + (dup ? `, dont ${dup} déjà ${plural(dup, 'présent', 'présents')}` : '') + '.';

  listBox.className = 'import-list';
  clear(listBox);
  items.forEach((it, i) => {
    const box = h('input', { type: 'checkbox', checked: !!it.rule && !it.duplicate, disabled: !it.rule, 'aria-label': `Importer ${it.name}`, on: { change: refresh } });
    boxes[i] = box;
    const detail = h('div', { class: 'detail' });
    if (it.rule) {
      detail.append('Si ', describeRule(it.rule), ' → ',
        h('span', { class: 'chip' }, ico('folder', 13), it.folder.path),
        it.folder.status === 'missing' ? h('span', { class: 'chip warn', style: 'margin-left:6px' }, 'dossier à créer') : null,
        it.folder.status === 'approx' ? h('span', { class: 'chip', style: 'margin-left:6px' }, 'dossier retrouvé par son nom') : null,
        it.rule.match === 'any' ? ' (au moins une condition)' : '');
    } else {
      detail.append(`Ignoré : ${it.skip}.`);
    }
    listBox.appendChild(h('label', { class: 'import-item' + (it.rule ? '' : ' skipped') },
      box,
      h('div', null,
        h('div', { class: 'title' }, it.name || '(sans nom)', it.rule && it.rule.enabled === false ? h('span', { class: 'chip warn', style: 'margin-left:8px' }, 'désactivée') : null),
        detail,
        it.notes.map((n) => h('div', { class: 'detail' }, n)))));
  });
  refresh();
}

// --------------------------------------------------------------- événements

const refreshAccount = debounce(async (accountId) => {
  await loadFolders(accountId);
  const { accountId: cur, folder } = state.current;
  if (state.view === 'mail' && !state.query && (cur === 'unified' || (cur === accountId && folder === 'INBOX'))) loadMessages({ silent: true });
}, 800);

api.on('mail:changed', ({ accountId }) => refreshAccount(accountId));
api.on('mail:sorted', ({ moved }) => {
  toast(`${moved.length} ${plural(moved.length, 'nouveau message rangé', 'nouveaux messages rangés')} automatiquement.`);
  if (state.prefs.notifications !== false && typeof Notification !== 'undefined') {
    if (Notification.permission === 'granted' && moved.length) {
      const counts = {};
      moved.forEach((m) => { counts[m.folder] = (counts[m.folder] || 0) + 1; });
      const body = Object.entries(counts).map(([f, n]) => `${n} → ${f}`).join('\n');
      new Notification(`MailHub : ${moved.length} message(s) trié(s)`, { body });
    } else if (Notification.permission !== 'denied' && Notification.permission !== 'granted') {
      Notification.requestPermission();
    }
  }
});
api.on('account:status', ({ accountId, state: st }) => { state.status[accountId] = st; renderSidebar(); });
api.on('app:error', ({ message }) => toast(message, { error: true }));

api.on('app:updateAvailable', ({ version }) => {
  toast(`Une mise à jour (${version}) est disponible. Téléchargement en cours…`);
});

api.on('app:updateDownloaded', ({ version }) => {
  toast(`Mise à jour (${version}) téléchargée et prête !`, {
    timeout: 60000,
    actions: [
      {
        label: 'Redémarrer et mettre à jour',
        onClick: async () => {
          try {
            if (api.updates && api.updates.install) {
              await call(api.updates.install());
            }
          } catch (err) {
            toast('Impossible d’appliquer automatiquement la mise à jour : ' + err.message, { error: true });
          }
        },
      },
      {
        label: 'Télécharger (.dmg / .exe)',
        onClick: () => {
          window.open('https://github.com/Theocitron73/Mailhub/releases/latest', '_blank');
        },
      },
    ],
  });
});

$('#btn-compose').addEventListener('click', () => openCompose());
$('#btn-refresh').addEventListener('click', async () => {
  await Promise.all(state.accounts.map((a) => loadFolders(a.id)));
  loadMessages();
});
$('#nav-rules').addEventListener('click', () => (state.view === 'rules' ? showMail() : showPanel('rules')));
$('#nav-settings').addEventListener('click', () => (state.view === 'settings' ? showMail() : showPanel('settings')));

$('#search').addEventListener('input', debounce((e) => {
  state.query = e.target.value.trim();
  state.sel.clear();
  loadMessages();
}, 350));

api.on('app:closeTab', () => {
  if (state.tab !== 'list') closeActiveTab();
  else api.app.hide();
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && state.tabs.length && !$('#modal-root').firstChild) {
    if (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      cycleTab(e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1);
      return;
    }
  }
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag) || $('#modal-root').firstChild || state.view !== 'mail') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (state.tab !== 'list') {
    const t = activeTabObj();
    if (e.key === 'r' && t && t.kind === 'mail' && t.o.detail) { e.preventDefault(); replyTo(t.o); }
    return; // la liste est masquée : ses raccourcis ne s'appliquent pas
  }
  if (e.key === 'Escape') return;
  const selKeys = [...state.sel];
  const idx = state.opened ? state.messages.findIndex((m) => keyOf(m) === keyOf(state.opened.msg))
    : (selKeys.length === 1 ? state.messages.findIndex((m) => keyOf(m) === selKeys[0]) : -1);
  if (e.key === 'Enter' && selKeys.length === 1) {
    const m = state.messages[idx];
    if (m) { e.preventDefault(); onRowDblClick(m); return; }
  }
  if (e.key === 's' && selKeys.length) { e.preventDefault(); const sel = selectedMessages(); const on = !sel.every((m) => m.flagged); sel.forEach((m) => { if (!!m.flagged !== on) toggleFlag(m); }); return; }
  const go = (i) => {
    const m = state.messages[i];
    if (!m) return;
    selectOnly(m);
    if (layoutPref() === 'full') renderList(); else openMessage(m);
    const row = $('#list-rows').children[i];
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  };
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); go(Math.min(idx + 1, state.messages.length - 1)); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); go(Math.max(idx - 1, 0)); }
  else if (e.key === 'Delete' || e.key === 'Backspace' || e.key === '#') {
    const sel = selectedMessages();
    if (sel.length) { e.preventDefault(); deleteMessages(sel); }
  } else if (e.key === 'm') {
    const sel = selectedMessages();
    if (sel.length) { e.preventDefault(); openFilePicker(sel); }
  } else if (e.key === 'r' && state.opened && state.opened.detail) { e.preventDefault(); replyTo(state.opened); }
  else if (e.key === 'u') {
    const sel = selectedMessages();
    if (sel.length) { e.preventDefault(); setSeen(sel, !sel.every((m) => m.seen)); }
  }
});

// Une erreur silencieuse laissait des zones vides : on la montre.
window.addEventListener('error', (e) => {
  if (/ResizeObserver/.test(e.message || '')) return;
  toast(`Erreur d’affichage : ${e.message}`, { error: true });
});
window.addEventListener('unhandledrejection', (e) => {
  toast(`Erreur : ${(e.reason && e.reason.message) || e.reason}`, { error: true });
});

// ----------------------------------------------------------------- démarrage

(async function init() {
  renderLayoutSwitch();
  initSplitter();
  initSidebarSplitter();
  applyLayout();
  $('#nav-rules').append(ico('rules'), h('span', null, 'Règles de tri'));
  $('#nav-settings').append(ico('gear'), h('span', null, 'Réglages'));
  $('#btn-refresh').appendChild(ico('refresh', 17));
  $('#search-icon').appendChild(ico('search', 16));
  $('#list-rows').addEventListener('scroll', loadMoreIfNeeded, { passive: true });
  window.addEventListener('resize', debounce(loadMoreIfNeeded, 200));
  renderTabs();
  $('#btn-sortnow').append(ico('rules', 15), 'Trier maintenant');
  $('#btn-sortnow').addEventListener('click', sortNow);
  $('#sort-by').addEventListener('change', (e) => setSort(e.target.value, e.target.value === 'date' ? 'desc' : 'asc'));
  $('#sort-dir').addEventListener('click', () => setSort(sortBy(), sortDir() === 'asc' ? 'desc' : 'asc'));
  renderReader();

  try {
    state.prefs = await call(api.prefs.get());
    applySizes();
    applyTheme();
    window.applySidebarWidth();
    applyLayout();
    state.accounts = await call(api.accounts.list());
    state.rules = await call(api.rules.list());
    state.contacts = await call(api.contacts.list());
  } catch (err) {
    toast(err.message, { error: true });
  }

  if (!state.accounts.length) {
    showPanel('welcome');
    return;
  }
  renderSidebar();
  updateTitle();
  await Promise.all(state.accounts.map((a) => loadFolders(a.id)));
  await loadMessages();
})();
