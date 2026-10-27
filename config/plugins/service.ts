import { Plugin } from "@opencode/plugin"
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import {
  formatEffortList,
  formatFormRequest,
  formatModelEfforts,
  formatOutcome,
  formatPermissionRequest,
  resolveEffort,
  type FormRequest,
  type Outcome,
  type PermissionRequest,
} from "../lib/service-format.ts"

// Porta fixa: o agente é o único servidor; o principal apenas consome.
const PORT = "4096"
const PASSWORD = process.env.OPENCODE_AGENT_PASSWORD ?? ""
const STATE_DIR = "/tmp/opencode-agent"
const STATE_FILE = STATE_DIR + "/sessions.json"

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const POLL_INTERVAL_MS = positiveNumber(process.env.OPENCODE_AGENT_POLL_INTERVAL_MS, 500)
const MAX_WAIT_MS = positiveNumber(process.env.OPENCODE_AGENT_MAX_WAIT_MS, 15 * 60 * 1000)
const REQUEST_TIMEOUT_MS = positiveNumber(process.env.OPENCODE_AGENT_REQUEST_TIMEOUT_MS, 30 * 1000)

const SERVICE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const MESSAGE_PAGE_SIZE = 50
// Limite de segurança para não varrer uma sessão inteira em caso de cursor inesperado.
const MAX_MESSAGE_PAGES = 20

function validateServiceName(value: unknown): string {
  if (typeof value !== "string" || !SERVICE_NAME_PATTERN.test(value)) {
    throw new Error(
      `nome de serviço inválido: ${JSON.stringify(value)}. Use letras, números, '_', '.' e '-', ` +
        `começando por letra ou número (ex.: servico-a).`,
    )
  }
  return value
}

function validateTask(value: unknown, service: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`campo 'task' do serviço '${service}' não pode ser vazio`)
  }
  return value
}

const DECISION_MAP: Record<string, "once" | "always" | "reject"> = {
  allow: "once",
  allow_always: "always",
  deny: "reject",
}

type ModelRef = { providerID: string; modelID: string; variant?: string }
type ModelInfo = ModelRef & { name?: string; variants: string[] }
type ServiceState = { id?: string; model?: ModelRef; startedAt?: number }
type State = Record<string, ServiceState | string>

// Tarefas em andamento neste processo (o estado é em memória, como o próprio plugin).
// Só é permitida uma tarefa por serviço; as demais devem usar service_status.
// O token identifica a tarefa para não limpar o estado de uma tarefa mais nova.
type PendingTask = { startedAt: number; token: symbol }
const pendingTasks = new Map<string, PendingTask>()

function clearPendingTask(service: string, token: symbol) {
  if (pendingTasks.get(service)?.token === token) pendingTasks.delete(service)
}

type ApiInit = {
  method?: string
  body?: string
  signal?: AbortSignal
}

class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "HttpError"
    this.status = status
  }
}

function loadState(): State {
  try {
    const parsed: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as State
    return {}
  } catch {
    return {}
  }
}

function saveState(state: State) {
  mkdirSync(STATE_DIR, { recursive: true })
  const temp = `${STATE_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    // Escreve em um arquivo temporário no mesmo diretório e renomeia de forma atômica.
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(temp, STATE_FILE)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      // o temporário pode nem ter sido criado
    }
    throw err
  }
}

// Serializa leitura, mutação e gravação do estado entre chamadas concorrentes.
let stateQueue: Promise<unknown> = Promise.resolve()

function updateState<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
  const run = stateQueue.then(async () => {
    const state = loadState()
    const result = await fn(state)
    saveState(state)
    return result
  })
  stateQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function getServiceState(state: State, service: string): ServiceState {
  const raw = state[service]
  if (!raw) return {}
  if (typeof raw === "string") return { id: raw }
  return raw
}

// Garante que toda mensagem de erro de uma tool identifique o serviço e, quando
// a sessão já existe, o sessionID. Evita prefixar mensagens que já têm os dois.
function contextualizeError(err: unknown, service: string, id?: string): Error {
  const message = err instanceof Error ? err.message : String(err)
  const hasService = message.includes(`'${service}'`) || message.includes(`"${service}"`)
  const hasSession = !id || message.includes(id)
  if (hasService && hasSession) return err instanceof Error ? err : new Error(message)

  const context: string[] = []
  if (!hasService) context.push(`serviço '${service}'`)
  if (!hasSession && id) context.push(`sessão ${id}`)
  const wrapped = new Error(context.length ? `[${context.join(", ")}] ${message}` : message, { cause: err })
  if (err instanceof Error) wrapped.name = err.name
  return wrapped
}

async function withServiceContext<T>(service: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw contextualizeError(err, service, getServiceState(loadState(), service).id)
  }
}

function abortReason(signal: AbortSignal): Error {
  const err = new Error("operação cancelada")
  err.name = "AbortError"
  err.cause = signal.reason
  return err
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })

function normalizeRequestError(err: unknown, service: string, path: string, signal?: AbortSignal): Error {
  if (signal?.aborted) {
    return new Error(`operação cancelada ao falar com '${service}' (${path}).`)
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError") {
      return new Error(
        `requisição para '${service}' (${path}) excedeu o tempo limite de ${REQUEST_TIMEOUT_MS}ms ` +
          `(ajustável via OPENCODE_AGENT_REQUEST_TIMEOUT_MS).`,
      )
    }
    if (err.name === "AbortError") {
      return new Error(`requisição para '${service}' (${path}) foi cancelada.`)
    }
    return err
  }
  return new Error(String(err))
}

async function api(service: string, path: string, init?: ApiInit) {
  const headers: Record<string, string> = {
    authorization: "Basic " + Buffer.from("opencode:" + PASSWORD).toString("base64"),
  }
  if (init?.body !== undefined) headers["content-type"] = "application/json"

  // O timeout vale para a requisição inteira, inclusive para a leitura do corpo.
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout

  let res: Response
  try {
    res = await fetch(`http://${service}:${PORT}${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body,
      signal,
    })
  } catch (err) {
    throw normalizeRequestError(err, service, path, init?.signal)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new HttpError(res.status, `requisição em '${service}' falhou (${path}): ${res.status} ${text}`)
  }
  return res
}

