import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { leads as googleLeads } from '../google.js';
import { readJson, writeJson } from './storage.js';

export function normalizePhone(phone) {
  let value = String(phone ?? '').replace(/\D/g, '');
  if (value.startsWith('0800') || value.startsWith('0300')) return null;
  if (value.startsWith('0')) value = value.slice(1);
  if (value.length === 10 || value.length === 11) value = `55${value}`;
  return value.length >= 12 ? value : null;
}

export function googleKey(root) {
  // Parse the project file on each launch so a changed key does not require a server restart.
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const match = text.match(/^\s*(?:export\s+)?API_GOOGLE_MAPS\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#]+))/m);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? process.env.API_GOOGLE_MAPS ?? '').trim();
}

export function loadTemplates(root) {
  const text = fs.readFileSync(path.join(root, 'mensagem.txt'), 'utf8');
  const templates = text.split(/^\s*---\s*$/m).map((item) => item.trim()).filter(Boolean);
  if (!templates.length) throw Object.assign(new Error('Salve uma mensagem antes de iniciar a campanha.'), { status: 400 });
  return templates;
}

export function composeMessage(templates, lead) {
  return templates[Math.floor(Math.random() * templates.length)]
    .replaceAll('{nome}', lead.nome ?? '')
    .replaceAll('{avaliacao}', String(lead.avaliacao ?? '').replace('.', ','))
    .replaceAll('{total_avaliacoes}', String(lead.total_avaliacoes ?? ''));
}

const defaultTiming = { between: [3, 12], firstRound: [30, 40], round: [30, 300], typing: [2.5, 7], error: 15 };
const random = (range) => range[0] + Math.random() * (range[1] - range[0]);
const isAbort = (error) => error.name === 'AbortError';

export async function executeCampaign({ root, campaign, accounts, whatsapp, logger, run, signal, changed, source = googleLeads, timing = defaultTiming, templates = loadTemplates(root), key = googleKey(root), preview = false, onPreview }) {
  const historyPath = path.join(root, 'historico.json');
  const history = readJson(historyPath, { empresas: {}, buscas: {} });
  if (!history.empresas || !history.buscas) throw new Error('O histórico está incompleto. Verifique historico.json antes de iniciar.');
  const usedNumbers = new Set(Object.values(history.empresas).map((item) => normalizePhone(item.numero)).filter(Boolean));
  const used = (lead) => Boolean(history.empresas[lead.id]) || usedNumbers.has(normalizePhone(lead.telefone));
  const leased = new Map();
  const save = () => { if (!preview) writeJson(historyPath, history); };
  const scope = campaign.name;
  const sleep = (seconds) => delay(seconds * 1000, undefined, { signal });
  const event = (type, data) => {
    if (type === 'consulta') { run.queries++; logger.info(scope, `Consulta ${run.queries} à API do Google Maps.`); }
    if (type === 'area') logger.info(scope, `Região encontrada: ${data}.`);
    if (type === 'dividiu') logger.info(scope, `Busca ampliada: ${data} áreas pendentes.`);
    changed();
  };

  function makeSource(niche) {
    const returned = [];
    async function* generate() {
      for (const city of campaign.cities) {
        signal.throwIfAborted();
        const searchKey = `${niche}|${city}`.toLowerCase().replace(/\s+/g, ' ');
        const search = preview ? structuredClone(history.buscas[searchKey] ?? {}) : (history.buscas[searchKey] ??= {});
        if (search.esgotada) { logger.info(scope, `Busca já percorrida: ${niche} em ${city}.`); continue; }
        logger.info(scope, `Buscando ${niche} em ${city}.`);
        try {
          for await (const lead of source({ chave: key, termo: niche, cidade: city, busca: search, jaUsado: used, aoEvento: event, signal })) {
            const enriched = { ...lead, nicho: niche, _searchKey: searchKey };
            leased.set(lead.id, enriched);
            signal.throwIfAborted();
            yield enriched;
          }
        } finally { save(); }
        logger.info(scope, `Busca finalizada: ${niche} em ${city}.`);
      }
    }
    const generator = generate();
    const item = { niche, ended: false, returned, generator, async next() {
      if (returned.length) return returned.shift();
      if (item.ended) return null;
      const result = await generator.next();
      if (result.done) { item.ended = true; return returned.shift() ?? null; }
      return result.value;
    } };
    return item;
  }

  const sources = campaign.niches.map(makeSource);
  let cursor = 0;
  function round() {
    const available = sources.filter((item) => !item.ended || item.returned.length);
    if (!available.length) return [];
    const result = Array.from({ length: 3 }, (_, index) => available[(cursor + index) % available.length]);
    cursor = (cursor + 3) % available.length;
    return result;
  }
  async function nextLead(preferred) {
    for (const item of [preferred, ...sources.filter((sourceItem) => sourceItem !== preferred)]) {
      const lead = await item.next();
      if (lead) return lead;
    }
    return null;
  }

  async function sendOne(accountId, preferred) {
    while (!signal.aborted) {
      const account = await whatsapp.wait(accountId, signal);
      const lead = await nextLead(preferred);
      signal.throwIfAborted();
      if (!lead) return 'empty';
      const phone = normalizePhone(lead.telefone);
      if (!phone || used(lead)) { leased.delete(lead.id); continue; }
      // Reserve before awaiting: protects against duplicate businesses/numbers across workers.
      const record = { nome: lead.nome, nicho: lead.nicho, numero: phone, status: 'enviando', conta: accountId, data: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) };
      history.empresas[lead.id] = record;
      usedNumbers.add(phone);
      save();
      let attemptedSend = false;
      try {
        const [contact] = (await account.socket.onWhatsApp(phone)) ?? [];
        signal.throwIfAborted();
        if (!contact?.exists) {
          record.status = 'sem_whatsapp';
          run.withoutWhatsapp++;
          logger.warn(accountId.toUpperCase(), `${lead.nome} · ${lead.nicho} · +${phone} · sem WhatsApp.`);
          save(); changed();
          continue;
        }
        await account.socket.sendPresenceUpdate('composing', contact.jid);
        await sleep(random(timing.typing));
        await account.socket.sendPresenceUpdate('paused', contact.jid);
        signal.throwIfAborted();
        if (account.status !== 'connected') throw new Error('A conta desconectou antes do envio.');
        attemptedSend = true;
        // A stop waits for an already-started send to settle before declaring the run stopped.
        await account.socket.sendMessage(contact.jid, { text: composeMessage(templates, lead) });
        record.status = 'enviado';
        record.data = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        run.sent++;
        logger.success(accountId.toUpperCase(), `${lead.nome} · ${lead.nicho} · +${phone} · mensagem enviada. Total: ${run.sent}.`);
        save(); changed();
        return 'sent';
      } catch (error) {
        if (!attemptedSend) {
          delete history.empresas[lead.id];
          usedNumbers.delete(phone);
          leased.set(lead.id, lead);
          sources.find((item) => item.niche === lead.nicho).returned.push(lead);
        } else {
          record.status = 'erro';
          run.errors++;
        }
        save(); changed();
        if (isAbort(error) || signal.aborted) throw error;
        logger.error(accountId.toUpperCase(), `${lead.nome} · ${attemptedSend ? 'envio falhou; não será repetido' : 'contato devolvido à fila'} · ${error.message}`);
        await sleep(timing.error);
        return 'failed';
      }
    }
    signal.throwIfAborted();
  }

  async function worker(accountId) {
    let previous = null;
    while (!signal.aborted) {
      await whatsapp.wait(accountId, signal);
      const items = round();
      if (!items.length) return;
      let sent = 0;
      let empty = false;
      for (const item of items) {
        signal.throwIfAborted();
        if (sent) await sleep(random(timing.between));
        const result = await sendOne(accountId, item);
        if (result === 'sent') sent++;
        if (result === 'empty') { empty = true; break; }
      }
      if (empty) return;
      let interval = random(previous === null ? timing.firstRound : timing.round);
      if (previous !== null && timing.round[1] - timing.round[0] > 50) while (Math.abs(interval - previous) < 25) interval = random(timing.round);
      previous = interval;
      logger.info(accountId.toUpperCase(), `Rodada finalizada: ${sent} enviada(s). Próxima em ${Math.round(interval)}s.`);
      await sleep(interval);
    }
  }

  try {
    if (preview) {
      for (let index = 0; index < 2; index++) for (const item of round()) {
        let lead, phone;
        do { lead = await nextLead(item); phone = lead && normalizePhone(lead.telefone); } while (lead && (!phone || used(lead)));
        if (!lead) break;
        usedNumbers.add(phone);
        onPreview?.(lead, phone, composeMessage(templates, lead));
      }
    } else {
      const results = await Promise.allSettled(accounts.map(async (id) => {
        try { await worker(id); }
        catch (error) { if (!isAbort(error) && !signal.aborted) run.abort(error); throw error; }
      }));
      const failure = results.find((result) => result.status === 'rejected' && !isAbort(result.reason));
      if (failure) throw failure.reason;
      signal.throwIfAborted();
    }
  } finally {
    // Return unattempted leads to the persisted queue, including a lead interrupted while typing.
    for (const lead of leased.values()) {
      const search = history.buscas[lead._searchKey];
      if (search && !used(lead)) {
        search.fila ??= [];
        const { _searchKey, ...restored } = lead;
        if (!search.fila.some((queued) => queued.id === lead.id)) search.fila.unshift(restored);
        search.esgotada = false;
      }
    }
    for (const item of sources) await item.generator.return();
    save();
  }
}
