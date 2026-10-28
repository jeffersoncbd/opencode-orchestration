import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/dockercode-config.sh")
const HAS_BASH = spawnSync("bash", ["-c", "true"]).status === 0

type Resolved = { dir: string; files: string[]; project: boolean }

// Executa a lib em um bash isolado e devolve o que ela resolveu.
function resolveConfig(home: string, project: string, env: Record<string, string> = {}): Resolved {
  const script = `
set -euo pipefail
source "$LIB_PATH"
printf 'dir=%s\\n' "$USER_CONFIG_DIR"
for f in \${USER_CONFIGS[@]+"\${USER_CONFIGS[@]}"}; do printf 'file=%s\\n' "$f"; done
if _dockercode_has_project_config "$PROJECT"; then echo 'project=yes'; else echo 'project=no'; fi
`
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, LIB_PATH: LIB, PROJECT: project }
  delete childEnv.DOCKERCODE_CONFIG_FILE
  delete childEnv.DOCKERCODE_CONFIG_DIR
  Object.assign(childEnv, env)

  const result = spawnSync("bash", ["-c", script], { env: childEnv, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || `bash saiu com ${result.status}`)

  let dir = ""
  const files: string[] = []
  let projectHasConfig = false
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("dir=")) dir = line.slice(4)
    else if (line.startsWith("file=")) files.push(line.slice(5))
    else if (line === "project=yes") projectHasConfig = true
  }
  return { dir, files, project: projectHasConfig }
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "dockercode-config-"))
  const project = mkdtempSync(join(tmpdir(), "dockercode-project-"))
  return {
    home,
    project,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
    },
  }
}

function writeConfig(dir: string, name = "opencode.json") {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), "{}\n")
}

test("sem configuração do usuário e sem config no projeto", { skip: !HAS_BASH }, () => {
  const { home, project, cleanup } = makeHome()
  try {
    const resolved = resolveConfig(home, project)
    assert.equal(resolved.dir, "")
    assert.deepEqual(resolved.files, [])
    assert.equal(resolved.project, false)
  } finally {
    cleanup()
  }
})

test("usa ~/.config/dockercode/opencode.json e opencode.jsonc por padrão", { skip: !HAS_BASH }, () => {
  const { home, project, cleanup } = makeHome()
  try {
    const configDir = join(home, ".config", "dockercode")
    writeConfig(configDir)
    writeConfig(configDir, "opencode.jsonc")
    const resolved = resolveConfig(home, project)
    assert.equal(resolved.dir, configDir)
    assert.deepEqual(resolved.files, [join(configDir, "opencode.json"), join(configDir, "opencode.jsonc")])
  } finally {
    cleanup()
  }
})

test("DOCKERCODE_CONFIG_FILE tem precedência e resolve o diretório", { skip: !HAS_BASH }, () => {
  const { home, project, cleanup } = makeHome()
  try {
    writeConfig(join(home, ".config", "dockercode"))
    const customDir = join(home, "custom-config")
    writeConfig(customDir)
    const resolved = resolveConfig(home, project, { DOCKERCODE_CONFIG_FILE: join(customDir, "opencode.json") })
    assert.equal(resolved.dir, customDir)
    assert.deepEqual(resolved.files, [join(customDir, "opencode.json")])
  } finally {
    cleanup()
  }
})

test("DOCKERCODE_CONFIG_FILE inválido aborta com erro", { skip: !HAS_BASH }, () => {
  const { home, project, cleanup } = makeHome()
  try {
    writeConfig(join(home, "custom-config"), "outro.json")
    assert.throws(
      () => resolveConfig(home, project, { DOCKERCODE_CONFIG_FILE: join(home, "custom-config", "outro.json") }),
      /deve apontar para um arquivo chamado opencode\.json ou opencode\.jsonc/,
    )
  } finally {
    cleanup()
  }
})

test("DOCKERCODE_CONFIG_DIR vazio aborta com erro", { skip: !HAS_BASH }, () => {
  const { home, project, cleanup } = makeHome()
  try {
    const empty = join(home, "empty")
    mkdirSync(empty, { recursive: true })
    assert.throws(() => resolveConfig(home, project, { DOCKERCODE_CONFIG_DIR: empty }), /nenhum opencode\.json/)
  } finally {
    cleanup()
  }
})

test("detecta opencode.json e .opencode/opencode.json no projeto", { skip: !HAS_BASH }, () => {
  const { home, project, cleanup } = makeHome()
  try {
    writeConfig(project)
    assert.equal(resolveConfig(home, project).project, true)

    rmSync(join(project, "opencode.json"))
    writeConfig(join(project, ".opencode"))
    assert.equal(resolveConfig(home, project).project, true)
  } finally {
    cleanup()
  }
})
