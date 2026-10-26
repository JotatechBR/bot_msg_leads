export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
export const h = escapeHtml;

const icons = {
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.5 5.5L8 16l2.5-5.5L16 8Z"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  message: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 1 1 19 0Z"/><path d="M7 9h9M7 13h6"/>',
  whatsapp: '<path d="M20 11.5A8.5 8.5 0 0 1 7.4 19L3 20l1-4.4A8.5 8.5 0 1 1 20 11.5Z"/><path d="m8 7 1.5 2-1 1c.8 1.7 1.7 2.7 3.5 3.5l1-1 2 1.5c-1 3-7 .5-8-4.5 0-1 .4-2 1-2.5Z"/>',
  settings: '<path d="m9.5 3-.5 2-2 .9-1.9-.6-2 3.4L4.6 10v2L3 13.5l2 3.4 2-.6 2 .9.5 2.3h4.1l.5-2.3 2-.9 2 .6 2-3.4-1.6-1.5v-2l1.6-1.3-2-3.4-2 .6-2-.9-.5-2H9.5Z"/><circle cx="11.5" cy="11.3" r="3"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  arrowUp: '<path d="M6 18 18 6M6 6h12v12"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/><circle cx="8" cy="6" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 .5 7M20 3v5h-5"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m6 9 3 3-3 3m6 0h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>',
};

