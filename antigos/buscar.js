import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------- Configuração ----------------
const LEADS_POR_PEDIDO = 5;
const NOTA_MINIMA = 4.3;          // filtro no código
const NOTA_MINIMA_API = 4.0;      // filtro enviado à API (múltiplos de 0.5)
const MIN_AVALIACOES = 10;
const MAX_PAGINAS_POR_PEDIDO = 3; // limite de chamadas por execução (controle de custo)

const DOMINIOS_REDE_SOCIAL = [
  'instagram.com', 'facebook.com', 'fb.com', 'fb.me', 'wa.me', 'whatsapp.com',
  'linktr.ee', 'tiktok.com', 'youtube.com', 'twitter.com', 'x.com', 'linkedin.com',
];

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.googleMapsUri',
  'nextPageToken',
].join(',');

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ARQUIVO_ESTADO = path.join(DIR, 'leads_vistos.json');
const ARQUIVO_ULTIMOS = path.join(DIR, 'ultimos_leads.json'); // lido pelo enviar.js

// ---------------- Utilitários ----------------
const log = (msg) => console.error(msg); // status vai pro stderr; stdout fica só com o JSON

function carregarChave() {
  try {
    process.loadEnvFile(path.join(DIR, '.env'));
  } catch {
    // sem .env: tenta variável de ambiente já definida
  }
  const chave = process.env.API_GOOGLE_MAPS?.trim();
  if (!chave) {
    log('Erro: variável API_GOOGLE_MAPS não encontrada no .env');
    process.exit(1);
  }
  return chave;
}

function carregarEstado() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  } catch {
    return { vistos: [], buscas: {} };
  }
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

function redeSocial(url) {
  try {
    const host = new URL(url).hostname.replace(/^(www\.|m\.)/, '');
    return DOMINIOS_REDE_SOCIAL.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

function paraLead(place) {
  return {
    nome: place.displayName?.text ?? null,
    telefone: place.nationalPhoneNumber ?? place.internationalPhoneNumber ?? null,
    rede_social: place.websiteUri ?? null, // só chega aqui se for rede social ou vazio
    endereco: place.formattedAddress ?? null,
    avaliacao: place.rating ?? null,
    total_avaliacoes: place.userRatingCount ?? 0,
    google_maps: place.googleMapsUri?.replace(/&g_mp=.*$/, '') ?? null,
  };
}

function ehLead(place) {
  if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') return false;
  if ((place.rating ?? 0) < NOTA_MINIMA) return false;
  if ((place.userRatingCount ?? 0) < MIN_AVALIACOES) return false;
  if (place.websiteUri && !redeSocial(place.websiteUri)) return false;
  return true;
}

// ---------------- API ----------------
async function textSearch(chave, textQuery, pageToken) {
  const body = {
    textQuery,
    minRating: NOTA_MINIMA_API,
    regionCode: 'BR',
    languageCode: 'pt-BR',
    pageSize: 20,
  };
  if (pageToken) body.pageToken = pageToken;

  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': chave,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = new Error(dados.error?.message ?? `HTTP ${resp.status}`);
    erro.status = dados.error?.status;
    throw erro;
  }
  return dados;
}

// ---------------- Principal ----------------
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    log('Uso: node buscar.js "<o que buscar>" "<cidade>"');
    log('Ex.: node buscar.js "barbearia" "Campinas SP"');
    process.exit(1);
  }
  const textQuery = args.length >= 2 ? `${args[0]} em ${args.slice(1).join(' ')}` : args[0];
  const chaveBusca = textQuery.toLowerCase().replace(/\s+/g, ' ').trim();

  const chave = carregarChave();
  const estado = carregarEstado();
  const vistos = new Set(estado.vistos);
  const busca = estado.buscas[chaveBusca] ?? { nextPageToken: null, esgotada: false, fila: [] };

  const leads = [];
  const entregar = (lead, id) => {
    leads.push(lead);
    vistos.add(id);
  };

  // 1) Leads que sobraram da execução anterior
  while (leads.length < LEADS_POR_PEDIDO && busca.fila.length > 0) {
    const { id, lead } = busca.fila.shift();
    if (!vistos.has(id)) entregar(lead, id);
  }

  // 2) Busca novas páginas na API
  let paginas = 0;
  while (leads.length < LEADS_POR_PEDIDO && !busca.esgotada && paginas < MAX_PAGINAS_POR_PEDIDO) {
    log(`Buscando "${textQuery}" (página ${busca.nextPageToken ? 'seguinte' : '1'})...`);
    let dados;
    try {
      dados = await textSearch(chave, textQuery, busca.nextPageToken);
    } catch (err) {
      if (busca.nextPageToken && err.status === 'INVALID_ARGUMENT') {
        log('Token de página expirou, recomeçando do início (leads já vistos são ignorados).');
        busca.nextPageToken = null;
        continue;
      }
      throw err;
    }
    paginas++;

    for (const place of dados.places ?? []) {
      if (vistos.has(place.id) || !ehLead(place)) continue;
      if (busca.fila.some((f) => f.id === place.id)) continue;
      if (leads.length < LEADS_POR_PEDIDO) entregar(paraLead(place), place.id);
      else busca.fila.push({ id: place.id, lead: paraLead(place) });
    }

    busca.nextPageToken = dados.nextPageToken ?? null;
    if (!busca.nextPageToken) busca.esgotada = true;
  }

  estado.vistos = [...vistos];
  estado.buscas[chaveBusca] = busca;
  salvarEstado(estado);
  fs.writeFileSync(ARQUIVO_ULTIMOS, JSON.stringify(leads, null, 2));

  console.log(JSON.stringify(leads, null, 2));

  log(`\n${leads.length} lead(s) entregue(s). Chamadas à API nesta execução: ${paginas}.`);
  if (busca.esgotada && busca.fila.length === 0 && leads.length < LEADS_POR_PEDIDO) {
    log('Essa busca se esgotou (a API devolve no máximo 60 resultados por termo).');
    log('Tente outro termo ou um bairro específico, ex.: "barbearia" "Cambuí Campinas SP".');
  } else if (leads.length < LEADS_POR_PEDIDO) {
    log('Limite de páginas por execução atingido; rode de novo para continuar essa busca.');
  }
}

main().catch((err) => {
  log(`Erro na API do Google: ${err.message}`);
  if (err.status === 'PERMISSION_DENIED') {
    log('Verifique se a "Places API (New)" está ativada no Google Cloud e se a chave tem permissão para ela.');
  }
  process.exit(1);
});
