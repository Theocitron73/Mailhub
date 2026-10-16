'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');

const { Store } = require('./src/store');
const { ImapManager, friendlyError } = require('./src/imap');
const rulesio = require('./src/rulesio');
const { attachmentPreview } = require('./src/attachment');
const { cleanImage, buildSignedMessage } = require('./src/signature');
const tb = require('./src/thunderbird');
const { findRule, senderRule, upsertSenderRule } = require('./src/rules');

const PORT = 3000;
const HOST = '0.0.0.0';

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Initialize local store
const store = new Store(dataDir, null);
let imapManager = null;
try {
  imapManager = new ImapManager(store);
} catch (e) {
  console.warn('ImapManager init note:', e.message);
}

// ------------------------------------------------------------- Demo Mail Store
// Provides a fully working, rich local email experience for demo accounts
const demoMessagesFile = path.join(dataDir, 'mailhub-demo-messages.json');
let demoStore = {
  folders: {},
  messages: {},
  nextUid: 100,
};

function initDemoData() {
  const accounts = store.listAccounts();
  let demoAccount = accounts[0];

  if (!demoAccount) {
    demoAccount = store.addAccount({
      name: 'Théo Le Barbier',
      email: 'theolebarbier50@gmail.com',
      color: '#2f4b8a',
      imap: {
        host: 'demo',
        port: 993,
        secure: true,
        user: 'theolebarbier50@gmail.com',
      },
      password: 'demo-password',
    });

    // Add initial rules
    store.addRules([
      {
        name: 'Factures & Hébergement',
        enabled: true,
        match: 'any',
        accountId: demoAccount.id,
        folder: 'Factures',
        conditions: [
          { field: 'subject', op: 'contains', value: 'facture' },
          { field: 'from', op: 'contains', value: 'ovhcloud' },
          { field: 'from', op: 'contains', value: 'stripe' },
        ],
      },
      {
        name: 'Projets & Code',
        enabled: true,
        match: 'all',
        accountId: demoAccount.id,
        folder: 'Projets',
        conditions: [
          { field: 'domain', op: 'equals', value: 'github.com' },
        ],
      },
      {
        name: 'Newsletters tech',
        enabled: true,
        match: 'all',
        accountId: demoAccount.id,
        folder: 'Newsletter',
        conditions: [
          { field: 'from', op: 'contains', value: 'techhebdo' },
        ],
      },
    ]);

    // Initial contacts
    store.recordContacts([
      { address: 'alice.dupont@techstudio.fr', name: 'Alice Dupont' },
      { address: 'notifications@github.com', name: 'GitHub Notifications' },
      { address: 'facturation@ovhcloud.com', name: 'OVHcloud Facturation' },
      { address: 'newsletter@techhebdo.fr', name: 'Tech Hebdo' },
      { address: 'julien.martin@techlead.io', name: 'Julien Martin' },
      { address: 'invoices@stripe.com', name: 'Stripe Billing' },
    ]);
  }

  const accId = demoAccount.id;

  if (fs.existsSync(demoMessagesFile)) {
    try {
      demoStore = JSON.parse(fs.readFileSync(demoMessagesFile, 'utf8'));
    } catch (_) {
      seedDemoMessages(accId);
    }
  } else {
    seedDemoMessages(accId);
  }
}

function saveDemoStore() {
  try {
    fs.writeFileSync(demoMessagesFile, JSON.stringify(demoStore, null, 2), 'utf8');
  } catch (err) {
    console.error('Erreur sauvegarde demo store:', err.message);
  }
}

