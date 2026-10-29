import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { composeMessage, basePath } from './campaign.js';
import { readJson, writeJson } from './storage.js';

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

// Lê o .env a cada início de campanha, como a chave do Google, para não exigir reinício do servidor.
export function envValue(root, name) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const match = text.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\s#]+))`, 'm'));
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? process.env[name] ?? '').trim();
}

export function emailSettings(root) {
  return { key: envValue(root, 'API_KEY_SENDGRID'), from: envValue(root, 'EMAIL_REMETENTE'), fromName: envValue(root, 'NOME_REMETENTE') };
}

const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendEmail({ key, from, fromName, to, subject, text, signal, fetchImpl = fetch }) {
  const response = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, ...(fromName ? { name: fromName } : {}) },
      subject,
      content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: escapeHtml(text).replace(/\r?\n/g, '<br>') }],
    }),
    signal,
  });
  if (response.status === 202) return;
  let detail = '';
  try { detail = (await response.json()).errors?.map((item) => item.message).join('; ') ?? ''; } catch { /* resposta sem JSON */ }
  throw Object.assign(new Error(`SendGrid (${response.status}): ${detail || 'falha no envio'}`), { status: response.status });
}

const random = (range) => range[0] + Math.random() * (range[1] - range[0]);
const isAbort = (error) => error.name === 'AbortError';
const now = () => new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

export async function executeEmailCampaign({ root, campaign, logger, run, signal, changed, settings, templates, send = sendEmail, pause = [1, 3] }) {
  const historyPath = path.join(root, 'historico.json');
  const history = readJson(historyPath, { empresas: {}, buscas: {} });
  if (!history.empresas || !history.buscas) throw new Error('O histórico está incompleto. Verifique historico.json antes de iniciar.');
  const contacts = readJson(basePath(root, campaign.id), null);
  if (!Array.isArray(contacts)) throw new Error('A base de contatos desta campanha não foi encontrada. Importe a base novamente.');
  const scope = campaign.name;
  let sentAny = false;
  for (const contact of contacts) {
    if (!contact.email) continue;
    signal.throwIfAborted();
    const id = `email:${contact.email}`;
    if (history.empresas[id]) { run.skipped++; continue; }
    const lead = { nome: contact.nome, nicho: contact.nicho };
    if (sentAny) await delay(random(pause) * 1000, undefined, { signal });
    // Reserva antes de enviar: um envio interrompido nunca é repetido por engano.
    const record = { nome: contact.nome, nicho: contact.nicho, email: contact.email, canal: 'email', status: 'enviando', data: now() };
    history.empresas[id] = record;
    writeJson(historyPath, history);
    try {
      await send({ ...settings, to: contact.email, subject: composeMessage([campaign.emailSubject], lead), text: composeMessage(templates, lead), signal });
      sentAny = true;
      record.status = 'enviado';
      record.data = now();
      run.sent++;
      logger.success(scope, `${contact.nome || contact.email} · ${contact.nicho} · ${contact.email} · e-mail enviado. Total: ${run.sent}.`);
    } catch (error) {
      if (isAbort(error) || signal.aborted || error.status === 401 || error.status === 403) {
        delete history.empresas[id];
        writeJson(historyPath, history);
        changed();
        if (error.status === 401 || error.status === 403) throw new Error(`${error.message}. Confira API_KEY_SENDGRID e se o remetente está verificado no SendGrid.`);
        throw error;
      }
      record.status = 'erro';
      run.errors++;
      logger.error(scope, `${contact.nome || contact.email} · ${contact.email} · ${error.message}`);
    }
    writeJson(historyPath, history);
    changed();
  }
}