async function readJson<T>(res: Response, service: string, path: string, signal?: AbortSignal): Promise<T> {
  try {
    return (await res.json()) as T
  } catch (err) {
    throw normalizeRequestError(err, service, path, signal)
  }
}

type RawModel = {
  providerID: string
  id: string
  name?: string
  variants?: Array<{ id: string }>
}

function toModelInfo(model: RawModel): ModelInfo {
  return {
    providerID: model.providerID,
    modelID: model.id,
    name: model.name,
    variants: (model.variants ?? []).map((variant) => variant.id),
  }
}

function modelBody(model: ModelRef) {
  return {
    id: model.modelID,
    providerID: model.providerID,
    ...(model.variant ? { variant: model.variant } : {}),
  }
}

async function getModels(service: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const res = await api(service, "/api/model", { signal })
  const json = await readJson<{ data?: RawModel[] }>(res, service, "/api/model", signal)
  return (json.data ?? []).map(toModelInfo)
}

async function getDefaultModel(service: string, signal?: AbortSignal): Promise<ModelInfo | undefined> {
  const res = await api(service, "/api/model/default", { signal })
  const json = await readJson<{ data?: RawModel | null }>(res, service, "/api/model/default", signal)
  return json.data ? toModelInfo(json.data) : undefined
}

async function getDefaultModelID(service: string, signal?: AbortSignal): Promise<string | undefined> {
  return (await getDefaultModel(service, signal))?.modelID
}

async function getSessionModel(service: string, id: string, signal?: AbortSignal): Promise<ModelRef | undefined> {
  const res = await api(service, `/api/session/${id}`, { signal })
  const json = await readJson<{
    data?: { model?: { id: string; providerID: string; variant?: string } }
  }>(res, service, `/api/session/${id}`, signal)
  const model = json.data?.model
  if (!model) return undefined
  const variant = model.variant && model.variant !== "default" ? model.variant : undefined
  return { providerID: model.providerID, modelID: model.id, ...(variant ? { variant } : {}) }
}

async function createSession(service: string, model?: ModelRef, signal?: AbortSignal): Promise<string> {
  const res = await api(service, "/api/session", {
    method: "POST",
    body: JSON.stringify(model ? { model: modelBody(model) } : {}),
    signal,
  })
  const json = await readJson<{ data: { id: string } }>(res, service, "/api/session", signal)
  return json.data.id
}

async function deleteSession(service: string, id: string, signal?: AbortSignal) {
  await api(service, `/api/session/${id}`, { method: "DELETE", signal })
}

async function setSessionModel(service: string, id: string, model: ModelRef, signal?: AbortSignal) {
  await api(service, `/api/session/${id}/model`, {
    method: "POST",
    body: JSON.stringify({ model: modelBody(model) }),
    signal,
  })
}

async function listPermissions(service: string, id: string, signal?: AbortSignal): Promise<PermissionRequest[]> {
  const res = await api(service, `/api/session/${id}/permission`, { signal })
  const json = await readJson<{ data?: PermissionRequest[] }>(res, service, "/permission", signal)
  return json.data ?? []
}

async function listForms(service: string, id: string, signal?: AbortSignal): Promise<FormRequest[]> {
  const res = await api(service, `/api/session/${id}/form`, { signal })
  const json = await readJson<{ data?: FormRequest[] }>(res, service, "/form", signal)
  return json.data ?? []
}

async function readIdleOutcome(
  service: string,
  id: string,
  startedAt: number,
  signal?: AbortSignal,
): Promise<{ outcome: string; error?: string } | undefined> {
  const path = `/api/session/${id}/message?type=idle&order=desc&limit=10`
  const res = await api(service, path, { signal })
  const json = await readJson<{
    data?: Array<{ time?: { created?: number }; outcome?: string; error?: { message?: string } }>
  }>(res, service, path, signal)
  const idle = (json.data ?? []).find((m) => (m.time?.created ?? 0) >= startedAt)
  if (!idle) return undefined
  return { outcome: idle.outcome ?? "succeeded", error: idle.error?.message }
}

