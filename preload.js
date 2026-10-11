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
    send: (accountId, mail) => invoke('messages:send', accountId, mail),
    pickAttachments: () => invoke('messages:pickAttachments'),
  },

  // règles de tri
  rules: {
    list: () => invoke('rules:list'),
    add: (rule) => invoke('rules:add', rule),
    update: (rule) => invoke('rules:update', rule),
    remove: (id) => invoke('rules:remove', id),
    // « ranger cet expéditeur » : crée la règle, déplace le message et, au choix, l'existant
    sortSender: (payload) => invoke('rules:sortSender', payload),
    applyToFolder: (accountId, folder) => invoke('rules:applyToFolder', accountId, folder),
  },

  // préférences
  prefs: {
    get: () => invoke('prefs:get'),
    set: (patch) => invoke('prefs:set', patch),
  },

  // événements poussés par le processus principal
  on: (channel, callback) => {
    const allowed = ['mail:sorted', 'mail:new', 'mail:changed', 'account:status', 'app:error'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
