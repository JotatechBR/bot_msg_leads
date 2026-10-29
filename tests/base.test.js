import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

test('campanha com base importada envia só para a base, sem Google', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbita-'));
  fs.writeFileSync(path.join(root, 'mensagem.txt'), 'Olá {nome}\n');
  const sent = [];
  const socket = { onWhatsApp: async (n) => [{ exists: !n.endsWith('0000'), jid: `${n}@s.whatsapp.net` }], sendPresenceUpdate: async () => {}, sendMessage: async (jid, m) => sent.push([jid, m.text]) };
  const account = { id: 'wa1', status: 'connected', socket };
  const whatsapp = Object.assign(new (await import('node:events')).EventEmitter(), { list: () => [{ id: 'wa1', status: 'connected' }], wait: async () => account, close: async () => {} });
  const { BotRuntime } = await import('../bot/runtime.js');
  const runtime = new BotRuntime({ root, whatsapp, timing: { between: [0, 0], firstRound: [0, 0], round: [0, 0], typing: [0, 0], error: 0 } });
  const app = createApp({ root, runtime, deployment: 'local' });
  await new Promise((r) => app.listen(0, 'localhost', r));
  const base = `http://localhost:${app.address().port}`;
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  const [status, { campaign }] = await post('/api/campaigns/base', { name: 'Minha base', accounts: 1, template: 'Oi {nome}, {nicho}', contacts: [
    { nome: 'Ana', numero: '19 99999-1111', nicho: 'Dentista' }, { nome: 'Ana 2', numero: '(19) 99999-1111', nicho: 'dentista' },
    { nome: 'Bia', numero: '11988882222', nicho: 'Padaria' }, { nome: 'Sem zap', numero: '19 90000-0000', nicho: 'Padaria' }, { nome: 'Ruim', numero: '123', nicho: 'x' } ] });
  assert.equal(status, 201);
  assert.deepEqual(campaign.base, { total: 3, invalid: 1, duplicates: 1 });
  assert.equal((await post(`/api/campaigns/${campaign.id}/start`, {}))[0], 202);
  await runtime.completion;
  assert.deepEqual(sent.map((s) => s[1]).sort(), ['Oi Ana, Dentista', 'Oi Bia, Padaria']);
  assert.equal(runtime.runs[campaign.id].status, 'completed');
  assert.equal(runtime.runs[campaign.id].withoutWhatsapp, 1);
  await app.shutdown();
});

test('campanha por e-mail envia pelo SendGrid para os e-mails válidos da base', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbita-'));
  fs.writeFileSync(path.join(root, '.env'), 'API_KEY_SENDGRID=SG.teste\nEMAIL_REMETENTE=contato@exemplo.com\n');
  const sent = [];
  const send = async (mail) => { if (mail.to === 'falha@x.com') throw new Error('rejeitado'); sent.push(mail); };
  const whatsapp = Object.assign(new (await import('node:events')).EventEmitter(), { list: () => [], close: async () => {} });
  const { BotRuntime } = await import('../bot/runtime.js');
  const runtime = new BotRuntime({ root, whatsapp, email: { send, pause: [0, 0] } });
  const app = createApp({ root, runtime, deployment: 'local' });
  await new Promise((r) => app.listen(0, 'localhost', r));
  const base = `http://localhost:${app.address().port}`;
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  assert.equal((await post('/api/campaigns/base', { name: 'Sem assunto', channel: 'email', template: 'Oi', contacts: [{ email: 'a@b.com' }] }))[0], 400);
  const [status, { campaign }] = await post('/api/campaigns/base', { name: 'Por e-mail', channel: 'email', emailSubject: 'Olá {nome}', template: 'Oi {nome}, tudo bem? ({nicho})', contacts: [
    { nome: 'Ana', email: 'Ana@Exemplo.com', nicho: 'Dentista' }, { nome: 'Ana 2', email: 'ana@exemplo.com', nicho: 'Dentista' },
    { nome: 'Bia', email: 'bia@exemplo.com', nicho: 'Padaria' }, { nome: 'Falha', email: 'falha@x.com' }, { nome: 'Ruim', email: 'sem-arroba' }, { nome: 'Só zap', numero: '19999991111' } ] });
  assert.equal(status, 201);
  assert.deepEqual(campaign.base, { total: 3, invalid: 2, duplicates: 1 });
  assert.equal((await post(`/api/campaigns/${campaign.id}/start`, {}))[0], 202);
  await runtime.completion;
  assert.deepEqual(sent.map((m) => [m.to, m.subject, m.text, m.from]), [
    ['ana@exemplo.com', 'Olá Ana', 'Oi Ana, tudo bem? (Dentista)', 'contato@exemplo.com'],
    ['bia@exemplo.com', 'Olá Bia', 'Oi Bia, tudo bem? (Padaria)', 'contato@exemplo.com']]);
  const run = runtime.runs[campaign.id];
  assert.equal(run.status, 'completed');
  assert.deepEqual([run.sent, run.errors], [2, 1]);
  // segunda execução não repete e-mails já enviados
  await post(`/api/campaigns/${campaign.id}/start`, {});
  await runtime.completion;
  assert.equal(sent.length, 2);
  await app.shutdown();
});