async function readAssistantText(
  service: string,
  id: string,
  startedAt: number,
  signal?: AbortSignal,
): Promise<string> {
  type AssistantMessage = {
    content?: Array<{ type?: string; text?: string }>
    time?: { created?: number }
  }

  const messages: AssistantMessage[] = []
  let cursor: string | undefined

  for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
    const params = new URLSearchParams({ type: "assistant", limit: String(MESSAGE_PAGE_SIZE) })
    // A API não aceita 'order' junto com 'cursor'; a ordem é preservada nas páginas seguintes.
    if (cursor) params.set("cursor", cursor)
    else params.set("order", "desc")

    const path = `/api/session/${id}/message?${params.toString()}`
    const res = await api(service, path, { signal })
    const json = await readJson<{
      data?: AssistantMessage[]
      cursor?: { next?: string | null }
    }>(res, service, path, signal)

    const data = json.data ?? []
    let reachedStart = false
    for (const message of data) {
      const created = message.time?.created ?? 0
      if (created < startedAt) {
        reachedStart = true
        continue
      }
      messages.push(message)
    }

    const next = json.cursor?.next
    // Em ordem decrescente, ao encontrar uma mensagem anterior ao startedAt as páginas
    // seguintes só terão mensagens mais antigas.
    if (!next || data.length === 0 || reachedStart) break
    cursor = next
  }

  if (messages.length === 0) return ""

  // ordem cronológica (mais antiga primeiro)
  messages.reverse()

  const textParts: string[] = []
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type === "text" && part.text) textParts.push(part.text)
    }
  }

  return textParts.join("\n")
}

async function replyPermission(
  service: string,
  id: string,
  requestID: string,
  decision: "once" | "always" | "reject",
  message?: string,
  signal?: AbortSignal,
) {
  await api(service, `/api/session/${id}/permission/${requestID}/reply`, {
    method: "POST",
    body: JSON.stringify(message !== undefined && message !== "" ? { decision, message } : { decision }),
    signal,
  })
}

async function replyForm(
  service: string,
  id: string,
  formID: string,
  answer: Record<string, unknown>,
  signal?: AbortSignal,
) {
  await api(service, `/api/session/${id}/form/${formID}/reply`, {
    method: "POST",
    body: JSON.stringify({ answer }),
    signal,
  })
}

async function cancelForm(service: string, id: string, formID: string, signal?: AbortSignal) {
  await api(service, `/api/session/${id}/form/${formID}`, { method: "DELETE", signal })
}

async function waitForOutcome(service: string, id: string, startedAt: number, signal?: AbortSignal): Promise<Outcome> {
  const deadline = startedAt + MAX_WAIT_MS
  while (true) {
    if (signal?.aborted) throw abortReason(signal)

    const permissions = await listPermissions(service, id, signal)
    if (permissions.length) return { kind: "permission", permissions }

    const forms = await listForms(service, id, signal)
    if (forms.length) return { kind: "form", forms }

    const idle = await readIdleOutcome(service, id, startedAt, signal)
    if (idle) {
      return {
        kind: "done",
        text: await readAssistantText(service, id, startedAt, signal),
        outcome: idle.outcome,
        error: idle.error,
      }
    }

    if (Date.now() > deadline) return { kind: "timeout" }
    await sleep(POLL_INTERVAL_MS, signal)
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}min` : `${hours}h`
}

// A tarefa deixa de estar pendente somente quando o agente chega a um estado final.
function formatOutcomeAndTrack(service: string, id: string, outcome: Outcome, token?: symbol): string {
  if (outcome.kind === "done" && token) clearPendingTask(service, token)
  return formatOutcome(service, id, outcome)
}

async function ensureSession(service: string, signal?: AbortSignal): Promise<{ id: string; model?: ModelRef }> {
  return updateState(async (state) => {
    const svc = getServiceState(state, service)
    if (svc.id) {
      if (svc.model) await setSessionModel(service, svc.id, svc.model, signal)
      return { id: svc.id, model: svc.model }
    }

    const id = await createSession(service, svc.model, signal)
    state[service] = { ...svc, id }
    return { id, model: svc.model }
  })
}

async function delegate(service: string, task: string, signal?: AbortSignal): Promise<string> {
  if (pendingTasks.has(service)) {
    throw new Error(
      `o serviço '${service}' já tem uma tarefa em andamento. ` +
        `Use a tool 'service_status' para acompanhar o andamento — não reenvie a tarefa. ` +
        `Para cancelar a execução, use 'service_interrupt'.`,
    )
  }

  // Registra antes do primeiro await para que duas chamadas concorrentes não passem juntas.
  const pending: PendingTask = { startedAt: Date.now(), token: Symbol(service) }
  pendingTasks.set(service, pending)
  let promptSent = false

  try {
    const { id } = await ensureSession(service, signal)
    const startedAt = Date.now()

    await updateState((state) => {
      const svc = getServiceState(state, service)
      if (svc.id === id) {
        svc.startedAt = startedAt
        state[service] = svc
      }
    })

    await api(service, `/api/session/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: task }),
      signal,
    })
    promptSent = true

    return formatOutcomeAndTrack(service, id, await waitForOutcome(service, id, startedAt, signal), pending.token)
  } catch (err) {
    // Se o prompt nem chegou a ser aceito, não existe tarefa remota para acompanhar.
    if (!promptSent) clearPendingTask(service, pending.token)
    throw err
  }
}

