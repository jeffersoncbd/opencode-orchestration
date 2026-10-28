#!/usr/bin/env bash
# Resolve a configuração global opcional do usuário (opencode.json/jsonc).
# É sourced por dockercode, dockeragent e scripts/smoke.sh; não é executado direto.
#
# Precedência:
#   1. DOCKERCODE_CONFIG_FILE (caminho completo)
#   2. DOCKERCODE_CONFIG_DIR  (pasta com opencode.json ou opencode.jsonc)
#   3. ~/.config/dockercode   (padrão)
#
# Define:
#   USER_CONFIGS    array com os caminhos absolutos encontrados
#   USER_CONFIG_DIR diretório resolvido (vazio se nenhum arquivo foi encontrado)

USER_CONFIGS=()
USER_CONFIG_DIR=""

_dockercode_die() {
  echo "erro: $*" >&2
  exit 1
}

_dockercode_collect_user_configs() {
  USER_CONFIGS=()
  USER_CONFIG_DIR=""

  if [[ -n "${DOCKERCODE_CONFIG_FILE:-}" ]]; then
    local file="$DOCKERCODE_CONFIG_FILE" base dir
    base="$(basename "$file")"
    case "$base" in
      opencode.json | opencode.jsonc) ;;
      *)
        _dockercode_die \
          "DOCKERCODE_CONFIG_FILE deve apontar para um arquivo chamado opencode.json ou opencode.jsonc (recebido: '$file')."
        ;;
    esac
    [[ -f "$file" ]] || _dockercode_die "DOCKERCODE_CONFIG_FILE='$file' não existe ou não é um arquivo regular."
    dir="$(cd "$(dirname "$file")" && pwd -P)" ||
      _dockercode_die "não foi possível resolver o diretório de DOCKERCODE_CONFIG_FILE='$file'."
    USER_CONFIGS=("$dir/$base")
    USER_CONFIG_DIR="$dir"
    return 0
  fi

  local dir="${DOCKERCODE_CONFIG_DIR:-$HOME/.config/dockercode}" name explicit=false
  if [[ -n "${DOCKERCODE_CONFIG_DIR:-}" ]]; then
    explicit=true
  fi

  if [[ ! -d "$dir" ]]; then
    if [[ "$explicit" == true ]]; then
      _dockercode_die "DOCKERCODE_CONFIG_DIR='$dir' não é um diretório."
    fi
    return 0
  fi

  dir="$(cd "$dir" && pwd -P)" || _dockercode_die "não foi possível resolver o diretório '$dir'."
  USER_CONFIG_DIR="$dir"
  for name in opencode.json opencode.jsonc; do
    if [[ -f "$dir/$name" ]]; then
      USER_CONFIGS+=("$dir/$name")
    fi
  done

  if [[ "$explicit" == true && ${#USER_CONFIGS[@]} -eq 0 ]]; then
    _dockercode_die "nenhum opencode.json ou opencode.jsonc encontrado em DOCKERCODE_CONFIG_DIR='$dir'."
  fi
}

# true se a pasta do projeto tem uma configuração local do OpenCode.
_dockercode_has_project_config() {
  local base="${1:-$PWD}" name
  for name in opencode.json opencode.jsonc .opencode/opencode.json .opencode/opencode.jsonc; do
    if [[ -f "$base/$name" ]]; then
      return 0
    fi
  done
  return 1
}

_dockercode_collect_user_configs
