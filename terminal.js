// Saída do terminal: cores, colunas alinhadas e filtro dos logs internos do WhatsApp
import { styleText } from 'node:util';

const cor = (estilo, texto) => styleText(estilo, String(texto));
const CORES_CONTAS = ['cyan', 'magenta', 'yellow', 'blue', 'green'];
const LARGURA_NOME = 30;
const LARGURA_NICHO = 14;

// A libsignal (criptografia do WhatsApp) escreve direto no console a cada troca de chaves
// ("Closing session: SessionEntry {...}"). É normal e não interessa aqui, então é descartado.
const RUIDO = /^(Closing session|Opening session|Removing old closed session|Session already (closed|open)|Decrypted message with closed session|Closing open session|Closing stale open session|Migrating session|Failed to decrypt message|Session error|V1 session storage|Unhandled bucket type|WARNING: Expected pubkey)/;
for (const metodo of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[metodo].bind(console);
  console[metodo] = (...args) => {
    if (typeof args[0] === 'string' && RUIDO.test(args[0])) return;
    original(...args);
  };
}

const escrever = (texto = '') => console.log(texto);
const hora = () => new Date().toLocaleTimeString('pt-BR');

function ajustar(texto, largura) {
  texto = String(texto ?? '');
  return texto.length > largura ? texto.slice(0, largura - 1) + '…' : texto.padEnd(largura);
}

export function formatarTempo(seg) {
  const min = Math.floor(seg / 60);
  const resto = (seg - min * 60).toFixed(2).replace('.', ',');
  return min > 0 ? `${min}min ${resto}s` : `${resto}s`;
}

function formatarDuracao(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return h > 0 ? `${h}h ${min}min` : `${min}min`;
}

// "5519998959997" -> "+55 19 99895-9997"
export function formatarTelefone(numero) {
  const m = String(numero ?? '').match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : `+${numero}`;
}

export function rotuloConta(conta) {
  return cor(['bold', CORES_CONTAS[(conta.n - 1) % CORES_CONTAS.length]], `WA${conta.n}`);
}

export function cabecalho({ termos, cidades, contas, teste }) {
  const linha = '─'.repeat(46);
  escrever();
  escrever(cor('cyan', `╭${linha}╮`));
  escrever(cor('cyan', '│') + cor('bold', '  BOT DE LEADS  ·  Google Maps → WhatsApp'.padEnd(46)) + cor('cyan', '│'));
  escrever(cor('cyan', `╰${linha}╯`));
  escrever(`  ${cor('dim', 'Nichos ')}  ${termos.join(', ')}`);
  escrever(`  ${cor('dim', 'Cidades')}  ${cidades.join(', ')}`);
  escrever(`  ${cor('dim', 'Contas ')}  ${teste ? cor('yellow', 'modo teste (nada é enviado nem salvo)') : contas}`);
  escrever();
}

export function secao(texto) {
  escrever();
  escrever(cor('bold', `▸ ${texto}`));
}

export const info = (texto) => escrever(`  ${cor('dim', texto)}`);
export const aviso = (texto) => escrever(`  ${cor('yellow', '!')} ${cor('yellow', texto)}`);
export const erro = (texto) => escrever(`  ${cor('red', '✗')} ${cor('red', texto)}`);

export function contaConectada(conta) {
  escrever(`  ${cor('green', '●')} ${rotuloConta(conta)}  conectado  ${cor('dim', formatarTelefone(conta.numeroProprio))}`);
}

export function contaAviso(conta, texto) {
  escrever(`  ${cor('dim', hora())}  ${rotuloConta(conta)}  ${cor('yellow', '!')} ${cor('yellow', texto)}`);
}

export function qrCode(conta) {
  escrever();
  escrever(`  ${rotuloConta(conta)}  ${cor('bold', 'Escaneie o QR code com o celular dessa conta')}`);
  info('WhatsApp > Aparelhos conectados > Conectar um aparelho');
  escrever();
}

const STATUS = {
  enviado: () => cor('green', ajustar('✓ enviado', 14)),
  sem_whatsapp: () => cor('yellow', ajustar('– sem WhatsApp', 14)),
  erro: () => cor('red', ajustar('✗ erro', 14)),
  devolvido: () => cor('blue', ajustar('↺ volta à fila', 14)),
};

export function envio(conta, status, lead, numero, detalhe = '') {
  escrever(
    `  ${cor('dim', hora())}  ${rotuloConta(conta)}  ${STATUS[status]()}  ` +
    `${cor('italic', ajustar(lead.nicho, LARGURA_NICHO))}  ` +
    `${ajustar(lead.nome, LARGURA_NOME)}  ${cor('dim', ajustar(formatarTelefone(numero), 18))}` +
    (detalhe ? `  ${cor('dim', detalhe)}` : ''),
  );
}

export function fimDaRodada(conta, enviadas, intervalo) {
  escrever(
    `  ${cor('dim', hora())}  ${rotuloConta(conta)}  ` +
    cor('dim', `⏸ rodada com ${enviadas} enviada(s) · próxima rodada em ${formatarTempo(intervalo)}`),
  );
}

export function previa(lead, numero, mensagem) {
  escrever();
  escrever(`  ${cor('italic', `[${lead.nicho}]`)} ${cor('bold', lead.nome)}  ${cor('dim', formatarTelefone(numero))}`);
  for (const linha of mensagem.split('\n')) escrever(`  ${cor('dim', '│')} ${linha}`);
}

export function resumo({ contas, inicio, consultasApi, porNicho }) {
  const total = contas.reduce((s, c) => s + c.enviadas, 0);
  escrever();
  escrever(cor('cyan', `  ──────────────── Resumo ────────────────`));
  escrever(`  ${cor('dim', ajustar('Tempo rodando', 18))}${formatarDuracao(Date.now() - inicio)}`);
  for (const c of contas) {
    escrever(
      `  ${rotuloConta(c)}${' '.repeat(15)}${cor('green', c.enviadas)} enviadas  ` +
      cor('dim', `· ${c.semWhatsapp} sem WhatsApp · ${c.erros} erros`),
    );
  }
  escrever(`  ${cor('bold', ajustar('Total', 18))}${cor(['bold', 'green'], total)} enviadas`);
  for (const [nicho, qtd] of Object.entries(porNicho ?? {})) {
    escrever(`  ${cor('italic', ajustar(nicho, 18))}${qtd}`);
  }
  escrever(`  ${cor('dim', ajustar('Consultas à API', 18))}${consultasApi}`);
  escrever();
}
