import assert from "node:assert/strict"
import test from "node:test"
import {
  formatEffortList,
  formatField,
  formatFormRequest,
  formatModelEfforts,
  formatOutcome,
  formatPermissionRequest,
  resolveEffort,
  type FormField,
  type FormRequest,
  type PermissionRequest,
} from "../config/lib/service-format.ts"

test("formatField descreve campo de texto livre", () => {
  const field: FormField = {
    key: "q0",
    title: "Nome do projeto",
    description: "Use o nome completo",
    required: true,
    placeholder: "ex.: servico-a",
    default: "sem-nome",
  }

  const text = formatField(field)
  assert.match(text, /campo 'q0' — Nome do projeto \(obrigatório\)/)
  assert.match(text, /descrição: Use o nome completo/)
  assert.match(text, /responda com texto livre/)
  assert.match(text, /placeholder: ex\.: servico-a/)
  assert.match(text, /valor padrão: "sem-nome"/)
})

test("formatField lista opções de texto e de escolha", () => {
  const textOptions = formatField({ key: "q1", title: "Ambiente", options: ["dev", "prod"] })
  assert.match(textOptions, /valores \(texto exato\): "dev", "prod"/)

  const choice = formatField({
    key: "q2",
    title: "Região",
    options: [
      { value: "br", label: "Brasil", description: "América do Sul" },
      { value: "us", label: "Estados Unidos" },
    ],
  })
  assert.match(choice, /é uma ESCOLHA/)
  assert.match(choice, /value: "br" \| label: Brasil \| descrição: América do Sul/)
  assert.match(choice, /value: "us" \| label: Estados Unidos/)
})

test("formatPermissionRequest inclui recursos, detalhe e instruções", () => {
  const singular: PermissionRequest[] = [
    { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["ls", "pwd"], message: "precisa listar" },
  ]

  const one = formatPermissionRequest("servico-a", singular)
  assert.match(one, /O agente 'servico-a' pediu permissão para continuar \(1 pedido\):/)
  assert.match(one, /\[1\] ação: shell/)
  assert.match(one, /recursos: ls, pwd/)
  assert.match(one, /detalhe: precisa listar/)
  assert.match(one, /id: per_1/)
  assert.match(one, /service_permission/)

  const two = formatPermissionRequest("servico-a", [
    ...singular,
    { id: "per_2", sessionID: "ses_1", action: "edit", resources: [] },
  ])
  assert.match(two, /\(2 pedidos\):/)
  assert.doesNotMatch(two, /detalhe:.*per_2/)
})

test("formatFormRequest mostra campos, exemplo e cancelamento", () => {
  const forms: FormRequest[] = [
    {
      id: "form_1",
      sessionID: "ses_1",
      title: "Configuração",
      fields: [{ key: "q0", title: "Ambiente", options: ["dev", "prod"] }],
    },
    {
      id: "form_2",
      sessionID: "ses_1",
      title: "Observações",
      fields: [],
    },
  ]

  const text = formatFormRequest("servico-b", forms)
  assert.match(text, /O agente 'servico-b' precisa de uma resposta \(2 formulários pendentes\):/)
  assert.match(text, /\[1\] Configuração {2}\(id: form_1\)/)
  assert.match(text, /campo 'q0' — Ambiente/)
  assert.match(text, /Exemplo: service_form \{ service: "servico-b", formID: "form_1", answer: \{ "q0": "dev" \} \}/)
  assert.match(text, /formID: "\*" com cancel: true para cancelar todos os pendentes/)
})

test("resolveEffort aceita default, normaliza caixa e rejeita variante inexistente", () => {
  assert.equal(resolveEffort("", ["low", "high"]), undefined)
  assert.equal(resolveEffort("default", ["low", "high"]), undefined)
  assert.equal(resolveEffort(" HIGH ", ["low", "high"]), "high")

  assert.throws(
    () => resolveEffort("max", ["low", "high"]),
    /esforço 'max' indisponível; use um destes: low, high \(ou 'default' para o padrão do modelo\)/,
  )
  assert.throws(() => resolveEffort("high", []), /não oferece níveis de esforço \(variants\)/)
})

test("formatModelEfforts descreve variantes e o esforço atual", () => {
  assert.equal(formatModelEfforts([]), "")
  assert.equal(formatModelEfforts(["low", "high"]), " — esforços: low, high")
  assert.equal(formatModelEfforts(["low", "high"], "high"), " — esforços: low, high (atual: high)")
  assert.equal(formatModelEfforts(["low", "high"], "default"), " — esforços: low, high (atual: default)")
})

test("formatEffortList lista default e variantes, marcando o atual", () => {
  assert.equal(formatEffortList(["low", "high"]), "- default (padrão do modelo)\n- low\n- high")
  assert.equal(formatEffortList(["low", "high"], "high"), "- default (padrão do modelo)\n- low\n- high [atual]")
  assert.equal(formatEffortList(["low", "high"], "default"), "- default (padrão do modelo) [atual]\n- low\n- high")
})

test("formatOutcome devolve o texto e sinaliza falha/interrupção", () => {
  assert.equal(formatOutcome("svc", "ses_1", { kind: "done", text: "resposta", outcome: "succeeded" }), "resposta")
  assert.equal(formatOutcome("svc", "ses_1", { kind: "done", text: "", outcome: "succeeded" }), "")

  const failed = formatOutcome("svc", "ses_1", { kind: "done", text: "parcial", outcome: "failed", error: "boom" })
  assert.equal(failed, "parcial\n\n⚠️ o agente 'svc' (sessão ses_1) encerrou com falha (failed). Erro: boom")

  const interrupted = formatOutcome("svc", "ses_1", { kind: "done", text: "", outcome: "interrupted" })
  assert.equal(interrupted, "⚠️ a execução do agente 'svc' (sessão ses_1) foi interrompida.")
})

test("formatOutcome delega permissão, formulário e timeout", () => {
  const permission = formatOutcome("svc", "ses_1", {
    kind: "permission",
    permissions: [{ id: "per_1", sessionID: "ses_1", action: "shell", resources: [] }],
  })
  assert.match(permission, /pediu permissão para continuar/)

  const form = formatOutcome("svc", "ses_1", {
    kind: "form",
    forms: [{ id: "form_1", sessionID: "ses_1", title: "Pergunta", fields: [] }],
  })
  assert.match(form, /precisa de uma resposta/)

  const timeout = formatOutcome("svc", "ses_abc", { kind: "timeout" })
  assert.match(timeout, /tempo esgotado aguardando 'svc' \(sessão ses_abc\)/)
  assert.match(timeout, /service_status/)
  assert.match(timeout, /service_interrupt/)
})
