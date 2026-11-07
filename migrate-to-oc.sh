#!/usr/bin/env bash
# Script TEMPORÁRIO de migração dos nomes antigos para os novos:
#   comandos:  dockercode    -> oc-main
#              dockeragent   -> oc-agent
#   imagens:   opencode-run   -> oc-main
#              opencode-agent -> oc-agent
#   env vars:  DOCKERCODE_IMAGE       -> OC_MAIN_IMAGE
#              DOCKERCODE_AGENT_IMAGE -> OC_AGENT_IMAGE
#              DOCKERCODE_CONFIG_FILE -> OC_CONFIG_FILE
#              DOCKERCODE_CONFIG_DIR  -> OC_CONFIG_DIR
#
# O que ele faz:
#   1. remove os launchers antigos de ~/.local/bin;
#   2. remove containers antigos (principal `dockercode-*` e agentes da imagem
#      `opencode-agent`);
#   3. remove as imagens antigas `opencode-run` e `opencode-agent`;
#   4. opcionalmente reescreve DOCKERCODE_* nos arquivos de rc do shell;
#   5. roda ./install.sh para instalar os novos comandos e construir as imagens.
#
# O que ele NÃO faz (mantido de propósito): ~/.config/dockercode/, .dockercode/,
# a lib dockercode-config.sh, OPENCODE_AGENT_* e /tmp/opencode-agent.
#
# Pode apagar este arquivo depois da migração.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=false
ASSUME_YES=false
KEEP_IMAGES=false
REWRITE_RC=false
RUN_INSTALL=true

usage() {
  cat <<'EOF'
uso: ./migrate-to-oc.sh [opções]

Migra a instalação antiga (dockercode/dockeragent, imagens opencode-run/
opencode-agent e variáveis DOCKERCODE_*) para os novos nomes oc-main/oc-agent.

Opções:
  --dry-run       mostra o que seria feito, sem alterar nada
  --yes, -y       não pede confirmação
  --keep-images   não remove as imagens antigas
  --rewrite-rc    reescreve DOCKERCODE_* nos arquivos de rc do shell
                  (~/.bashrc, ~/.bash_profile, ~/.profile, ~/.zshrc),
                  criando backups .bak.<timestamp>
  --no-install    não roda ./install.sh no final
  -h, --help      esta ajuda

Sem --yes, pede confirmação antes de remover containers/imagens.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --yes | -y) ASSUME_YES=true; shift ;;
    --keep-images) KEEP_IMAGES=true; shift ;;
    --rewrite-rc) REWRITE_RC=true; shift ;;
    --no-install) RUN_INSTALL=false; shift ;;
    -h | --help) usage; exit 0 ;;
    *)
      echo "erro: opção desconhecida: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }

run() {
  if [[ "$DRY_RUN" == true ]]; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

# --- Coleta do que existe ------------------------------------------------

HAS_DOCKER=false
if command -v docker >/dev/null 2>&1; then
  HAS_DOCKER=true
fi

OLD_LAUNCHERS=()
for launcher in dockercode dockeragent; do
  if [[ -e "$HOME/.local/bin/$launcher" ]]; then
    OLD_LAUNCHERS+=("$HOME/.local/bin/$launcher")
  fi
done

OLD_CONTAINERS=()
if [[ "$HAS_DOCKER" == true ]]; then
  while IFS= read -r name; do
    [[ -n "$name" ]] && OLD_CONTAINERS+=("$name")
  done < <(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^dockercode-' || true)

  while IFS= read -r name; do
    [[ -n "$name" ]] && OLD_CONTAINERS+=("$name")
  done < <(docker ps -a --filter ancestor=opencode-agent --format '{{.Names}}' 2>/dev/null || true)
fi

# Remove duplicatas preservando a ordem.
if [[ ${#OLD_CONTAINERS[@]} -gt 0 ]]; then
  mapfile -t OLD_CONTAINERS < <(printf '%s\n' "${OLD_CONTAINERS[@]}" | awk '!seen[$0]++')
fi

OLD_IMAGES=()
if [[ "$HAS_DOCKER" == true && "$KEEP_IMAGES" != true ]]; then
  for image in opencode-run opencode-agent; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      OLD_IMAGES+=("$image")
    fi
  done
fi

# Variáveis ainda definidas no ambiente atual (não dá para alterar o pai).
ENV_FOUND=()
for var in DOCKERCODE_IMAGE DOCKERCODE_AGENT_IMAGE DOCKERCODE_CONFIG_FILE DOCKERCODE_CONFIG_DIR; do
  if [[ -n "${!var:-}" ]]; then
    ENV_FOUND+=("$var=${!var}")
  fi
done

RC_FILES=()
RC_WITH_MATCHES=()
for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.zshrc"; do
  [[ -f "$rc" ]] || continue
  RC_FILES+=("$rc")
  if grep -q 'DOCKERCODE_' "$rc" 2>/dev/null; then
    RC_WITH_MATCHES+=("$rc")
  fi
done

# --- Plano ---------------------------------------------------------------

step "plano de migração"
if [[ "$DRY_RUN" == true ]]; then
  say "modo: dry-run (nada será alterado)"
fi

if [[ ${#OLD_LAUNCHERS[@]} -eq 0 ]]; then
  say "launchers antigos: nenhum encontrado em ~/.local/bin"
else
  say "launchers antigos a remover:"
  printf '  - %s\n' "${OLD_LAUNCHERS[@]}"
fi

if [[ "$HAS_DOCKER" != true ]]; then
  say "docker: NÃO encontrado no PATH (etapas de container/imagem serão ignoradas)"
elif [[ ${#OLD_CONTAINERS[@]} -eq 0 ]]; then
  say "containers antigos: nenhum encontrado"
else
  say "containers antigos a remover (docker rm -f):"
  printf '  - %s\n' "${OLD_CONTAINERS[@]}"
fi

if [[ "$KEEP_IMAGES" == true ]]; then
  say "imagens antigas: mantidas (--keep-images)"
elif [[ "$HAS_DOCKER" != true ]]; then
  say "imagens antigas: ignoradas (sem docker)"
elif [[ ${#OLD_IMAGES[@]} -eq 0 ]]; then
  say "imagens antigas: nenhuma encontrada"
else
  say "imagens antigas a remover (docker rmi):"
  printf '  - %s\n' "${OLD_IMAGES[@]}"
fi

if [[ ${#ENV_FOUND[@]} -gt 0 ]]; then
  say "variáveis antigas definidas neste shell (troque manualmente; um script não altera o shell pai):"
  printf '  - %s\n' "${ENV_FOUND[@]}"
fi

if [[ ${#RC_WITH_MATCHES[@]} -eq 0 ]]; then
  say "arquivos de rc: nenhum DOCKERCODE_* encontrado"
elif [[ "$REWRITE_RC" == true ]]; then
  say "arquivos de rc a reescrever:"
  printf '  - %s\n' "${RC_WITH_MATCHES[@]}"
else
  say "atenção: DOCKERCODE_* encontrado em (use --rewrite-rc para migrar):"
  printf '  - %s\n' "${RC_WITH_MATCHES[@]}"
fi

if [[ "$RUN_INSTALL" == true ]]; then
  say "instalação: ./install.sh será executado no final (cria oc-main/oc-agent)"
else
  say "instalação: pulada (--no-install)"
fi

# --- Confirmação ---------------------------------------------------------

if [[ "$ASSUME_YES" != true && "$DRY_RUN" != true ]]; then
  if [[ ! -t 0 ]]; then
    echo "erro: sem terminal interativo; rode com --yes para confirmar." >&2
    exit 1
  fi
  say ""
  read -r -p "Continuar com a migração? Isso encerra sessões antigas. [s/N] " answer
  case "$answer" in
    s | S | y | Y | sim | SIM) ;;
    *) say "cancelado."; exit 1 ;;
  esac
fi

# --- Execução ------------------------------------------------------------

if [[ "$REWRITE_RC" == true && ${#RC_WITH_MATCHES[@]} -gt 0 ]]; then
  step "reescrevendo variáveis nos arquivos de rc"
  stamp="$(date +%Y%m%d%H%M%S)"
  for rc in "${RC_WITH_MATCHES[@]}"; do
    if [[ "$DRY_RUN" == true ]]; then
      say "[dry-run] sed -i '$rc' (backup em $rc.bak.$stamp)"
      continue
    fi
    cp "$rc" "$rc.bak.$stamp"
    sed -i \
      -e 's/DOCKERCODE_AGENT_IMAGE/OC_AGENT_IMAGE/g' \
      -e 's/DOCKERCODE_IMAGE/OC_MAIN_IMAGE/g' \
      -e 's/DOCKERCODE_CONFIG_FILE/OC_CONFIG_FILE/g' \
      -e 's/DOCKERCODE_CONFIG_DIR/OC_CONFIG_DIR/g' \
      "$rc"
    say "  - $rc atualizado (backup: $rc.bak.$stamp)"
  done
fi

if [[ ${#OLD_LAUNCHERS[@]} -gt 0 ]]; then
  step "removendo launchers antigos"
  run rm -f "${OLD_LAUNCHERS[@]}"
fi

if [[ ${#OLD_CONTAINERS[@]} -gt 0 ]]; then
  step "removendo containers antigos (execuções em andamento serão encerradas)"
  run docker rm -f "${OLD_CONTAINERS[@]}"
fi

if [[ ${#OLD_IMAGES[@]} -gt 0 ]]; then
  step "removendo imagens antigas"
  for image in "${OLD_IMAGES[@]}"; do
    if [[ "$DRY_RUN" == true ]]; then
      run docker rmi "$image"
    else
      if ! docker rmi "$image" >/dev/null 2>&1; then
        say "aviso: não foi possível remover a imagem '$image' (em uso ou já removida)."
      else
        say "  - imagem '$image' removida"
      fi
    fi
  done
fi

if [[ "$RUN_INSTALL" == true ]]; then
  step "instalando os novos comandos e imagens"
  if [[ "$HAS_DOCKER" != true ]]; then
    say "aviso: docker não encontrado; ./install.sh não será executado."
  elif [[ "$DRY_RUN" == true ]]; then
    run bash "$HERE/install.sh"
  else
    bash "$HERE/install.sh"
  fi
fi

step "migração concluída"
if [[ "$DRY_RUN" == true ]]; then
  say "dry-run concluído: nada foi alterado."
fi
say "novos comandos: oc-main (container em background), oc-run (TUI), oc-agent (agente) e oc-up/oc-down (stack)"
say "novas imagens:  oc-main e oc-agent"
say ""
say "Lembre-se:"
say "  - abra um novo shell (ou rode 'source ~/.bashrc') para aplicar mudanças de rc;"
say "  - defina OC_PROJECT (ex.: export OC_PROJECT=nome-do-projeto) e use o mesmo valor em oc-main e oc-agent;"
say "  - reexporte a chave se você usava as variáveis antigas no ambiente;"
say "  - ~/.config/dockercode/ e .dockercode/ foram mantidos de propósito;"
say "  - este script pode ser apagado depois da migração."
