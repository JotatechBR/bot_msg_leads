import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { buildLeads, createApp, parseDate } from '../server.js';

test('interpreta datas do histórico com o fuso de São Paulo', () => {
  assert.equal(parseDate('16/10/2026, 18:08:16'), '2026-10-16T21:08:16.000Z');
  assert.equal(parseDate('17/10/2026 09:30'), '2026-10-17T12:30:00.000Z');
  assert.equal(parseDate('sem data'), null);
});

test('a fila exclui empresas e telefones contatados e elimina duplicatas entre buscas', () => {
  const lead = (id, phone) => ({ id, telefone: phone, nome: `Empresa ${id}` });
  const history = { empresas: { used: { nome: 'Contatada', numero: '5511999991111', status: 'enviado', data: '16/10/2026, 12:00:00' } }, buscas: {
    'pet shop|campinas sp': { fila: [lead('used', '19999992222'), lead('same-phone', '(11) 99999-1111'), lead('new', '(19) 99999-3333')], esgotada: false },
    'barbearia|valinhos sp': { fila: [lead('new', '(19) 99999-3333'), lead('same-queue-phone', '5519999993333'), lead('other', '(19) 99999-4444')], esgotada: true },
  } };
  const result = buildLeads(history);
  assert.deepEqual(result.leads.map((item) => item.id), ['new', 'other', 'used']);
  assert.equal(result.leads[0].city, 'campinas sp');
  assert.equal(result.leads[2].niche, '');
  assert.deepEqual(result.searches.map((item) => item.queued), [1, 1]);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbita-test-'));
  await fs.mkdir(path.join(root, 'sessoes', 'wa1'), { recursive: true });
  await fs.mkdir(path.join(root, 'web'), { recursive: true });
  const history = { empresas: { known: { nome: 'Empresa real', numero: '5511999991111', status: 'enviado', data: '16/10/2026, 12:00:00' } }, buscas: {} };
  await fs.writeFile(path.join(root, 'historico.json'), JSON.stringify(history));
  await fs.writeFile(path.join(root, 'mensagem.txt'), 'Olá, {nome}! Uma mensagem de teste.\n');
  await fs.writeFile(path.join(root, '.env'), 'API_GOOGLE_MAPS=private-api-key-test\n');
  await fs.writeFile(path.join(root, 'sessoes', 'wa1', 'creds.json'), '{"private":"session-secret-test"}');
  await fs.writeFile(path.join(root, 'web', 'index.html'), '<html lang="pt-BR">Órbita</html>');
  const app = createApp({ root });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => { await new Promise((resolve) => app.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const post = (body, headers = {}) => fetch(`${base}/api/campaigns`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { root, base, history, post };
}

const campaign = { name: 'Campanha de teste', niches: ['barbearia'], cities: ['Campinas SP'], accounts: 1 };

test('a API entrega dados reais sem expor chave, credenciais ou arquivos privados', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/api/data`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text();
  const data = JSON.parse(text);
  assert.equal(data.leads[0].name, 'Empresa real');
  assert.equal(data.apiConfigured, true);
  assert.deepEqual(data.accounts, [{ id: 'wa1', name: 'WhatsApp 1', saved: true }]);
  assert.ok(!text.includes('private-api-key-test'));
  assert.ok(!text.includes('session-secret-test'));
  for (const file of ['/.env', '/historico.json', '/sessoes/wa1/creds.json', '/%2e%2e/.env']) {
    assert.equal((await fetch(base + file)).status, 404);
  }
  assert.equal((await fetch(base + '/')).status, 200);
});

test('rejeita alterações de outra origem e hosts externos sem criar campanhas', async (t) => {
  const { base, root, post } = await fixture(t);
  assert.equal((await post(campaign, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await post(campaign, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = http.get(base + '/api/data', { headers: { Host: 'malicious.example' } }, (response) => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject);
  });
  assert.equal(status, 403);
  await assert.rejects(fs.access(path.join(root, '.orbita', 'campanhas.json')));
});

test('salva rascunhos concorrentes sem perder registros nem modificar o histórico', async (t) => {
  const { root, history, post } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => post({ ...campaign, name: `Campanha ${index}`, niches: ['barbearia', 'barbearia'] })));
  assert.ok(responses.every((response) => response.status === 201));
  const stored = JSON.parse(await fs.readFile(path.join(root, '.orbita', 'campanhas.json'), 'utf8'));
  assert.equal(stored.length, 4);
  assert.equal(new Set(stored.map((item) => item.id)).size, 4);
  assert.ok(stored.every((item) => item.status === 'rascunho' && item.niches.length === 1));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'historico.json'), 'utf8')), history);
});

test('valida entradas e salva modelos somente com uma edição válida', async (t) => {
  const { root, base, post } = await fixture(t);
  for (const invalid of [{ ...campaign, name: 'x' }, { ...campaign, niches: [] }, { ...campaign, cities: [''] }, { ...campaign, accounts: 9 }]) assert.equal((await post(invalid)).status, 400);
  const put = (text) => fetch(base + '/api/template', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  assert.equal((await put('muito curta')).status, 200);
  assert.equal((await put('Olá, {nome}!\n---\n')).status, 400);
  assert.equal((await put('Olá, {nome}! Tudo bem?\n---\nOutra versão de mensagem.')).status, 200);
  assert.equal(await fs.readFile(path.join(root, 'mensagem.txt'), 'utf8'), 'Olá, {nome}! Tudo bem?\n---\nOutra versão de mensagem.\n');
  assert.equal((await fetch(base + '/api/template', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'message' })).status, 415);
});
