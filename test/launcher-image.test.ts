import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const LIB = join(ROOT, "bin/dockercode-config.sh")
const HAS_BASH = spawnSync("bash", ["-c", "true"]).status === 0

function makeTree() {
  const home = mkdtempSync(join(tmpdir(), "dockercode-image-"))
  const project = join(home, "workspace")
  mkdirSync(project, { recursive: true })
  return {
    home,
    project,
    writeImage: (dir: string, name: string, content: string) => {
      mkdirSync(join(dir, ".dockercode"), { recursive: true })
      writeFileSync(join(dir, ".dockercode", name), content)
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

// Executa só a resolução de imagem (a lib é sourced, como nos launchers).
function resolveImage(home: string, dir: string, defaultValue: string, envValue: string, names: string[]): string {
  const script = `
set -euo pipefail
source "$LIB_PATH"
_dockercode_resolve_image "$DIR" "$DEFAULT" "$ENV_VALUE" $NAMES
`
  const result = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      HOME: home,
      LIB_PATH: LIB,
      DIR: dir,
      DEFAULT: defaultValue,
      ENV_VALUE: envValue,
      NAMES: names.join(" "),
    },
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(result.stderr || `bash saiu com ${result.status}`)
  return result.stdout.trim()
}

test("usa a imagem padrão sem env e sem arquivo", { skip: !HAS_BASH }, () => {
  const { home, project, cleanup } = makeTree()
  try {
    assert.equal(resolveImage(home, project, "oc-main", "", ["image"]), "oc-main")
  } finally {
    cleanup()
  }
})

test("OC_MAIN_IMAGE tem precedência sobre o arquivo do projeto", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(project, "image", "projeto:dev\n")
    assert.equal(resolveImage(home, project, "oc-main", "env:tag", ["image"]), "env:tag")
  } finally {
    cleanup()
  }
})

test("lê .dockercode/image de um diretório pai (serviço em subpasta)", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    const service = join(project, "servico-a")
    mkdirSync(service, { recursive: true })
    writeImage(project, "image", "meuproj/opencode:dev\n")
    assert.equal(resolveImage(home, service, "oc-main", "", ["image"]), "meuproj/opencode:dev")
  } finally {
    cleanup()
  }
})

test("agente usa agent-image e cai para image quando não existe", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(project, "image", "projeto:dev\n")
    assert.equal(resolveImage(home, project, "oc-agent", "", ["agent-image", "image"]), "projeto:dev")

    writeImage(project, "agent-image", "agente:dev\n")
    assert.equal(resolveImage(home, project, "oc-agent", "", ["agent-image", "image"]), "agente:dev")
  } finally {
    cleanup()
  }
})

test("ignora linhas vazias, comentários, CRLF e espaços em volta", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(project, "image", "# imagem do projeto\r\n\r\n   proj/dev:1  \r\noutra:2\n")
    assert.equal(resolveImage(home, project, "oc-main", "", ["image"]), "proj/dev:1")
  } finally {
    cleanup()
  }
})

test("imagem inválida aborta (não deixa virar flag do docker run)", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(project, "image", "-it\n")
    assert.throws(() => resolveImage(home, project, "oc-main", "", ["image"]), /imagem inválida/)
    assert.throws(() => resolveImage(home, project, "oc-main", "com espaço", ["image"]), /imagem inválida/)
  } finally {
    cleanup()
  }
})

test("arquivo vazio ou só com comentários aborta", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(project, "image", "# nada aqui\n\n")
    assert.throws(() => resolveImage(home, project, "oc-main", "", ["image"]), /vazio ou só tem comentários/)
  } finally {
    cleanup()
  }
})

test("não sobe além de $HOME (arquivo na home não vaza para o projeto)", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(home, "image", "global:1\n")
    assert.equal(resolveImage(home, project, "oc-main", "", ["image"]), "oc-main")
  } finally {
    cleanup()
  }
})

// --- Launchers com um docker falso, para conferir a imagem/comando passados ---

function makeFakeDocker(root: string) {
  const bin = join(root, "fakebin")
  const log = join(root, "docker-args.log")
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_ARGS_LOG"
case "$1" in
  container) [[ "\${FAKE_CONTAINER_EXISTS:-}" == "1" || -f "$DOCKER_CONTAINER_MARKER" ]] && exit 0 || exit 1 ;;
  image) exit 0 ;;
  run) touch "$DOCKER_CONTAINER_MARKER"; exit 0 ;;
  exec) exit 0 ;;
  inspect) printf 'true\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`,
  )
  chmodSync(join(bin, "docker"), 0o755)
  return { bin, log }
}

function runLauncher(
  script: string,
  cwd: string,
  home: string,
  extraEnv: Record<string, string> = {},
  args: string[] = [],
) {
  const { bin, log } = makeFakeDocker(home)
  const marker = join(home, "docker-container-exists")
  const baseEnv = { ...process.env }
  delete baseEnv.OC_PROJECT
  const result = spawnSync("bash", [join(ROOT, "bin", script), ...args], {
    cwd,
    env: {
      ...baseEnv,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      DOCKER_ARGS_LOG: log,
      DOCKER_CONTAINER_MARKER: marker,
      ...extraEnv,
    },
    encoding: "utf8",
  })
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    : []
  return { result, calls }
}

