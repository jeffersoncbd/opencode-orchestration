#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="${OPENCODE_SMOKE_NETWORK:-dockercode}"
IMAGE="${OPENCODE_SMOKE_IMAGE:-opencode-run}"
SERVICE_DIR="${1:-$PWD}"
TASK="${2:-Responda apenas com a palavra: ok}"

usage() {
  cat <<'EOF'
uso: scripts/smoke.sh [pasta-do-serviço] [tarefa]

Sobe (ou reutiliza) o agente da pasta, espera /api/info e executa as tools
service_models, service_efforts, service, service_status e service_setEffort. Se o script subiu
o agente, ele é parado ao final.

Requer:
  - OPENCODE_API_KEY exportada;
  - opencode.json na pasta do serviço;
  - imagens instaladas (./install.sh) e rede dockercode.

Variáveis opcionais:
  OPENCODE_SMOKE_IMAGE   imagem do principal (padrão: opencode-run)
  OPENCODE_SMOKE_NETWORK rede docker (padrão: dockercode)
  SMOKE_MAX_WAIT_MS      espera máxima da tarefa (padrão: 120000)
EOF
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac

if [[ ! -d "$SERVICE_DIR" ]]; then
  echo "erro: pasta do serviço não encontrada: $SERVICE_DIR" >&2
  exit 1
fi
SERVICE_DIR="$(cd "$SERVICE_DIR" && pwd)"
SERVICE="$(basename "$SERVICE_DIR")"

if ! [[ "$SERVICE" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  echo "erro: o nome da pasta '$SERVICE' não é um nome de serviço válido." >&2
  echo "use letras, números, '_', '.' e '-', começando por letra ou número." >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || {
  echo "erro: docker não encontrado no PATH" >&2
  exit 1
}

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "erro: imagem '$IMAGE' não encontrada; rode ./install.sh primeiro." >&2
  exit 1
fi
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "erro: rede '$NETWORK' não encontrada; rode ./install.sh primeiro." >&2
  exit 1
fi

PASS_FILE="$HOME/.config/dockercode/agent-password"
PASSWORD=""
if [[ -f "$PASS_FILE" ]]; then
  PASSWORD="$(cat "$PASS_FILE")"
fi

STARTED_AGENT=false
cleanup() {
  if [[ "$STARTED_AGENT" == true ]]; then
    echo "==> parando o agente '$SERVICE' (iniciado pelo smoke)" >&2
    docker stop -t 2 "$SERVICE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if docker container inspect "$SERVICE" >/dev/null 2>&1; then
  if [[ "$(docker inspect -f '{{.State.Running}}' "$SERVICE" 2>/dev/null)" != true ]]; then
    echo "erro: já existe um container parado chamado '$SERVICE'." >&2
    echo "remova-o (docker rm '$SERVICE') ou suba o agente novamente antes do smoke." >&2
    exit 1
  fi
  echo "==> reutilizando o agente '$SERVICE' já em execução"
else
  if [[ -z "${OPENCODE_API_KEY:-}" ]]; then
    echo "erro: OPENCODE_API_KEY não está definida; exporte a chave antes de subir o agente." >&2
    exit 1
  fi
  if ! docker image inspect opencode-agent >/dev/null 2>&1; then
    echo "erro: imagem 'opencode-agent' não encontrada; rode ./install.sh primeiro." >&2
    exit 1
  fi

  has_config=false
  for candidate in \
    "$SERVICE_DIR/opencode.json" \
    "$SERVICE_DIR/opencode.jsonc" \
    "$SERVICE_DIR/.opencode/opencode.json" \
    "$SERVICE_DIR/.opencode/opencode.jsonc"; do
    if [[ -f "$candidate" ]]; then
      has_config=true
      break
    fi
  done
  if [[ "$has_config" != true ]]; then
    echo "erro: nenhum opencode.json encontrado em '$SERVICE_DIR'." >&2
    echo "o agente precisa do provider configurado na pasta do serviço." >&2
    exit 1
  fi

  echo "==> subindo o agente '$SERVICE' a partir de $SERVICE_DIR"
  (cd "$SERVICE_DIR" && "$HERE/bin/dockeragent")
  STARTED_AGENT=true
fi

echo "==> aguardando /api/info em '$SERVICE'"
curl_auth=()
if [[ -n "$PASSWORD" ]]; then
  curl_auth=(-u "opencode:$PASSWORD")
fi

ready=false
deadline=$((SECONDS + 20))
while ((SECONDS < deadline)); do
  if docker exec "$SERVICE" curl -fsS --connect-timeout 1 --max-time 2 \
    "${curl_auth[@]}" "http://127.0.0.1:4096/api/info" >/dev/null 2>&1; then
    ready=true
    break
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$SERVICE" 2>/dev/null || true)" != true ]]; then
    break
  fi
  sleep 0.5
done

if [[ "$ready" != true ]]; then
  echo "erro: o agente '$SERVICE' não respondeu em /api/info em até 20s." >&2
  echo "--- docker logs --tail 50 $SERVICE ---" >&2
  docker logs --tail 50 "$SERVICE" >&2 || true
  exit 1
fi

env_args=(
  -e HOME=/tmp
  -e "OPENCODE_AGENT_MAX_WAIT_MS=${SMOKE_MAX_WAIT_MS:-120000}"
  -e "OPENCODE_AGENT_POLL_INTERVAL_MS=${OPENCODE_AGENT_POLL_INTERVAL_MS:-500}"
  -e "OPENCODE_AGENT_REQUEST_TIMEOUT_MS=${OPENCODE_AGENT_REQUEST_TIMEOUT_MS:-30000}"
)
if [[ -n "${OPENCODE_API_KEY:-}" ]]; then
  env_args+=(-e OPENCODE_API_KEY)
fi
if [[ -n "$PASSWORD" ]]; then
  env_args+=(-e "OPENCODE_AGENT_PASSWORD=$PASSWORD")
fi

echo "==> executando service_models, service_efforts, service, service_status e service_setEffort"
docker run --rm \
  --network "$NETWORK" \
  -u "$(id -u):$(id -g)" \
  "${env_args[@]}" \
  -v "$HERE:/repo:ro" \
  "$IMAGE" node /repo/scripts/smoke.mjs "$SERVICE" "$TASK"