function seedDemoMessages(accId) {
  const now = Date.now();
  const d = (daysAgo, hoursAgo = 0) => new Date(now - (daysAgo * 86400000 + hoursAgo * 3600000)).toISOString();

  demoStore.folders[accId] = [
    { path: 'INBOX', name: 'Boîte de réception', specialUse: '\\Inbox', delimiter: '/', selectable: true },
    { path: 'Projets', name: 'Projets', delimiter: '/', selectable: true },
    { path: 'Factures', name: 'Factures', delimiter: '/', selectable: true },
    { path: 'Newsletter', name: 'Newsletter', delimiter: '/', selectable: true },
    { path: 'Sent', name: 'Envoyés', specialUse: '\\Sent', delimiter: '/', selectable: true },
    { path: 'Archive', name: 'Archives', specialUse: '\\Archive', delimiter: '/', selectable: true },
    { path: 'Trash', name: 'Corbeille', specialUse: '\\Trash', delimiter: '/', selectable: true },
  ];

  demoStore.messages[accId] = [
    {
      uid: 1,
      folder: 'INBOX',
      subject: 'Revue d’architecture MailHub v1.0',
      from: 'alice.dupont@techstudio.fr',
      fromName: 'Alice Dupont',
      to: 'theolebarbier50@gmail.com',
      cc: 'julien.martin@techlead.io',
      date: d(0, 2),
      size: 4210,
      seen: false,
      flagged: true,
      hasAttachment: true,
      html: `
        <div style="font-family: sans-serif; line-height: 1.6; color: #17212e;">
          <p>Bonjour Théo,</p>
          <p>J'ai testé la nouvelle version de <strong>MailHub</strong> en web. L'interface est remarquablement fluide et réactive !</p>
          <p>Quelques points notables validés :</p>
          <ul>
            <li>Le moteur de tri automatique applique bien les règles sur l'expéditeur et les domaines.</li>
            <li>Le glisser-déposer de messages vers un dossier crée automatiquement la règle associée.</li>
            <li>La gestion des pièces jointes et la vue fractionnée (à côté / en dessous / plein écran) fonctionnent parfaitement.</li>
          </ul>
          <p>Ci-joint le schéma d'architecture récapitulatif.</p>
          <p>Bien cordialement,<br><strong>Alice Dupont</strong><br><em>Tech Studio</em></p>
        </div>
      `,
      text: "Bonjour Théo,\n\nJ'ai testé la nouvelle version de MailHub en web. L'interface est remarquablement fluide !\n\nBien cordialement,\nAlice Dupont",
      attachments: [
        {
          index: 0,
          filename: 'architecture-mailhub.pdf',
          contentType: 'application/pdf',
          size: 15420,
          contentBase64: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 55 >>\nstream\nBT /F1 18 Tf 50 700 Td (Architecture MailHub - Mode Web) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000010 00000 n \n0000000060 00000 n \n0000000117 00000 n \n0000000201 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n308\n%%EOF').toString('base64'),
        },
      ],
    },
    {
      uid: 2,
      folder: 'INBOX',
      subject: '[Theocitron73/Mailhub] Pull request #14 merged: Amélioration du tri automatique',
      from: 'notifications@github.com',
      fromName: 'GitHub Notifications',
      to: 'theolebarbier50@gmail.com',
      cc: '',
      date: d(1, 4),
      size: 3200,
      seen: false,
      flagged: false,
      hasAttachment: false,
      html: `
        <div style="font-family: sans-serif; line-height: 1.5; color: #24292f;">
          <h2 style="font-size: 18px; margin-bottom: 8px;">Theocitron73/Mailhub</h2>
          <p>Pull request <strong>#14: Amélioration du tri automatique</strong> a été fusionnée dans <code>main</code>.</p>
          <p style="background: #f6f8fa; padding: 10px; border-radius: 6px; font-family: monospace;">
            Merge branch 'feature/rules-engine' into main<br>
            All 46 unit tests passed successfully.
          </p>
          <p><a href="https://github.com/Theocitron73/Mailhub" style="color: #0969da; text-decoration: none;">Voir sur GitHub</a></p>
        </div>
      `,
      text: "Theocitron73/Mailhub: Pull request #14 merged successfully.\nAll 46 unit tests passed.",
      attachments: [],
    },
    {
      uid: 3,
      folder: 'INBOX',
      subject: 'Facture n° FR-2026-89412 - Hébergement & Domaines',
      from: 'facturation@ovhcloud.com',
      fromName: 'OVHcloud Facturation',
      to: 'theolebarbier50@gmail.com',
      cc: '',
      date: d(2, 6),
      size: 6100,
      seen: true,
      flagged: false,
      hasAttachment: true,
      html: `
        <div style="font-family: sans-serif; line-height: 1.5; color: #17212e;">
          <h3>Votre facture OVHcloud est disponible</h3>
          <p>Numéro de facture : <strong>FR-2026-89412</strong></p>
          <p>Montant total TTC : <strong>42,50 €</strong></p>
          <p>Paiement prélevé automatiquement sur votre carte bancaire.</p>
          <p>Merci pour votre confiance,<br>L'équipe OVHcloud</p>
        </div>
      `,
      text: "Facture OVHcloud n° FR-2026-89412 - Montant : 42,50 € TTC.",
      attachments: [
        {
          index: 0,
          filename: 'facture-ovh-89412.pdf',
          contentType: 'application/pdf',
          size: 18400,
          contentBase64: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 50 >>\nstream\nBT /F1 16 Tf 50 700 Td (Facture OVHcloud: FR-2026-89412 - 42.50 EUR) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000010 00000 n \n0000000060 00000 n \n0000000117 00000 n \n0000000201 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n303\n%%EOF').toString('base64'),
        },
      ],
    },
    {
      uid: 4,
      folder: 'INBOX',
      subject: 'Tech Hebdo #142 : Les nouveautés Node.js et l’avenir des clients mails',
      from: 'newsletter@techhebdo.fr',
      fromName: 'Tech Hebdo',
      to: 'theolebarbier50@gmail.com',
      cc: '',
      date: d(3, 1),
      size: 8900,
      seen: true,
      flagged: false,
      hasAttachment: false,
      html: `
        <div style="font-family: sans-serif; line-height: 1.6; color: #17212e;">
          <h2 style="color: #2f4b8a;">Tech Hebdo #142</h2>
          <p>Au sommaire cette semaine :</p>
          <ul>
            <li><strong>Clients mail modernes :</strong> Pourquoi la gestion locale des règles et la boîte unifiée reviennent en force.</li>
            <li><strong>Node.js 22 :</strong> Performance accrue pour les streams et les protocoles réseau.</li>
            <li><strong>Design d'applications :</strong> Éviter la surcharge visuelle pour privilégier la typographie et la lisibilité.</li>
          </ul>
          <p>Bonne lecture !</p>
        </div>
      `,
      text: "Tech Hebdo #142 : Les nouveautés Node.js et l'avenir des clients mails.",
      attachments: [],
    },
    {
      uid: 5,
      folder: 'INBOX',
      subject: 'Déjeuner d’équipe vendredi midi ?',
      from: 'julien.martin@techlead.io',
      fromName: 'Julien Martin',
      to: 'theolebarbier50@gmail.com',
      cc: '',
      date: d(4, 5),
      size: 1950,
      seen: true,
      flagged: true,
      hasAttachment: false,
      html: `
        <div style="font-family: sans-serif; line-height: 1.6; color: #17212e;">
          <p>Salut Théo,</p>
          <p>On pensait aller au restaurant italien en bas du bureau vendredi vers 12h30 avec l'équipe pour fêter la sortie de la nouvelle version.</p>
          <p>Dis-moi si tu es disponible !</p>
          <p>À plus,<br>Julien</p>
        </div>
      `,
      text: "Salut Théo,\n\nOn pensait aller au restaurant italien vendredi vers 12h30. Dis-moi si tu es disponible !\n\nÀ plus,\nJulien",
      attachments: [],
    },
    {
      uid: 6,
      folder: 'Factures',
      subject: 'Reçu pour votre paiement Stripe - Mars 2026',
      from: 'invoices@stripe.com',
      fromName: 'Stripe Billing',
      to: 'theolebarbier50@gmail.com',
      cc: '',
      date: d(8, 2),
      size: 4500,
      seen: true,
      flagged: false,
      hasAttachment: false,
      html: `
        <div style="font-family: sans-serif; line-height: 1.5; color: #17212e;">
          <h3>Reçu Stripe</h3>
          <p>Montant payé : <strong>29,00 €</strong></p>
          <p>Statut : Payé</p>
          <p>Merci pour votre abonnement MailHub Pro.</p>
        </div>
      `,
      text: "Reçu pour votre paiement Stripe - Mars 2026 : 29,00 €",
      attachments: [],
    },
    {
      uid: 7,
      folder: 'Projets',
      subject: 'Moteur de filtrage et parsing Thunderbird msgFilterRules.dat',
      from: 'claire@opensource.org',
      fromName: 'Claire Dev',
      to: 'theolebarbier50@gmail.com',
      cc: '',
      date: d(10, 4),
      size: 5100,
      seen: true,
      flagged: false,
      hasAttachment: false,
      html: `
        <div style="font-family: sans-serif; line-height: 1.5; color: #17212e;">
          <p>Bonjour,</p>
          <p>Le module de parsing Thunderbird fonctionne à merveille : il décode correctement les noms UTF-7 IMAP et les conditions complexes ET / OU.</p>
          <p>Félicitations pour le travail sur MailHub !</p>
        </div>
      `,
      text: "Bonjour,\n\nLe module de parsing Thunderbird fonctionne à merveille.\nFélicitations pour le travail sur MailHub !",
      attachments: [],
    },
    {
      uid: 8,
      folder: 'Sent',
      subject: 'Re: Revue d’architecture MailHub v1.0',
      from: 'theolebarbier50@gmail.com',
      fromName: 'Théo Le Barbier',
      to: 'alice.dupont@techstudio.fr',
      cc: '',
      date: d(0, 1),
      size: 2100,
      seen: true,
      flagged: false,
      hasAttachment: false,
      html: `
        <div style="font-family: sans-serif; line-height: 1.5; color: #17212e;">
          <p>Merci Alice,</p>
          <p>J'ai bien reçu le schéma d'architecture. Tout est prêt pour le déploiement web !</p>
          <p>Théo</p>
        </div>
      `,
      text: "Merci Alice,\n\nJ'ai bien reçu le schéma d'architecture. Tout est prêt pour le déploiement web !\n\nThéo",
      attachments: [],
    },
  ];

  demoStore.nextUid = 10;
  saveDemoStore();
}