async function respondPermission(
  service: string,
  requestID: string,
  decisionLabel: string,
  message?: string,
  signal?: AbortSignal,
): Promise<string> {
  const decision = DECISION_MAP[decisionLabel]
  if (!decision) throw new Error(`decision inválida: '${decisionLabel}' (use allow, allow_always ou deny)`)

  const svc = getServiceState(loadState(), service)
  if (!svc.id) throw new Error(`sem sessão ativa para '${service}'. Rode a tool 'service' primeiro.`)

  const token = pendingTasks.get(service)?.token
  const startedAt = Date.now()
  if (requestID === "*") {
    const permissions = await listPermissions(service, svc.id, signal)
    if (!permissions.length) throw new Error(`nenhum pedido de permissão pendente para '${service}'.`)
    for (const p of permissions) await replyPermission(service, svc.id, p.id, decision, message, signal)
  } else {
    await replyPermission(service, svc.id, requestID, decision, message, signal)
  }

  return formatOutcomeAndTrack(service, svc.id, await waitForOutcome(service, svc.id, startedAt, signal), token)
}

async function respondForm(
  service: string,
  formID: string,
  answer: Record<string, unknown> | undefined,
  cancel: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const svc = getServiceState(loadState(), service)
  if (!svc.id) throw new Error(`sem sessão ativa para '${service}'. Rode a tool 'service' primeiro.`)

  const token = pendingTasks.get(service)?.token
  if (!cancel && (answer === undefined || Object.keys(answer).length === 0)) {
    throw new Error(
      `'answer' é obrigatório para responder o formulário (a menos que use cancel: true). ` +
        `Informe um objeto no formato { "<campo>": "<resposta>" }, usando o 'value' da opção para campos de escolha.`,
    )
  }
  if (formID === "*" && !cancel) {
    throw new Error(
      `formID '*' só pode ser usado com cancel: true (para cancelar todos os formulários pendentes). ` +
        `Para responder, informe o id de um formulário específico retornado pela tool 'service' ou 'service_status'.`,
    )
  }

  const startedAt = Date.now()
  if (formID === "*") {
    const forms = await listForms(service, svc.id, signal)
    if (!forms.length) throw new Error(`nenhum formulário pendente para '${service}'.`)
    for (const f of forms) await cancelForm(service, svc.id, f.id, signal)
  } else if (cancel) {
    await cancelForm(service, svc.id, formID, signal)
  } else {
    await replyForm(service, svc.id, formID, answer ?? {}, signal)
  }

  return formatOutcomeAndTrack(service, svc.id, await waitForOutcome(service, svc.id, startedAt, signal), token)
}

async function status(service: string, signal?: AbortSignal): Promise<string> {
  const svc = getServiceState(loadState(), service)
  if (!svc.id) {
    if (pendingTasks.has(service)) {
      return (
        `o agente '${service}' ainda está iniciando a tarefa (sessão ainda não criada). ` +
        `Aguarde e chame 'service_status' novamente.`
      )
    }
    return `nenhuma sessão ativa para '${service}'. Rode a tool 'service' para iniciar uma tarefa.`
  }

  const id = svc.id
  const permissions = await listPermissions(service, id, signal)
  if (permissions.length) return formatPermissionRequest(service, permissions)

  const forms = await listForms(service, id, signal)
  if (forms.length) return formatFormRequest(service, forms)

  // Se uma nova tarefa já foi registrada em memória, não confunda o idle anterior com o resultado dela.
  const pending = pendingTasks.get(service)
  const startedAt = Math.max(svc.startedAt ?? 0, pending?.startedAt ?? 0)
  const idle = await readIdleOutcome(service, id, startedAt, signal)
  if (idle) {
    const current = pendingTasks.get(service)
    if (current && current.token !== pending?.token) {
      return (
        `o agente '${service}' ainda está em execução (sessão ${id}, iniciada há ${formatDuration(Date.now() - current.startedAt)}). ` +
        `Aguarde e chame 'service_status' novamente, ou use 'service_interrupt' para cancelar.`
      )
    }
    if (pending) pendingTasks.delete(service)
    const text = await readAssistantText(service, id, startedAt, signal)
    const result = formatOutcome(service, id, { kind: "done", text, outcome: idle.outcome, error: idle.error })
    return result || `a tarefa de '${service}' terminou (${idle.outcome ?? "succeeded"}) sem texto final.`
  }

  if (startedAt) {
    return (
      `o agente '${service}' ainda está em execução (sessão ${id}, iniciada há ${formatDuration(Date.now() - startedAt)}). ` +
      `Aguarde e chame 'service_status' novamente, ou use 'service_interrupt' para cancelar.`
    )
  }

  return `nenhuma tarefa em execução para '${service}' (sessão ${id} sem execução registrada).`
}

