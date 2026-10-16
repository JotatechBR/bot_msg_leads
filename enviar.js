import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tela from './terminal.js'; // importar antes do baileys: filtra os logs internos da libsignal
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { leads } from './google.js';

// ---------------- Configuração ----------------
const CONTAS_PADRAO = 2;             // quantos WhatsApps enviam ao mesmo tempo (mude com --contas N)
const PRIMEIRO_INTERVALO = [30, 40]; // segundos: a primeira espera de cada conta fica perto de 30s
const INTERVALO = [30, 300];         // segundos: depois, qualquer valor entre 30s e 5min
const DIFERENCA_MINIMA = 25;         // segundos: uma espera nunca fica parecida com a anterior
const DIGITANDO = [2.5, 7];          // segundos mostrando "digitando..." antes de enviar
const MAX_TENTATIVAS_CONEXAO = 5;

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PASTA_SESSOES = path.join(DIR, 'sessoes');
const ARQUIVO_MENSAGEM = path.join(DIR, 'mensagem.txt');
const ARQUIVO_HISTORICO = path.join(DIR, 'historico.json');

// ---------------- Utilitários ----------------
const esperar = (seg) => new Promise((r) => setTimeout(r, seg * 1000));
const sortear = (min, max) => min + Math.random() * (max - min); // número quebrado
const agora = () => new Date().toLocaleString('pt-BR');

function proximoIntervalo(anterior) {
  if (anterior === null) return sortear(...PRIMEIRO_INTERVALO);
  let seg;
  do seg = sortear(...INTERVALO);
  while (Math.abs(seg - anterior) < DIFERENCA_MINIMA);
  return seg;
}

function carregarChave() {
  try {
    process.loadEnvFile(path.join(DIR, '.env'));
  } catch {
    // sem .env: tenta variável de ambiente já definida
  }
  const chave = process.env.API_GOOGLE_MAPS?.trim();
  if (!chave) throw new Error('variável API_GOOGLE_MAPS não encontrada no .env');
  return chave;
}

// historico.json:
//   empresas: { [placeId]: { nome, numero, status, conta, data } }  status = enviando | enviado | sem_whatsapp | erro
//   buscas:   { ["termo|cidade"]: { areas, fila, esgotada } }
// Qualquer empresa (ou número) presente em "empresas" nunca é contatada de novo.
function carregarHistorico() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO_HISTORICO, 'utf8'));
  } catch {
    return { empresas: {}, buscas: {} };
  }
}

// mensagem.txt pode ter várias versões separadas por uma linha "---"; uma é sorteada por empresa
function carregarModelos() {
  const texto = fs.readFileSync(ARQUIVO_MENSAGEM, 'utf8');
  return texto.split(/^\s*---\s*$/m).map((t) => t.trim()).filter(Boolean);
}

function montarMensagem(modelos, lead) {
  const modelo = modelos[Math.floor(Math.random() * modelos.length)];
  return modelo
    .replaceAll('{nome}', lead.nome ?? '')
    .replaceAll('{avaliacao}', String(lead.avaliacao ?? '').replace('.', ','))
    .replaceAll('{total_avaliacoes}', String(lead.total_avaliacoes ?? ''));
}

// "(19) 99568-2603" -> "5519995682603"
function normalizarTelefone(telefone) {
  if (!telefone) return null;
  let digitos = telefone.replace(/\D/g, '');
  if (digitos.startsWith('0800') || digitos.startsWith('0300')) return null;
  if (digitos.startsWith('0')) digitos = digitos.slice(1);
  if (digitos.length === 10 || digitos.length === 11) digitos = '55' + digitos;
  return digitos.length >= 12 ? digitos : null;
}

const listaDeArgumento = (texto) => texto.split(',').map((t) => t.trim()).filter(Boolean);

// ---------------- WhatsApp ----------------
async function conectar(conta, tentativa = 1) {
  const { state, saveCreds } = await useMultiFileAuthState(conta.pasta);

  return new Promise((resolve, reject) => {
    let conectado = false;
    // Obs.: não usar Browsers.windows('Desktop') — o WhatsApp encerra a conexão (428) antes de gerar o QR
    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (qr) {
        tela.qrCode(conta);
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        conectado = true;
        resolve(sock);
      }
      if (connection !== 'close') return;

      if (conectado) {
        conta.caiu = true; // caiu durante o uso: o trabalhador reconecta
        conta.deslogada = codigo === DisconnectReason.loggedOut;
      } else if (codigo === DisconnectReason.loggedOut) {
        reject(new Error(`${conta.rotulo}: sessão desconectada pelo celular. Apague a pasta "sessoes/${conta.id}" e rode de novo para escanear o QR.`));
      } else if (codigo === DisconnectReason.restartRequired) {
        tela.info(`${conta.rotulo}: QR escaneado, finalizando a conexão...`);
        conectar(conta, tentativa).then(resolve, reject); // reinício obrigatório logo após escanear o QR
      } else if (tentativa < MAX_TENTATIVAS_CONEXAO) {
        tela.aviso(`${conta.rotulo}: conexão caiu (código ${codigo ?? '?'}). Tentando de novo (${tentativa + 1}/${MAX_TENTATIVAS_CONEXAO})...`);
        setTimeout(() => conectar(conta, tentativa + 1).then(resolve, reject), 3000);
      } else {
        reject(new Error(`${conta.rotulo}: não foi possível conectar após ${MAX_TENTATIVAS_CONEXAO} tentativas (último código: ${codigo ?? '?'}).`));
      }
    });
  });
}

