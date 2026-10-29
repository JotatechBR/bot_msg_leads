import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BotRuntime } from './bot/runtime.js';
import { googleKey, normalizePhone, basePath } from './bot/campaign.js';
import { EMAIL_PATTERN, emailSettings } from './bot/email.js';
import { createAuth } from './bot/auth.js';

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
    id, name: item.nome || 'Empresa sem nome', phone: item.numero ?? item.email ?? '',
    niche: item.nicho ?? '', city: '', address: '', rating: null, reviews: null, maps: '', social: '',
    status: item.status ?? 'erro', account: item.conta ?? null, date: parseDate(item.data),
  })).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return { leads: [...queued, ...contacted], searches };
}

function failure(message, status = 400) { return Object.assign(new Error(message), { status }); }
async function bodyJson(req, limit = 64 * 1024) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw failure('Envie os dados como JSON.', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw failure(`O conteúdo excede o limite de ${Math.round(limit / 1024)} KB.`, 413);
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

const listFromEnv = (value) => String(value ?? '').split(',').map((item) => item.trim().replace(/\/$/, '')).filter(Boolean);

// deployment: 'local' (npm start no PC, só localhost), 'server' (VPS atrás do Caddy, com login) ou 'vercel' (somente leitura)
export function createApp({
  root = ROOT,
  runtime = new BotRuntime({ root }),
  deployment = process.env.ORBITA_MODO === 'servidor' ? 'server' : 'local',
  password = process.env.PAINEL_SENHA,
  allowedOrigins = listFromEnv(process.env.PAINEL_ORIGENS),
} = {}) {
  const published = deployment === 'vercel';
  const server = deployment === 'server';
  const auth = createAuth({ root, password });
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

  async function data() {
    const [history, campaigns, template] = await Promise.all([
      jsonFile(path.join(root, 'historico.json'), { empresas: {}, buscas: {} }),
      jsonFile(draftsPath, []),
      fs.readFile(path.join(root, 'mensagem.txt'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; }),
    ]);
    const state = runtime.snapshot();
    return { ...buildLeads(history), campaigns, template, accounts: state.accounts, runtime: state, liveTransport: published ? 'poll' : 'sse', environment: deployment, readOnly: published, authRequired: auth.enabled, apiConfigured: Boolean(googleKey(root)), manual: runtime.manualLog(), emailConfigured: Boolean(emailSettings(root).key && emailSettings(root).from), updatedAt: new Date().toISOString() };
  }

  const app = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      // No modo servidor o Node só escuta em localhost; quem chega aqui é o Caddy, que informa o protocolo original.
      const protocol = published ? 'https' : server ? String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() : 'http';
      const url = new URL(req.url, `${protocol}://${req.headers.host ?? 'localhost'}`);
      const secure = url.protocol === 'https:';
      if (deployment === 'local' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw failure('Acesse pelo endereço localhost mostrado no terminal.', 403);
      // O painel na Vercel repassa /api para cá: a origem do navegador é o domínio da Vercel (PAINEL_ORIGENS).
      if (req.headers.origin && req.headers.origin !== url.origin && !allowedOrigins.includes(req.headers.origin)) throw failure('Origem não permitida.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw failure('Origem não permitida.', 403);
      if (published && url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)) {
        throw failure('O deploy padrão da Vercel permite consultar este painel. Para editar, conectar WhatsApp e executar campanhas, inicie o projeto localmente com npm start.', 501);
      }

      if (req.method === 'GET' && url.pathname === '/api/session') {
        return sendJson(200, { authRequired: auth.enabled, authenticated: auth.authenticated(req) });
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const body = await bodyJson(req);
        const cookie = auth.login(body.password, { secure });
        if (cookie) res.setHeader('Set-Cookie', cookie);
        runtime.logger.info('PAINEL', 'Login realizado no painel.');
        return sendJson(200, { authenticated: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        res.setHeader('Set-Cookie', auth.logout({ secure }));
        return sendJson(200, { authenticated: false });
      }
      if (url.pathname.startsWith('/api/') && !auth.authenticated(req)) {
        return sendJson(401, { error: 'Entre com a senha do painel para continuar.', login: true });
      }

      if (req.method === 'GET' && url.pathname === '/api/runtime') return sendJson(200, runtime.snapshot());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (published) return sendJson(404, { error: 'Use /api/runtime para consultar o estado.' });
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
        return sendJson(200, await data());
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

      if (req.method === 'POST' && url.pathname === '/api/campaigns/base') {
        const body = await bodyJson(req, 2 * 1024 * 1024);
        if (typeof body.name !== 'string' || body.name.trim().length < 3 || body.name.length > 80) throw failure('Dê um nome à campanha com 3 a 80 caracteres.');
        const accounts = Number(body.accounts ?? 1);
        if (!Number.isInteger(accounts) || accounts < 1 || accounts > 5) throw failure('Selecione de 1 a 5 contas.');
        if (!Array.isArray(body.contacts) || !body.contacts.length) throw failure('A base não tem contatos. Envie um arquivo com nome, número e nicho.');
        if (body.contacts.length > 5000) throw failure('Cada base aceita até 5.000 contatos. Divida o arquivo em partes.', 413);
        const channel = body.channel === 'email' ? 'email' : 'whatsapp';
        let emailSubject = null;
        if (channel === 'email') {
          emailSubject = typeof body.emailSubject === 'string' ? body.emailSubject.trim() : '';
          if (emailSubject.length < 3 || emailSubject.length > 200) throw failure('Informe o assunto do e-mail com 3 a 200 caracteres.');
          if (typeof body.template !== 'string' || !body.template.trim()) throw failure('Escreva a mensagem do e-mail.');
        }
        let template = null;
        if (body.template != null && String(body.template).trim()) {
          if (typeof body.template !== 'string' || body.template.trim().length < 10 || body.template.length > 20000) throw failure('A mensagem da campanha precisa ter de 10 a 20.000 caracteres.');
          if (body.template.split(/^\s*---\s*$/m).some((version) => !version.trim())) throw failure('Preencha todas as versões da mensagem ou remova o separador vazio.');
          template = body.template.trim();
        }
        const seen = new Set();
        const contacts = [];
        let invalid = 0;
        let duplicates = 0;
        for (const item of body.contacts) {
          const phone = normalizePhone(item?.numero);
          const email = String(item?.email ?? '').trim().toLowerCase();
          const identity = channel === 'email' ? (EMAIL_PATTERN.test(email) && email.length <= 254 ? email : null) : phone;
          if (!identity) { invalid++; continue; }
          if (seen.has(identity)) { duplicates++; continue; }
          seen.add(identity);
          contacts.push({ nome: String(item.nome ?? '').trim().slice(0, 160), ...(phone ? { numero: phone } : {}), ...(EMAIL_PATTERN.test(email) ? { email } : {}), nicho: String(item.nicho ?? '').trim().slice(0, 160) || 'geral' });
        }
        if (!contacts.length) throw failure(channel === 'email' ? 'Nenhum e-mail válido foi encontrado. Confira a coluna email do arquivo.' : 'Nenhum número válido foi encontrado. Use DDD + número, por exemplo 19 99999-9999.');
        const niches = [...new Map(contacts.map((contact) => [contact.nicho.toLowerCase(), contact.nicho])).values()];
        const campaign = {
          id: randomUUID(), type: 'base', channel, name: body.name.trim(), niches, cities: ['Base importada'], accounts: channel === 'email' ? 1 : accounts,
          ...(emailSubject ? { emailSubject } : {}),
          ...(template ? { template } : {}), base: { total: contacts.length, invalid, duplicates },
          status: 'rascunho', createdAt: new Date().toISOString(),
        };
        await write(async () => {
          const campaigns = await jsonFile(draftsPath, []);
          if (campaigns.length >= 200) throw failure('O limite de 200 rascunhos foi atingido.', 409);
          await atomicWrite(basePath(root, campaign.id), JSON.stringify(contacts) + '\n');
          await atomicWrite(draftsPath, JSON.stringify([campaign, ...campaigns], null, 2) + '\n');
        });
        runtime.logger.info('PAINEL', `Base importada para ${campaign.name}: ${contacts.length} contatos (${invalid} inválidos, ${duplicates} repetidos).`);
        return sendJson(201, { campaign });
      }

      if (req.method === 'POST' && url.pathname === '/api/manual') {
        const body = await bodyJson(req);
        const channel = body.channel === 'email' ? 'email' : 'whatsapp';
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (text.length < 2 || text.length > (channel === 'email' ? 20000 : 4096)) throw failure(channel === 'email' ? 'Escreva a mensagem do e-mail (até 20.000 caracteres).' : 'Escreva a mensagem (até 4.096 caracteres).');
        const entry = await runtime.sendManual({ channel, to: body.to, name: String(body.name ?? '').trim().slice(0, 160), subject: String(body.subject ?? '').slice(0, 200), text, account: body.account });
        return sendJson(200, { entry });
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
  app.runtime = runtime;
  app.shutdown = async () => {
    try { await runtime.shutdown(); }
    finally {
      for (const stream of streams) stream.end();
      await new Promise((resolve) => app.close(resolve));
    }
  };
  app.on('close', () => { runtime.shutdown().catch((error) => runtime.logger.error('SERVIDOR', error.message)); });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const port = Number(process.env.PORT || 3001);
  if (process.env.ORBITA_MODO === 'servidor' && !process.env.PAINEL_SENHA) {
    console.error('\n  No modo servidor o painel fica acessível pela internet.\n  Defina PAINEL_SENHA no arquivo .env antes de iniciar.\n');
    process.exit(1);
  }
  const server = createApp();
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `A porta ${port} está em uso. Experimente PORT=${port + 1} npm start.` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, 'localhost', () => {
    console.log(`\n  Órbita · seu espaço de prospecção\n  Local: http://localhost:${port}`);
    if (process.env.ORBITA_MODO === 'servidor') console.log('  Modo servidor: acesso pela internet via Caddy (HTTPS), com login.');
    else if (process.env.PAINEL_SENHA) console.log('  Login com senha ativado (PAINEL_SENHA).');
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
