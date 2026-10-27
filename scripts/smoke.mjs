#!/usr/bin/env node
// Executa as tools reais do plugin contra um agente já acessível pela rede.
// É chamado pelo scripts/smoke.sh dentro de um container da rede dockercode.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const [service, task = "Responda apenas com a palavra: ok"] = process.argv.slice(2)
if (!service) {
  console.error("uso: node scripts/smoke.mjs <serviço> [tarefa]")
  process.exit(2)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const work = mkdtempSync(join(tmpdir(), "opencode-smoke-"))
const controller = new AbortController()

function step(message) {
  console.log(`==> ${message}`)
}

async function call(tools, name, input) {
  const tool = tools.get(name)
  if (!tool) throw new Error(`tool '${name}' não foi registrada pelo plugin`)
  return await tool.execute(input, { signal: controller.signal })
}

try {
  // O runtime do OpenCode fornece @opencode/plugin. No smoke usamos um stub
  // mínimo para carregar o plugin com o Node puro, sem depender do bundler.
  mkdirSync(join(work, "plugins"), { recursive: true })
  mkdirSync(join(work, "lib"), { recursive: true })
  writeFileSync(join(work, "package.json"), JSON.stringify({ type: "module" }))
  const stub = join(work, "node_modules/@opencode/plugin")
  mkdirSync(stub, { recursive: true })
  writeFileSync(
    join(stub, "package.json"),
    JSON.stringify({ name: "@opencode/plugin", version: "0.0.0-smoke", type: "module", exports: "./index.js" }),
  )
  writeFileSync(join(stub, "index.js"), "export const Plugin = { define: (definition) => definition }\n")

  cpSync(join(root, "config/plugins/service.ts"), join(work, "plugins/service.ts"))
  cpSync(join(root, "config/lib/service-format.ts"), join(work, "lib/service-format.ts"))

  const { default: plugin } = await import(pathToFileURL(join(work, "plugins/service.ts")).href)
  const tools = new Map()
  await plugin.setup({
    tool: {
      transform: async (register) => register({ add: (tool) => tools.set(tool.name, tool) }),
    },
  })

  step(`service_models em '${service}'`)
  const models = (await call(tools, "service_models", { service })).content
  console.log(models)
  if (!models?.trim() || /nenhum modelo disponível/i.test(models)) {
    throw new Error(`service_models não retornou modelos para '${service}'`)
  }

  step(`service em '${service}': ${task}`)
  const answer = (await call(tools, "service", { service, task })).content
  console.log(answer || "(resposta vazia)")
  if (!answer?.trim()) throw new Error(`a tarefa de '${service}' terminou sem texto final`)
  if (/pediu permissão para continuar|precisa de uma resposta|tempo esgotado aguardando/.test(answer)) {
    throw new Error(`a tarefa de '${service}' parou aguardando intervenção (permissão, formulário ou timeout)`)
  }

  step(`service_status em '${service}'`)
  const status = (await call(tools, "service_status", { service })).content
  console.log(status)
  if (!status?.trim() || /ainda está (em execução|iniciando)/.test(status)) {
    throw new Error(`service_status não confirmou a conclusão da tarefa de '${service}'`)
  }

  step(`service_efforts em '${service}'`)
  const efforts = (await call(tools, "service_efforts", { service })).content
  console.log(efforts)
  if (!/esforços de '.*'|não oferece níveis de esforço/.test(efforts)) {
    throw new Error(`service_efforts não retornou a lista de esforços de '${service}'`)
  }

  step(`service_setEffort em '${service}' (default)`)
  const effort = (await call(tools, "service_setEffort", { service, effort: "default" })).content
  console.log(effort)
  if (!/esforço de '.*' definido para o padrão/.test(effort)) {
    throw new Error(`service_setEffort não confirmou o esforço padrão de '${service}'`)
  }

  console.log("smoke ok")
} catch (err) {
  console.error(`erro no smoke: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
