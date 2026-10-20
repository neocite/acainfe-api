#!/usr/bin/env bash
# Deploy da API: atualiza o código, instala, compila, sobe no PM2 e confere a saúde.
# Se a API não responder depois do deploy, volta para a versão anterior.
#
# Uso (na pasta do projeto):  ./scripts/deploy.sh            # branch main
#                             BRANCH=outra ./scripts/deploy.sh
#                             SKIP_TESTS=1 ./scripts/deploy.sh
set -euo pipefail

APP=acainfe-api
BRANCH="${BRANCH:-main}"
PORT="${PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
cd "$(dirname "$0")/.."

log() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null
node -v | grep -q '^v22' || die "Node 22 não encontrado (rode scripts/setup-server.sh)."
corepack enable >/dev/null 2>&1 || true

log "Conferindo o .env (sem exibir valores)"
[ -f .env ] || die ".env não encontrado em $(pwd)."
chmod 600 .env
for var in MONGODB_URI MONGODB_DB ADMIN_API_KEY APP_API_KEY MASTER_KEYS MASTER_KEY_ID LINK_SIGNING_SECRET PUBLIC_BASE_URL; do
  grep -Eq "^${var}=.+" .env || die "Falta $var no .env."
done
grep -Eq '^PUBLIC_BASE_URL=.*ngrok' .env && die "PUBLIC_BASE_URL ainda aponta para o ngrok."
grep -Eq '^NODE_ENV=production' .env || echo "Aviso: NODE_ENV no .env não é 'production' (o PM2 força production)."

PREVIOUS="$(git rev-parse HEAD)"
log "Atualizando código ($BRANCH) — versão atual ${PREVIOUS:0:7}"
git diff --quiet || die "Há alterações locais não commitadas nesta máquina. Resolva antes do deploy."
git fetch --prune origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
CURRENT="$(git rev-parse HEAD)"
echo "Nova versão: ${CURRENT:0:7}"

build() {
  # Dev deps são necessárias para testes e build (mesmo com NODE_ENV=production no shell).
  pnpm install --frozen-lockfile --prod=false
  if [ "${SKIP_TESTS:-0}" != "1" ]; then pnpm test; fi
  pnpm build
}

log "Instalando, testando e compilando"
build || die "Falha no build/testes. Nada foi alterado no PM2 (a versão anterior continua no ar)."

healthy() {
  for _ in $(seq 1 20); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

log "Subindo no PM2"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save >/dev/null

if healthy; then
  log "Deploy concluído: ${CURRENT:0:7} no ar ($HEALTH_URL ok)"
  exit 0
fi

log "A API não respondeu. Voltando para ${PREVIOUS:0:7}"
pm2 logs "$APP" --lines 40 --nostream || true
git checkout -q "$PREVIOUS"
SKIP_TESTS=1 build
pm2 startOrReload ecosystem.config.cjs --update-env
if healthy; then
  git checkout -q "$BRANCH"
  die "Deploy de ${CURRENT:0:7} falhou; versão ${PREVIOUS:0:7} restaurada e no ar. Veja os logs acima."
fi
die "Deploy falhou e a versão anterior também não respondeu. Veja: pm2 logs $APP"
