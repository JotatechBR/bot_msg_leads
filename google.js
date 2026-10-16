// Busca de leads na Places API (New) - Text Search
// Lead = estabelecimento operando, sem site próprio (rede social é aceita), bem avaliado e com telefone.
//
// A API devolve no máximo 60 resultados por busca. Para cobrir a cidade inteira, a busca é feita por
// áreas (retângulos): começa com a cidade toda e, quando uma área devolve 60 resultados (saturou),
// ela é dividida em 4 partes menores, que são buscadas depois.

const NOTA_MINIMA = 4.3;          // filtro no código
const NOTA_MINIMA_API = 4.0;      // filtro enviado à API (múltiplos de 0.5)
const MIN_AVALIACOES = 10;
const LIMITE_POR_BUSCA = 60;      // máximo que a API devolve por busca
const LADO_MINIMO_GRAUS = 0.005;  // ~500 m: área menor que isso não é mais dividida

const URL_TEXT_SEARCH = 'https://places.googleapis.com/v1/places:searchText';

const DOMINIOS_REDE_SOCIAL = [
  'instagram.com', 'facebook.com', 'fb.com', 'fb.me', 'wa.me', 'whatsapp.com',
  'linktr.ee', 'tiktok.com', 'youtube.com', 'twitter.com', 'x.com', 'linkedin.com',
];