test("oc-main sobe em background com .dockercode/image e keepalive", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(project, "image", "meuproj/opencode:dev\n")
    const { result, calls } = runLauncher("oc-main", project, home)
    assert.equal(result.status, 0, result.stderr)
    const run = calls.find((line) => line.startsWith("run "))
    assert.ok(run, `nenhum docker run registrado: ${calls.join(" | ")}`)
    assert.match(run, /run -d --rm --init /)
    assert.match(run, /--name workspace /)
    assert.match(run, /OC_PROJECT=workspace/)
    assert.match(run, /meuproj\/opencode:dev sleep infinity$/)
    assert.match(result.stdout, /iniciado em background/)
    assert.match(result.stdout, /oc-run/)
  } finally {
    cleanup()
  }
})

test("oc-agent roda com .dockercode/agent-image, prefixo e comando serve explícito", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(project, "agent-image", "agente:dev\n")
    const { result, calls } = runLauncher("oc-agent", project, home, { OC_PROJECT: "proj" })
    assert.equal(result.status, 0, result.stderr)
    const run = calls.find((line) => line.startsWith("run "))
    assert.ok(run, `nenhum docker run registrado: ${calls.join(" | ")}`)
    assert.match(run, /--name proj-workspace /)
    assert.match(run, /OC_PROJECT=proj/)
    assert.match(run, /agente:dev opencode serve --hostname 0\.0\.0\.0 --port 4096$/)
  } finally {
    cleanup()
  }
})

test("oc-agent exige OC_PROJECT", { skip: !HAS_BASH }, () => {
  const { home, project, cleanup } = makeTree()
  try {
    const { result } = runLauncher("oc-agent", project, home)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /defina OC_PROJECT com o prefixo do projeto/)
  } finally {
    cleanup()
  }
})

test("oc-run executa opencode -c no container com o nome da pasta", { skip: !HAS_BASH }, () => {
  const { home, project, cleanup } = makeTree()
  try {
    const { result, calls } = runLauncher("oc-run", project, home, { FAKE_CONTAINER_EXISTS: "1" })
    assert.equal(result.status, 0, result.stderr)
    const exec = calls.find((line) => line.startsWith("exec "))
    assert.ok(exec, `nenhum docker exec registrado: ${calls.join(" | ")}`)
    assert.equal(exec, "exec -it workspace opencode -c")
    assert.equal(calls.find((line) => line.startsWith("run ")), undefined)
  } finally {
    cleanup()
  }
})

test("oc-run sobe o container com oc-main quando ele não existe", { skip: !HAS_BASH }, () => {
  const { home, project, cleanup } = makeTree()
  try {
    const { result, calls } = runLauncher("oc-run", project, home)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /container 'workspace' não encontrado; iniciando com 'oc-main'/)

    const run = calls.find((line) => line.startsWith("run "))
    assert.ok(run, `nenhum docker run registrado: ${calls.join(" | ")}`)
    assert.match(run, /--name workspace /)

    const exec = calls.find((line) => line.startsWith("exec "))
    assert.ok(exec, `nenhum docker exec registrado: ${calls.join(" | ")}`)
    assert.equal(exec, "exec -it workspace opencode -c")
  } finally {
    cleanup()
  }
})

test("oc-run com nome explícito abre o container informado de qualquer pasta", { skip: !HAS_BASH }, () => {
  const { home, cleanup } = makeTree()
  try {
    const other = join(home, "qualquer-pasta")
    mkdirSync(other, { recursive: true })
    const { result, calls } = runLauncher(
      "oc-run",
      other,
      home,
      { FAKE_CONTAINER_EXISTS: "1" },
      ["opencode-orchestration"],
    )
    assert.equal(result.status, 0, result.stderr)
    const exec = calls.find((line) => line.startsWith("exec "))
    assert.ok(exec, `nenhum docker exec registrado: ${calls.join(" | ")}`)
    assert.equal(exec, "exec -it opencode-orchestration opencode -c")
    assert.equal(calls.find((line) => line.startsWith("run ")), undefined)
  } finally {
    cleanup()
  }
})

test("oc-run com nome explícito não sobe um container inexistente", { skip: !HAS_BASH }, () => {
  const { home, cleanup } = makeTree()
  try {
    const { result, calls } = runLauncher("oc-run", home, home, {}, ["opencode-orchestration"])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /container 'opencode-orchestration' não encontrado/)
    assert.match(result.stderr, /não sobe o container/)
    assert.equal(calls.find((line) => line.startsWith("run ")), undefined)
    assert.equal(calls.find((line) => line.startsWith("exec ")), undefined)
  } finally {
    cleanup()
  }
})

test("oc-run rejeita nome de container inválido antes de chamar o docker", { skip: !HAS_BASH }, () => {
  const { home, project, cleanup } = makeTree()
  try {
    const { result, calls } = runLauncher("oc-run", project, home, {}, ["-it"])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /opção desconhecida/)
    assert.deepEqual(calls, [])
  } finally {
    cleanup()
  }
})
