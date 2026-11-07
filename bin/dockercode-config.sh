#!/usr/bin/env bash
# Resolve a configuração global opcional do usuário (opencode.json/jsonc).
# É sourced por oc-main, oc-agent e scripts/smoke.sh; não é executado direto.
#
# Precedência:
#   1. OC_CONFIG_FILE (caminho completo)
#   2. OC_CONFIG_DIR  (pasta com opencode.json ou opencode.jsonc)
#   3. ~/.config/dockercode   (padrão)
#
# Define:
#   USER_CONFIGS    array com os caminhos absolutos encontrados
#   USER_CONFIG_DIR diretório resolvido (vazio se nenhum arquivo foi encontrado)
#
# Também expõe _dockercode_resolve_image, usada pelos launchers para permitir
# imagens estendidas por projeto (precedência: env > .dockercode/image > padrão).

USER_CONFIGS=()
USER_CONFIG_DIR=""

_dockercode_die() {
  echo "erro: $*" >&2
  exit 1
}

_dockercode_collect_user_configs() {
  USER_CONFIGS=()
  USER_CONFIG_DIR=""

  if [[ -n "${OC_CONFIG_FILE:-}" ]]; then
    local file="$OC_CONFIG_FILE" base dir
    base="$(basename "$file")"
    case "$base" in
      opencode.json | opencode.jsonc) ;;
      *)
        _dockercode_die \
          "OC_CONFIG_FILE deve apontar para um arquivo chamado opencode.json ou opencode.jsonc (recebido: '$file')."
        ;;
    esac
    [[ -f "$file" ]] || _dockercode_die "OC_CONFIG_FILE='$file' não existe ou não é um arquivo regular."
    dir="$(cd "$(dirname "$file")" && pwd -P)" ||
      _dockercode_die "não foi possível resolver o diretório de OC_CONFIG_FILE='$file'."
    USER_CONFIGS=("$dir/$base")
    USER_CONFIG_DIR="$dir"
    return 0
  fi

  local dir="${OC_CONFIG_DIR:-$HOME/.config/dockercode}" name explicit=false
  if [[ -n "${OC_CONFIG_DIR:-}" ]]; then
    explicit=true
  fi

  if [[ ! -d "$dir" ]]; then
    if [[ "$explicit" == true ]]; then
      _dockercode_die "OC_CONFIG_DIR='$dir' não é um diretório."
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
    _dockercode_die "nenhum opencode.json ou opencode.jsonc encontrado em OC_CONFIG_DIR='$dir'."
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

# --- Imagem usada pelos launchers -------------------------------------------

# Procura <dir>/.dockercode/<nome>, subindo diretório a diretório.
# Para em $HOME (inclusive) e em /, então não existe imagem "global" implícita na
# home: use OC_MAIN_IMAGE/OC_AGENT_IMAGE para um padrão global.
_dockercode_find_image_file() {
  local dir="$1" name="$2"
  while :; do
    if [[ "$dir" == "/" || "$dir" == "${HOME:-}" ]]; then
      return 1
    fi
    if [[ -f "$dir/.dockercode/$name" ]]; then
      printf '%s\n' "$dir/.dockercode/$name"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
}

# Lê a primeira linha útil do arquivo (ignora linhas vazias e comentários "#").
_dockercode_read_image_file() {
  local file="$1" line image=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    image="$line"
    break
  done < "$file"
  printf '%s\n' "$image"
}

# Rejeita nomes que o docker run interpretaria como flag (ex.: "-it") ou vazios.
_dockercode_validate_image() {
  local image="$1"
  if [[ -z "$image" ]]; then
    _dockercode_die "imagem vazia (verifique OC_MAIN_IMAGE/OC_AGENT_IMAGE ou .dockercode/image)."
  fi
  if ! [[ "$image" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$ ]]; then
    _dockercode_die "imagem inválida: '$image' (use letras, números, '.', '_', '/', ':', '@' e '-'; não comece com '-')."
  fi
}

# Resolve a imagem: env > .dockercode/<arquivos, na ordem> > padrão.
# Uso: image="$(_dockercode_resolve_image <dir> <padrão> <valor-do-env> <arquivo>...)"
_dockercode_resolve_image() {
  local dir="$1" default="$2" env_value="$3" image="" file name
  shift 3

  if [[ -n "$env_value" ]]; then
    image="$env_value"
  else
    for name in "$@"; do
      file="$(_dockercode_find_image_file "$dir" "$name")" || continue
      image="$(_dockercode_read_image_file "$file")"
      if [[ -z "$image" ]]; then
        _dockercode_die "arquivo '$file' está vazio ou só tem comentários."
      fi
      break
    done
    [[ -n "$image" ]] || image="$default"
  fi

  _dockercode_validate_image "$image"
  printf '%s\n' "$image"
}

_dockercode_collect_user_configs
