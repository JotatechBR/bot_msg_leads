import { h, icon, number, titleCase, dateLabel, phoneLabel, badge, companyAvatar, messagePreview } from './components.js';
import { routes, navigation, overviewView, leadsView, leadResults, campaignsView, messagesView, accountsView, settingsView, guideView } from './views.js';
import { runtimeLogs } from './runtime-views.js';

const main = document.querySelector('#main');
const state = {
  data: null, route: 'overview', query: '', status: 'all', niche: '', city: '', sort: 'default',
  page: 1, selected: new Set(), moreFilters: false, overviewFilter: 'queue', chartPeriod: 7,
  messageDraft: null, campaignDraft: null,
};
let toastTimeout;
let loading = false;
let lastFocusedLeadButton;
let runtimeSignature = '';
let liveEvents;
let livePolling;
let pollingInFlight = false;

function readPreference(key) { try { return localStorage.getItem(key); } catch { return null; } }
function savePreference(key, value) { try { localStorage.setItem(key, value); } catch { /* The preference still applies for this visit. */ } }
document.documentElement.dataset.motion = readPreference('orbita-motion') === 'off' ? 'off' : 'on';

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000), headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Não foi possível concluir a operação.');
  return result;
}

function toast(message, error = false) {
  const element = document.querySelector('#toast');
  clearTimeout(toastTimeout);
  element.className = `toast${error ? ' is-error' : ''}`;
  element.innerHTML = `${icon(error ? 'info' : 'checkCircle')}<span>${h(message)}</span>`;
  element.hidden = false;
  toastTimeout = setTimeout(() => { element.hidden = true; }, error ? 6500 : 4200);
}

function normalized(value) { return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function filteredLeads() {
  const query = normalized(state.query.trim());
  const result = state.data.leads.filter((lead) =>
    (state.status === 'all' || lead.status === state.status) &&
    (!state.niche || lead.niche === state.niche) &&
    (!state.city || lead.city === state.city) &&
    (!query || normalized([lead.name, lead.phone, lead.city, lead.niche].join(' ')).includes(query) || (query.replace(/\D/g, '').length > 3 && lead.phone.replace(/\D/g, '').includes(query.replace(/\D/g, '')))));
  if (state.sort === 'name') result.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  if (state.sort === 'rating') result.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  if (state.sort === 'recent') result.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return result;
}

function updateResults() {
  const results = document.querySelector('#lead-results');
  if (results) results.innerHTML = leadResults(filteredLeads(), state);
  updateSelection();
}

function updateSelection() {
  const checkboxes = [...document.querySelectorAll('.lead-checkbox')];
  const all = document.querySelector('#select-all');
  if (all) {
    const count = checkboxes.filter((checkbox) => state.selected.has(checkbox.dataset.id)).length;
    all.checked = count > 0 && count === checkboxes.length;
    all.indeterminate = count > 0 && count < checkboxes.length;
  }
  const exportButton = document.querySelector('#export-leads');
  if (exportButton) exportButton.innerHTML = `${icon('download')}${state.selected.size ? `Exportar ${state.selected.size} selecionado(s)` : 'Exportar CSV'}`;
}

function currentRoute() {
  const hash = location.hash.slice(1).split('/')[0];
  return routes.some((route) => route.id === hash) || hash === 'guide' ? hash : 'overview';
}

function rememberEditing() {
  const message = document.querySelector('#message-text');
  if (message) state.messageDraft = message.value.trim() === state.data?.template.trim() ? null : message.value;
  const form = document.querySelector('#campaign-form');
  if (form) state.campaignDraft = Object.fromEntries(new FormData(form));
}

function render({ animate = false, focus = false } = {}) {
  if (!state.data) return;
  state.route = currentRoute();
  const title = routes.find((route) => route.id === state.route)?.title || 'Como funciona';
  document.querySelector('#navigation').innerHTML = navigation(state.data, state.route);
  document.querySelector('#breadcrumb-page').textContent = title;
  document.title = `${title} — Órbita`;
  const views = {
    overview: () => overviewView(state.data, state),
    leads: () => leadsView(state.data, state, filteredLeads()),
    campaigns: () => campaignsView(state.data, location.hash === '#campaigns/new'),
    messages: () => messagesView({ ...state.data, template: state.messageDraft ?? state.data.template }),
    accounts: () => accountsView(state.data),
    settings: () => settingsView(state.data),
    guide: guideView,
  };
  main.innerHTML = views[state.route]();
  if (state.data.readOnly) {
    main.insertAdjacentHTML('afterbegin', `<div class="notice notice-soft">${icon('info')}<p>Painel publicado para consulta. Para editar, conectar WhatsApp e enviar campanhas, abra a versão local com <code>npm start</code>.</p></div>`);
    for (const button of main.querySelectorAll('[data-connect-account], [data-disconnect-account], [data-start-campaign], [data-stop-campaign], button[type="submit"]')) button.disabled = true;
  }
  runtimeSignature = signature(state.data.runtime);
  main.classList.toggle('page-enter', animate);
  if (state.route === 'leads') updateSelection();
  if (state.route === 'messages' && state.messageDraft !== null) {
    const status = document.querySelector('#message-save-status');
    status.textContent = 'Alterações não salvas';
    status.classList.add('unsaved');
  }
  if (state.route === 'settings') document.querySelector('#motion-toggle').checked = document.documentElement.dataset.motion !== 'off';
  if (state.campaignDraft && document.querySelector('#campaign-form')) {
    for (const [name, value] of Object.entries(state.campaignDraft)) {
      const input = document.querySelector(`#campaign-form [name="${name}"]`);
      if (input) input.value = value;
    }
  }
  if (focus) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    main.focus({ preventScroll: true });
  }
}

