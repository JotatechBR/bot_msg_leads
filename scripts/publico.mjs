import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fork, spawn } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const controller = new AbortController();
let server;
let tunnel;
let stopping = false;
let finish;
const finished = new Promise((resolve) => { finish = resolve; });

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadCloudflared() {
  if (process.env.CLOUDFLARED_BIN) {
    const binary = path.resolve(process.env.CLOUDFLARED_BIN);
    await fs.access(binary, constants.X_OK);
    return binary;
  }
  const architectures = { x64: 'amd64', arm64: 'arm64' };
  if (process.platform !== 'linux' || !architectures[process.arch]) throw new Error('O download automático está disponível no Linux x64 e ARM64. Defina CLOUDFLARED_BIN com o caminho de uma instalação do cloudflared para outro sistema.');
  const directory = path.join(root, '.orbita', 'bin');
  const binary = path.join(directory, `cloudflared-${architectures[process.arch]}`);
  const metadataFile = `${binary}.json`;
  try {
    const saved = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
    if (saved.sha256 && await hashFile(binary) === saved.sha256) { await fs.access(binary, constants.X_OK); return binary; }
  } catch { /* Install a verified copy if the cached binary is missing or incomplete. */ }

  console.log('Baixando cloudflared do repositório oficial da Cloudflare. Isso só é necessário na primeira execução.');
  const releaseResponse = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'orbita-public-access' },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
  });
  if (!releaseResponse.ok) throw new Error(`Não foi possível consultar a versão do cloudflared no GitHub (HTTP ${releaseResponse.status}). Tente novamente ou defina CLOUDFLARED_BIN com o caminho do executável instalado.`);
  const release = await releaseResponse.json();
  const asset = release.assets?.find((item) => item.name === `cloudflared-linux-${architectures[process.arch]}`);
  if (!asset?.browser_download_url?.startsWith('https://github.com/cloudflare/cloudflared/releases/download/') || !/^sha256:[a-f\d]{64}$/.test(asset.digest ?? '')) throw new Error('A versão do cloudflared não informou um download com verificação SHA-256. Instale pelo site oficial da Cloudflare e defina CLOUDFLARED_BIN.');
  const expected = asset.digest.slice(7);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${binary}.${randomUUID()}.download`;
  try {
    const response = await fetch(asset.browser_download_url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) });
    if (!response.ok || !response.body) throw new Error(`Falha ao baixar cloudflared: HTTP ${response.status}.`);
    let bytes = 0;
    const limit = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > 150 * 1024 * 1024 ? new Error('O download ultrapassou o tamanho esperado.') : null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(temporary, { flags: 'wx', mode: 0o700 }), { signal: controller.signal });
    if (await hashFile(temporary) !== expected) throw new Error('A verificação do download falhou. O executável não será iniciado.');
    await fs.rename(temporary, binary);
    await fs.writeFile(metadataFile, JSON.stringify({ version: release.tag_name, sha256: expected }) + '\n', { mode: 0o600 });
    return binary;
  } finally { await fs.rm(temporary, { force: true }); }
}

function waitForExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  controller.abort();
  const exits = [waitForExit(tunnel), waitForExit(server)];
  tunnel?.kill('SIGTERM');
  server?.kill('SIGTERM');
  await Promise.all(exits);
  finish();
}

process.on('SIGINT', () => { void stop(0); });
process.on('SIGTERM', () => { void stop(0); });

try {
  try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const binary = await downloadCloudflared();
  controller.signal.throwIfAborted();
  console.log('\nIniciando o Órbita para acesso público, sem usuário e senha…\n');
  server = fork(path.join(root, 'server.js'), ['--publico'], { cwd: root, env: process.env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  server.on('exit', (code) => { if (!stopping) { console.error('O servidor foi encerrado; o acesso público também será fechado.'); void stop(code || 1); } });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('O servidor demorou para iniciar. Confira o terminal.')), 15000);
    server.on('message', (message) => { if (message?.type === 'orbita-ready') { clearTimeout(timeout); resolve(message.port); } });
    server.once('error', (error) => { clearTimeout(timeout); reject(error); });
    server.once('exit', () => { clearTimeout(timeout); reject(new Error('Não foi possível iniciar o servidor. Encerre a execução anterior ou use outra PORT.')); });
  });
  controller.signal.throwIfAborted();
  const configFile = path.join(root, '.orbita', 'tunnel-config.yml');
  await fs.writeFile(configFile, '{}\n', { mode: 0o600 });
  tunnel = spawn(binary, ['--config', configFile, 'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let announced = false;
  function output(stream) {
    let pending = '';
    stream.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const url = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
        if (url && !announced) {
          announced = true;
          console.log(`\n  LINK PÚBLICO: ${url}\n\n  Qualquer pessoa com esse link pode acessar e controlar o painel.\n  Mantenha este terminal aberto. Ctrl+C encerra o link e o servidor.\n`);
        }
        if (line.trim()) console.log(`[TÚNEL] ${line}`);
      }
    });
  }
  output(tunnel.stdout);
  output(tunnel.stderr);
  tunnel.once('error', (error) => { console.error(`Não foi possível abrir o túnel: ${error.message}`); void stop(1); });
  tunnel.once('exit', (code) => { if (!stopping) { console.error('O túnel foi encerrado. Execute npm run publico novamente para criar outro link.'); void stop(code || 1); } });
  await finished;
} catch (error) {
  if (!stopping) { console.error(error.message); await stop(1); }
}
