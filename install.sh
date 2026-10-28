#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX_BIN="$HOME/.local/bin"
CONFIG_ROOT="$HOME/.config/dockercode"

command -v docker >/dev/null 2>&1 || { echo "erro: docker não encontrado no PATH" >&2; exit 1; }

# 1. Launchers
mkdir -p "$PREFIX_BIN"
install -m 755 "$HERE/bin/dockercode"  "$PREFIX_BIN/dockercode"
install -m 755 "$HERE/bin/dockeragent" "$PREFIX_BIN/dockeragent"
install -m 644 "$HERE/bin/dockercode-config.sh" "$PREFIX_BIN/dockercode-config.sh"

# 2. Configuração do opencode (plugin de tools, funções puras e agente "Agent")
mkdir -p "$CONFIG_ROOT/plugins" "$CONFIG_ROOT/lib" "$CONFIG_ROOT/agents"
install -m 644 "$HERE/config/plugins/service.ts"       "$CONFIG_ROOT/plugins/service.ts"
install -m 644 "$HERE/config/lib/service-format.ts"    "$CONFIG_ROOT/lib/service-format.ts"
install -m 644 "$HERE/config/agents/agent.md"          "$CONFIG_ROOT/agents/agent.md"

# 3. Imagens
docker build -f "$HERE/dockerfiles/OpencodeRunDockerfile"   -t opencode-run   "$HERE"
docker build -f "$HERE/dockerfiles/OpencodeAgentDockerfile" -t opencode-agent "$HERE"

# 4. Rede
docker network inspect dockercode >/dev/null 2>&1 || docker network create dockercode

echo
echo "opencode-orchestration instalado."
echo "  principal:  dockercode   (na raiz do projeto)"
echo "  agente:     dockeragent  (na pasta de cada serviço)"
if [[ -f "$CONFIG_ROOT/opencode.json" || -f "$CONFIG_ROOT/opencode.jsonc" ]]; then
  echo "  config:     $CONFIG_ROOT/opencode.json(c) (vale para todos os serviços)"
else
  echo "  config:     opcional em $CONFIG_ROOT/opencode.json (vale para todos os serviços)"
fi
