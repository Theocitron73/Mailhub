'use strict';

/**
 * Transfert des réglages d'un ordinateur vers un téléphone par QR code, sur le réseau local.
 *
 * L'ordinateur ouvre un petit serveur temporaire et affiche un QR code qui contient :
 * ses adresses sur le réseau local, le port, un jeton à usage unique et une clé de chiffrement.
 * Le téléphone lit le QR, télécharge les réglages chiffrés et les déchiffre avec la clé du QR :
 * quelqu'un d'autre sur le même Wi-Fi ne verrait que des données illisibles.
 * Le serveur s'arrête après le premier téléchargement réussi, ou au bout de quelques minutes.
 */

const crypto = require('crypto');
const http = require('http');
const os = require('os');

const PREFIX = 'MAILHUB-TRANSFER:1';
const TTL = 5 * 60 * 1000;
const MAX_BAD = 30;

function seal(obj, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function open(box, key) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
  } catch (_) {
    throw new Error('Réglages reçus illisibles : rescannez le QR code affiché par l’ordinateur.');
  }
}

function encodeCode({ hosts, port, token, key }) {
  return `${PREFIX};h=${hosts.join(',')};p=${port};t=${token};k=${key.toString('base64url')}`;
}

function parseCode(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith(PREFIX + ';')) throw new Error('Ce QR code n’est pas un transfert MailHub.');
  const f = Object.fromEntries(raw.slice(PREFIX.length + 1).split(';').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  const hosts = String(f.h || '').split(',').filter((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x)).slice(0, 6);
  const port = Number(f.p);
  const key = Buffer.from(String(f.k || ''), 'base64url');
  if (!hosts.length || !(port > 0 && port < 65536) || !/^[a-f0-9]{32}$/.test(f.t || '') || key.length !== 32) {
    throw new Error('QR code MailHub incomplet : rescannez-le.');
  }
  return { hosts, port, token: f.t, key };
}

// Adresses IPv4 de l'ordinateur sur le réseau local (Wi-Fi, Ethernet), les plus probables d'abord
function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      const virtual = /docker|vbox|vmnet|virtual|veth|br-|utun|tailscale|zt/i.test(name);
      out.push({ address: a.address, score: (priv ? 2 : 0) + (virtual ? -3 : 0) + (a.address.startsWith('192.168.') ? 1 : 0) });
    }
  }
  return out.sort((x, y) => y.score - x.score).map((x) => x.address).slice(0, 4);
}

/** Serveur temporaire de l'ordinateur. onEvent('done' | 'expired') prévient l'interface. */
class TransferServer {
  constructor({ onEvent } = {}) {
    this.onEvent = onEvent || (() => {});
    this.server = null;
    this.timer = null;
  }

  async start(payload, { hosts = localAddresses(), ttl = TTL, bind = '0.0.0.0' } = {}) {
    this.stop();
    if (!hosts.length) throw new Error('Cet ordinateur n’est connecté à aucun réseau local (Wi-Fi ou câble).');
    const key = crypto.randomBytes(32);
    const token = crypto.randomBytes(16).toString('hex');
    const body = JSON.stringify(seal(payload, key));
    let bad = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === `/mailhub-transfer/${token}`) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(body, () => { this.stop(); this.onEvent('done'); }); // usage unique
        return;
      }
      res.writeHead(404).end();
      if (++bad >= MAX_BAD) { this.stop(); this.onEvent('expired'); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, bind, resolve); });
    this.server = server;
    this.timer = setTimeout(() => { this.stop(); this.onEvent('expired'); }, ttl);
    const { port } = server.address();
    return { code: encodeCode({ hosts, port, token, key }), hosts, port, expiresAt: new Date(Date.now() + ttl).toISOString() };
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.server) { const s = this.server; this.server = null; s.close(); if (s.closeAllConnections) setTimeout(() => s.closeAllConnections(), 500); }
  }
}

function get(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`code ${res.statusCode}`)); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 60 * 1024 * 1024) req.destroy(new Error('trop gros')); else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', reject);
  });
}

/** Côté téléphone : télécharge et déchiffre les réglages désignés par le QR code. */
async function receive(text, { timeout = 6000 } = {}) {
  const { hosts, port, token, key } = parseCode(text);
  let last = null;
  for (const host of hosts) {
    try {
      const body = await get(`http://${host}:${port}/mailhub-transfer/${token}`, timeout);
      return open(JSON.parse(body), key);
    } catch (err) { last = err; }
  }
  throw new Error('Impossible de joindre l’ordinateur. Vérifiez que le téléphone et l’ordinateur sont sur le même Wi-Fi, que le QR code est encore affiché, puis réessayez.'
    + (last ? ` (${last.message})` : ''));
}

module.exports = { PREFIX, seal, open, encodeCode, parseCode, localAddresses, TransferServer, receive };