initDemoData();

// ------------------------------------------------------------- Express App Setup
const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

// Server-Sent Events clients
const sseClients = new Set();

function broadcast(channel, payload) {
  const data = JSON.stringify({ channel, payload });
  sseClients.forEach((res) => {
    try {
      res.write(`data: ${data}\n\n`);
    } catch (_) {}
  });
}

// Wire events from real ImapManager if active
if (imapManager) {
  imapManager.on('sorted', (payload) => broadcast('mail:sorted', payload));
  imapManager.on('new-mail', (payload) => broadcast('mail:new', payload));
  imapManager.on('changed', (payload) => broadcast('mail:changed', payload));
  imapManager.on('status', (payload) => broadcast('account:status', payload));
  imapManager.on('error', (payload) => broadcast('app:error', payload));
}

// SSE Route
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Helper for Demo Folder statistics
function getDemoFolders(accountId) {
  const list = demoStore.folders[accountId] || [];
  const msgs = demoStore.messages[accountId] || [];

  return list.map((f) => {
    const fMsgs = msgs.filter((m) => m.folder === f.path);
    const unseen = fMsgs.filter((m) => !m.seen).length;
    return {
      path: f.path,
      name: f.name,
      delimiter: f.delimiter || '/',
      specialUse: f.specialUse,
      selectable: f.selectable !== false,
      unseen,
      total: fMsgs.length,
    };
  });
}

