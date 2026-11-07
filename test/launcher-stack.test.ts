import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const HAS_BASH = spawnSync("bash", ["-c", "true"]).status === 0

const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
state="$FAKE_STATE"
mkdir -p "$state"
printf '%s\\n' "$*" >> "$FAKE_LOG"
cmd="$1"
shift || true
case "$cmd" in
  container)
    if [[ "\${1:-}" == "inspect" && -f "$state/\${2:-}" ]]; then exit 0; else exit 1; fi
    ;;
  image | network) exit 0 ;;
  run)
    name=""
    args=("$@")
    for ((i = 0; i < \${#args[@]}; i++)); do
      if [[ "\${args[$i]}" == "--name" ]]; then name="\${args[$((i + 1))]}"; fi
    done
    [[ -n "$name" ]] || exit 1
    touch "$state/$name"
    if [[ -n "\${FAKE_FAIL_RUN:-}" && "$name" == "$FAKE_FAIL_RUN" ]]; then exit 1; fi
    ;;
  inspect)
    name="\${@: -1}"
    if [[ -f "$state/$name" ]]; then echo true; else echo false; fi
    ;;
  exec | logs) exit 0 ;;
  stop | rm)
    name="\${@: -1}"
    rm -f "$state/$name"
    ;;
  *) exit 0 ;;
esac
`

type Project = {
  root: string
  project: string
  home: string
  fakebin: string
  state: string
  log: string
  hooks: string
  writeStack: (content: string, dir?: string) => void
  run: (script: string, args?: string[], env?: Record<string, string>) => { status: number | null; stdout: string; stderr: string; calls: string[] }
  cleanup: () => void
}

function makeProject(): Project {
  const root = mkdtempSync(join(tmpdir(), "oc-stack-"))
  const home = join(root, "home")
  const project = join(root, "projeto")
  const fakebin = join(root, "fakebin")
  const state = join(root, "state")
  const log = join(root, "docker.log")
  const hooks = join(project, "hooks.log")
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(fakebin, { recursive: true })
  const docker = join(fakebin, "docker")
  writeFileSync(docker, FAKE_DOCKER)
  chmodSync(docker, 0o755)

  const writeStack = (content: string, dir = project) => {
    writeFileSync(join(dir, ".oc-services"), content)
  }

  const run = (script: string, args: string[] = [], extraEnv: Record<string, string> = {}) => {
    const baseEnv = { ...process.env }
    delete baseEnv.OC_PROJECT
    delete baseEnv.OC_STACK_FILE
    const result = spawnSync("bash", [join(ROOT, "bin", script), ...args], {
      cwd: project,
      env: {
        ...baseEnv,
        HOME: home,
        PATH: `${fakebin}:${process.env.PATH}`,
        FAKE_STATE: state,
        FAKE_LOG: log,
        ...extraEnv,
      },
      encoding: "utf8",
    })
    const calls = existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
      : []
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls }
  }

  return {
    root,
    project,
    home,
    fakebin,
    state,
    log,
    hooks,
    writeStack,
    run,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function mkService(project: string, ...names: string[]) {
  for (const name of names) mkdirSync(join(project, name), { recursive: true })
}

function readHooks(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : []
}

const SIMPLE_STACK = `# stack de teste
project = proj
network = net
before-up = echo before >> "$OC_ROOT/hooks.log"
after-up = echo after >> "$OC_ROOT/hooks.log"
before-down = echo before-down >> "$OC_ROOT/hooks.log"
after-down = echo after-down >> "$OC_ROOT/hooks.log"

svc-a -v volume:/volume
svc-b -p 3001:3001
`

test("oc-up --print interpreta diretivas, ordem, variáveis e --network automático", { skip: !HAS_BASH }, () => {
  const p = makeProject()
  try {
    p.writeStack(`svc-a -v "\${VOLUME:-volume:/volume}" --label a=b
