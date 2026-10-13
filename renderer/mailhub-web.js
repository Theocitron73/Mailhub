'use strict';

/**
 * MailHub Web Adapter
 * Provides the window.mailhub API interface for the web browser,
 * communicating with the Express backend via REST / Server-Sent Events.
 */
(() => {
  // If running inside Electron desktop, preload.js already exposes native window.mailhub
  if (typeof window !== 'undefined' && window.mailhub && window.mailhub.platform !== 'web') {
    return;
  }

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  async function invoke(channel, ...args) {
    try {
      const res = await fetch('/api/ipc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, args }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: text || `HTTP ${res.status}` };
      }
      return await res.json();
    } catch (err) {
      return { ok: false, error: err.message || 'Erreur réseau' };
    }
  }

  function downloadBlob(content, filename, mimeType) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'telechargement';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Event dispatching via Server-Sent Events (SSE)
  const listeners = new Map();
  let eventSource = null;

  function initSSE() {
    if (typeof EventSource === 'undefined') return;
    try {
      eventSource = new EventSource('/api/events');
      eventSource.onmessage = (e) => {
        try {
          const { channel, payload } = JSON.parse(e.data);
          const cbs = listeners.get(channel);
          if (cbs) {
            cbs.forEach((cb) => {
              try { cb(payload); } catch (err) { console.error('SSE listener error:', err); }
            });
          }
        } catch (_) {}
      };
      eventSource.onerror = () => {
        // Automatically reconnects
      };
    } catch (err) {
      console.warn('SSE initialization failed:', err);
    }
  }

  initSSE();

  window.mailhub = {
    platform: isMac ? 'darwin' : 'web',

    accounts: {
      list: () => invoke('accounts:list'),
      test: (cfg) => invoke('accounts:test', cfg),
      add: (cfg) => invoke('accounts:add', cfg),
      update: (id, patch) => invoke('accounts:update', id, patch),
      remove: (id) => invoke('accounts:remove', id),
      encryptionAvailable: () => Promise.resolve({ ok: true, data: false }),
    },

    folders: {
      list: (accountId) => invoke('folders:list', accountId),
      create: (accountId, path) => invoke('folders:create', accountId, path),
      rename: (accountId, from, to) => invoke('folders:rename', accountId, from, to),
      remove: (accountId, path) => invoke('folders:remove', accountId, path),
    },

    messages: {
      list: (accountId, folder, opts) => invoke('messages:list', accountId, folder, opts),
      unified: (limit) => invoke('messages:unified', limit),
      search: (accountId, folder, query) => invoke('messages:search', accountId, folder, query),
      get: (accountId, folder, uid) => invoke('messages:get', accountId, folder, uid),
      flag: (accountId, folder, uids, flag, on) => invoke('messages:flag', accountId, folder, uids, flag, on),
      move: (accountId, folder, uids, dest) => invoke('messages:move', accountId, folder, uids, dest),
      remove: (accountId, folder, uids) => invoke('messages:remove', accountId, folder, uids),
      saveAttachment: async (accountId, folder, uid, index) => {
        const res = await invoke('messages:attachmentData', accountId, folder, uid, index);
        if (!res.ok) return res;
        const d = res.data;
        if (d.dataUrl) {
          const a = document.createElement('a');
          a.href = d.dataUrl;
          a.download = d.filename || 'piece-jointe';
          a.click();
          return { ok: true, data: { saved: true, path: d.filename } };
        }
        if (d.base64) {
          const bytes = Uint8Array.from(atob(d.base64), (c) => c.charCodeAt(0));
          downloadBlob(bytes, d.filename || 'piece-jointe', d.contentType || 'application/octet-stream');
          return { ok: true, data: { saved: true, path: d.filename } };
        }
        if (d.text) {
          downloadBlob(d.text, d.filename || 'document.txt', d.contentType || 'text/plain');
          return { ok: true, data: { saved: true, path: d.filename } };
        }
        return { ok: true, data: { saved: false } };
      },
      attachmentData: (accountId, folder, uid, index) => invoke('messages:attachmentData', accountId, folder, uid, index),
      openAttachment: async (accountId, folder, uid, index) => {
        const res = await invoke('messages:attachmentData', accountId, folder, uid, index);
        if (!res.ok) return res;
        const d = res.data;
        let url = d.dataUrl;
        if (!url && d.base64) {
          const bytes = Uint8Array.from(atob(d.base64), (c) => c.charCodeAt(0));
          const blob = new Blob([bytes], { type: d.contentType || 'application/octet-stream' });
          url = URL.createObjectURL(blob);
        } else if (!url && d.text) {
          const blob = new Blob([d.text], { type: d.contentType || 'text/plain' });
          url = URL.createObjectURL(blob);
        }
        if (url) {
          window.open(url, '_blank');
          return { ok: true, data: { ok: true } };
        }
        return { ok: false, error: 'Aperçu non disponible pour ce fichier.' };
      },
      send: (accountId, mail) => invoke('messages:send', accountId, mail),
      flagged: () => invoke('messages:flagged'),
      pickAttachments: () => {
        return new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.multiple = true;
          input.onchange = async () => {
            const files = Array.from(input.files || []);
            const out = [];
            for (const f of files) {
              const b64 = await new Promise((r) => {
                const reader = new FileReader();
                reader.onload = () => r(reader.result);
                reader.readAsDataURL(f);
              });
              out.push({
                name: f.name,
                size: f.size,
                dataUrl: b64,
                path: f.name,
              });
            }
            resolve({ ok: true, data: out });
          };
          input.click();
        });
      },
    },

    rules: {
      list: () => invoke('rules:list'),
      add: (rule) => invoke('rules:add', rule),
      update: (rule) => invoke('rules:update', rule),
      remove: (id) => invoke('rules:remove', id),
      addMany: (list) => invoke('rules:addMany', list),
      move: (id, delta) => invoke('rules:move', id, delta),
      sortSender: (payload) => invoke('rules:sortSender', payload),
      autoSender: (payload) => invoke('rules:autoSender', payload),
      applyToFolder: (accountId, folder) => invoke('rules:applyToFolder', accountId, folder),
      applyAll: (accountId) => invoke('rules:applyAll', accountId),
      export: async () => {
        const res = await invoke('rules:export');
        if (res && res.ok && res.data && res.data.content) {
          downloadBlob(res.data.content, 'mailhub-regles.json', 'application/json');
          return { ok: true, data: { saved: true, count: res.data.count, path: 'mailhub-regles.json' } };
        }
        return res;
      },
      importPick: () => {
        return new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.json,application/json';
          input.onchange = () => {
            const file = input.files && input.files[0];
            if (!file) return resolve({ ok: true, data: null });
            const reader = new FileReader();
            reader.onload = async () => {
              const res = await invoke('rules:importPickDirect', { file: file.name, text: reader.result });
              resolve(res);
            };
            reader.readAsText(file);
          };
          input.click();
        });
      },
      duplicates: (items) => invoke('rules:duplicates', items),
    },

    signatures: {
      pickImage: () => {
        return new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/png,image/jpeg,image/gif,image/webp';
          input.onchange = () => {
            const file = input.files && input.files[0];
            if (!file) return resolve({ ok: true, data: null });
            if (file.size > 1.5 * 1024 * 1024) {
              return resolve({ ok: false, error: 'Image trop lourde (1,5 Mo maximum). Réduisez-la avant de l’ajouter.' });
            }
            const reader = new FileReader();
            reader.onload = () => {
              resolve({
                ok: true,
                data: {
                  dataUrl: reader.result,
                  name: file.name,
                  id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                },
              });
            };
            reader.readAsDataURL(file);
          };
          input.click();
        });
      },
    },

    contacts: {
      list: () => invoke('contacts:list'),
      remove: (email) => invoke('contacts:remove', email),
      importSent: () => invoke('contacts:importSent'),
    },

    app: {
      hide: () => Promise.resolve({ ok: true, data: true }),
    },

    thunderbird: {
      scan: () => invoke('thunderbird:scan'),
      pick: () => {
        return new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.dat,text/plain';
          input.onchange = () => {
            const file = input.files && input.files[0];
            if (!file) return resolve({ ok: true, data: null });
            const reader = new FileReader();
            reader.onload = async () => {
              const res = await invoke('thunderbird:pickDirect', { file: file.name, text: reader.result });
              resolve(res);
            };
            reader.readAsText(file);
          };
          input.click();
        });
      },
      preview: (file, accountId) => invoke('thunderbird:preview', file, accountId),
    },

    prefs: {
      get: () => invoke('prefs:get'),
      set: (patch) => invoke('prefs:set', patch),
    },

    updates: {
      check: () => Promise.resolve({ ok: true, data: { update: false } }),
      install: () => Promise.resolve({ ok: true }),
    },

    on: (channel, callback) => {
      const allowed = ['mail:sorted', 'mail:new', 'mail:changed', 'account:status', 'app:error', 'app:closeTab', 'app:updateAvailable', 'app:updateDownloaded'];
      if (!allowed.includes(channel)) return () => {};
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(callback);
      return () => {
        const set = listeners.get(channel);
        if (set) set.delete(callback);
      };
    },
  };
})();