function signature(runtime) {
  if (!runtime) return '';
  return JSON.stringify({ accounts: runtime.accounts, active: runtime.active, runs: runtime.runs });
}

function applyRuntime(runtime, force = false) {
  if (!state.data) return;
  const oldSignature = runtimeSignature;
  state.data.runtime = runtime;
  state.data.accounts = runtime.accounts;
  const editable = location.hash === '#campaigns/new' || state.route === 'messages';
  if (!editable && ['accounts', 'campaigns'].includes(state.route) && (force || oldSignature !== signature(runtime))) {
    const focused = document.activeElement;
    const attributes = ['data-connect-account', 'data-disconnect-account', 'data-start-campaign', 'data-stop-campaign'];
    const restore = attributes.find((attribute) => focused?.hasAttribute(attribute));
    const value = restore ? focused.getAttribute(restore) : null;
    render();
    if (restore) [...main.querySelectorAll(`[${restore}]`)].find((element) => element.getAttribute(restore) === value)?.focus({ preventScroll: true });
  } else {
    const logs = document.querySelector('#runtime-logs');
    if (logs) { logs.innerHTML = runtimeLogs(runtime.logs); logs.scrollTop = logs.scrollHeight; }
  }
  runtimeSignature = signature(runtime);
}

function serverStatus(connected) {
  const status = document.querySelector('.local-status');
  status.innerHTML = connected ? `<span></span> ${state.data?.environment === 'vercel' ? 'Publicado na Vercel' : 'Servidor local conectado'}` : '<span></span> Reconectando ao servidor';
  status.classList.toggle('connection-error', !connected);
}

async function pollRuntime() {
  if (pollingInFlight || document.hidden) return;
  pollingInFlight = true;
  try {
    applyRuntime(await request('/api/runtime'));
    serverStatus(true);
  } catch { serverStatus(false); }
  finally { pollingInFlight = false; }
}

function startPolling() {
  if (livePolling) return;
  void pollRuntime();
  livePolling = setInterval(pollRuntime, 2000);
}

function startLiveEvents() {
  if (liveEvents || livePolling) return;
  // The published API uses polling; localhost streams events directly.
  if (state.data.liveTransport === 'poll') { startPolling(); return; }
  liveEvents = new EventSource('/api/events');
  liveEvents.onmessage = (event) => {
    try {
      applyRuntime(JSON.parse(event.data));
      clearInterval(livePolling);
      livePolling = undefined;
      serverStatus(true);
    } catch (error) { console.error('Falha ao atualizar o estado do bot:', error); }
  };
  liveEvents.onopen = () => serverStatus(true);
  liveEvents.onerror = () => {
    serverStatus(false);
    startPolling();
  };
}

async function runtimeAction(button, url, { body = {}, message } = {}) {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  const original = button.innerHTML;
  button.textContent = 'Aguarde…';
  try {
    const result = await request(url, { method: 'POST', body: JSON.stringify(body) });
    applyRuntime(result, true);
    if (message) toast(message);
  } catch (error) {
    toast(error.name === 'TimeoutError' ? 'A operação demorou. Verifique o estado da conta ou campanha antes de tentar novamente.' : error.message, true);
  } finally {
    if (button.isConnected) { button.disabled = false; button.removeAttribute('aria-busy'); button.innerHTML = original; }
  }
}

