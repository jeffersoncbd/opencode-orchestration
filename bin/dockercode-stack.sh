#!/usr/bin/env bash
# Lê o arquivo de stack do projeto (.oc-services), usado por `oc-up`
# e `oc-down`. É sourced; não é executado direto.
#
# Formato (uma linha por item, sem dependências externas):
#
#   # diretivas (chave = valor)
#   project = emissor-v2
#   network = emissor-v2
#   before-up = ./run-mongo.sh
#   after-up = echo "stack no ar"
#   before-down = :
#   after-down = docker stop mongo
#
#   # serviços: <pasta> [opções extras do docker run]
#   cadastro-service  -v emissor-v2:/volume
#   server-v1         -p "${SERVER_PORT:-3001}:3001"
#
# O `--network` global é aplicado a todos os agentes (e ao principal) que não
# declararem o próprio `--network`. As opções aceitam expansão do shell
# (${VAR}, ${VAR:-padrão}, $(...), aspas), como no script antigo.
#
# Depois de carregar, define:
#   STACK_FILE, STACK_ROOT, STACK_PROJECT, STACK_NETWORK
#   STACK_SERVICE_DIRS[], STACK_SERVICE_NAMES[], STACK_SERVICE_OPTS[]
#   STACK_BEFORE_UP[], STACK_AFTER_UP[], STACK_BEFORE_DOWN[], STACK_AFTER_DOWN[]

STACK_FILE=""
STACK_ROOT=""
STACK_PROJECT=""
STACK_PROJECT_EXPLICIT=false
STACK_NETWORK=""
STACK_SERVICE_DIRS=()
STACK_SERVICE_NAMES=()
STACK_SERVICE_OPTS=()
STACK_BEFORE_UP=()
STACK_AFTER_UP=()
STACK_BEFORE_DOWN=()
STACK_AFTER_DOWN=()

_dockercode_stack_die() {
  echo "erro: $*" >&2
  exit 1
}

