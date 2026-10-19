import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { readJson } from './storage.js';
import '../terminal.js'; // Suppress libsignal's raw session/key dumps before loading Baileys.

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode/index.js');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

export function qrDataUrl(text) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const cells = [];
  for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (qr.isDark(row, col)) cells.push(`M${col + 4},${row + 4}h1v1h-1z`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${count + 8} ${count + 8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${cells.join('')}" fill="#000"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

async function defaultAdapter(folder) {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import('baileys');
  const { state, saveCreds } = await useMultiFileAuthState(folder);
  return { makeSocket: () => makeWASocket({ auth: state, logger: pino({ level: 'silent' }), markOnlineOnConnect: false, connectTimeoutMs: 30000, defaultQueryTimeoutMs: 30000 }), saveCreds, reasons: DisconnectReason };
}

export class WhatsAppManager extends EventEmitter {
  constructor({ root, logger, adapter = defaultAdapter, onQr, retryMs = 3000 }) {
    super();
    Object.assign(this, { root, logger, adapter, onQr, retryMs });
    this.accounts = new Map();
    this.closed = false;
  }

  list() {
    let folders = [];
    try { folders = fs.readdirSync(path.join(this.root, 'sessoes'), { withFileTypes: true }).filter((folder) => folder.isDirectory() && /^wa[1-5]$/.test(folder.name)).map((folder) => folder.name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return [...new Set([...folders, ...this.accounts.keys()])].sort().map((id) => this.snapshot(id));
  }

  snapshot(id) {
    const account = this.accounts.get(id);
    let saved = false;
    try { saved = Boolean(readJson(path.join(this.root, 'sessoes', id, 'creds.json'), null)?.me?.id); } catch { /* An invalid session can be paired again. */ }
    return { id, name: `WhatsApp ${id.slice(2)}`, saved, status: account?.status ?? 'disconnected', phone: account?.phone ?? null, qr: account?.qr ?? null, error: account?.error ?? null };
  }

  changed() { this.emit('change'); }

  connect(id, { reset = false } = {}) {
    if (!/^wa[1-5]$/.test(id)) throw fail('Escolha uma conta de wa1 a wa5.', 400);
    if (this.closed) throw fail('O servidor está encerrando.');
    let previous = this.accounts.get(id);
    if (previous && ['connected', 'connecting', 'qr', 'reconnecting'].includes(previous.status)) return this.snapshot(id);
    if (previous?.pendingAuth || previous?.pendingClose) throw fail('Aguarde a finalização da conexão anterior antes de tentar novamente.');
    if (reset) {
      const folder = path.join(this.root, 'sessoes', id);
      if (fs.existsSync(folder)) {
        const backups = path.join(this.root, '.orbita', 'sessoes-anteriores');
        fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
        fs.renameSync(folder, path.join(backups, `${id}-${Date.now()}`));
      }
      this.logger.info(id.toUpperCase(), 'Sessão anterior arquivada. Preparando um novo pareamento.');
    }
    const account = { id, status: 'connecting', qr: null, phone: null, error: null, socket: null, generation: 0, controller: new AbortController(), credentialsWrite: Promise.resolve(), attempt: 0 };
    this.accounts.set(id, account);
    this.logger.info(id.toUpperCase(), 'Conectando ao WhatsApp…');
    this.changed();
    this.open(account).catch((error) => this.failed(account, error));
    return this.snapshot(id);
  }

  failed(account, error) {
    if (account.controller.signal.aborted || this.closed) return;
    account.controller.abort();
    account.socket?.end(undefined);
    account.status = 'error';
    account.error = String(error.message).slice(0, 300);
    account.qr = null;
    this.logger.error(account.id.toUpperCase(), account.error);
    this.changed();
  }

  async open(account) {
    const generation = ++account.generation;
    account.pendingAuth = true;
    let adapter;
    try { adapter = await this.adapter(path.join(this.root, 'sessoes', account.id)); }
    finally { account.pendingAuth = false; }
    if (account.controller.signal.aborted || this.closed || generation !== account.generation) return;
    const socket = adapter.makeSocket();
    account.socket = socket;
    socket.ev.on('creds.update', () => {
      account.credentialsWrite = account.credentialsWrite.then(() => adapter.saveCreds()).catch((error) => {
        this.logger.error(account.id.toUpperCase(), `Falha ao salvar credenciais: ${error.message}`);
      });
    });
    socket.ev.on('connection.update', (update) => {
      if (account.controller.signal.aborted || this.closed || generation !== account.generation) return;
      if (update.qr) {
        try { account.qr = qrDataUrl(update.qr); }
        catch (error) { this.failed(account, new Error(`Não foi possível gerar o QR code: ${error.message}`)); return; }
        account.status = 'qr';
        account.error = null;
        this.logger.info(account.id.toUpperCase(), 'QR code atualizado no painel. Escaneie em WhatsApp → Aparelhos conectados.');
        this.onQr?.(account.id, update.qr);
        this.changed();
      }
      if (update.connection === 'open') {
        const phone = socket.user?.id?.split(':')[0]?.split('@')[0] ?? null;
        const duplicate = phone && [...this.accounts.values()].find((item) => item !== account && item.status === 'connected' && item.phone === phone);
        if (duplicate) {
          account.controller.abort();
          account.status = 'error';
          account.error = `Esse número já está conectado em ${duplicate.id.toUpperCase()}. Use outro número.`;
          account.qr = null;
          socket.end(undefined);
          this.logger.error(account.id.toUpperCase(), account.error);
          this.changed();
          return;
        }
        account.attempt = 0;
        account.status = 'connected';
        account.phone = phone;
        account.qr = null;
        account.error = null;
        this.logger.success(account.id.toUpperCase(), `WhatsApp conectado${phone ? ` · +${phone}` : ''}.`);
        this.changed();
      }
      if (update.connection !== 'close') return;
      account.qr = null;
      const code = update.lastDisconnect?.error?.output?.statusCode;
      if (code != null && [adapter.reasons.loggedOut, adapter.reasons.badSession, adapter.reasons.multideviceMismatch].includes(code)) {
        account.status = 'logged_out';
        account.error = 'A sessão foi encerrada. Clique em Gerar novo QR e escaneie novamente.';
        this.logger.warn(account.id.toUpperCase(), account.error);
        this.changed();
        return;
      }
      if (code != null && code === adapter.reasons.connectionReplaced) return this.failed(account, new Error('A conexão foi substituída por outra execução. Encerre o outro bot antes de reconectar.'));
      account.attempt++;
      if (account.attempt > 5) return this.failed(account, new Error(`Não foi possível reconectar (código ${code ?? '?'}). Tente novamente pelo painel.`));
      account.status = 'reconnecting';
      this.logger.warn(account.id.toUpperCase(), code === adapter.reasons.restartRequired ? 'QR lido. Finalizando o pareamento…' : `Conexão caiu (código ${code ?? '?'}). Reconectando, tentativa ${account.attempt}/5.`);
      this.changed();
      account.socket = null;
      // Baileys requires a fresh socket after pairing. Wait for credentials to reach disk first.
      const reconnect = async () => {
        await account.credentialsWrite;
        await delay(code === adapter.reasons.restartRequired ? 100 : this.retryMs, undefined, { signal: account.controller.signal });
        if (!account.controller.signal.aborted && generation === account.generation) await this.open(account);
      };
      reconnect().catch((error) => this.failed(account, error));
    });
  }

  async wait(id, signal) {
    signal?.throwIfAborted();
    const current = () => this.accounts.get(id);
    if (current()?.status === 'connected') return current();
    if (!current() || ['disconnected', 'logged_out', 'error'].includes(current().status)) throw fail(current()?.error || `Conecte ${id.toUpperCase()} pelo painel.`);
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); this.off('change', changed); signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(Object.assign(new Error('Operação interrompida.'), { name: 'AbortError' })); };
      const changed = () => {
        const account = current();
        if (account?.status === 'connected') { cleanup(); resolve(account); }
        else if (!account || ['disconnected', 'logged_out', 'error'].includes(account.status)) { cleanup(); reject(fail(account?.error || 'Conta desconectada.')); }
      };
      const timeout = setTimeout(() => { cleanup(); reject(fail(`A conexão de ${id.toUpperCase()} demorou. Verifique a conta no painel.`)); }, 150000);
      this.on('change', changed);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  async disconnect(id) {
    const account = this.accounts.get(id);
    if (!account) return;
    account.controller.abort();
    account.pendingClose = true;
    account.generation++;
    account.socket?.end(undefined);
    account.socket = null;
    account.status = 'disconnected';
    account.qr = null;
    account.error = null;
    try { await account.credentialsWrite; }
    finally { account.pendingClose = false; }
    this.logger.info(id.toUpperCase(), 'Conexão encerrada. Sessão mantida para a próxima conexão.');
    this.changed();
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.accounts.keys()].map((id) => this.disconnect(id)));
  }
}