async function refresh({ initial = false, manual = false } = {}) {
  if (loading) return;
  loading = true;
  const button = document.querySelector('#refresh-button');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    rememberEditing();
    state.data = await request('/api/data');
    const published = state.data.environment === 'vercel';
    document.querySelector('.workspace-local').textContent = published ? 'VERCEL' : 'LOCAL';
    document.querySelector('.profile small').textContent = published ? 'Painel publicado' : 'Ambiente local';
    serverStatus(true);
    const existing = new Set(state.data.leads.map((lead) => lead.id));
    state.selected = new Set([...state.selected].filter((id) => existing.has(id)));
    const readOnlyView = ['overview', 'accounts', 'leads', 'campaigns'].includes(state.route) && location.hash !== '#campaigns/new';
    if (initial || (readOnlyView && !document.querySelector('#lead-dialog').open)) render({ animate: initial });
    else if (manual && state.route !== 'messages' && location.hash !== '#campaigns/new') {
      const searchFocused = document.activeElement?.id === 'lead-search';
      const selection = searchFocused ? document.activeElement.selectionStart : null;
      render();
      if (searchFocused) {
        const input = document.querySelector('#lead-search');
        input.focus();
        try { input.setSelectionRange(selection, selection); } catch { /* Search fields may not support selection ranges. */ }
      }
    }
    startLiveEvents();
    if (manual) toast('Dados atualizados.');
  } catch (error) {
    if (!state.data) main.innerHTML = `<section class="load-error">${icon('compass')}<h1>Vamos retomar a conexão.</h1><p>${h(error.name === 'TimeoutError' ? 'O servidor demorou para responder. Confirme que npm start está em execução e tente novamente.' : error.message)}</p><button class="button button-primary" id="retry-load">${icon('refresh')} Tentar novamente</button></section>`;
    else if (manual) toast('Não foi possível atualizar os dados. Tente novamente.', true);
  } finally {
    loading = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

function toggleSidebar(open) {
  const sidebar = document.querySelector('#sidebar');
  sidebar.classList.toggle('is-open', open);
  document.querySelector('#sidebar-backdrop').hidden = !open;
  document.querySelector('#mobile-menu').setAttribute('aria-expanded', String(open));
  document.body.style.overflow = open ? 'hidden' : '';
  if (window.matchMedia('(max-width:800px)').matches) {
    document.querySelector('.workspace').inert = open;
    sidebar.inert = !open;
    if (open) sidebar.querySelector('a[aria-current="page"]')?.focus();
  }
}

const mobileQuery = window.matchMedia('(max-width:800px)');
function syncSidebar() {
  if (!mobileQuery.matches) {
    document.querySelector('#sidebar').inert = false;
    document.querySelector('.workspace').inert = false;
    toggleSidebar(false);
  } else if (!document.querySelector('#sidebar').classList.contains('is-open')) document.querySelector('#sidebar').inert = true;
}
mobileQuery.addEventListener('change', syncSidebar);
syncSidebar();

function safeLink(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? h(url.href) : ''; }
  catch { return ''; }
}

