import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BotRuntime } from './bot/runtime.js';
import { googleKey } from './bot/campaign.js';
import { networkConfig, isLoopback, isPrivateNetwork } from './bot/network.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/components.js': ['components.js', 'text/javascript; charset=utf-8'],
  '/views.js': ['views.js', 'text/javascript; charset=utf-8'],
  '/runtime-views.js': ['runtime-views.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/assets/orbita.svg': ['assets/orbita.svg', 'image/svg+xml'],
  '/assets/ubuntu-sans.ttf': ['assets/ubuntu-sans.ttf', 'font/ttf'],
};

async function jsonFile(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

const digits = (value) => String(value ?? '').replace(/\D/g, '').replace(/^0/, '');
function phoneKey(value) {
  const number = digits(value);
  return number.length === 10 || number.length === 11 ? `55${number}` : number;
}

export function parseDate(value) {
  const match = String(value ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, day, month, year, hour, minute, second = '00'] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}-03:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function buildLeads(history) {
  const companies = history.empresas ?? {};
  const usedNumbers = new Set(Object.values(companies).map((item) => phoneKey(item.numero)).filter(Boolean));
  const found = new Map();
  const searches = [];
  for (const [key, search] of Object.entries(history.buscas ?? {})) {
    const [niche, city] = key.split('|');
    let available = 0;
    for (const lead of search.fila ?? []) {
      const phone = phoneKey(lead.telefone);
      if (companies[lead.id] || (phone && usedNumbers.has(phone))) continue;
      if (!found.has(lead.id)) {
        found.set(lead.id, {
          id: lead.id, name: lead.nome || 'Empresa sem nome', phone: lead.telefone ?? '',
          niche, city: city ?? '', address: lead.endereco ?? '', rating: lead.avaliacao,
          reviews: lead.total_avaliacoes ?? 0, maps: lead.google_maps ?? '', social: lead.rede_social ?? '',
          status: 'pendente', account: null, date: null,
        });
        if (phone) usedNumbers.add(phone);
        available++;
      }
    }
    searches.push({ id: key, niche, city: city ?? '', queued: available, exhausted: Boolean(search.esgotada) });
  }
  const queued = [...found.values()];
  const contacted = Object.entries(companies).map(([id, item]) => ({
    id, name: item.nome || 'Empresa sem nome', phone: item.numero ?? '',
    niche: item.nicho ?? '', city: '', address: '', rating: null, reviews: null, maps: '', social: '',
    status: item.status ?? 'erro', account: item.conta ?? null, date: parseDate(item.data),
  })).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return { leads: [...queued, ...contacted], searches };
}

function failure(message, status = 400) { return Object.assign(new Error(message), { status }); }
async function bodyJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw failure('Envie os dados como JSON.', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw failure('O conteúdo excede o limite de 64 KB.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure('O conteúdo JSON é inválido.'); }
}

function validateList(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 160)) {
    throw failure(`Informe de 1 a 20 ${label}, com até 160 caracteres cada.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

export function createApp({ root = ROOT, runtime = new BotRuntime({ root }), access = networkConfig() } = {}) {
  const streams = new Set();
  let pendingWrite = Promise.resolve();
  function write(task) {
    const result = pendingWrite.then(task);
    pendingWrite = result.catch(() => {});
    return result;
  }
  async function atomicWrite(file, content) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.rename(temporary, file);
  }
  const draftsPath = path.join(root, '.orbita', 'campanhas.json');

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      const local = isLoopback(req.socket.remoteAddress);
      const forwardedProtocol = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
      const protocol = access.publicOrigin && local && forwardedProtocol === 'https' ? 'https' : 'http';
      const url = new URL(req.url, `${protocol}://${req.headers.host ?? 'localhost'}`);
      if (!access.hosts.has(url.hostname)) throw failure('Host não permitido. Use o endereço mostrado no terminal do servidor.', 403);
      if (!local && (!access.enabled || !isPrivateNetwork(req.socket.remoteAddress))) throw failure('Acesso permitido somente pelo computador ou pela rede local.', 403);
      if (req.headers.origin && req.headers.origin !== url.origin) throw failure('Origem não permitida.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw failure('Origem não permitida.', 403);

      if (req.method === 'GET' && url.pathname === '/api/runtime') return sendJson(200, runtime.snapshot());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        streams.add(res);
        let scheduled;
        const push = () => { scheduled = null; if (!res.destroyed) res.write(`data: ${JSON.stringify(runtime.snapshot())}\n\n`); };
        const changed = () => { if (!scheduled) scheduled = setTimeout(push, 100); };
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 15000);
        runtime.on('change', changed);
        push();
        res.on('close', () => { clearTimeout(scheduled); clearInterval(heartbeat); runtime.off('change', changed); streams.delete(res); });
        return;
      }

      const accountAction = url.pathname.match(/^\/api\/accounts\/(wa[1-5])\/(connect|disconnect)$/);
      if (req.method === 'POST' && accountAction) {
        const [, id, action] = accountAction;
        if (action === 'connect') {
          const body = await bodyJson(req);
          if (body.reset !== undefined && typeof body.reset !== 'boolean') throw failure('A opção de pareamento é inválida.');
          runtime.connectAccount(id, { reset: body.reset === true });
        } else await runtime.disconnectAccount(id);
        return sendJson(202, runtime.snapshot());
      }

      const campaignAction = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/(start|stop)$/);
      if (req.method === 'POST' && campaignAction) {
        const [, id, action] = campaignAction;
        if (action === 'start') {
          const campaigns = await jsonFile(draftsPath, []);
          const campaign = campaigns.find((item) => item.id === id);
          if (!campaign) throw failure('Campanha não encontrada.', 404);
          runtime.start(campaign);
        } else runtime.stop(id);
        return sendJson(202, runtime.snapshot());
      }

      if (req.method === 'GET' && url.pathname === '/api/data') {
        const [history, campaigns, template] = await Promise.all([
          jsonFile(path.join(root, 'historico.json'), { empresas: {}, buscas: {} }),
          jsonFile(draftsPath, []),
          fs.readFile(path.join(root, 'mensagem.txt'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; }),
        ]);
        const state = runtime.snapshot();
        return sendJson(200, { ...buildLeads(history), campaigns, template, accounts: state.accounts, runtime: state, liveTransport: 'sse', apiConfigured: Boolean(googleKey(root)), updatedAt: new Date().toISOString() });
      }

      if (req.method === 'POST' && url.pathname === '/api/campaigns') {
        const body = await bodyJson(req);
        if (typeof body.name !== 'string' || body.name.trim().length < 3 || body.name.length > 80) throw failure('Dê um nome à campanha com 3 a 80 caracteres.');
        const niches = validateList(body.niches, 'nichos');
        const cities = validateList(body.cities, 'cidades');
        const accounts = Number(body.accounts ?? 1);
        if (!Number.isInteger(accounts) || accounts < 1 || accounts > 5) throw failure('Selecione de 1 a 5 contas.');
        const campaign = { id: randomUUID(), name: body.name.trim(), niches, cities, accounts, status: 'rascunho', createdAt: new Date().toISOString() };
        await write(async () => {
          const campaigns = await jsonFile(draftsPath, []);
          if (campaigns.length >= 200) throw failure('O limite de 200 rascunhos foi atingido.', 409);
          await atomicWrite(draftsPath, JSON.stringify([campaign, ...campaigns], null, 2) + '\n');
        });
        runtime.logger.info('PAINEL', `Campanha preparada: ${campaign.name}.`);
        return sendJson(201, { campaign });
      }

      if (req.method === 'PUT' && url.pathname === '/api/template') {
        const body = await bodyJson(req);
        if (typeof body.text !== 'string' || body.text.trim().length < 10 || body.text.length > 20000) throw failure('A mensagem precisa ter de 10 a 20.000 caracteres.');
        const versions = body.text.split(/^\s*---\s*$/m);
        if (versions.some((version) => !version.trim())) throw failure('Preencha todas as versões da mensagem ou remova o separador vazio.');
        await write(() => atomicWrite(path.join(root, 'mensagem.txt'), body.text.trim() + '\n'));
        runtime.logger.info('PAINEL', `${versions.length} modelo(s) de mensagem salvo(s). Serão usados na próxima campanha.`);
        return sendJson(200, { saved: true });
      }

      if (url.pathname.startsWith('/api/')) return sendJson(404, { error: 'Rota não encontrada.' });
      if (!['GET', 'HEAD'].includes(req.method)) return sendJson(405, { error: 'Método não permitido.' });
      const entry = FILES[url.pathname];
      if (!entry) return sendJson(404, { error: 'Página não encontrada.' });
      const buffer = await fs.readFile(path.join(root, 'web', entry[0]));
      res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : buffer);
    } catch (error) {
      if (!res.headersSent) sendJson(error.status ?? 500, { error: error.status ? error.message : 'Não foi possível acessar os arquivos do projeto. Verifique o terminal.' });
      if (!error.status) runtime.logger.error('SERVIDOR', error.message);
      else if (req.method !== 'GET') runtime.logger.warn('PAINEL', `${req.method} ${req.url}: ${error.message}`);
    }
  });
  server.runtime = runtime;
  server.shutdown = async () => {
    try { await runtime.shutdown(); }
    finally {
      for (const stream of streams) stream.end();
      await new Promise((resolve) => server.close(resolve));
    }
  };
  server.on('close', () => { runtime.shutdown().catch((error) => runtime.logger.error('SERVIDOR', error.message)); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const port = Number(process.env.PORT || 3001);
  const access = networkConfig({ enabled: process.argv.includes('--rede') || process.env.ORBITA_REDE === '1', publicUrl: process.env.ORBITA_URL_PUBLICA || '' });
  const server = createApp({ access });
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `A porta ${port} está em uso. Experimente PORT=${port + 1} npm start.` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, access.host, () => {
    console.log(`\n  Órbita · seu espaço de prospecção\n  Local: http://localhost:${port}`);
    if (access.publicOrigin) console.log(`  Origem HTTPS configurada: ${access.publicOrigin}`);
    if (access.enabled) {
      for (const address of access.addresses) console.log(`  Rede:  http://${address}:${port}`);
      console.log('\n  Acesso habilitado na rede local, sem usuário e senha.');
    } else console.log('\n  Para acessar de outro dispositivo: npm run rede');
    console.log('\n  Ctrl+C para encerrar.\n');
  });
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.runtime.logger.info('SERVIDOR', 'Encerrando campanhas e conexões. Aguarde a finalização dos envios em andamento…');
    try { await server.shutdown(); } catch (error) { console.error(error.message); process.exitCode = 1; }
  });
}
