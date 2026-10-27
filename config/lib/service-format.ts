// Funções puras de formatação das respostas das tools e de resolução de
// esforço (variant). Não dependem do runtime do OpenCode nem de I/O, o que
// permite testá-las com `node:test`.

export type PermissionRequest = {
  id: string
  sessionID: string
  action: string
  resources: string[]
  message?: string
}

export type FormField = {
  key: string
  type?: string
  title?: string
  description?: string
  required?: boolean
  placeholder?: string
  default?: unknown
  options?: unknown
}

export type FormRequest = {
  id: string
  sessionID: string
  title: string
  fields: FormField[]
}

export type Outcome =
  | { kind: "permission"; permissions: PermissionRequest[] }
  | { kind: "form"; forms: FormRequest[] }
  | { kind: "done"; text: string; outcome?: string; error?: string }
  | { kind: "timeout" }

export function formatPermissionRequest(service: string, permissions: PermissionRequest[]): string {
  const plural = permissions.length === 1 ? "" : "s"
  const lines = [`O agente '${service}' pediu permissão para continuar (${permissions.length} pedido${plural}):`, ""]
  permissions.forEach((p, i) => {
    lines.push(`[${i + 1}] ação: ${p.action}`)
    if (p.resources?.length) lines.push(`    recursos: ${p.resources.join(", ")}`)
    if (p.message) lines.push(`    detalhe: ${p.message}`)
    lines.push(`    id: ${p.id}`)
    lines.push("")
  })
  lines.push(
    "Para decidir, chame a tool 'service_permission' informando o id (ou '*' para todos) e a decisão:",
    '  decision: "allow" (permitir só desta vez) | "allow_always" (permitir e lembrar) | "deny" (negar)',
    "  message (opcional): feedback, útil principalmente ao negar.",
  )
  return lines.join("\n")
}

export function formatField(field: FormField): string {
  const parts: string[] = []
  const req = field.required ? " (obrigatório)" : ""
  parts.push(`    campo '${field.key}' — ${field.title || "(sem título)"}${req}`)
  if (field.description) parts.push(`      descrição: ${field.description}`)

  const options = field.options
  if (Array.isArray(options) && options.length > 0) {
    if (options.every((o) => typeof o === "string")) {
      parts.push(
        `      responda com um destes valores (texto exato): ${options.map((o) => JSON.stringify(o)).join(", ")}`,
      )
    } else {
      parts.push(`      é uma ESCOLHA — o valor da resposta deve ser o "value" de UMA destas opções:`)
      for (const o of options as Array<{ value?: unknown; label?: string; description?: string }>) {
        const bits = [`        - value: ${JSON.stringify(o.value)}`]
        if (o.label) bits.push(`label: ${o.label}`)
        if (o.description) bits.push(`descrição: ${o.description}`)
        parts.push(bits.join(" | "))
      }
    }
  } else {
    parts.push(`      responda com texto livre`)
  }
  if (field.placeholder) parts.push(`      placeholder: ${field.placeholder}`)
  if (field.default !== undefined) parts.push(`      valor padrão: ${JSON.stringify(field.default)}`)
  return parts.join("\n")
}

export function formatFormRequest(service: string, forms: FormRequest[]): string {
  const plural = forms.length === 1 ? "" : "s"
  const lines = [`O agente '${service}' precisa de uma resposta (${forms.length} formulário${plural} pendente${plural}):`, ""]
  forms.forEach((f, i) => {
    lines.push(`[${i + 1}] ${f.title || "(sem título)"}  (id: ${f.id})`)
    for (const field of f.fields ?? []) lines.push(formatField(field))
    lines.push("")
  })

  lines.push(
    "Para responder, chame a tool 'service_form' com o id de UM formulário e o objeto 'answer' usando como chave o nome do campo (ex.: 'q0') e como valor a resposta:",
    `  service: "${service}"`,
    "  formID: id do formulário (obrigatório para responder)",
    "  answer: { \"<campo>\": \"<resposta>\" }  (para campos de escolha, use o 'value' da opção selecionada)",
  )

  // exemplo concreto com o primeiro campo do primeiro formulário
  const first = forms[0]
  const field = first?.fields?.[0]
  if (field) {
    let exampleValue: string
    if (Array.isArray(field.options) && field.options.length > 0) {
      const firstOpt = field.options[0]
      exampleValue = typeof firstOpt === "string" ? firstOpt : String((firstOpt as { value?: unknown }).value ?? "")
    } else {
      exampleValue = "resposta"
    }
    lines.push(
      `  Exemplo: service_form { service: "${service}", formID: "${first!.id}", answer: { ${JSON.stringify(
        field.key,
      )}: ${JSON.stringify(exampleValue)} } }`,
    )
  }
  lines.push(
    "  Para cancelar: cancel: true com o id de um formulário, ou formID: \"*\" com cancel: true para cancelar todos os pendentes.",
  )
  return lines.join("\n")
}

export function resolveEffort(effort: string, variants: string[]): string | undefined {
  const normalized = effort.trim()
  if (normalized === "" || normalized.toLowerCase() === "default") return undefined

  const match = variants.find((variant) => variant.toLowerCase() === normalized.toLowerCase())
  if (match) return match
  if (variants.length === 0) {
    throw new Error("o modelo selecionado não oferece níveis de esforço (variants)")
  }
  throw new Error(
    `esforço '${normalized}' indisponível; use um destes: ${variants.join(", ")} (ou 'default' para o padrão do modelo)`,
  )
}

export function formatModelEfforts(variants: string[], current?: string): string {
  if (variants.length === 0) return ""
  const selected = current ? ` (atual: ${current})` : ""
  return ` — esforços: ${variants.join(", ")}${selected}`
}

export function formatEffortList(variants: string[], current?: string): string {
  const marker = (id: string) => (current === id ? " [atual]" : "")
  const lines = [`- default (padrão do modelo)${marker("default")}`]
  for (const variant of variants) lines.push(`- ${variant}${marker(variant)}`)
  return lines.join("\n")
}

export function formatOutcome(service: string, id: string, outcome: Outcome): string {
  if (outcome.kind === "done") {
    const text = outcome.text
    if (outcome.outcome === "failed") {
      const reason = outcome.error ? ` Erro: ${outcome.error}` : ""
      return (
        (text ? text + "\n\n" : "") +
        `⚠️ o agente '${service}' (sessão ${id}) encerrou com falha (failed).${reason}`
      )
    }
    if (outcome.outcome === "interrupted") {
      return (text ? text + "\n\n" : "") + `⚠️ a execução do agente '${service}' (sessão ${id}) foi interrompida.`
    }
    return text
  }
  if (outcome.kind === "permission") return formatPermissionRequest(service, outcome.permissions)
  if (outcome.kind === "form") return formatFormRequest(service, outcome.forms)
  return (
    `tempo esgotado aguardando '${service}' (sessão ${id}). A execução pode seguir em segundo plano; ` +
    `use a tool 'service_status' com { service: "${service}" } para consultar o andamento — não reenvie a tarefa. ` +
    `Para cancelar, use 'service_interrupt'.`
  )
}
