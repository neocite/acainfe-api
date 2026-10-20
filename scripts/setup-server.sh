#!/usr/bin/env bash
# Preparação da máquina (uma vez): Node 22, pnpm, PM2, nginx + HTTPS para a API.
# Uso: sudo DOMAIN=api.acainfe.com EMAIL=voce@exemplo.com ./scripts/setup-server.sh
set -euo pipefail

DOMAIN="${DOMAIN:-api.acainfe.com}"
EMAIL="${EMAIL:-}"
PORT="${PORT:-3000}"

log() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Rode como root (sudo)."
[ -n "$EMAIL" ] || die "Informe EMAIL=... (avisos de expiração do Let's Encrypt)."

log "Pacotes do sistema"
apt-get update -y
apt-get install -y curl git nginx certbot python3-certbot-nginx

log "Node 22 (nvm) e pnpm (corepack)"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 22 >/dev/null
nvm alias default 22 >/dev/null
corepack enable
command -v pm2 >/dev/null || npm install -g pm2

log "DNS: $DOMAIN deve apontar para esta máquina"
SERVER_IP="$(curl -fsS https://api.ipify.org || true)"
DNS_IP="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
echo "IP desta máquina: ${SERVER_IP:-?} · DNS de $DOMAIN: ${DNS_IP:-não resolve}"
[ -n "$DNS_IP" ] || die "Crie o registro A de $DOMAIN apontando para ${SERVER_IP:-este servidor} e rode de novo."

log "Site no nginx (proxy para 127.0.0.1:$PORT)"
SITE=/etc/nginx/sites-available/acainfe-api
cat > "$SITE" <<NGINX
server {
  listen 80;
  server_name $DOMAIN;
  client_max_body_size 6m;
  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 120s;
  }
}
NGINX
ln -sf "$SITE" /etc/nginx/sites-enabled/acainfe-api
nginx -t
systemctl reload nginx

log "Certificado HTTPS (Let's Encrypt)"
certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos -m "$EMAIL"
certbot renew --dry-run

log "PM2 na inicialização da máquina"
pm2 startup systemd -u "$(whoami)" --hp "$HOME" >/dev/null || true

log "Pronto. Próximos passos:"
cat <<TXT
1. Coloque o .env na pasta do projeto (NUNCA no git), com chmod 600, e:
   NODE_ENV=production
   PUBLIC_BASE_URL=https://$DOMAIN
   MASTER_KEYS igual à usada antes (os certificados A1 estão cifrados com ela)
2. Rode ./scripts/deploy.sh dentro da pasta do projeto.
TXT
