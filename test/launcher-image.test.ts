import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
    assert.equal(resolveImage(home, project, "opencode-run", "", ["image"]), "opencode-run")
  } finally {
    cleanup()
  }
})

test("DOCKERCODE_IMAGE tem precedência sobre o arquivo do projeto", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(project, "image", "projeto:dev\n")
    assert.equal(resolveImage(home, project, "opencode-run", "env:tag", ["image"]), "env:tag")
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
    assert.equal(resolveImage(home, service, "opencode-run", "", ["image"]), "meuproj/opencode:dev")
  } finally {
    cleanup()
  }
})

test("agente usa agent-image e cai para image quando não existe", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(project, "image", "projeto:dev\n")
    assert.equal(resolveImage(home, project, "opencode-agent", "", ["agent-image", "image"]), "projeto:dev")

    writeImage(project, "agent-image", "agente:dev\n")
    assert.equal(resolveImage(home, project, "opencode-agent", "", ["agent-image", "image"]), "agente:dev")
  } finally {
    cleanup()
  }
})

test("ignora linhas vazias, comentários, CRLF e espaços em volta", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(project, "image", "# imagem do projeto\r\n\r\n   proj/dev:1  \r\noutra:2\n")
    assert.equal(resolveImage(home, project, "opencode-run", "", ["image"]), "proj/dev:1")
  } finally {
    cleanup()
  }
})

test("imagem inválida aborta (não deixa virar flag do docker run)", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(project, "image", "-it\n")
    assert.throws(() => resolveImage(home, project, "opencode-run", "", ["image"]), /imagem inválida/)
    assert.throws(() => resolveImage(home, project, "opencode-run", "com espaço", ["image"]), /imagem inválida/)
  } finally {
    cleanup()
  }
})

test("arquivo vazio ou só com comentários aborta", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(project, "image", "# nada aqui\n\n")
    assert.throws(() => resolveImage(home, project, "opencode-run", "", ["image"]), /vazio ou só tem comentários/)
  } finally {
    cleanup()
  }
})

test("não sobe além de $HOME (arquivo na home não vaza para o projeto)", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(home, "image", "global:1\n")
    assert.equal(resolveImage(home, project, "opencode-run", "", ["image"]), "opencode-run")
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
  container) exit 1 ;;
  image) exit 0 ;;
  exec) exit 0 ;;
  inspect) printf 'true\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`,
  )
  chmodSync(join(bin, "docker"), 0o755)
  return { bin, log }
}

function runLauncher(script: string, cwd: string, home: string) {
  const { bin, log } = makeFakeDocker(home)
  const result = spawnSync("bash", [join(ROOT, "bin", script)], {
    cwd,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, DOCKER_ARGS_LOG: log },
    encoding: "utf8",
  })
  const calls = readFileSync(log, "utf8").trim().split("\n")
  return { result, calls }
}

test("dockercode roda com .dockercode/image e o comando opencode", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(project, "image", "meuproj/opencode:dev\n")
    const { result, calls } = runLauncher("dockercode", project, home)
    assert.equal(result.status, 0, result.stderr)
    const run = calls.find((line) => line.startsWith("run "))
    assert.ok(run, `nenhum docker run registrado: ${calls.join(" | ")}`)
    assert.match(run, /meuproj\/opencode:dev opencode$/)
  } finally {
    cleanup()
  }
})

test("dockeragent roda com .dockercode/agent-image e o comando serve explícito", { skip: !HAS_BASH }, () => {
  const { home, project, writeImage, cleanup } = makeTree()
  try {
    writeImage(project, "agent-image", "agente:dev\n")
    const { result, calls } = runLauncher("dockeragent", project, home)
    assert.equal(result.status, 0, result.stderr)
    const run = calls.find((line) => line.startsWith("run "))
    assert.ok(run, `nenhum docker run registrado: ${calls.join(" | ")}`)
    assert.match(run, /agente:dev opencode serve --hostname 0\.0\.0\.0 --port 4096$/)
  } finally {
    cleanup()
  }
})
