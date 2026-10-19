import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
import { acquireProjectLock, readJson, writeJson } from './storage.js';
import { WhatsAppManager } from './whatsapp.js';
import { executeCampaign, googleKey, loadTemplates } from './campaign.js';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const BUSY = ['running', 'stopping'];

export class BotRuntime extends EventEmitter {
  constructor({ root, logger = createLogger({ root }), whatsapp, source, timing, onQr } = {}) {
    super();
    Object.assign(this, { root, logger, source, timing });
    this.whatsapp = whatsapp ?? new WhatsAppManager({ root, logger, onQr });
    this.active = null;
    this.completion = Promise.resolve();
    this.lockRelease = null;
    this.closed = false;
    this.runsPath = path.join(root, '.orbita', 'execucoes.json');
    this.runs = readJson(this.runsPath, {});
    for (const run of Object.values(this.runs)) if (BUSY.includes(run.status)) { run.status = 'interrupted'; run.error = 'O servidor foi encerrado durante esta execução. Inicie novamente para continuar pelo histórico.'; }
    this.whatsapp.on('change', () => this.emit('change'));
    this.logger.events.on('entry', () => this.emit('change'));
  }

  snapshot() {
    return { accounts: this.whatsapp.list(), active: this.active ? this.publicRun(this.active) : null, runs: this.runs, logs: this.logger.entries.slice(-60) };
  }

  publicRun(run) {
    const { controller, abort, templates, key, ...result } = run;
    return structuredClone(result);
  }

  own() {
    if (this.closed) throw fail('O servidor está encerrando.');
    if (!this.lockRelease) this.lockRelease = acquireProjectLock(this.root);
  }

  connectAccount(id, options) {
    if (!/^wa[1-5]$/.test(id)) throw fail('Escolha uma conta de wa1 a wa5.', 400);
    this.own();
    if (options?.reset && this.isBusy() && this.active.accounts.includes(id)) throw fail('Pare a campanha antes de refazer o pareamento da conta.');
    return this.whatsapp.connect(id, options);
  }

  async disconnectAccount(id) {
    if (this.isBusy() && this.active.accounts.includes(id)) throw fail('Pare a campanha antes de desconectar uma conta em uso.');
    await this.whatsapp.disconnect(id);
  }

  isBusy() { return this.active && BUSY.includes(this.active.status); }

  persist() {
    this.runs[this.active.campaignId] = this.publicRun(this.active);
    writeJson(this.runsPath, this.runs);
    this.emit('change');
  }

  start(campaign) {
    if (this.isBusy()) throw fail('Já existe uma campanha em execução. Pare ou aguarde a conclusão antes de iniciar outra.');
    if (!Array.isArray(campaign.niches) || !campaign.niches.length || !Array.isArray(campaign.cities) || !campaign.cities.length || !Number.isInteger(campaign.accounts) || campaign.accounts < 1 || campaign.accounts > 5) throw fail('A campanha está incompleta. Prepare nichos, cidades e contas antes de iniciar.', 400);
    const key = googleKey(this.root);
    if (!key) throw fail('Configure API_GOOGLE_MAPS no arquivo .env antes de iniciar.', 400);
    const templates = loadTemplates(this.root);
    // Validate the history before creating a run or touching WhatsApp.
    const history = readJson(path.join(this.root, 'historico.json'), { empresas: {}, buscas: {} });
    if (!history.empresas || !history.buscas) throw fail('O histórico está incompleto. Verifique historico.json.', 400);
    const accounts = this.whatsapp.list().filter((account) => account.status === 'connected').slice(0, campaign.accounts).map((account) => account.id);
    if (accounts.length < campaign.accounts) throw fail(`Esta campanha precisa de ${campaign.accounts} conta(s) conectada(s). Conecte o WhatsApp na aba Contas antes de iniciar.`);
    this.own();
    const controller = new AbortController();
    const run = {
      id: randomUUID(), campaignId: campaign.id, name: campaign.name, status: 'running',
      startedAt: new Date().toISOString(), endedAt: null, accounts,
      sent: 0, withoutWhatsapp: 0, errors: 0, queries: 0, error: null, controller,
      abort: (error) => controller.abort(error),
    };
    const previous = this.active;
    const previousRun = this.runs[campaign.id];
    this.active = run;
    try { this.persist(); }
    catch (error) {
      this.active = previous;
      if (previousRun) this.runs[campaign.id] = previousRun;
      else delete this.runs[campaign.id];
      throw error;
    }
    this.logger.info(campaign.name, `Campanha iniciada · nichos: ${campaign.niches.join(', ')} · cidades: ${campaign.cities.join(', ')} · contas: ${accounts.join(', ')}.`);
    this.completion = this.execute(campaign, run, templates, key);
    return this.publicRun(run);
  }

  async execute(campaign, run, templates, key) {
    try {
      await executeCampaign({ root: this.root, campaign, accounts: run.accounts, whatsapp: this.whatsapp, logger: this.logger, run, signal: run.controller.signal, changed: () => this.persist(), source: this.source, timing: this.timing, templates, key });
      run.status = 'completed';
      this.logger.success(campaign.name, 'Campanha concluída. As buscas disponíveis foram percorridas.');
    } catch (error) {
      if (run.status === 'stopping' && error.name === 'AbortError') {
        run.status = 'stopped';
        this.logger.info(campaign.name, 'Campanha parada pelo usuário. O histórico foi preservado.');
      } else {
        run.status = 'error';
        run.error = String(error.message).slice(0, 400);
        this.logger.error(campaign.name, `Campanha interrompida: ${run.error}`);
      }
    } finally {
      run.endedAt = new Date().toISOString();
      this.logger.info(campaign.name, `Resumo · ${run.sent} enviadas · ${run.withoutWhatsapp} sem WhatsApp · ${run.errors} erros · ${run.queries} consultas à API.`);
      try { this.persist(); }
      catch (error) { this.logger.error('ARQUIVOS', `Não foi possível salvar o resumo da execução: ${error.message}`); }
    }
    return this.publicRun(run);
  }

  stop(campaignId) {
    if (!this.isBusy() || this.active.campaignId !== campaignId) throw fail('Esta campanha não está em execução.');
    if (this.active.status !== 'stopping') {
      this.active.status = 'stopping';
      this.active.controller.abort();
      this.logger.warn(this.active.name, 'Parada solicitada. Nenhum novo envio será iniciado; aguardando operações em andamento.');
      this.persist();
    }
    return this.publicRun(this.active);
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.isBusy()) this.stop(this.active.campaignId);
      await this.completion;
    } finally {
      try { await this.whatsapp.close(); }
      finally { this.lockRelease?.(); this.lockRelease = null; }
    }
  }
}