_dockercode_stack_trim() {
  local value="$1"
  value="${value%$'\r'}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Procura <dir>/.oc-services subindo até $HOME (exclusive) e /.
_dockercode_stack_find() {
  local dir="$1"
  while [[ "$dir" != "/" && "$dir" != "${HOME:-}" ]]; do
    if [[ -f "$dir/.oc-services" ]]; then
      printf '%s/.oc-services\n' "$(cd "$dir" && pwd -P)"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

# OC_STACK_FILE > .oc-services a partir do diretório informado.
_dockercode_stack_resolve() {
  local dir="$1"
  if [[ -n "${OC_STACK_FILE:-}" ]]; then
    [[ -f "$OC_STACK_FILE" ]] || _dockercode_stack_die "OC_STACK_FILE='$OC_STACK_FILE' não existe ou não é um arquivo regular."
    printf '%s/%s\n' "$(cd "$(dirname "$OC_STACK_FILE")" && pwd -P)" "$(basename "$OC_STACK_FILE")"
    return 0
  fi
  _dockercode_stack_find "$dir"
}

_dockercode_stack_validate_name() {
  local kind="$1" value="$2"
  if ! [[ "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
    _dockercode_stack_die "$kind inválido: '$value' (use letras, números, '_', '.' e '-', começando por letra ou número)."
  fi
}

_dockercode_stack_validate_dir() {
  local dir="$1" line="$2" name
  [[ -n "$dir" ]] || _dockercode_stack_die "serviço sem pasta na linha $line."
  [[ "$dir" != /* ]] || _dockercode_stack_die "a pasta do serviço deve ser relativa à raiz do projeto (linha $line): '$dir'."
  [[ "$dir" != *..* ]] || _dockercode_stack_die "a pasta do serviço não pode conter '..' (linha $line): '$dir'."
  [[ "$dir" =~ ^[a-zA-Z0-9._/-]+$ ]] || _dockercode_stack_die "pasta de serviço inválida na linha $line: '$dir'."
  name="${dir%/}"
  name="${name##*/}"
  _dockercode_stack_validate_name "nome do serviço" "$name"
}

_dockercode_stack_service_exists() {
  local name="$1" existing
  if [[ ${#STACK_SERVICE_NAMES[@]} -gt 0 ]]; then
    for existing in "${STACK_SERVICE_NAMES[@]}"; do
      [[ "$existing" == "$name" ]] && return 0
    done
  fi
  return 1
}

# Carrega e valida a sintaxe. Não exige que as pastas existam: o `oc-down`
# precisa conseguir parar containers mesmo se um serviço foi removido do disco.
_dockercode_stack_load() {
  local file="$1"
  [[ -f "$file" ]] || _dockercode_stack_die "arquivo de stack não encontrado: '$file'."

  STACK_FILE="$(cd "$(dirname "$file")" && pwd -P)/$(basename "$file")"
  STACK_ROOT="$(dirname "$STACK_FILE")"

  STACK_PROJECT=""
  STACK_PROJECT_EXPLICIT=false
  STACK_NETWORK=""
  STACK_SERVICE_DIRS=()
  STACK_SERVICE_NAMES=()
  STACK_SERVICE_OPTS=()
  STACK_BEFORE_UP=()
  STACK_AFTER_UP=()
  STACK_BEFORE_DOWN=()
  STACK_AFTER_DOWN=()

  local line key value dir rest name lineno=0 serialized arg index has_network
  local -a args=()
  local -a raw_services=()
  local -a raw_service_lines=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    line="$(_dockercode_stack_trim "$line")"
    [[ -z "$line" || "$line" == \#* ]] && continue

    if [[ "$line" =~ ^([a-zA-Z][a-zA-Z0-9_-]*)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="$(_dockercode_stack_trim "${BASH_REMATCH[2]}")"
      case "$key" in
        project | network | before-up | after-up | before-down | after-down) ;;
        *)
          _dockercode_stack_die "diretiva desconhecida '$key' em $STACK_FILE:$lineno (válidas: project, network, before-up, after-up, before-down, after-down)."
          ;;
      esac
      [[ -n "$value" ]] || _dockercode_stack_die "diretiva '$key' vazia em $STACK_FILE:$lineno."
      case "$key" in
        project) STACK_PROJECT="$value"; STACK_PROJECT_EXPLICIT=true ;;
        network) STACK_NETWORK="$value" ;;
        before-up) STACK_BEFORE_UP+=("$value") ;;
        after-up) STACK_AFTER_UP+=("$value") ;;
        before-down) STACK_BEFORE_DOWN+=("$value") ;;
        after-down) STACK_AFTER_DOWN+=("$value") ;;
      esac
      continue
    fi

    raw_services+=("$line")
    raw_service_lines+=("$lineno")
  done < "$STACK_FILE"

  # Segunda passada: as diretivas já foram lidas, então a ordem no arquivo não
  # interfere na aplicação do `network` global aos serviços.
  for index in "${!raw_services[@]}"; do
    line="${raw_services[$index]}"
    lineno="${raw_service_lines[$index]}"
    read -r dir rest <<< "$line"
    _dockercode_stack_validate_dir "$dir" "$lineno"
    name="${dir%/}"
    name="${name##*/}"
    if _dockercode_stack_service_exists "$name"; then
      _dockercode_stack_die "serviço duplicado '$name' em $STACK_FILE:$lineno."
    fi

    args=()
    if [[ -n "$rest" ]]; then
      if ! eval "args=($rest)"; then
        _dockercode_stack_die "opções inválidas para o serviço '$name' em $STACK_FILE:$lineno: $rest"
      fi
    fi

    for arg in ${args[@]+"${args[@]}"}; do
      case "$arg" in
        --name | --name=*)
          _dockercode_stack_die "não defina --name no serviço '$name': o nome do container é '<project>-<serviço>'."
          ;;
      esac
    done

    if [[ -n "$STACK_NETWORK" ]]; then
      has_network=false
      for arg in ${args[@]+"${args[@]}"}; do
        case "$arg" in
          --network | --network=*) has_network=true; break ;;
        esac
      done
      if [[ "$has_network" != true ]]; then
        args+=(--network "$STACK_NETWORK")
      fi
    fi

    serialized=""
    if [[ ${#args[@]} -gt 0 ]]; then
      serialized="$(printf '%q ' "${args[@]}")"
    fi
    STACK_SERVICE_DIRS+=("$dir")
    STACK_SERVICE_NAMES+=("$name")
    STACK_SERVICE_OPTS+=("$serialized")
  done

  if [[ ${#STACK_SERVICE_NAMES[@]} -eq 0 ]]; then
    _dockercode_stack_die "nenhum serviço definido em $STACK_FILE."
  fi

  if [[ -z "$STACK_PROJECT" ]]; then
    STACK_PROJECT="$(basename "$STACK_ROOT")"
  fi
  _dockercode_stack_validate_name "prefixo do projeto (project/OC_PROJECT)" "$STACK_PROJECT"

  if [[ -n "$STACK_NETWORK" ]]; then
    if [[ "$STACK_NETWORK" == -* || "$STACK_NETWORK" == *[[:space:]]* ]]; then
      _dockercode_stack_die "rede inválida: '$STACK_NETWORK'."
    fi
  fi
}

_dockercode_stack_print() {
  printf 'root=%s\n' "$STACK_ROOT"
  printf 'file=%s\n' "$STACK_FILE"
  printf 'project=%s\n' "$STACK_PROJECT"
  printf 'network=%s\n' "$STACK_NETWORK"
  local hook
  for hook in ${STACK_BEFORE_UP[@]+"${STACK_BEFORE_UP[@]}"}; do printf 'before-up=%s\n' "$hook"; done
  for hook in ${STACK_AFTER_UP[@]+"${STACK_AFTER_UP[@]}"}; do printf 'after-up=%s\n' "$hook"; done
  for hook in ${STACK_BEFORE_DOWN[@]+"${STACK_BEFORE_DOWN[@]}"}; do printf 'before-down=%s\n' "$hook"; done
  for hook in ${STACK_AFTER_DOWN[@]+"${STACK_AFTER_DOWN[@]}"}; do printf 'after-down=%s\n' "$hook"; done
  local i
  for i in "${!STACK_SERVICE_NAMES[@]}"; do
    printf 'service=%s dir=%s opts=%s\n' \
      "${STACK_SERVICE_NAMES[$i]}" "${STACK_SERVICE_DIRS[$i]}" "${STACK_SERVICE_OPTS[$i]}"
  done
}

# Executa hooks na raiz do projeto, com o contexto do stack no ambiente.
_dockercode_stack_run_hooks() {
  local phase="$1"
  shift
  local hook
  for hook in "$@"; do
    echo "==> $phase: $hook" >&2
    (
      cd "$STACK_ROOT"
      export OC_ROOT="$STACK_ROOT"
      export OC_PROJECT="$STACK_PROJECT"
      export OC_NETWORK="$STACK_NETWORK"
      export OC_STACK_FILE="$STACK_FILE"
      export OC_SERVICES="${STACK_SERVICE_NAMES[*]}"
      bash -c "$hook"
    )
  done
}
