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

export function networkConfig({ enabled = false, publicAccess = false } = {}) {
  // Public access is served through an HTTPS tunnel to the loopback listener.
  if (publicAccess) return { enabled: true, public: true, host: '127.0.0.1', hosts: null, addresses: [] };
  if (!enabled) return { enabled: false, public: false, host: '127.0.0.1', hosts: new Set(localHosts), addresses: [] };
  const addresses = [...new Set(Object.values(os.networkInterfaces()).flat().filter((item) => item && !item.internal && item.family === 'IPv4' && isPrivateNetwork(item.address)).map((item) => item.address))];
  if (!addresses.length) throw new Error('Não foi encontrado um IP de rede local. Conecte o Ubuntu ao Wi-Fi ou cabo de rede e execute npm run rede novamente.');

  return { enabled: true, public: false, host: '0.0.0.0', hosts: new Set([...localHosts, ...addresses]), addresses };
}