export function icon(name, className = '') {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.compass}</svg>`;
}

export const number = (value) => new Intl.NumberFormat('pt-BR').format(value ?? 0);
export const titleCase = (text) => String(text || '').replace(/(^|\s)\p{L}/gu, (letter) => letter.toLocaleUpperCase('pt-BR')).replace(/\bSp\b/g, 'SP');
export const dateLabel = (date, options = {}) => date ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', timeZone: 'America/Sao_Paulo', ...options }).format(new Date(date)) : 'Sem registro';
export const phoneLabel = (phone) => {
  const digits = String(phone ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  return digits.replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3') || 'Não informado';
};

export const statusLabels = { pendente: 'Na fila', enviado: 'Enviado', sem_whatsapp: 'Sem WhatsApp', erro: 'Falhou', enviando: 'Em andamento' };
export function badge(status) { return `<span class="badge badge-${h(status)}"><span class="status-dot"></span>${h(statusLabels[status] ?? status)}</span>`; }
export function initials(name) { return String(name).trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase(); }
export function companyAvatar(lead) { return `<span class="company-avatar tone-${[...lead.name].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 5}">${h(initials(lead.name))}</span>`; }

export function emptyState({ title = 'Ainda não há oportunidades por aqui', description = 'Prepare uma campanha com os nichos e as cidades que você quer explorar.', action = 'Preparar campanha', href = '#campaigns', symbol = 'compass' } = {}) {
  return `<div class="empty-state">${icon(symbol)}<h3>${h(title)}</h3><p>${h(description)}</p>${action ? `<a class="button button-secondary" href="${h(href)}">${h(action)} ${icon('arrow')}</a>` : ''}</div>`;
}

export function leadTable(leads, { compact = false, selectable = false, selected = new Set() } = {}) {
  if (!leads.length) return emptyState({ title: 'Nenhum lead encontrado', description: 'Tente outro nome, nicho ou status para encontrar suas oportunidades.', action: '' });
  return `<div class="table-scroll"><table class="leads-table ${compact ? 'compact-table' : ''}"><caption class="sr-only">Lista de empresas e status dos contatos</caption><thead><tr>${selectable ? '<th class="select-cell"><input type="checkbox" id="select-all" aria-label="Selecionar todos os leads desta página" /></th>' : ''}<th>Empresa</th><th>Nicho</th>${compact ? '' : '<th>Avaliação</th>'}<th>Status</th><th><span class="sr-only">Ver detalhes</span></th></tr></thead><tbody>${leads.map((lead) => `<tr>${selectable ? `<td class="select-cell"><input type="checkbox" class="lead-checkbox" data-id="${h(lead.id)}" aria-label="Selecionar ${h(lead.name)}" ${selected.has(lead.id) ? 'checked' : ''} /></td>` : ''}<td><button class="company-button" data-lead="${h(lead.id)}">${companyAvatar(lead)}<span class="company-info"><strong>${h(lead.name)}</strong><small>${h(lead.city ? titleCase(lead.city) : phoneLabel(lead.phone))}</small></span></button></td><td><span class="niche-label">${h(lead.niche ? titleCase(lead.niche) : 'Não informado')}</span></td>${compact ? '' : `<td>${lead.rating ? `<span class="rating">${icon('star')}${h(String(lead.rating).replace('.', ','))}<small>(${number(lead.reviews)})</small></span>` : '<span class="muted">—</span>'}</td>`}<td>${badge(lead.status)}</td><td><button class="icon-button table-arrow" data-lead="${h(lead.id)}" aria-label="Ver ${h(lead.name)}">${icon('arrowUp')}</button></td></tr>`).join('')}</tbody></table></div>`;
}

export function orbitVisual(queued) {
  return `<div class="orbit-visual" aria-hidden="true"><svg class="orbit-lines" viewBox="0 0 440 300"><defs><radialGradient id="orbit-light"><stop offset="0" stop-color="#d9e8af" stop-opacity=".14"/><stop offset="1" stop-color="#d9e8af" stop-opacity="0"/></radialGradient></defs><circle cx="234" cy="150" r="145" fill="url(#orbit-light)"/><g fill="none" stroke="#75927d" stroke-opacity=".36"><ellipse cx="234" cy="150" rx="165" ry="91" transform="rotate(-28 234 150)"/><ellipse cx="234" cy="150" rx="126" ry="70" transform="rotate(-28 234 150)"/><ellipse cx="234" cy="150" rx="86" ry="48" transform="rotate(-28 234 150)"/><path d="M50 150h368M234 15v270" stroke-dasharray="2 8" stroke-opacity=".22"/></g><circle cx="234" cy="150" r="40" fill="#d8e9ae"/><g fill="none" stroke="#2b493a" stroke-width="1.8"><ellipse cx="234" cy="150" rx="23" ry="12" transform="rotate(-42 234 150)"/><ellipse cx="234" cy="150" rx="23" ry="12" transform="rotate(42 234 150)"/></g><circle cx="234" cy="150" r="4.5" fill="#2b493a"/><circle class="orbit-pulse" cx="234" cy="150" r="49" fill="none" stroke="#d8e9ae" stroke-opacity=".2"/><circle cx="342" cy="65" r="5" fill="#d8e9ae"/><circle cx="104" cy="214" r="4" fill="#7a9b84"/><circle cx="331" cy="198" r="3.5" fill="#a7c786"/><circle cx="133" cy="94" r="3" fill="#9aaf83"/></svg><div class="orbit-tag tag-maps">${icon('pin')}<span>Google Maps<small>O ponto de partida</small></span><span class="tag-check">${icon('check')}</span></div><div class="orbit-tag tag-leads">${icon('people')}<span>${number(queued)} oportunidades<small>Esperando uma conexão</small></span></div><div class="orbit-tag tag-whatsapp">${icon('whatsapp')}<span>WhatsApp</span><span class="tag-dot"></span></div><span class="orbit-caption">ENCONTRE. CONECTE. CRESÇA.</span></div>`;
}

export function pageHeading(eyebrow, title, description, actions = '') {
  return `<div class="page-heading"><div>${eyebrow ? `<p class="eyebrow">${h(eyebrow)}</p>` : ''}<h1>${h(title)}</h1><p class="page-description">${h(description)}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`;
}

export function messagePreview(text, lead) {
  return text.replaceAll('{nome}', lead?.name || 'sua próxima conexão').replaceAll('{avaliacao}', String(lead?.rating ?? '4,8').replace('.', ',')).replaceAll('{total_avaliacoes}', String(lead?.reviews ?? '120'));
}