async function resetService(service: string, force: boolean, signal?: AbortSignal): Promise<string> {
  const current = getServiceState(loadState(), service)
  if (!current.id) {
    if (pendingTasks.has(service)) {
      return (
        `o agente '${service}' ainda está iniciando uma tarefa (sessão ainda não criada); ` +
        `aguarde e tente 'service_reset' novamente.`
      )
    }
    return `não havia sessão ativa para '${service}'; nada a limpar.`
  }

  const id = current.id
  if (!force) {
    try {
      await deleteSession(service, id, signal)
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(
          `não foi possível remover a sessão ${id} de '${service}': ${reason}. ` +
            `Se o agente estiver inacessível, chame 'service_reset' novamente com force: true para limpar apenas o estado local.`,
        )
      }
      // 404: a sessão já não existe no agente; o estado local pode ser limpo.
    }
  }

  await updateState((state) => {
    const svc = getServiceState(state, service)
    // Se outra chamada já criou uma nova sessão, não apague o estado dela.
    if (svc.id && svc.id !== id) return
    if (svc.model) state[service] = { model: svc.model }
    else delete state[service]
  })

  pendingTasks.delete(service)

  if (force) {
    return (
      `estado local de '${service}' limpo (force: true); a sessão remota ${id} pode continuar existindo no agente. ` +
      `A próxima chamada inicia uma nova sessão.`
    )
  }
  return (
    `sessão ${id} de '${service}' removida do agente (execução ativa interrompida) e o contexto local foi limpo; ` +
    `a próxima chamada inicia uma nova sessão.`
  )
}

async function interruptService(service: string, signal?: AbortSignal): Promise<string> {
  const svc = getServiceState(loadState(), service)
  if (!svc.id) {
    if (pendingTasks.has(service)) {
      return (
        `o agente '${service}' ainda está iniciando uma tarefa (sessão ainda não criada); ` +
        `aguarde um instante e tente 'service_interrupt' novamente.`
      )
    }
    return `nenhuma sessão ativa para '${service}'; não há execução para interromper.`
  }

  const id = svc.id
  try {
    const res = await api(service, `/api/session/${id}/interrupt`, { method: "POST", signal })
    const json = await readJson<{ interrupted?: boolean }>(res, service, "/interrupt", signal)
    pendingTasks.delete(service)
    if (json.interrupted) {
      return (
        `execução de '${service}' interrompida (sessão ${id}); o contexto da sessão foi mantido. ` +
        `Use 'service_status' para ver o resultado final ou 'service_reset' para descartar a sessão.`
      )
    }
    return `não havia execução ativa para '${service}' (sessão ${id}); nada foi interrompido.`
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      pendingTasks.delete(service)
      return (
        `a sessão ${id} de '${service}' não existe mais no agente; nada foi interrompido. ` +
        `Use 'service_reset' para limpar o estado local.`
      )
    }
    throw err
  }
}

async function listModels(service: string, signal?: AbortSignal): Promise<string> {
  const models = await getModels(service, signal)
  const defaultID = await getDefaultModelID(service, signal)
  const selected = getServiceState(loadState(), service).model
  const lines = models.map((m) => {
    const isSelected = !!selected && selected.providerID === m.providerID && selected.modelID === m.modelID
    const tags: string[] = []
    if (m.modelID === defaultID) tags.push("padrão")
    if (isSelected) tags.push("selecionado")
    const current = isSelected ? (selected?.variant ?? "default") : undefined
    const suffix = tags.length ? ` [${tags.join(", ")}]` : ""
    return `- ${m.providerID}/${m.modelID}${m.name ? ` (${m.name})` : ""}${suffix}${formatModelEfforts(m.variants, current)}`
  })
  return lines.length ? lines.join("\n") : "(nenhum modelo disponível)"
}

type ResolvedModel = { model: ModelInfo; variant?: string; variantSpecified: boolean }

async function resolveModel(service: string, query: string, signal?: AbortSignal): Promise<ResolvedModel> {
  const models = await getModels(service, signal)
  const q = query.trim()
  const hash = q.indexOf("#")
  const base = hash === -1 ? q : q.slice(0, hash)
  const rawVariant = hash === -1 ? undefined : q.slice(hash + 1)
  const matched = models.find((c) => {
    if (`${c.providerID}/${c.modelID}` === base) return true
    if (c.name && c.name.toLowerCase() === base.toLowerCase()) return true
    if (c.modelID === base) return true
    return c.modelID.endsWith("/" + base)
  })
  if (!matched) {
    throw new Error(`modelo '${q}' não encontrado em '${service}'. Use a tool 'service_models' para listar.`)
  }
  const variant = rawVariant === undefined ? undefined : resolveEffort(rawVariant, matched.variants)
  return { model: matched, variant, variantSpecified: rawVariant !== undefined }
}

