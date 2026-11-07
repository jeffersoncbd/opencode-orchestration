#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX_BIN="$HOME/.local/bin"
CONFIG_ROOT="$HOME/.config/dockercode"

command -v docker >/dev/null 2>&1 || { echo "erro: docker não encontrado no PATH" >&2; exit 1; }

# 1. Launchers
mkdir -p "$PREFIX_BIN"
install -m 755 "$HERE/bin/oc-main"  "$PREFIX_BIN/oc-main"
install -m 755 "$HERE/bin/oc-agent" "$PREFIX_BIN/oc-agent"
install -m 755 "$HERE/bin/oc-run"   "$PREFIX_BIN/oc-run"
install -m 755 "$HERE/bin/oc-up"    "$PREFIX_BIN/oc-up"
install -m 755 "$HERE/bin/oc-down"  "$PREFIX_BIN/oc-down"
install -m 644 "$HERE/bin/dockercode-config.sh" "$PREFIX_BIN/dockercode-config.sh"
install -m 644 "$HERE/bin/dockercode-stack.sh"  "$PREFIX_BIN/dockercode-stack.sh"

# 2. Configuração do opencode (plugin de tools, funções puras e agente "Agent")
mkdir -p "$CONFIG_ROOT/plugins" "$CONFIG_ROOT/lib" "$CONFIG_ROOT/agents"
install -m 644 "$HERE/config/plugins/service.ts"       "$CONFIG_ROOT/plugins/service.ts"
install -m 644 "$HERE/config/lib/service-format.ts"    "$CONFIG_ROOT/lib/service-format.ts"
install -m 644 "$HERE/config/agents/agent.md"          "$CONFIG_ROOT/agents/agent.md"

# 3. Imagens
docker build -f "$HERE/dockerfiles/OcMainDockerfile"   -t oc-main   "$HERE"
docker build -f "$HERE/dockerfiles/OcAgentDockerfile" -t oc-agent "$HERE"

echo
echo "opencode-orchestration instalado."
echo "  principal:  oc-main   (na raiz do projeto; inicia em background)"
echo "  interface:  oc-run    (abre a TUI; aceita o nome do container como argumento)"
echo "  agente:     oc-agent  (na pasta de cada serviço)"
echo "  stack:      oc-up / oc-down (usam .oc-services na raiz)"
echo "  rede:       passe --network <rede> aos launchers (não há rede fixa)"
if [[ -f "$CONFIG_ROOT/opencode.json" || -f "$CONFIG_ROOT/opencode.jsonc" ]]; then
  echo "  config:     $CONFIG_ROOT/opencode.json(c) (vale para todos os serviços)"
else
  echo "  config:     opcional em $CONFIG_ROOT/opencode.json (vale para todos os serviços)"
fi