// ------------------------------------------------------------- IPC Handler Logic
async function handleChannel(channel, args) {
  // ---- accounts
  if (channel === 'accounts:list') {
    return store.listAccounts();
  }
  if (channel === 'accounts:encryption') {
    return false;
  }
  if (channel === 'accounts:test') {
    const [cfg] = args;
    if (cfg.imap && cfg.imap.host === 'demo') {
      return { ok: true };
    }
    if (imapManager) {
      return ImapManager.testConnection(cfg);
    }
    return { ok: true };
  }
  if (channel === 'accounts:add') {
    const [cfg] = args;
    if (cfg.imap && cfg.imap.host !== 'demo' && imapManager) {
      const test = await ImapManager.testConnection(cfg);
      if (!test.ok) throw new Error(test.error);
    }
    const account = store.addAccount(cfg);
    if (!demoStore.folders[account.id]) {
      demoStore.folders[account.id] = [
        { path: 'INBOX', name: 'Boîte de réception', specialUse: '\\Inbox', delimiter: '/', selectable: true },
        { path: 'Sent', name: 'Envoyés', specialUse: '\\Sent', delimiter: '/', selectable: true },
        { path: 'Trash', name: 'Corbeille', specialUse: '\\Trash', delimiter: '/', selectable: true },
      ];
      demoStore.messages[account.id] = [];
      saveDemoStore();
    }
    if (account.imap && account.imap.host !== 'demo' && imapManager) {
      try { imapManager.startWatching(account.id); } catch (_) {}
    }
    return account;
  }
  if (channel === 'accounts:update') {
    const [id, patch = {}] = args;
    const cur = store.getAccount(id);
    if (!cur) throw new Error('Compte introuvable');
    if (patch.imap && patch.imap.host !== 'demo' && imapManager) {
      const email = typeof patch.email === 'string' ? patch.email.trim() : cur.email;
      const imap = {
        host: String(patch.imap.host || '').trim(),
        port: Number(patch.imap.port) || 993,
        secure: patch.imap.secure !== false,
        user: String(patch.imap.user || '').trim() || email,
      };
      if (imap.host) {
        const test = await ImapManager.testConnection({ email, password: patch.password || cur.password, imap });
        if (!test.ok) throw new Error(test.error);
      }
    }
    return store.updateAccount(id, patch);
  }
  if (channel === 'accounts:remove') {
    const [id] = args;
    if (imapManager) {
      try { await imapManager.disconnect(id); } catch (_) {}
    }
    store.removeAccount(id);
    delete demoStore.folders[id];
    delete demoStore.messages[id];
    saveDemoStore();
    return true;
  }

  // ---- folders
  if (channel === 'folders:list') {
    const [accountId] = args;
    const acc = store.getAccount(accountId);
    if (acc && acc.imap && acc.imap.host !== 'demo' && imapManager) {
      try {
        return await imapManager.listFolders(accountId);
      } catch (e) {
        console.warn('Real IMAP folder list failed, falling back to local folders:', e.message);
      }
    }
    return { folders: getDemoFolders(accountId), prefix: '' };
  }
  if (channel === 'folders:create') {
    const [accountId, folderPath] = args;
    const folders = demoStore.folders[accountId] || [];
    const name = folderPath.split('/').pop();
    const existing = folders.find((f) => f.path === folderPath);
    if (!existing) {
      folders.push({ path: folderPath, name, delimiter: '/', selectable: true });
      demoStore.folders[accountId] = folders;
      saveDemoStore();
    }
    return { path: folderPath };
  }
  if (channel === 'folders:rename') {
    const [accountId, from, to] = args;
    const folders = demoStore.folders[accountId] || [];
    const target = folders.find((f) => f.path === from);
    if (target) {
      target.path = to;
      target.name = to.split('/').pop();
    }
    const msgs = demoStore.messages[accountId] || [];
    msgs.forEach((m) => {
      if (m.folder === from) m.folder = to;
    });
    saveDemoStore();
    return true;
  }
  if (channel === 'folders:remove') {
    const [accountId, folderPath] = args;
    const folders = demoStore.folders[accountId] || [];
    demoStore.folders[accountId] = folders.filter((f) => f.path !== folderPath);
    const msgs = demoStore.messages[accountId] || [];
    demoStore.messages[accountId] = msgs.filter((m) => m.folder !== folderPath);
    saveDemoStore();
    return true;
  }

  // ---- messages
  if (channel === 'messages:list') {
    const [accountId, folder, opts = {}] = args;
    const acc = store.getAccount(accountId);
    if (acc && acc.imap && acc.imap.host !== 'demo' && imapManager) {
      try {
        return await imapManager.listMessages(accountId, folder, opts);
      } catch (e) {
        console.warn('Real IMAP messages list error:', e.message);
      }
    }
    const msgs = (demoStore.messages[accountId] || []).filter((m) => m.folder === folder);
    const limit = opts.limit || 50;
    const sorted = msgs.sort((a, b) => new Date(b.date) - new Date(a.date));
    return {
      messages: sorted.slice(0, limit),
      total: sorted.length,
    };
  }

  if (channel === 'messages:unified') {
    const [limit = 50] = args;
    const accounts = store.listAccounts();
    const all = [];
    for (const acc of accounts) {
      const msgs = (demoStore.messages[acc.id] || []).filter((m) => m.folder === 'INBOX');
      msgs.forEach((m) => all.push({ ...m, accountId: acc.id }));
    }
    const sorted = all.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, limit);
    return sorted;
  }

  if (channel === 'messages:search') {
    const [accountId, folder, query] = args;
    const q = String(query || '').toLowerCase().trim();
    const msgs = (demoStore.messages[accountId] || []).filter((m) => (folder ? m.folder === folder : true));
    return msgs.filter((m) =>
      (m.subject && m.subject.toLowerCase().includes(q)) ||
      (m.from && m.from.toLowerCase().includes(q)) ||
      (m.fromName && m.fromName.toLowerCase().includes(q)) ||
      (m.text && m.text.toLowerCase().includes(q))
    );
  }

  if (channel === 'messages:get') {
    const [accountId, folder, uid] = args;
    const msgs = demoStore.messages[accountId] || [];
    const found = msgs.find((m) => m.uid === Number(uid) && m.folder === folder) || msgs.find((m) => m.uid === Number(uid));
    if (!found) throw new Error('Message introuvable');
    return {
      uid: found.uid,
      subject: found.subject,
      from: { address: found.from, name: found.fromName },
      to: [{ address: found.to, name: '' }],
      cc: found.cc ? [{ address: found.cc, name: '' }] : [],
      date: found.date,
      html: found.html,
      text: found.text,
      flags: [found.seen ? '\\Seen' : null, found.flagged ? '\\Flagged' : null].filter(Boolean),
      attachments: (found.attachments || []).map((a, i) => ({
        index: i,
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      })),
    };
  }

  if (channel === 'messages:flag') {
    const [accountId, folder, uids, flag, on] = args;
    const msgs = demoStore.messages[accountId] || [];
    const uidSet = new Set(uids.map(Number));
    msgs.forEach((m) => {
      if (m.folder === folder && uidSet.has(m.uid)) {
        if (flag === '\\Seen') m.seen = !!on;
        if (flag === '\\Flagged') m.flagged = !!on;
      }
    });
    saveDemoStore();
    return true;
  }

  if (channel === 'messages:move') {
    const [accountId, folder, uids, dest] = args;
    const msgs = demoStore.messages[accountId] || [];
    const uidSet = new Set(uids.map(Number));
    msgs.forEach((m) => {
      if (m.folder === folder && uidSet.has(m.uid)) {
        m.folder = dest;
      }
    });
    saveDemoStore();
    return true;
  }

  if (channel === 'messages:remove') {
    const [accountId, folder, uids] = args;
    const msgs = demoStore.messages[accountId] || [];
    const uidSet = new Set(uids.map(Number));
    demoStore.messages[accountId] = msgs.filter((m) => !(m.folder === folder && uidSet.has(m.uid)));
    saveDemoStore();
    return true;
  }

  if (channel === 'messages:attachmentData') {
    const [accountId, folder, uid, index] = args;
    const msgs = demoStore.messages[accountId] || [];
    const found = msgs.find((m) => m.uid === Number(uid));
    if (!found || !found.attachments || !found.attachments[index]) {
      throw new Error('Pièce jointe introuvable');
    }
    const att = found.attachments[index];
    const buf = Buffer.from(att.contentBase64 || '', 'base64');
    return attachmentPreview({
      filename: att.filename,
      contentType: att.contentType,
      content: buf,
    });
  }

  if (channel === 'messages:send') {
    const [accountId, mail] = args;
    const acc = store.getAccount(accountId);
    if (!acc) throw new Error('Compte introuvable');

    let finalHtml = mail.html || `<div style="font-family:sans-serif;line-height:1.5;">${mail.text || ''}</div>`;
    let finalText = mail.text || '';
    let finalAttachments = (mail.attachments || []).map((a, i) => {
      const isObj = typeof a === 'object' && a !== null;
      return {
        index: i,
        filename: (isObj ? a.name : a) || 'piece-jointe',
        contentType: (isObj && a.contentType) || 'application/octet-stream',
        size: (isObj && a.size) || 0,
        contentBase64: (isObj && a.dataUrl ? a.dataUrl.split(',')[1] : '') || '',
      };
    });

    if (mail.signatureId) {
      const sig = (acc.signatures || []).find((s) => s.id === mail.signatureId);
      const built = sig && sig.images && sig.images.length ? buildSignedMessage(finalText, mail.signatureBlock || '', sig.images, finalHtml) : null;
      if (built) {
        finalText = built.text;
        finalHtml = built.html;
        const sigAtts = built.attachments.map((sa, i) => ({
          index: finalAttachments.length + i,
          filename: sa.filename,
          contentType: sa.contentType,
          size: sa.content.length,
          contentBase64: sa.content.toString('base64'),
        }));
        finalAttachments = [...sigAtts, ...finalAttachments];
      }
    }

    // Add to Sent folder in demoStore
    const newUid = ++demoStore.nextUid;
    const newMsg = {
      uid: newUid,
      folder: 'Sent',
      subject: mail.subject || '(sans objet)',
      from: acc.email,
      fromName: acc.name,
      to: mail.to || '',
      cc: mail.cc || '',
      date: new Date().toISOString(),
      size: finalText.length + 1000,
      seen: true,
      flagged: false,
      hasAttachment: !!finalAttachments.length,
      html: finalHtml,
      text: finalText,
      attachments: finalAttachments,
    };

    if (!demoStore.messages[accountId]) demoStore.messages[accountId] = [];
    demoStore.messages[accountId].unshift(newMsg);
    saveDemoStore();

    // Record contacts
    if (mail.to) {
      store.recordContacts([{ address: mail.to, name: '' }]);
    }
    return { ok: true, messageId: `<${newUid}@mailhub.web>` };
  }

  if (channel === 'messages:markAllRead') {
    const [accountId, folder] = args;
    const acc = store.getAccount(accountId);
    if (acc && acc.imap && acc.imap.host !== 'demo' && imapManager) {
      try {
        return await imapManager.markAllRead(accountId, folder);
      } catch (e) {
        console.warn('Real IMAP markAllRead error:', e.message);
      }
    }
    const msgs = demoStore.messages[accountId] || [];
    msgs.forEach((m) => {
      if (m.folder === folder) m.seen = true;
    });
    saveDemoStore();
    return true;
  }

  if (channel === 'messages:deleteAllInFolder') {
    const [accountId, folder] = args;
    const acc = store.getAccount(accountId);
    if (acc && acc.imap && acc.imap.host !== 'demo' && imapManager) {
      try {
        return await imapManager.deleteAllInFolder(accountId, folder);
      } catch (e) {
        console.warn('Real IMAP deleteAllInFolder error:', e.message);
      }
    }
    const msgs = demoStore.messages[accountId] || [];
    const initialLen = msgs.length;
    demoStore.messages[accountId] = msgs.filter((m) => m.folder !== folder);
    const deletedCount = initialLen - demoStore.messages[accountId].length;
    saveDemoStore();
    return { deletedCount };
  }

  if (channel === 'messages:markAllReadInAccount') {
    const [accountId] = args;
    const acc = store.getAccount(accountId);
    if (acc && acc.imap && acc.imap.host !== 'demo' && imapManager) {
      try {
        return await imapManager.markAllReadInAccount(accountId);
      } catch (e) {
        console.warn('Real IMAP markAllReadInAccount error:', e.message);
      }
    }
    const msgs = demoStore.messages[accountId] || [];
    msgs.forEach((m) => { m.seen = true; });
    saveDemoStore();
    return true;
  }

  if (channel === 'messages:saveDraft') {
    const [accountId, mail] = args;
    const acc = store.getAccount(accountId);
    if (!acc) throw new Error('Compte introuvable');
    if (acc.imap && acc.imap.host !== 'demo' && imapManager) {
      try {
        return await imapManager.saveDraft(accountId, mail);
      } catch (e) {
        console.warn('Real IMAP saveDraft error:', e.message);
      }
    }
    const newUid = ++demoStore.nextUid;
    const newMsg = {
      uid: newUid,
      folder: 'Drafts',
      subject: mail.subject || '(sans objet)',
      from: acc.email,
      fromName: acc.name,
      to: mail.to || '',
      cc: mail.cc || '',
      date: new Date().toISOString(),
      size: (mail.text || '').length + 500,
      seen: true,
      flagged: false,
      hasAttachment: !!(mail.attachments && mail.attachments.length),
      html: mail.html || '',
      text: mail.text || '',
      attachments: mail.attachments || [],
    };
    if (!demoStore.messages[accountId]) demoStore.messages[accountId] = [];
    demoStore.messages[accountId].unshift(newMsg);
    saveDemoStore();
    return { ok: true };
  }

  if (channel === 'messages:flagged') {
    const accounts = store.listAccounts();
    const results = [];
    for (const acc of accounts) {
      const msgs = demoStore.messages[acc.id] || [];
      msgs.filter((m) => m.flagged).forEach((m) => results.push({ ...m, accountId: acc.id }));
    }
    return results.sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  // ---- rules
  if (channel === 'rules:list') {
    return store.listRules();
  }
  if (channel === 'rules:add') {
    const [rule] = args;
    return store.addRule(rule);
  }
  if (channel === 'rules:update') {
    const [rule] = args;
    return store.updateRule(rule);
  }
  if (channel === 'rules:remove') {
    const [id] = args;
    return store.removeRule(id);
  }
  if (channel === 'rules:addMany') {
    const [list] = args;
    return store.addRules(list);
  }
  if (channel === 'rules:move') {
    const [id, delta] = args;
    return store.moveRule(id, delta);
  }

  if (channel === 'rules:sortSender') {
    const [{ accountId, folder, uids, from, dest, createRule, scope, moveExisting }] = args;
    let moved = 0;
    const msgs = demoStore.messages[accountId] || [];

    if (uids && uids.length) {
      const uidSet = new Set(uids.map(Number));
      msgs.forEach((m) => {
        if (m.folder === folder && uidSet.has(m.uid)) {
          m.folder = dest;
          moved++;
        }
      });
    }

    let rule = null;
    if (createRule && from) {
      rule = store.upsertSenderRule({ accountId, from, folder: dest, scope }).rule;
    }

    if (moveExisting && from && dest !== folder) {
      const fromLower = from.toLowerCase();
      msgs.forEach((m) => {
        if (m.folder === folder && m.from.toLowerCase() === fromLower) {
          m.folder = dest;
          moved++;
        }
      });
    }

    saveDemoStore();
    return { moved, rule };
  }

  if (channel === 'rules:autoSender') {
    const [{ accountId, senders, folder }] = args;
    const unique = [...new Set((senders || []).map((s) => String(s || '').toLowerCase().trim()).filter(Boolean))].slice(0, 20);
    return unique.map((from) => {
      const res = store.upsertSenderRule({ accountId, from, folder, scope: 'address' });
      return {
        from,
        rule: res.rule,
        created: res.created,
        previousFolder: res.previousFolder,
        previousEnabled: res.previousEnabled,
      };
    });
  }

  if (channel === 'rules:applyToFolder') {
    const [accountId, folder] = args;
    const rules = store.listRules().filter((r) => r.accountId === accountId && r.enabled !== false);
    if (!rules.length) return { moved: 0, scanned: 0, noRules: true };

    const msgs = demoStore.messages[accountId] || [];
    const targetMsgs = msgs.filter((m) => m.folder === folder);
    let movedCount = 0;
    const movedItems = [];

    targetMsgs.forEach((msg) => {
      const rule = findRule(rules, accountId, msg);
      if (rule && rule.folder && rule.folder !== folder) {
        msg.folder = rule.folder;
        movedCount++;
        movedItems.push({ uid: msg.uid, folder: rule.folder });
      }
    });

    if (movedCount > 0) {
      saveDemoStore();
      broadcast('mail:sorted', { accountId, moved: movedItems });
    }

    return { moved: movedCount, scanned: targetMsgs.length, failed: [], noRules: false };
  }

  if (channel === 'rules:applyAll') {
    const [accountId] = args;
    const ids = accountId ? [accountId] : store.listAccounts().map((a) => a.id);
    const total = { moved: 0, scanned: 0, failed: [], accounts: ids.length, noRules: true };

    for (const id of ids) {
      const res = await handleChannel('rules:applyToFolder', [id, 'INBOX']);
      total.moved += res.moved;
      total.scanned += res.scanned;
      if (!res.noRules) total.noRules = false;
    }
    return total;
  }

  if (channel === 'rules:export') {
    const rules = store.listRules();
    if (!rules.length) throw new Error('Vous n’avez aucune règle à exporter.');
    const accounts = store.listAccounts();
    const data = rulesio.exportRules(rules, accounts);
    return {
      saved: true,
      count: data.rules.length,
      content: JSON.stringify(data, null, 2),
    };
  }

  if (channel === 'rules:importPickDirect') {
    const [{ file, text }] = args;
    const { rules, skipped } = rulesio.parseRulesFile(text);
    const accounts = store.listAccounts();
    const existing = new Set(store.listRules().map((r) => rulesio.ruleKey(r.accountId, r)));
    const emails = [...new Set(rules.map((r) => r.accountEmail))];
    const mapping = {};
    emails.forEach((e) => {
      const a = accounts.find((x) => x.email.toLowerCase() === e);
      mapping[e] = a ? a.id : accounts.length === 1 ? accounts[0].id : '';
    });
    return {
      file,
      skipped,
      emails,
      mapping,
      rules: rules.map((r) => ({
        ...r,
        duplicate: !!mapping[r.accountEmail] && existing.has(rulesio.ruleKey(mapping[r.accountEmail], r)),
      })),
    };
  }

  if (channel === 'rules:duplicates') {
    const [items] = args;
    const existing = new Set(store.listRules().map((r) => rulesio.ruleKey(r.accountId, r)));
    return items.map((it) => !!it.accountId && existing.has(rulesio.ruleKey(it.accountId, it)));
  }

  // ---- contacts
  if (channel === 'contacts:list') {
    return store.listContacts();
  }
  if (channel === 'contacts:remove') {
    const [email] = args;
    store.removeContact(email);
    return store.listContacts();
  }
  if (channel === 'contacts:importSent') {
    let scanned = 0;
    let added = 0;
    for (const acc of store.listAccounts()) {
      const sentMsgs = (demoStore.messages[acc.id] || []).filter((m) => m.folder === 'Sent');
      scanned += sentMsgs.length;
      sentMsgs.forEach((m) => {
        if (m.to) {
          added += store.recordContacts([{ address: m.to, name: '' }]);
        }
      });
    }
    return { scanned, added, contacts: store.listContacts() };
  }

  // ---- thunderbird
  if (channel === 'thunderbird:scan') {
    // In web environment, provide pre-scanned mock or sample filters
    return [];
  }
  if (channel === 'thunderbird:pickDirect') {
    const [{ file, text }] = args;
    const filters = tb.parseFilterFile(text);
    if (!filters.length) throw new Error('Ce fichier ne contient aucun filtre Thunderbird reconnu.');
    return {
      file,
      server: 'Thunderbird Import',
      filters: filters.length,
      suggestedAccountId: store.listAccounts()[0]?.id || '',
    };
  }
  if (channel === 'thunderbird:preview') {
    const [file, accountId] = args;
    const folders = getDemoFolders(accountId);
    return {
      total: 0,
      importable: 0,
      ignored: 0,
      rules: [],
    };
  }

  // ---- preferences
  if (channel === 'prefs:get') {
    return store.getPrefs();
  }
  if (channel === 'prefs:set') {
    const [patch] = args;
    return store.setPrefs(patch);
  }

  // ---- signatures
  if (channel === 'signatures:pickImage') {
    return null;
  }

  if (channel === 'app:hide') {
    return true;
  }

  throw new Error(`Canal inconnu : ${channel}`);
}

// REST IPC Endpoint
app.post('/api/ipc', async (req, res) => {
  const { channel, args = [] } = req.body || {};
  if (!channel) {
    return res.status(400).json({ ok: false, error: 'Nom de canal manquant' });
  }

  try {
    const data = await handleChannel(channel, args);
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`[IPC ${channel}] Error:`, err.message);
    res.json({ ok: false, error: friendlyError(err) });
  }
});

// Serve static frontend files
const rendererDir = path.join(__dirname, 'renderer');
app.use(express.static(rendererDir));

// Fallback to index.html for SPA routing
app.use((req, res) => {
  res.sendFile(path.join(rendererDir, 'index.html'));
});

// Start Server
const server = http.createServer(app);
server.listen(PORT, HOST, () => {
  console.log(`MailHub Web server running on http://${HOST}:${PORT}`);
});