async function resolveCurrentModel(
  service: string,
  svc: ServiceState,
  signal?: AbortSignal,
): Promise<ModelInfo> {
  const models = await getModels(service, signal)
  const find = (ref: ModelRef): ModelInfo | undefined =>
    models.find((m) => m.providerID === ref.providerID && m.modelID === ref.modelID)

  if (svc.model) {
    const found = find(svc.model)
    if (found) return found
    throw new Error(
      `o modelo ${svc.model.providerID}/${svc.model.modelID} de '${service}' não está mais disponível. ` +
        `Use 'service_setModel' para escolher outro modelo.`,
    )
  }

  if (svc.id) {
    const sessionModel = await getSessionModel(service, svc.id, signal)
    if (sessionModel) {
      const found = find(sessionModel)
      if (found) return found
      throw new Error(
        `o modelo ${sessionModel.providerID}/${sessionModel.modelID} da sessão ${svc.id} de '${service}' não está mais disponível. ` +
          `Use 'service_setModel' para escolher outro modelo.`,
      )
    }
  }

  const defaultModel = await getDefaultModel(service, signal)
  if (!defaultModel) {
    throw new Error(`não foi possível determinar o modelo padrão de '${service}'. Use 'service_setModel' para escolher um.`)
  }
  return find(defaultModel) ?? defaultModel
}

async function setEffort(service: string, effort: string, signal?: AbortSignal): Promise<string> {
  return updateState(async (state) => {
    const svc = getServiceState(state, service)
    const model = await resolveCurrentModel(service, svc, signal)
    const variant = resolveEffort(effort, model.variants)
    const ref: ModelRef = {
      providerID: model.providerID,
      modelID: model.modelID,
      ...(variant ? { variant } : {}),
    }

    svc.model = ref
    state[service] = svc
    if (svc.id) await setSessionModel(service, svc.id, ref, signal)

    const context = svc.id
      ? `modelo ${model.providerID}/${model.modelID}, sessão ${svc.id}`
      : `modelo ${model.providerID}/${model.modelID}; sem sessão ativa, será aplicado na próxima tarefa`
    const options = model.variants.length
      ? `variantes disponíveis: ${model.variants.join(", ")}`
      : "o modelo não oferece variantes"
    if (!variant) return `esforço de '${service}' definido para o padrão (${context}); ${options}.`
    return `esforço de '${service}' definido para '${variant}' (${context}); ${options}.`
  })
}

async function listEfforts(service: string, query: string | undefined, signal?: AbortSignal): Promise<string> {
  const svc = getServiceState(loadState(), service)
  const requested = query?.trim()
  const model = requested
    ? (await resolveModel(service, requested, signal)).model
    : await resolveCurrentModel(service, svc, signal)

  const matchesSelected =
    !!svc.model && svc.model.providerID === model.providerID && svc.model.modelID === model.modelID

  let current: string | undefined
  if (requested) {
    if (matchesSelected) current = svc.model!.variant ?? "default"
  } else if (matchesSelected) {
    current = svc.model!.variant ?? "default"
  } else if (svc.id) {
    const sessionModel = await getSessionModel(service, svc.id, signal)
    if (sessionModel && sessionModel.providerID === model.providerID && sessionModel.modelID === model.modelID) {
      current = sessionModel.variant ?? "default"
    }
  } else {
    current = "default"
  }

  const label = `${model.providerID}/${model.modelID}${model.name ? ` (${model.name})` : ""}`
  if (model.variants.length === 0) {
    return (
      `o modelo ${label} de '${service}' não oferece níveis de esforço (variants); ` +
      `use 'service_setModel' para escolher outro modelo.`
    )
  }

  const hint = matchesSelected
    ? "Use 'service_setEffort' com um destes valores para escolher; 'default' volta ao padrão do modelo."
    : `Defina este modelo com 'service_setModel' e depois use 'service_setEffort' para escolher um esforço.`
  return `esforços de '${service}' para ${label}:\n${formatEffortList(model.variants, current)}\n${hint}`
}

