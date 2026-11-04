'use strict';

/**
 * Envoi programmé : les messages attendent dans le stockage local et partent à l'heure dite
 * (ou au démarrage suivant si l'ordinateur était éteint). En cas d'échec, nouvel essai plus tard.
 */
const MAX_ATTEMPTS = 5;
const RETRY_MINUTES = 5;

// Résumé envoyé à l'interface : jamais le contenu des pièces jointes
function summary(item) {
  const m = item.mail || {};
  return {
    id: item.id,
    accountId: item.accountId,
    when: item.when,
    createdAt: item.createdAt,
    to: m.to || '',
    cc: m.cc || '',
    bcc: m.bcc || '',
    subject: m.subject || '',
    attachments: [
      ...(m.attachments || []).map((a) => a.name || 'piece-jointe'),
      ...((m.sourceAttachments && m.sourceAttachments.indexes) || []).map((_, i) => `pièce jointe d’origine ${i + 1}`),
    ],
    error: item.error || '',
    attempts: item.attempts || 0,
    paused: !!item.paused,
  };
}

function validWhen(when) {
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) throw new Error('Date d’envoi invalide.');
  if (d.getTime() > Date.now() + 366 * 86400000) throw new Error('Date d’envoi trop lointaine (un an maximum).');
  return d.toISOString();
}

class Scheduler {
  constructor(store, send, notify = () => {}) {
    this.store = store;
    this.send = send;
    this.notify = notify;
    this.busy = false;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 30000);
    setTimeout(() => this.tick(), 5000);
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  list() {
    return this.store.listScheduled().map(summary).sort((a, b) => new Date(a.when) - new Date(b.when));
  }

  add(accountId, mail, when) {
    if (!accountId || !mail) throw new Error('Message incomplet.');
    const item = this.store.addScheduled({ accountId, mail, when: validWhen(when) });
    return summary(item);
  }

  reschedule(id, when) {
    const item = this.store.updateScheduled(id, { when: validWhen(when), paused: false, attempts: 0, error: '' });
    if (!item) throw new Error('Message programmé introuvable (déjà envoyé ?).');
    return summary(item);
  }

  // Annule : le message complet est rendu à l'interface (pour le modifier ou le jeter)
  cancel(id) {
    const item = this.store.removeScheduled(id);
    if (!item) throw new Error('Message programmé introuvable (déjà envoyé ?).');
    return { accountId: item.accountId, mail: item.mail, when: item.when };
  }

  async sendNow(id) {
    const item = this.store.listScheduled().find((x) => x.id === id);
    if (!item) throw new Error('Message programmé introuvable (déjà envoyé ?).');
    await this._deliver(item, { throwOnError: true });
    return true;
  }

  async _deliver(item, { throwOnError = false } = {}) {
    try {
      await this.send(item.accountId, item.mail);
      this.store.removeScheduled(item.id);
      this.notify('sent', summary(item));
    } catch (err) {
      const attempts = (item.attempts || 0) + 1;
      const paused = attempts >= MAX_ATTEMPTS;
      const updated = this.store.updateScheduled(item.id, {
        attempts,
        paused,
        error: err.message || String(err),
        when: paused ? item.when : new Date(Date.now() + RETRY_MINUTES * attempts * 60000).toISOString(),
      });
      this.notify('failed', summary(updated || item));
      if (throwOnError) throw err;
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = this.store.listScheduled().filter((x) => !x.paused && new Date(x.when).getTime() <= Date.now());
      for (const item of due) await this._deliver(item);
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { Scheduler, summary };