async function abrirConta(conta) {
  conta.sock = await conectar(conta);
  conta.caiu = false;
  conta.numeroProprio = conta.sock.user?.id?.split(':')[0]?.split('@')[0] ?? null;
}

// ---------------- Principal ----------------
async function main() {
  const args = process.argv.slice(2);
  const modoTeste = args.includes('--teste');
  const iContas = args.indexOf('--contas');
  const qtdContas = iContas >= 0 ? Number(args[iContas + 1]) : CONTAS_PADRAO;
  const posicionais = args.filter((a, i) => !a.startsWith('--') && (iContas < 0 || i !== iContas + 1));

  if (posicionais.length < 2 || !(qtdContas >= 1)) {
    console.log(`
Uso: node enviar.js "<nicho(s)>" "<cidade(s)>" [--contas N] [--teste]

  node enviar.js "barbearia" "Campinas SP"
  node enviar.js "barbearia, pizzaria, pet shop" "Campinas SP, Valinhos SP"

  --contas N   quantos WhatsApps usar ao mesmo tempo (padrão: ${CONTAS_PADRAO})
  --teste      busca na API e mostra as mensagens, sem conectar no WhatsApp nem salvar

Roda sem parar até você apertar Ctrl+C.
`);
    process.exit(1);
  }
  const termos = listaDeArgumento(posicionais[0]);
  const cidades = listaDeArgumento(posicionais.slice(1).join(','));

  const chave = carregarChave();
  const modelos = carregarModelos();
  const historico = carregarHistorico();
  const salvar = () => {
    if (!modoTeste) fs.writeFileSync(ARQUIVO_HISTORICO, JSON.stringify(historico, null, 2));
  };
  const inicio = Date.now();
  let consultasApi = 0;

  tela.cabecalho({ termos, cidades, contas: qtdContas, teste: modoTeste });

  // Bloqueia por empresa (id do Google) e por número (mesmo telefone em outra ficha/filial)
  const numerosUsados = new Set(Object.values(historico.empresas).map((e) => e.numero));
  const jaUsado = (lead) =>
    Boolean(historico.empresas[lead.id]) || numerosUsados.has(normalizarTelefone(lead.telefone));

  const aoEvento = (tipo, dado) => {
    if (tipo === 'consulta') consultasApi++;
    if (tipo === 'area') tela.info(`área de busca: ${dado}`);
    if (tipo === 'dividiu') tela.info(`região com muitos resultados, dividida em partes menores (${dado} áreas na fila)`);
  };

  // Fonte única de leads, compartilhada pelas contas: percorre cada cidade x nicho
  async function* todosOsLeads() {
    for (const cidade of cidades) {
      for (const termo of termos) {
        const chaveBusca = `${termo}|${cidade}`.toLowerCase().replace(/\s+/g, ' ');
        const busca = modoTeste ? structuredClone(historico.buscas[chaveBusca] ?? {}) : (historico.buscas[chaveBusca] ??= {});
        if (busca.esgotada) {
          tela.info(`"${termo}" em ${cidade} já foi percorrida por completo, pulando`);
          continue;
        }
        tela.secao(`Buscando "${termo}" em ${cidade}`);
        yield* leads({ chave, termo, cidade, busca, jaUsado, aoEvento });
        salvar();
        tela.secao(`Terminou "${termo}" em ${cidade}`);
      }
    }
  }
  const gerador = todosOsLeads();
  const devolvidos = []; // leads que voltam para a fila (ex.: WhatsApp caiu antes de enviar)
  let fimDosLeads = false;
  async function proximoLead() {
    if (devolvidos.length > 0) return devolvidos.shift();
    if (fimDosLeads) return null;
    const { value, done } = await gerador.next();
    if (done) {
      fimDosLeads = true;
      return devolvidos.shift() ?? null;
    }
    return value;
  }

  if (modoTeste) {
    for (let i = 0; i < 10; i++) {
      const lead = await proximoLead();
      if (!lead) break;
      const numero = normalizarTelefone(lead.telefone);
      if (!numero) continue;
      numerosUsados.add(numero);
      tela.previa(lead, numero, montarMensagem(modelos, lead));
    }
    console.log();
    tela.info(`${consultasApi} consulta(s) à API do Google`);
    process.exit(0);
  }

  // Conecta as contas uma de cada vez (para não misturar os QR codes)
  tela.secao('Conectando WhatsApp');
  const contas = [];
  for (let n = 1; n <= qtdContas; n++) {
    const conta = {
      n, id: `wa${n}`, rotulo: `WhatsApp ${n}`, pasta: path.join(PASTA_SESSOES, `wa${n}`),
      enviadas: 0, semWhatsapp: 0, erros: 0,
    };
    await abrirConta(conta);
    if (conta.numeroProprio && contas.some((c) => c.numeroProprio === conta.numeroProprio)) {
      throw new Error(`${conta.rotulo} é o mesmo número de outra conta. Apague "sessoes/${conta.id}" e escaneie com outro celular.`);
    }
    tela.contaConectada(conta);
    contas.push(conta);
  }

  let encerrando = false;
  const encerrar = (codigo) => {
    encerrando = true;
    salvar();
    tela.resumo({ contas, inicio, consultasApi });
    for (const c of contas) c.sock?.end(undefined);
    process.exit(codigo);
  };
  process.on('SIGINT', () => {
    console.log();
    tela.info('Encerrando (Ctrl+C)...');
    encerrar(0);
  });

  console.log();
  tela.info(`Enviando com ${contas.length} conta(s) ao mesmo tempo. Aperte Ctrl+C para parar.`);

  async function trabalhador(conta) {
    let anterior = null;
    while (!encerrando) {
      if (conta.caiu) {
        if (conta.deslogada) {
          tela.contaAviso(conta, `sessão desconectada pelo celular; essa conta parou. Apague "sessoes/${conta.id}" e rode de novo.`);
          return;
        }
        tela.contaAviso(conta, 'conexão caiu, reconectando...');
        try {
          await abrirConta(conta);
          tela.contaAviso(conta, 'reconectado');
        } catch (err) {
          tela.contaAviso(conta, `${err.message} Tentando de novo em 1 minuto.`);
          await esperar(60);
          continue;
        }
      }

      const lead = await proximoLead();
      if (!lead) return;
      const numero = normalizarTelefone(lead.telefone);
      if (!numero || jaUsado(lead)) continue;

      // Registra ANTES de enviar: mesmo se o programa cair no meio, essa empresa nunca é contatada de novo
      const registro = { nome: lead.nome, numero, status: 'enviando', conta: conta.id, data: agora() };
      historico.empresas[lead.id] = registro;
      numerosUsados.add(numero);
      salvar();

      let jid;
      try {
        const [contato] = (await conta.sock.onWhatsApp(numero)) ?? [];
        if (!contato?.exists) {
          registro.status = 'sem_whatsapp';
          salvar();
          conta.semWhatsapp++;
          tela.envio(conta, 'sem_whatsapp', lead, numero);
          continue;
        }
        jid = contato.jid;
      } catch (err) {
        // nada foi enviado: libera a empresa para ser tentada de novo
        delete historico.empresas[lead.id];
        numerosUsados.delete(numero);
        devolvidos.push(lead);
        salvar();
        tela.envio(conta, 'devolvido', lead, numero, err.message);
        await esperar(15);
        continue;
      }

      try {
        await conta.sock.sendPresenceUpdate('composing', jid);
        await esperar(sortear(...DIGITANDO));
        await conta.sock.sendPresenceUpdate('paused', jid);
        await conta.sock.sendMessage(jid, { text: montarMensagem(modelos, lead) });
        registro.status = 'enviado';
        registro.data = agora();
        salvar();
        conta.enviadas++;
      } catch (err) {
        registro.status = 'erro'; // pode ou não ter saído: não tenta de novo para não repetir
        salvar();
        conta.erros++;
        tela.envio(conta, 'erro', lead, numero, err.message);
        await esperar(15);
        continue;
      }

      const intervalo = proximoIntervalo(anterior);
      anterior = intervalo;
      tela.envio(conta, 'enviado', lead, numero, `próxima em ${tela.formatarTempo(intervalo)}`);
      await esperar(intervalo);
    }
  }

  try {
    await Promise.all(contas.map((c) => trabalhador(c)));
  } catch (err) {
    tela.erro(err.message); // ex.: erro permanente da API do Google (cota, faturamento)
    encerrar(1);
  }
  tela.secao('Acabaram os leads de todas as buscas. Rode de novo com outros nichos ou cidades.');
  encerrar(0);
}

main().catch((err) => {
  tela.erro(err.message);
  process.exit(1);
});
