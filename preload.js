'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('mailhub', {
  platform: process.platform,

  // comptes
  accounts: {
    list: () => invoke('accounts:list'),
    test: (cfg) => invoke('accounts:test', cfg),
    add: (cfg) => invoke('accounts:add', cfg),
    update: (id, patch) => invoke('accounts:update', id, patch),
    remove: (id) => invoke('accounts:remove', id),
    encryptionAvailable: () => invoke('accounts:encryption'),
  },

  // dossiers
  folders: {
    list: (accountId) => invoke('folders:list', accountId),
    create: (accountId, path) => invoke('folders:create', accountId, path),
    rename: (accountId, from, to) => invoke('folders:rename', accountId, from, to),
    remove: (accountId, path) => invoke('folders:remove', accountId, path),
  },

  // messages
  messages: {
    list: (accountId, folder, opts) => invoke('messages:list', accountId, folder, opts),
    unified: (limit) => invoke('messages:unified', limit),
    search: (accountId, folder, query) => invoke('messages:search', accountId, folder, query),
    get: (accountId, folder, uid) => invoke('messages:get', accountId, folder, uid),
    flag: (accountId, folder, uids, flag, on) => invoke('messages:flag', accountId, folder, uids, flag, on),
    move: (accountId, folder, uids, dest) => invoke('messages:move', accountId, folder, uids, dest),
    remove: (accountId, folder, uids) => invoke('messages:remove', accountId, folder, uids),
    saveAttachment: (accountId, folder, uid, index) => invoke('messages:saveAttachment', accountId, folder, uid, index),
    attachmentData: (accountId, folder, uid, index) => invoke('messages:attachmentData', accountId, folder, uid, index),
    openAttachment: (accountId, folder, uid, index) => invoke('messages:openAttachment', accountId, folder, uid, index),
    send: (accountId, mail) => invoke('messages:send', accountId, mail),
    markAllRead: (accountId, folder) => invoke('messages:markAllRead', accountId, folder),
    markAllReadInAccount: (accountId) => invoke('messages:markAllReadInAccount', accountId),
    deleteAllInFolder: (accountId, folder) => invoke('messages:deleteAllInFolder', accountId, folder),
    saveDraft: (accountId, mail) => invoke('messages:saveDraft', accountId, mail),
    flagged: () => invoke('messages:flagged'),
    pickAttachments: () => invoke('messages:pickAttachments'),
  },

  // règles de tri
  rules: {
    list: () => invoke('rules:list'),
    add: (rule) => invoke('rules:add', rule),
    update: (rule) => invoke('rules:update', rule),
    remove: (id) => invoke('rules:remove', id),
    addMany: (list) => invoke('rules:addMany', list),
    move: (id, delta) => invoke('rules:move', id, delta),
    // « ranger cet expéditeur » : crée la règle, déplace le message et, au choix, l'existant
    sortSender: (payload) => invoke('rules:sortSender', payload),
    // glisser-déposer : une règle par expéditeur, avec de quoi annuler
    autoSender: (payload) => invoke('rules:autoSender', payload),
    applyToFolder: (accountId, folder) => invoke('rules:applyToFolder', accountId, folder),
    applyAll: (accountId) => invoke('rules:applyAll', accountId),
    export: () => invoke('rules:export'),
    importPick: () => invoke('rules:importPick'),
    duplicates: (items) => invoke('rules:duplicates', items),
  },

  signatures: {
    pickImage: () => invoke('signatures:pickImage'),
  },

  // carnet d'adresses
  contacts: {
    list: () => invoke('contacts:list'),
    remove: (email) => invoke('contacts:remove', email),
    importSent: () => invoke('contacts:importSent'),
  },

  app: {
    hide: () => invoke('app:hide'),
  },

  // import des filtres Thunderbird
  thunderbird: {
    scan: () => invoke('thunderbird:scan'),
    pick: () => invoke('thunderbird:pick'),
    preview: (file, accountId) => invoke('thunderbird:preview', file, accountId),
  },

  // préférences
  prefs: {
    get: () => invoke('prefs:get'),
    set: (patch) => invoke('prefs:set', patch),
  },

  settings: {
    export: () => invoke('settings:export'),
    import: () => invoke('settings:import'),
  },

  // mises à jour automatiques
  updates: {
    check: () => invoke('updates:check'),
    install: () => invoke('updates:install'),
  },

  // événements poussés par le processus principal
  on: (channel, callback) => {
    const allowed = ['mail:sorted', 'mail:new', 'mail:changed', 'account:status', 'app:error', 'app:closeTab', 'app:updateAvailable', 'app:updateDownloaded'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