const FIELD_MASK_LEADS = [
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

const FIELD_MASK_CIDADE = 'places.displayName,places.formattedAddress,places.viewport';

const esperar = (seg) => new Promise((r) => setTimeout(r, seg * 1000));

function redeSocial(url) {
  try {
    const host = new URL(url).hostname.replace(/^(www\.|m\.)/, '');
    return DOMINIOS_REDE_SOCIAL.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

function ehLead(place) {
  if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') return false;
  if ((place.rating ?? 0) < NOTA_MINIMA) return false;
  if ((place.userRatingCount ?? 0) < MIN_AVALIACOES) return false;
  if (place.websiteUri && !redeSocial(place.websiteUri)) return false;
  if (!place.nationalPhoneNumber && !place.internationalPhoneNumber) return false;
  return true;
}

function paraLead(place) {
  return {
    id: place.id,
    nome: place.displayName?.text ?? null,
    telefone: place.nationalPhoneNumber ?? place.internationalPhoneNumber ?? null,
    rede_social: place.websiteUri ?? null, // só chega aqui se for rede social ou vazio
    endereco: place.formattedAddress ?? null,
    avaliacao: place.rating ?? null,
    total_avaliacoes: place.userRatingCount ?? 0,
    google_maps: place.googleMapsUri?.replace(/&g_mp=.*$/, '') ?? null,
  };
}

// Chamada à API com até 3 novas tentativas em falhas temporárias (rede, 429, 5xx)
async function chamarApi(chave, fieldMask, body) {
  for (let tentativa = 1; ; tentativa++) {
    let resp, dados;
    try {
      resp = await fetch(URL_TEXT_SEARCH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': chave,
          'X-Goog-FieldMask': fieldMask,
        },
        body: JSON.stringify(body),
      });
      dados = await resp.json().catch(() => ({}));
    } catch (err) {
      if (tentativa <= 3) { await esperar(10 * tentativa); continue; }
      throw new Error(`Google Maps: falha de rede - ${err.message}`);
    }

    if (resp.ok) return dados;
    if ((resp.status === 429 || resp.status >= 500) && tentativa <= 3) {
      await esperar(10 * tentativa);
      continue;
    }
    const erro = new Error(`Google Maps: ${dados.error?.message ?? `HTTP ${resp.status}`}`);
    if (dados.error?.status === 'PERMISSION_DENIED') {
      erro.message += '\nVerifique se a "Places API (New)" está ativada no Google Cloud para essa chave.';
    }
    erro.status = dados.error?.status;
    throw erro;
  }
}

async function areaDaCidade(chave, cidade) {
  const dados = await chamarApi(chave, FIELD_MASK_CIDADE, {
    textQuery: cidade,
    regionCode: 'BR',
    languageCode: 'pt-BR',
    pageSize: 1,
  });
  const lugar = dados.places?.[0];
  if (!lugar?.viewport) throw new Error(`Não encontrei a cidade "${cidade}" no Google Maps.`);
  return { nome: lugar.formattedAddress ?? lugar.displayName?.text, ...lugar.viewport };
}

function dividirEm4({ low, high }) {
  const meioLat = (low.latitude + high.latitude) / 2;
  const meioLng = (low.longitude + high.longitude) / 2;
  return [
    { low: { latitude: low.latitude, longitude: low.longitude }, high: { latitude: meioLat, longitude: meioLng } },
    { low: { latitude: low.latitude, longitude: meioLng }, high: { latitude: meioLat, longitude: high.longitude } },
    { low: { latitude: meioLat, longitude: low.longitude }, high: { latitude: high.latitude, longitude: meioLng } },
    { low: { latitude: meioLat, longitude: meioLng }, high: { latitude: high.latitude, longitude: high.longitude } },
  ];
}

function podeDividir({ low, high }) {
  return high.latitude - low.latitude > LADO_MINIMO_GRAUS * 2 && high.longitude - low.longitude > LADO_MINIMO_GRAUS * 2;
}

/**
 * Entrega leads de "termo" em "cidade" um a um, buscando na API só quando precisa.
 * `busca` é o estado salvo dessa pesquisa e é atualizado aqui:
 *   { areas: [{ low, high, pageToken, brutos }], fila: [lead], esgotada }
 * `jaUsado(lead)` diz se a empresa já foi contatada (essas são descartadas).
 */
export async function* leads({ chave, termo, cidade, busca, jaUsado, log }) {
  if (!busca.areas) {
    const area = await areaDaCidade(chave, cidade);
    log?.(`Área de busca: ${area.nome}`);
    busca.areas = [{ low: area.low, high: area.high, pageToken: null, brutos: 0 }];
    busca.fila = [];
    busca.esgotada = false;
  }

  while (true) {
    while (busca.fila.length > 0) {
      const lead = busca.fila.shift();
      if (!jaUsado(lead)) yield lead;
    }
    if (busca.areas.length === 0) {
      busca.esgotada = true;
      return;
    }

    const area = busca.areas[0];
    const body = {
      textQuery: termo,
      minRating: NOTA_MINIMA_API,
      regionCode: 'BR',
      languageCode: 'pt-BR',
      pageSize: 20,
      locationRestriction: { rectangle: { low: area.low, high: area.high } },
    };
    if (area.pageToken) body.pageToken = area.pageToken;

    let dados;
    try {
      dados = await chamarApi(chave, FIELD_MASK_LEADS, body);
    } catch (err) {
      if (area.pageToken && err.status === 'INVALID_ARGUMENT') {
        area.pageToken = null; // token expirou: refaz essa área do início (já contatados são ignorados)
        area.brutos = 0;
        continue;
      }
      throw err;
    }

    const lugares = dados.places ?? [];
    area.brutos += lugares.length;
    const idsNaFila = new Set(busca.fila.map((l) => l.id));
    for (const place of lugares) {
      if (ehLead(place) && !idsNaFila.has(place.id)) busca.fila.push(paraLead(place));
    }

    area.pageToken = dados.nextPageToken ?? null;
    if (!area.pageToken) {
      busca.areas.shift();
      if (area.brutos >= LIMITE_POR_BUSCA && podeDividir(area)) {
        // saturou: provavelmente há mais estabelecimentos nessa área do que a API mostrou
        busca.areas.push(...dividirEm4(area).map((r) => ({ ...r, pageToken: null, brutos: 0 })));
      }
    }
  }
}