function openLead(id, source) {
  const lead = state.data.leads.find((item) => item.id === id);
  if (!lead) return;
  lastFocusedLeadButton = source;
  const dialog = document.querySelector('#lead-dialog');
  const maps = safeLink(lead.maps);
  const social = safeLink(lead.social);
  dialog.innerHTML = `<div class="detail-header"><span>NO SEU RADAR</span><button class="icon-button" id="close-lead" aria-label="Fechar detalhes">${icon('close')}</button></div><div class="detail-body">${companyAvatar(lead)}<h2 id="lead-dialog-title">${h(lead.name)}</h2>${badge(lead.status)}<dl class="detail-list"><div><dt>Segmento</dt><dd>${h(lead.niche ? titleCase(lead.niche) : 'Não informado no histórico')}</dd></div><div><dt>Telefone</dt><dd>${h(phoneLabel(lead.phone))}</dd></div>${lead.city ? `<div><dt>Região</dt><dd>${h(titleCase(lead.city))}</dd></div>` : ''}${lead.address ? `<div><dt>Endereço</dt><dd>${h(lead.address)}</dd></div>` : ''}${lead.rating ? `<div><dt>Avaliação</dt><dd>${h(String(lead.rating).replace('.', ','))} de 5 · ${number(lead.reviews)} avaliações</dd></div>` : ''}${lead.date ? `<div><dt>Registrado</dt><dd>${dateLabel(lead.date, { year: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd></div>` : ''}<div><dt>Conta</dt><dd>${h(lead.account ? `WhatsApp ${lead.account.replace('wa', '')}` : 'Sem atribuição')}</dd></div></dl><div class="detail-actions">${maps ? `<a class="button button-primary" href="${maps}" target="_blank" rel="noopener noreferrer">${icon('pin')} Ver no Google Maps ${icon('arrowUp')}</a>` : ''}${social ? `<a class="button button-secondary" href="${social}" target="_blank" rel="noopener noreferrer">${icon('globe')} Rede social</a>` : ''}<button class="button button-secondary" data-copy-phone="${h(lead.phone)}">${icon('copy')} Copiar telefone</button></div>${!lead.rating && lead.status !== 'pendente' ? '<p class="detail-note">Os contatos antigos guardam somente os dados registrados na época do envio.</p>' : ''}</div>`;
  dialog.showModal();
}

async function copy(text, success = 'Copiado para a área de transferência.') {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      // Some browsers do not provide the Clipboard API.
      const previousFocus = document.activeElement;
      const field = document.createElement('textarea');
      field.value = text;
      field.className = 'sr-only';
      field.setAttribute('readonly', '');
      (document.querySelector('dialog[open]') || document.body).append(field);
      try {
        field.select();
        if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
      } finally { field.remove(); previousFocus?.focus({ preventScroll: true }); }
    }
    toast(success);
  } catch { toast('Não foi possível copiar. Selecione e copie o texto manualmente.', true); }
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportLeads() {
  const leads = state.selected.size ? state.data.leads.filter((lead) => state.selected.has(lead.id)) : filteredLeads();
  if (!leads.length) return toast('Não há leads para exportar com esses filtros.', true);
  const rows = [['Empresa', 'Telefone', 'Nicho', 'Cidade', 'Avaliação', 'Total de avaliações', 'Status', 'Conta', 'Data', 'Google Maps'], ...leads.map((lead) => [lead.name, lead.phone, lead.niche, lead.city, lead.rating, lead.reviews, lead.status, lead.account, lead.date, lead.maps])];
  const url = URL.createObjectURL(new Blob(['\uFEFF', rows.map((row) => row.map(csvCell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `orbita-leads-${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`${number(leads.length)} lead(s) exportado(s).`);
}

function updatePreview({ versionsChanged = false } = {}) {
  const textarea = document.querySelector('#message-text');
  if (!textarea) return;
  const versions = textarea.value.split(/^\s*---\s*$/m).map((version) => version.trim()).filter(Boolean);
  const versionSelect = document.querySelector('#preview-version');
  const selectedVersion = Number(versionSelect.value || 0);
  if (versionsChanged && versions.length !== versionSelect.options.length) {
    versionSelect.innerHTML = versions.map((_, index) => `<option value="${index}">Versão ${index + 1} de ${versions.length}</option>`).join('');
    versionSelect.value = String(Math.min(selectedVersion, Math.max(0, versions.length - 1)));
  }
  const lead = state.data.leads.find((item) => item.id === document.querySelector('#preview-lead').value);
  document.querySelector('#preview-message').textContent = messagePreview(versions[Number(versionSelect.value)] || '', lead);
  document.querySelector('#preview-name').textContent = lead?.name || 'Contato de exemplo';
  document.querySelector('#message-char-count').textContent = `${number(textarea.value.length)} caracteres`;
}

document.querySelector('#refresh-button').innerHTML = icon('refresh');
document.querySelector('#refresh-button').addEventListener('click', () => refresh({ manual: true }));
document.querySelector('#mobile-menu').addEventListener('click', () => toggleSidebar(true));
document.querySelector('#sidebar-backdrop').addEventListener('click', () => { toggleSidebar(false); document.querySelector('#mobile-menu').focus(); });

document.addEventListener('click', (event) => {
  const target = event.target.closest('button, a');
  if (!target) return;
  if (target.closest('#sidebar') && target.matches('a[href^="#"]')) toggleSidebar(false);
  if (target.id === 'retry-load') refresh({ initial: true });
  if (target.dataset.connectAccount) runtimeAction(target, `/api/accounts/${target.dataset.connectAccount}/connect`, { body: { reset: target.dataset.reset === 'true' }, message: 'Conexão iniciada. Aguarde o QR code ou a reconexão da sessão.' });
  if (target.dataset.disconnectAccount) runtimeAction(target, `/api/accounts/${target.dataset.disconnectAccount}/disconnect`, { message: 'Conta desconectada. A sessão foi mantida.' });
  if (target.dataset.startCampaign) runtimeAction(target, `/api/campaigns/${target.dataset.startCampaign}/start`, { message: 'Campanha iniciada. Acompanhe os resultados no painel e no terminal.' });
  if (target.dataset.stopCampaign) runtimeAction(target, `/api/campaigns/${target.dataset.stopCampaign}/stop`, { message: 'Parada solicitada. Aguardando as operações em andamento.' });
  if (target.dataset.lead) openLead(target.dataset.lead, target);
  if (target.id === 'close-lead') document.querySelector('#lead-dialog').close();
  if (target.hasAttribute('data-copy-phone')) copy(target.dataset.copyPhone, 'Telefone copiado.');
  if (target.id === 'export-leads') exportLeads();
  if (target.hasAttribute('data-status')) {
    state.status = target.dataset.status;
    state.page = 1;
    render();
    document.querySelector(`[data-status="${state.status}"]`)?.focus({ preventScroll: true });
  }
  if (target.id === 'more-filters') {
    state.moreFilters = !state.moreFilters;
    document.querySelector('#extra-filters').hidden = !state.moreFilters;
    target.setAttribute('aria-expanded', String(state.moreFilters));
  }
  if (target.id === 'clear-filters') {
    Object.assign(state, { query: '', status: 'all', niche: '', city: '', sort: 'default', page: 1 });
    render();
    document.querySelector('#lead-search')?.focus();
  }
  if (target.id === 'clear-selection') { state.selected.clear(); updateResults(); }
  if (target.id === 'previous-page' || target.id === 'next-page') {
    state.page += target.id === 'next-page' ? 1 : -1;
    updateResults();
    document.querySelector(`#${target.id}`)?.focus({ preventScroll: true });
  }
  if (target.dataset.nicheSuggestion) {
    const input = document.querySelector('#campaign-niches');
    const current = input.value.split(',').map((item) => item.trim()).filter(Boolean);
    if (!current.includes(target.dataset.nicheSuggestion)) current.push(target.dataset.nicheSuggestion);
    input.value = current.join(', ');
    state.campaignDraft = Object.fromEntries(new FormData(document.querySelector('#campaign-form')));
    input.focus();
  }
  if (target.dataset.variable) {
    const input = document.querySelector('#message-text');
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.setRangeText(`{${target.dataset.variable}}`, start, end, 'end');
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

document.addEventListener('input', (event) => {
  const input = event.target;
  if (input.id === 'lead-search') { state.query = input.value; state.page = 1; updateResults(); }
  if (input.id === 'message-text') {
    state.messageDraft = input.value === state.data.template ? null : input.value;
    const status = document.querySelector('#message-save-status');
    status.textContent = state.messageDraft === null ? 'Salva no projeto' : 'Alterações não salvas';
    status.classList.toggle('unsaved', state.messageDraft !== null);
    updatePreview({ versionsChanged: true });
  }
  if (input.closest('#campaign-form')) state.campaignDraft = Object.fromEntries(new FormData(document.querySelector('#campaign-form')));
});

document.addEventListener('change', (event) => {
  const input = event.target;
  const filters = { 'niche-filter': 'niche', 'city-filter': 'city', 'sort-filter': 'sort' };
  if (filters[input.id]) { state[filters[input.id]] = input.value; state.page = 1; updateResults(); }
  if (input.id === 'select-all') {
    document.querySelectorAll('.lead-checkbox').forEach((checkbox) => input.checked ? state.selected.add(checkbox.dataset.id) : state.selected.delete(checkbox.dataset.id));
    updateResults();
  }
  if (input.classList.contains('lead-checkbox')) {
    input.checked ? state.selected.add(input.dataset.id) : state.selected.delete(input.dataset.id);
    const checkedId = input.dataset.id;
    updateResults();
    [...document.querySelectorAll('.lead-checkbox')].find((checkbox) => checkbox.dataset.id === checkedId)?.focus({ preventScroll: true });
  }
  if (input.id === 'overview-filter') { state.overviewFilter = input.value; render(); document.querySelector('#overview-filter').focus({ preventScroll: true }); }
  if (input.id === 'chart-period') { state.chartPeriod = Number(input.value); render(); document.querySelector('#chart-period').focus({ preventScroll: true }); }
  if (input.id === 'preview-lead' || input.id === 'preview-version') updatePreview();
  if (input.id === 'motion-toggle') {
    const value = input.checked ? 'on' : 'off';
    document.documentElement.dataset.motion = value;
    savePreference('orbita-motion', value);
    toast(input.checked ? 'Animações ativadas.' : 'Animações desativadas.');
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!['campaign-form', 'message-form'].includes(form.id)) return;
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  const original = button.innerHTML;
  const errorElement = form.querySelector('[role="alert"]');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Salvando…';
  errorElement.hidden = true;
  try {
    if (form.id === 'campaign-form') {
      const values = new FormData(form);
      const list = (value) => String(value).split(',').map((item) => item.trim()).filter(Boolean);
      const result = await request('/api/campaigns', { method: 'POST', body: JSON.stringify({ name: values.get('name'), niches: list(values.get('niches')), cities: list(values.get('cities')), accounts: Number(values.get('accounts')) }) });
      state.data.campaigns.unshift(result.campaign);
      state.campaignDraft = null;
      form.reset();
      location.hash = '#campaigns';
      toast('Campanha salva. Seu próximo passo já tem um lugar.');
    } else {
      const text = form.querySelector('textarea').value;
      await request('/api/template', { method: 'PUT', body: JSON.stringify({ text }) });
      state.data.template = text.trim() + '\n';
      const current = form.querySelector('textarea').value;
      state.messageDraft = current === text ? null : current;
      if (state.messageDraft === null) form.querySelector('textarea').value = state.data.template;
      const status = document.querySelector('#message-save-status');
      if (status) {
        status.textContent = state.messageDraft === null ? 'Salva no projeto' : 'Alterações não salvas';
        status.classList.toggle('unsaved', state.messageDraft !== null);
      }
      toast('Mensagens salvas no projeto.');
    }
  } catch (error) {
    errorElement.textContent = error.name === 'TimeoutError' ? 'O servidor demorou para responder. Atualize os dados para verificar se a alteração foi salva antes de tentar novamente.' : error.message;
    errorElement.hidden = false;
    errorElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } finally { button.disabled = false; button.removeAttribute('aria-busy'); button.innerHTML = original; }
});

document.querySelector('#lead-dialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
  }
});
document.querySelector('#lead-dialog').addEventListener('close', () => lastFocusedLeadButton?.isConnected && lastFocusedLeadButton.focus());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.querySelector('#sidebar').classList.contains('is-open')) {
    toggleSidebar(false);
    document.querySelector('#mobile-menu').focus();
  }
  if (event.key === 'Tab' && mobileQuery.matches && document.querySelector('#sidebar').classList.contains('is-open')) {
    const links = [...document.querySelectorAll('#sidebar a[href]')];
    if (event.shiftKey && document.activeElement === links[0]) { event.preventDefault(); links.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === links.at(-1)) { event.preventDefault(); links[0].focus(); }
  }
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) && !event.target.isContentEditable && !document.querySelector('#lead-dialog').open) {
    event.preventDefault();
    if (state.route !== 'leads') { rememberEditing(); location.hash = '#leads'; setTimeout(() => document.querySelector('#lead-search')?.focus(), 0); }
    else document.querySelector('#lead-search')?.focus();
  }
});

window.addEventListener('hashchange', () => { rememberEditing(); toggleSidebar(false); render({ animate: true, focus: true }); });
window.addEventListener('beforeunload', (event) => {
  if (state.messageDraft !== null || (state.campaignDraft && Object.values(state.campaignDraft).some((value, index) => index < 3 && String(value).trim()))) { event.preventDefault(); event.returnValue = ''; }
});
setInterval(() => {
  const usingControl = main.contains(document.activeElement) && document.activeElement.matches('input, textarea, select, button, a');
  if (!document.hidden && ['overview', 'accounts', 'leads', 'campaigns'].includes(state.route) && location.hash !== '#campaigns/new' && !document.querySelector('#lead-dialog').open && !usingControl) refresh();
}, 30000);
document.querySelector('#navigation').innerHTML = navigation(null, currentRoute());
refresh({ initial: true });