project = proj
svc-b -p "\${PORT:-3001}:3001"
network = net
`)
    const { status, stdout, stderr } = p.run("oc-up", ["--print"], { VOLUME: "custom:/volume", PORT: "4001" })
    assert.equal(status, 0, stderr)
    assert.match(stdout, /^root=.*\/projeto$/m)
    assert.match(stdout, /^project=proj$/m)
    assert.match(stdout, /^network=net$/m)
    assert.match(stdout, /^service=svc-a dir=svc-a opts=-v custom:\/volume --label a=b --network net/m)
    assert.match(stdout, /^service=svc-b dir=svc-b opts=-p 4001:3001 --network net/m)
  } finally {
    p.cleanup()
  }
})

test("project do arquivo tem precedência; OC_PROJECT só é usado quando ele falta", { skip: !HAS_BASH }, () => {
  const p = makeProject()
  try {
    p.writeStack("project = do-arquivo\nnetwork = net\nsvc-a\n")
    const fromFile = p.run("oc-up", ["--print"], { OC_PROJECT: "do-ambiente" })
    assert.equal(fromFile.status, 0, fromFile.stderr)
    assert.match(fromFile.stdout, /^project=do-arquivo$/m)

    p.writeStack("network = net\nsvc-a\n")
    const fromEnv = p.run("oc-up", ["--print"], { OC_PROJECT: "do-ambiente" })
    assert.equal(fromEnv.status, 0, fromEnv.stderr)
    assert.match(fromEnv.stdout, /^project=do-ambiente$/m)
  } finally {
    p.cleanup()
  }
})

test("oc-up sem .oc-services aborta com instrução", { skip: !HAS_BASH }, () => {
  const p = makeProject()
  try {
    const { status, stderr } = p.run("oc-up", ["--no-tui"])
    assert.notEqual(status, 0)
    assert.match(stderr, /arquivo \.oc-services não encontrado/)
  } finally {
    p.cleanup()
  }
})

test("erros de sintaxe abortam antes de subir qualquer container", { skip: !HAS_BASH }, () => {
  const p = makeProject()
  try {
    mkService(p.project, "svc-a")
    const cases: Array<[string, RegExp]> = [
      ["netwrok = x\nsvc-a\n", /diretiva desconhecida 'netwrok'/],
      ["project = proj\nsvc-a\nsvc-a\n", /serviço duplicado 'svc-a'/],
      ["project = proj\n../fora\n", /não pode conter '\.\.'/],
      ["project = proj\nsvc-a --name outro\n", /não defina --name/],
      ["# nada\n", /nenhum serviço definido/],
    ]
    for (const [content, pattern] of cases) {
      p.writeStack(content)
      const { status, stderr, calls } = p.run("oc-up", ["--no-tui"])
      assert.notEqual(status, 0, content)
      assert.match(stderr, pattern)
      assert.deepEqual(calls.filter((line) => line.startsWith("run ")), [])
    }
  } finally {
    p.cleanup()
  }
})

test("oc-up sobe principal e agentes com project, rede e hooks", { skip: !HAS_BASH }, () => {
  const p = makeProject()
  try {
    mkService(p.project, "svc-a", "svc-b")
    p.writeStack(SIMPLE_STACK)
    const { status, stdout, stderr, calls } = p.run("oc-up", ["--no-tui"])
    assert.equal(status, 0, stderr)
    assert.deepEqual(readHooks(p.hooks), ["before", "after"])
    assert.match(stdout, /stack 'proj' no ar/)
    assert.match(stdout, /principal: projeto/)
    assert.match(stdout, /agentes:\s+2/)

    const main = calls.find((line) => line.startsWith("run ") && line.includes("--name projeto "))
    assert.ok(main, `docker run do principal não encontrado: ${calls.join(" | ")}`)
    assert.match(main!, /-e OC_PROJECT=proj /)
    assert.match(main!, /--network net oc-main sleep infinity$/)

    const a = calls.find((line) => line.startsWith("run ") && line.includes("--name proj-svc-a "))
    const b = calls.find((line) => line.startsWith("run ") && line.includes("--name proj-svc-b "))
    assert.ok(a && b, `docker run dos agentes não encontrado: ${calls.join(" | ")}`)
    assert.match(a!, /-e OC_PROJECT=proj /)
    assert.match(a!, /-v volume:\/volume --network net oc-agent opencode serve/)
    assert.match(b!, /-p 3001:3001 --network net oc-agent opencode serve/)

    assert.equal(calls.find((line) => line.startsWith("exec -it ")), undefined)
  } finally {
    p.cleanup()
  }
})

test("oc-up sem --no-tui abre a TUI com oc-run no principal", { skip: !HAS_BASH }, () => {
  const p = makeProject()
  try {
    mkService(p.project, "svc-a")
    p.writeStack("project = proj\nnetwork = net\nsvc-a\n")
    const { status, stderr, calls } = p.run("oc-up")
    assert.equal(status, 0, stderr)
    assert.ok(calls.includes("exec -it projeto opencode -c"), calls.join(" | "))
  } finally {
    p.cleanup()
  }
})

test("oc-up reutiliza container já em execução e não o recria", { skip: !HAS_BASH }, () => {
  const p = makeProject()
  try {
    mkService(p.project, "svc-a", "svc-b")
    p.writeStack(SIMPLE_STACK)
    mkdirSync(p.state, { recursive: true })
    writeFileSync(join(p.state, "proj-svc-a"), "")

    const { status, stderr, calls } = p.run("oc-up", ["--no-tui"])
    assert.equal(status, 0, stderr)
    assert.match(stderr, /agente 'proj-svc-a' já está em execução/)
    assert.equal(calls.filter((line) => line.startsWith("run ") && line.includes("--name proj-svc-a ")).length, 0)
    assert.equal(calls.filter((line) => line.startsWith("run ") && line.includes("--name proj-svc-b ")).length, 1)
  } finally {
    p.cleanup()
  }
})

test("falha ao subir um agente para os containers iniciados e não roda after-up", { skip: !HAS_BASH }, () => {
  const p = makeProject()
  try {
    mkService(p.project, "svc-a", "svc-b")
    p.writeStack(SIMPLE_STACK)
    const { status, stderr, calls } = p.run("oc-up", ["--no-tui"], { FAKE_FAIL_RUN: "proj-svc-b" })
    assert.notEqual(status, 0)
    assert.match(stderr, /falha ao subir o stack; parando containers iniciados/)
    assert.ok(calls.includes("stop -t 2 proj-svc-a"), calls.join(" | "))
    assert.ok(calls.includes("stop -t 2 proj-svc-b"), calls.join(" | "))
    assert.ok(calls.includes("stop -t 2 projeto"), calls.join(" | "))
    assert.deepEqual(readHooks(p.hooks), ["before"])
  } finally {
    p.cleanup()
  }
})

test("oc-down para agentes em ordem inversa, o principal e roda hooks", { skip: !HAS_BASH }, () => {
  const p = makeProject()
  try {
    mkService(p.project, "svc-a", "svc-b")
    p.writeStack(SIMPLE_STACK)
    mkdirSync(p.state, { recursive: true })
    for (const name of ["projeto", "proj-svc-a", "proj-svc-b"]) writeFileSync(join(p.state, name), "")

    const { status, stdout, stderr, calls } = p.run("oc-down")
    assert.equal(status, 0, stderr)
    assert.match(stdout, /stack 'proj' parado/)
    assert.deepEqual(readHooks(p.hooks), ["before-down", "after-down"])

    const stops = calls.filter((line) => line.startsWith("stop -t 10 "))
    assert.deepEqual(stops, ["stop -t 10 proj-svc-b", "stop -t 10 proj-svc-a", "stop -t 10 projeto"])
    assert.deepEqual(readdirState(p.state), [])
  } finally {
    p.cleanup()
  }
})

test("oc-down --keep-main não para o container principal", { skip: !HAS_BASH }, () => {
  const p = makeProject()
  try {
    mkService(p.project, "svc-a")
    p.writeStack("project = proj\nnetwork = net\nsvc-a\n")
    mkdirSync(p.state, { recursive: true })
    for (const name of ["projeto", "proj-svc-a"]) writeFileSync(join(p.state, name), "")

    const { status, calls } = p.run("oc-down", ["--keep-main"])
    assert.equal(status, 0)
    assert.ok(calls.includes("stop -t 10 proj-svc-a"))
    assert.ok(!calls.includes("stop -t 10 projeto"))
    assert.deepEqual(readdirState(p.state), ["projeto"])
  } finally {
    p.cleanup()
  }
})

function readdirState(state: string): string[] {
  return existsSync(state) ? readdirSync(state).sort() : []
}
