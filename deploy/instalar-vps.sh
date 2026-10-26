#!/usr/bin/env bash
# Instala o Órbita numa VPS Ubuntu (AWS Lightsail ou EC2): Node.js, Caddy (HTTPS automático) e serviço 24h.
# Uso, dentro da pasta do projeto clonado:  bash deploy/instalar-vps.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USUARIO="$(whoami)"
PORTA=3001

if [ "$EUID" -eq 0 ]; then
  echo "Rode sem sudo, com o seu usuário normal (ex.: ubuntu): bash deploy/instalar-vps.sh"
  exit 1
fi

passo() { printf '\n\033[1;32m▸ %s\033[0m\n' "$1"; }

# Grava/atualiza CHAVE="valor" no .env sem mexer nas outras linhas
definir_env() {
  local chave="$1" valor="$2" arquivo="$DIR/.env"
  touch "$arquivo"
  chmod 600 "$arquivo"
  if grep -qE "^\s*${chave}\s*=" "$arquivo"; then
    local temporario
    temporario="$(mktemp)"
    grep -vE "^\s*${chave}\s*=" "$arquivo" > "$temporario" || true
    cat "$temporario" > "$arquivo"
    rm -f "$temporario"
  fi
  [ -s "$arquivo" ] && [ -n "$(tail -c1 "$arquivo")" ] && echo >> "$arquivo"
  printf '%s="%s"\n' "$chave" "$valor" >> "$arquivo"
}

valor_env() { grep -E "^\s*$1\s*=" "$DIR/.env" 2>/dev/null | tail -n1 | sed -E 's/^[^=]*=\s*//; s/^"(.*)"$/\1/' || true; }

passo "Memória de troca (swap) para o npm não faltar memória"
if [ "$(swapon --show | wc -l)" -eq 0 ]; then
  sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo "Swap de 1 GB criado."
else
  echo "Swap já existe."
fi

passo "Pacotes básicos"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

passo "Node.js 24"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
echo "Node $(node -v)"

passo "Caddy (servidor HTTPS com certificado automático)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy >/dev/null
fi
caddy version

passo "Dependências do projeto"
cd "$DIR"
npm ci --omit=dev --no-audit --no-fund

passo "Configuração (.env)"
if [ -z "$(valor_env API_GOOGLE_MAPS)" ]; then
  read -r -p "Chave da API do Google Maps (Places API New): " CHAVE
  definir_env API_GOOGLE_MAPS "$CHAVE"
else
  echo "API_GOOGLE_MAPS já configurada."
fi

if [ -z "$(valor_env PAINEL_SENHA)" ]; then
  while true; do
    read -r -s -p "Crie a senha do painel (mínimo 10 caracteres, sem aspas): " SENHA; echo
    read -r -s -p "Repita a senha: " SENHA2; echo
    if [ "$SENHA" != "$SENHA2" ]; then echo "As senhas não conferem."; continue; fi
    if [ "${#SENHA}" -lt 10 ]; then echo "Use pelo menos 10 caracteres."; continue; fi
    if [[ "$SENHA" == *'"'* ]]; then echo "Não use aspas na senha."; continue; fi
    break
  done
  definir_env PAINEL_SENHA "$SENHA"
else
  echo "PAINEL_SENHA já configurada (para trocar, edite o .env e rode: sudo systemctl restart orbita)."
fi

ORIGENS_ATUAIS="$(valor_env PAINEL_ORIGENS)"
read -r -p "Endereço do painel na Vercel (ex.: https://meu-painel.vercel.app) [${ORIGENS_ATUAIS:-nenhum}]: " ORIGEM
if [ -n "$ORIGEM" ]; then definir_env PAINEL_ORIGENS "${ORIGEM%/}"; fi

passo "Endereço público com HTTPS"
IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
HOST="${IP//./-}.sslip.io"
echo "IP público: $IP"
echo "Endereço:   https://$HOST"

sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$HOST {
	encode gzip
	reverse_proxy localhost:$PORTA {
		flush_interval -1
	}
}
CADDY
sudo systemctl enable --now caddy >/dev/null
sudo systemctl reload caddy

passo "Serviço do Órbita (inicia sozinho e reinicia se cair)"
sudo tee /etc/systemd/system/orbita.service >/dev/null <<SERVICE
[Unit]
Description=Orbita - painel e bot de leads
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USUARIO
WorkingDirectory=$DIR
Environment=ORBITA_MODO=servidor
Environment=NODE_ENV=production
Environment=PORT=$PORTA
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
SERVICE
sudo systemctl daemon-reload
sudo systemctl enable orbita >/dev/null
sudo systemctl restart orbita
sleep 3
sudo systemctl --no-pager --lines=5 status orbita || true

cat <<FIM

══════════════════════════════════════════════════════════════
 Pronto! O Órbita está rodando nesta VPS.

 1. Na AWS, libere as portas 80 e 443 (HTTP e HTTPS) no firewall
    da instância. Sem isso o certificado HTTPS não é emitido.

 2. Teste direto no navegador:  https://$HOST

 3. No vercel.json do projeto, troque o destino do rewrite por:
      https://$HOST/api/:path*
    Faça commit, push e aguarde o deploy da Vercel.

 Logs ao vivo:   journalctl -u orbita -f
 Reiniciar:      sudo systemctl restart orbita
 Atualizar:      bash deploy/atualizar.sh
══════════════════════════════════════════════════════════════
FIM