export default Plugin.define({
  id: "dockercode-service",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "service",
        description:
          "Delega uma tarefa ao agente OpenCode de outro serviço na rede (container) e devolve a resposta. " +
          "A resposta contém somente o texto final do agente do serviço. " +
          "Se o agente pedir permissão para alguma ferramenta (shell, edit, etc.), em vez da resposta você recebe o pedido " +
          "com o id e deve decidir usando a tool 'service_permission'. " +
          "Se o agente fizer uma pergunta (formulário), você recebe o formulário e deve responder com a tool 'service_form'. " +
          "Se a espera exceder o tempo máximo, use 'service_status' para acompanhar o andamento — não reenvie a tarefa. " +
          "Exemplos de nomes: servico-a, servico-b.",
        input: {
          type: "object",
          properties: {
            service: { type: "string", description: "Nome do container/serviço na rede dockercode (ex.: servico-a)" },
            task: { type: "string", description: "Instrução ou tarefa a executar no agente do serviço" },
          },
          required: ["service", "task"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { service, task } = input as { service: string; task: string }
          validateServiceName(service)
          validateTask(task, service)
          return { content: await withServiceContext(service, () => delegate(service, task, context.signal)) }
        },
      })

      editor.add({
        name: "service_status",
        description:
          "Consulta o andamento da última tarefa de um serviço sem enviar prompt. " +
          "Retorna pedidos de permissão pendentes, formulários pendentes, o resultado final se a tarefa já terminou " +
          "ou uma mensagem informando que ela ainda está em execução. Use após um timeout da tool 'service' ou quando " +
          "quiser saber o estado sem repetir a tarefa.",
        input: {
          type: "object",
          properties: {
            service: { type: "string", description: "Nome do container/serviço na rede dockercode (ex.: servico-a)" },
          },
          required: ["service"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { service } = input as { service: string }
          validateServiceName(service)
          return { content: await withServiceContext(service, () => status(service, context.signal)) }
        },
      })

      editor.add({
        name: "service_interrupt",
        description:
          "Interrompe uma execução ativa no agente de um serviço (POST /api/session/:id/interrupt) sem apagar a sessão. " +
          "Use quando a tarefa passou do tempo e você não quer esperar; o contexto da sessão é mantido e você pode " +
          "consultar o resultado com 'service_status' ou descartar a sessão com 'service_reset'.",
        input: {
          type: "object",
          properties: {
            service: { type: "string", description: "Nome do container/serviço na rede dockercode (ex.: servico-a)" },
          },
          required: ["service"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { service } = input as { service: string }
          validateServiceName(service)
          return { content: await withServiceContext(service, () => interruptService(service, context.signal)) }
        },
      })

      editor.add({
        name: "service_permission",
        description:
          "Responde a um pedido de permissão feito pelo agente de um serviço (retornado pela tool 'service' ou 'service_status'). " +
          "Informe o id do pedido (ou '*' para responder a todos os pendentes) e a decisão. " +
          "Depois de responder, aguarda a continuação: devolve a resposta final, um novo pedido de permissão ou um formulário.",
        input: {
          type: "object",
          properties: {
            service: { type: "string", description: "Nome do container/serviço na rede dockercode (ex.: servico-a)" },
            requestID: { type: "string", description: "id do pedido retornado pela tool 'service' (ex.: per_abc123), ou '*' para todos" },
            decision: {
              type: "string",
              enum: ["allow", "allow_always", "deny"],
              description: "allow = permitir só desta vez; allow_always = permitir e lembrar; deny = negar",
            },
            message: { type: "string", description: "Feedback opcional (útil principalmente ao negar)" },
          },
          required: ["service", "requestID", "decision"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { service, requestID, decision, message } = input as {
            service: string
            requestID: string
            decision: string
            message?: string
          }
          validateServiceName(service)
          return {
            content: await withServiceContext(service, () =>
              respondPermission(service, requestID, decision, message, context.signal),
            ),
          }
        },
      })

      editor.add({
        name: "service_form",
        description:
          "Responde a um formulário (pergunta) feito pelo agente de um serviço (retornado pela tool 'service' ou 'service_status'). " +
          "Informe o id de UM formulário e um objeto 'answer' em que cada chave é o nome do campo (ex.: 'q0') e cada valor é a resposta. " +
          "Para campos de escolha (que listam opções), o valor deve ser o 'value' da opção selecionada, não o 'label' nem a 'description'. " +
          "Use cancel: true para cancelar o formulário. O formID '*' só é aceito junto com cancel: true, para cancelar todos os pendentes; " +
          "não é possível responder vários formulários com o mesmo 'answer'. " +
          "Depois de responder, aguarda a continuação: devolve a resposta final, um novo pedido de permissão ou um novo formulário.",
        input: {
          type: "object",
          properties: {
            service: { type: "string", description: "Nome do container/serviço na rede dockercode (ex.: servico-a)" },
            formID: {
              type: "string",
              description: "id do formulário retornado pela tool 'service' (obrigatório para responder); '*' só com cancel: true",
            },
            answer: { type: "object", description: "Respostas no formato { chave: valor } para cada campo do formulário" },
            cancel: { type: "boolean", description: "true para cancelar o formulário (com formID: '*' cancela todos)" },
          },
          required: ["service", "formID"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { service, formID, answer, cancel } = input as {
            service: string
            formID: string
            answer?: Record<string, unknown>
            cancel?: boolean
          }
          validateServiceName(service)
          return {
            content: await withServiceContext(service, () =>
              respondForm(service, formID, answer, cancel === true, context.signal),
            ),
          }
        },
      })

      editor.add({
        name: "service_models",
        description:
          "Lista os modelos disponíveis no agente OpenCode de um serviço (container), no formato 'provider/modelID (nome)'. " +
          "Mostra também os níveis de esforço (variants) de cada modelo e o esforço atual do modelo selecionado. " +
          "Use para descobrir os modelos e esforços antes de usar 'service_setModel' ou 'service_setEffort'.",
        input: {
          type: "object",
          properties: {
            service: { type: "string", description: "Nome do container/serviço na rede dockercode (ex.: servico-a)" },
          },
          required: ["service"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { service } = input as { service: string }
          validateServiceName(service)
          return { content: await withServiceContext(service, () => listModels(service, context.signal)) }
        },
      })

      editor.add({
        name: "service_efforts",
        description:
          "Lista os níveis de esforço (variants) disponíveis para o modelo usado pelo agente de um serviço, " +
          "marcando o esforço atual. Use antes de 'service_setEffort' para escolher um valor. " +
          "Sem o campo 'model', consulta o modelo atual (selecionado, da sessão ou padrão).",
        input: {
          type: "object",
          properties: {
            service: { type: "string", description: "Nome do container/serviço na rede dockercode (ex.: servico-a)" },
            model: {
              type: "string",
              description: "Opcional: modelo específico (nome ou 'provider/modelID') para listar os esforços",
            },
          },
          required: ["service"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { service, model } = input as { service: string; model?: string }
          validateServiceName(service)
          return {
            content: await withServiceContext(service, () => listEfforts(service, model, context.signal)),
          }
        },
      })

      editor.add({
        name: "service_setModel",
        description:
          "Define o modelo usado pelo agente de um serviço (persistido para as próximas chamadas). " +
          "Aceita nome (ex.: deepseek-v4-pro) ou 'provider/modelID' (ex.: OpenRouter/deepseek/deepseek-v4-pro-0813). " +
          "Aceita também '#esforço' no final (ex.: provider/model#high) para já escolher uma variante. " +
          "Sem '#esforço', mantém o esforço anterior se o novo modelo oferecer a mesma variante; caso contrário, volta ao padrão.",
        input: {
          type: "object",
          properties: {
            service: { type: "string", description: "Nome do container/serviço na rede dockercode (ex.: servico-a)" },
            model: { type: "string", description: "Modelo a usar (nome, 'provider/modelID' ou 'provider/modelID#esforço')" },
          },
          required: ["service", "model"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { service, model } = input as { service: string; model: string }
          validateServiceName(service)
          return {
            content: await withServiceContext(service, async () => {
              const resolved = await resolveModel(service, model ?? "", context.signal)
              let selected: ModelRef | undefined
              let dropped: string | undefined
              await updateState((state) => {
                const svc = getServiceState(state, service)
                const previous = svc.model?.variant
                const variant = resolved.variantSpecified
                  ? resolved.variant
                  : previous && resolved.model.variants.includes(previous)
                    ? previous
                    : undefined
                dropped = previous && !variant ? previous : undefined
                selected = {
                  providerID: resolved.model.providerID,
                  modelID: resolved.model.modelID,
                  ...(variant ? { variant } : {}),
                }
                svc.model = selected
                state[service] = svc
              })
              const effort = selected!.variant ? `; esforço: ${selected!.variant}` : ""
              const removed = dropped
                ? ` (esforço anterior '${dropped}' removido: indisponível neste modelo)`
                : ""
              return `modelo de '${service}' definido para ${selected!.providerID}/${selected!.modelID}${effort}${removed}`
            }),
          }
        },
      })

      editor.add({
        name: "service_setEffort",
        description:
          "Define o nível de esforço de raciocínio (variant, equivalente ao /effort do TUI) do modelo usado pelo agente " +
          "de um serviço. Aceita os valores listados por 'service_models' (ex.: low, high, max) ou 'default' para usar o " +
          "padrão do modelo. O esforço é persistido e aplicado imediatamente à sessão atual (se existir).",
        input: {
          type: "object",
          properties: {
            service: { type: "string", description: "Nome do container/serviço na rede dockercode (ex.: servico-a)" },
            effort: {
              type: "string",
              description: "Nível de esforço/variant (ex.: low, high, max) ou 'default' para o padrão do modelo",
            },
          },
          required: ["service", "effort"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { service, effort } = input as { service: string; effort: string }
          validateServiceName(service)
          return {
            content: await withServiceContext(service, () => setEffort(service, effort ?? "", context.signal)),
          }
        },
      })

      editor.add({
        name: "service_reset",
        description:
          "Encerra a sessão do agente de um serviço: remove a sessão no agente (DELETE /api/session/:id, o que interrompe " +
          "uma execução ativa) e esquece a sessão local; a próxima chamada inicia uma nova sessão. O modelo definido é mantido. " +
          "Use force: true apenas quando o agente estiver inacessível, para limpar somente o estado local.",
        input: {
          type: "object",
          properties: {
            service: { type: "string", description: "Nome do container/serviço na rede dockercode (ex.: servico-a)" },
            force: {
              type: "boolean",
              description: "true para limpar apenas o estado local, sem tentar remover a sessão no agente",
            },
          },
          required: ["service"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { service, force } = input as { service: string; force?: boolean }
          validateServiceName(service)
          return {
            content: await withServiceContext(service, () => resetService(service, force === true, context.signal)),
          }
        },
      })
    })
  },
})
