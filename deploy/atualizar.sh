#!/usr/bin/env bash
# Atualiza o código da VPS com o que está no GitHub, preservando os dados desta máquina
# (histórico de contatos, mensagens, campanhas, logs, sessões do WhatsApp e .env).
# Atenção: para o serviço durante a atualização; campanhas em andamento são interrompidas.
# Uso: bash deploy/atualizar.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
DADOS=(.env historico.json mensagem.txt .orbita sessoes)
BACKUP="$DIR/../orbita-backup-$(date +%Y%m%d-%H%M%S)"

echo "▸ Parando o serviço..."
sudo systemctl stop orbita

echo "▸ Guardando os dados em $BACKUP"
mkdir -p "$BACKUP"
for item in "${DADOS[@]}"; do
  if [ -e "$item" ]; then cp -a "$item" "$BACKUP/"; fi
done

echo "▸ Baixando o código novo..."
git fetch --quiet origin
RAMO="$(git rev-parse --abbrev-ref HEAD)"
git reset --hard --quiet "origin/$RAMO"

echo "▸ Restaurando os dados desta VPS..."
for item in "${DADOS[@]}"; do
  if [ -e "$BACKUP/$item" ]; then rm -rf "$item"; cp -a "$BACKUP/$item" .; fi
done

echo "▸ Instalando dependências..."
npm ci --omit=dev --no-audit --no-fund

echo "▸ Iniciando o serviço..."
sudo systemctl start orbita
sleep 2
sudo systemctl --no-pager --lines=5 status orbita || true
echo
echo "Atualizado para $(git log -1 --format='%h %s'). Backup dos dados mantido em $BACKUP"
