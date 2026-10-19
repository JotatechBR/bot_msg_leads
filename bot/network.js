import os from 'node:os';
import { isIP } from 'node:net';

const localHosts = ['localhost', '127.0.0.1', '[::1]'];

function ipv4(address) {
  return String(address ?? '').replace(/^::ffff:/, '');
}

export function isLoopback(address) {
  return ['127.0.0.1', '::1'].includes(ipv4(address));
}

export function isPrivateNetwork(address) {
  const value = ipv4(address);
  if (isIP(value) !== 4) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export function networkConfig({ enabled = false, publicUrl = '' } = {}) {
  let publicOrigin = null;
  let publicHostname = null;
  if (publicUrl.trim()) {
    let url;
    try { url = new URL(publicUrl.trim()); }
    catch { throw new Error('ORBITA_URL_PUBLICA precisa ser a origem HTTPS do servidor, como https://api.exemplo.com.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('ORBITA_URL_PUBLICA deve conter somente a origem HTTPS do servidor, sem /api, credenciais ou parâmetros.');
    publicOrigin = url.origin;
    publicHostname = url.hostname;
  }
  const addresses = enabled ? [...new Set(Object.values(os.networkInterfaces()).flat().filter((item) => item && !item.internal && item.family === 'IPv4' && isPrivateNetwork(item.address)).map((item) => item.address))] : [];
  if (enabled && !addresses.length) throw new Error('Não foi encontrado um IP de rede local. Conecte o Ubuntu ao Wi-Fi ou cabo de rede e execute npm run rede novamente.');
  return {
    enabled, host: enabled ? '0.0.0.0' : '127.0.0.1',
    hosts: new Set([...localHosts, ...addresses, ...(publicHostname ? [publicHostname] : [])]),
    addresses, publicOrigin,
  };
}
