#!/usr/bin/env bash
# Выкладка веб-клиента на прод: сборка → deploy/site/web → рестарт Caddy.
# Запускать на VM с доступом к /home/pi/www/chat (или скопировать dist).
set -euo pipefail

DOMAIN="${DOMAIN:-ednar.duckdns.org}"
HOST="${HOST:-root@5.175.234.103}"
REMOTE_DIR="${REMOTE_DIR:-/root/chat}"

cd "$(dirname "$0")/../clients/web"

echo "== сборка веб-клиента"
npm ci
npm run build

echo "== выкладка на $HOST"
ssh "$HOST" "mkdir -p $REMOTE_DIR/deploy/site/web"
rsync -av --delete dist/ "$HOST:$REMOTE_DIR/deploy/site/web/"

echo "== Caddyfile с разрешённой камерой (нужен сканер QR)"
scp ../deploy/Caddyfile "$HOST:$REMOTE_DIR/deploy/Caddyfile"

echo "== рестарт Caddy"
ssh "$HOST" "cd $REMOTE_DIR/deploy && docker compose up -d --force-recreate caddy"

echo "== проверка"
curl -fsS "https://$DOMAIN/web/" -o /dev/null && echo "web отдаётся"
curl -fsSI "https://$DOMAIN/web/" | grep -i "permissions-policy" || true
