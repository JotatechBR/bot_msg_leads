// Vercel hosts the frontend. The bot itself remains on a persistent Node server.
const LIMIT = 64 * 1024;
const ROUTES = [
  ['GET', /^(data|runtime)$/],
  ['POST', /^campaigns$/],
  ['POST', /^campaigns\/[a-zA-Z0-9-]+\/(start|stop)$/],
  ['POST', /^accounts\/wa[1-5]\/(connect|disconnect)$/],
  ['PUT', /^template$/],
];

async function requestBody(request) {
  if (request.body !== undefined) {
    const value = Buffer.isBuffer(request.body) ? request.body : Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body));
    if (value.byteLength > LIMIT) throw Object.assign(new Error('O conteúdo excede o limite de 64 KB.'), { status: 413 });
    return value;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > LIMIT) throw Object.assign(new Error('O conteúdo excede o limite de 64 KB.'), { status: 413 });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('CDN-Cache-Control', 'no-store');
  response.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  const json = (status, value) => { response.statusCode = status; response.end(JSON.stringify(value)); };

  try {
    const incoming = new URL(request.url, `https://${request.headers.host ?? 'localhost'}`);
    const parameter = request.query?.route ?? incoming.searchParams.get('route');
    const route = Array.isArray(parameter) ? parameter.join('/') : parameter || incoming.pathname.replace(/^\/api\//, '');
    if (!ROUTES.some(([method, pattern]) => method === request.method && pattern.test(route))) return json(404, { error: 'Rota não encontrada.' });
    if (request.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Origem não permitida.' });
    if (request.headers.origin) {
      const origin = new URL(request.headers.origin);
      if (origin.host !== request.headers.host || origin.protocol !== 'https:') return json(403, { error: 'Origem não permitida.' });
    }

    const configured = process.env.ORBITA_BACKEND_URL?.trim();
    if (!configured) return json(503, { error: 'O painel está publicado. Para conectar o bot, defina ORBITA_BACKEND_URL nas variáveis da Vercel com o link HTTPS do servidor Ubuntu/VPS e publique novamente.' });
    let backend;
    try { backend = new URL(configured); } catch { return json(503, { error: 'ORBITA_BACKEND_URL precisa ser um endereço HTTPS válido do servidor do bot.' }); }
    if (backend.protocol !== 'https:' || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash) return json(503, { error: 'Configure ORBITA_BACKEND_URL com apenas a origem HTTPS do bot, sem /api, usuário, senha ou parâmetros.' });
    if (backend.host === request.headers.host) return json(503, { error: 'ORBITA_BACKEND_URL deve apontar para o servidor do bot, e não para o próprio painel da Vercel.' });

    const headers = { Accept: 'application/json', Origin: backend.origin };
    const options = { method: request.method, headers, signal: AbortSignal.timeout(8000), redirect: 'error' };
    if (request.method !== 'GET') {
      if (!request.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'Envie os dados como JSON.' });
      headers['Content-Type'] = 'application/json';
      options.body = await requestBody(request);
    }
    const result = await fetch(new URL(`/api/${route}`, backend), options);
    if (!result.headers.get('content-type')?.includes('application/json')) return json(502, { error: 'O servidor do bot não respondeu com dados da API. Verifique se o Ubuntu/VPS e o túnel estão ligados e se ORBITA_BACKEND_URL ainda é o endereço atual.' });
    const data = await result.json();
    if (route === 'data' && result.ok) data.liveTransport = 'poll';
    return json(result.status, data);
  } catch (error) {
    console.error('[Órbita API proxy]', error.message);
    if (error.status) return json(error.status, { error: error.message });
    if (error.name === 'TimeoutError') return json(504, { error: 'O servidor do bot demorou para responder. Verifique o estado da campanha antes de repetir um comando.' });
    return json(502, { error: 'Não foi possível conectar ao servidor do bot. Confira ORBITA_BACKEND_URL na Vercel e mantenha o servidor Ubuntu/VPS em execução.' });
  }
}
