# opencode-orchestration

Orquestra múltiplos agentes OpenCode, cada um rodando **isolado em seu próprio container**, controlados a partir de uma única sessão principal.

Use quando você tem um workspace com vários serviços (cada um com seu próprio `AGENTS.md`/contexto) e quer conversar com todos a partir de um só terminal, sem abrir uma sessão por serviço.

## Conceitos

| Componente | Imagem | Comando | Papel |
| --- | --- | --- | --- |
| **Principal** | `opencode-run` | `dockercode` | Sessão única que **consome** os agentes. Roda o TUI do OpenCode. |
| **Agente** | `opencode-agent` | `dockeragent` | Um container por serviço. Expõe o OpenCode via HTTP (`opencode serve`), **sem** capacidade de conectar em outros. |

Todos compartilham a rede Docker `dockercode` e se alcançam pelo **nome do container** (`http://<serviço>:4096`).

```
[sessão principal]  dockercode
   ├─ tools `service` / `service_status` / `service_interrupt` / `service_permission` / `service_form`
   │         `service_models` / `service_efforts` / `service_setModel` / `service_setEffort` / `service_reset`
   └─ agente `Agent`  (modo primário; use Shift+Tab, /agents ou Ctrl+X + A)
         │  HTTP http://<serviço>:4096
         ▼
[servico-a]  dockeragent  (opencode serve, PID 1)
[servico-b]  dockeragent  (opencode serve, PID 1)
```

## Pré-requisitos

- **Docker** instalado e usuário no grupo `docker`.
- **`~/.local/bin` no `PATH`** (os launchers são instalados lá):
  ```bash
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
  ```
- **API key** de um provider LLM e uma configuração de provider (global do usuário **ou** `opencode.json` no projeto — ver abaixo).

## Instalação

```bash
git clone <seu-repo>/opencode-orchestration
cd opencode-orchestration
./install.sh
```

O `install.sh` (idempotente) faz:

1. instala os launchers `dockercode` e `dockeragent` (e a lib `dockercode-config.sh`) em `~/.local/bin`;
2. copia a configuração para `~/.config/dockercode/` (plugin de tools, funções puras de formatação e o agente `Agent`);
3. constrói as imagens `opencode-run` e `opencode-agent`;
4. garante a rede `dockercode`.

## Configuração do provider (obrigatório)

O OpenCode precisa de um provider configurado. Há duas formas de fornecer a configuração (elas podem ser
combinadas):

1. **Configuração do usuário (recomendada)** — um único `opencode.json` (ou `opencode.jsonc`) em
   `~/.config/dockercode/`, usado por **todos** os projetos e serviços:

   ```bash
   mkdir -p ~/.config/dockercode
   $EDITOR ~/.config/dockercode/opencode.json
   ```

   Os launchers montam esse arquivo como a configuração **global** do OpenCode dentro dos containers
   (`/tmp/.config/opencode/opencode.json`), tanto no principal (`dockercode`) quanto nos agentes (`dockeragent`).

2. **Configuração do projeto** — `opencode.json` na raiz do workspace (principal) e/ou na pasta de cada
   serviço (agente). Continua suportada, mas agora é **opcional**: quando existe, o OpenCode faz merge com a
   configuração global e o arquivo do projeto **tem precedência** sobre ela.

O formato atual do V2 usa `providers` (plural). A chave **não** fica no JSON: declare o nome da variável em `env`
e exporte a variável antes de subir os containers.

Exemplo (`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "OpenCodeGo": {
      "name": "OpenCodeGo",
      "env": ["OPENCODE_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://opencode.ai/inference/go/openai/v1"
      },
      "models": {
        "deepseek-v4.1-flash": { "name": "deepseek-v4.1-flash" },
        "deepseek-v4-pro": { "name": "deepseek-v4-pro" }
      }
    }
  }
}
```

Exporte a chave no ambiente de onde você roda os launchers:

```bash
export OPENCODE_API_KEY="sua-chave"
dockercode
# em cada pasta de serviço:
dockeragent
```

Os launchers repassam a variável aos containers com `docker run -e OPENCODE_API_KEY`. Se preferir não deixá-la no
ambiente do shell, use `settings.apiKey: "{env:OPENCODE_API_KEY}"` ou um `--env-file` com permissão `600`.

### Onde procurar a configuração do usuário

Os launchers resolvem o arquivo nesta ordem:

1. `DOCKERCODE_CONFIG_FILE` — caminho completo de um `opencode.json`/`opencode.jsonc`;
2. `DOCKERCODE_CONFIG_DIR` — pasta que contenha `opencode.json` ou `opencode.jsonc`;
3. `~/.config/dockercode/opencode.json` ou `~/.config/dockercode/opencode.jsonc` (padrão).

Se `DOCKERCODE_CONFIG_FILE`/`DOCKERCODE_CONFIG_DIR` forem definidos mas inválidos (arquivo inexistente, nome
diferente ou pasta sem configuração), o launcher aborta com erro. Sem nenhum arquivo do usuário e sem
`opencode.json` no projeto, o launcher apenas avisa que o provider pode não estar configurado — o arquivo do
projeto continua valendo sozinho.

Para reaproveitar a configuração global que você já usa no host:

```bash
export DOCKERCODE_CONFIG_FILE="$HOME/.config/opencode/opencode.json"
```

O arquivo precisa se chamar `opencode.json` ou `opencode.jsonc`. Ele é montado como configuração global
(precedência menor que a do projeto); caminhos com `{file:...}` são resolvidos **dentro do container** (`~` = `/tmp`).

> **Rotacione a chave antiga.** Versões anteriores deste projeto gravavam a chave em texto puro no `opencode.json`;
> se você usou esse formato, gere uma nova chave no console do provider e descarte a anterior.

O `opencode.json` do projeto está no `.gitignore`; não versione credenciais. O mesmo formato de `providers`/`env`
vale para a configuração do usuário e para a de cada serviço.

Sem uma configuração (do usuário ou do projeto) ou credencial, o `opencode serve` do agente não consegue responder.

## Uso

### 1. Subir os agentes (um por serviço)

Dentro de cada pasta de serviço:

```bash
cd projeto-x/servico-a && dockeragent
cd projeto-x/servico-b && dockeragent
```

O agente sobe **detached** e, depois que `/api/info` responde (health check de até 10s), imprime o endereço:

```
agente 'servico-a' iniciado: http://servico-a:4096 (logs: docker logs -f servico-a)
```

Se o health check falhar, o launcher mostra as últimas linhas de `docker logs`, para o container e sai com erro.

O nome do container é o nome da pasta. Se já existir um container com esse nome, o launcher aborta antes de subir; pare/remova o anterior. O nome precisa casar `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`.

Parar: `docker stop servico-a`.

Argumentos antes de `--` são repassados ao `docker run`; argumentos depois de `--` substituem o comando padrão do container, como no `dockercode`. Nesse caso o health check é omitido (use apenas para depuração).

### 2. Abrir a sessão principal

Na raiz do workspace:

```bash
cd projeto-x && dockercode
```

O container principal chama-se `dockercode-<pasta>` para não colidir com os nomes dos serviços. Se já existir um container com esse nome, o launcher aborta; encerre a outra sessão principal antes.

### 3. Falar com um serviço (modo `Agent`)

Aperte **Shift+Tab** para ciclar entre os agentes até o modo **Agent** (ou use `/agents`, ou `Ctrl+X` e depois `A`). No V2, `Tab` é autocomplete do prompt — não troca de agente. Nele, você escreve o nome do serviço como primeira string, seguido da tarefa:

```
servico-a Olá, tudo bem?
servico-b explique a arquitetura
```

O prompt é repassado **integralmente** ao serviço (sem resumo, reformulação ou tradução). A resposta é somente o texto final do agente do container:

Você também pode simplesmente pedir em linguagem natural ("conecte com o servico-a e faça X") e o agente principal roteia para o serviço certo usando a tool `service`.

### Tools disponíveis (para o LLM principal)

| Tool | Ação |
| --- | --- |
| `service` | delega uma tarefa ao agente do serviço e devolve a resposta (somente o texto final) |
| `service_status` | consulta o andamento sem reenviar o prompt: permissões, formulários ou resultado final |
| `service_interrupt` | interrompe uma execução ativa sem apagar a sessão (útil após timeout) |
| `service_permission` | responde a um pedido de permissão do agente (allow / allow_always / deny) |
| `service_form` | responde a um formulário/pergunta do agente (objeto `answer` ou `cancel`) |
| `service_models` | lista os modelos disponíveis no agente (com os esforços/variants de cada um e o esforço atual) |
| `service_efforts` | lista só os esforços do modelo atual (ou de um modelo específico), marcando o esforço atual |
| `service_setModel` | define o modelo do agente (persistido); aceita `provider/model#esforço` e mantém o esforço quando possível |
| `service_setEffort` | define o esforço do modelo (equivalente ao `/effort` do TUI); `default` volta ao padrão do modelo |
| `service_reset` | remove a sessão remota e limpa o contexto (mantém o modelo e o esforço; `force: true` só limpa o estado local) |

Para trocar só o esforço de raciocínio (o `/effort` do TUI), use `service_efforts` (ou `service_models`) para ver as variantes
disponíveis e depois:

```
service_efforts { service: "servico-a" }
service_efforts { service: "servico-a", model: "opencode/deepseek-v4.1-flash-free" }
service_setEffort { service: "servico-a", effort: "high" }
service_setEffort { service: "servico-a", effort: "default" }  # volta ao padrão
```

O esforço fica persistido junto com o modelo e é aplicado imediatamente se o serviço já tiver uma sessão.
Se nenhum modelo tiver sido escolhido ainda, a tool fixa o modelo padrão atual para poder aplicar o esforço.

## Estado e sessões

- Sessão, modelo, esforço e início da última tarefa de cada serviço ficam em `/tmp/opencode-agent/sessions.json` **dentro do container principal** (vida = duração do `dockercode`). A gravação é serializada e atômica (arquivo temporário + `rename`), com permissão `0600`.
- Só uma tarefa por serviço: enquanto uma tarefa estiver em andamento (inclusive após um timeout), novas chamadas a `service` para o mesmo serviço são recusadas; use `service_status` para acompanhar e `service_interrupt` para cancelar.
- Nomes de serviço devem casar `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` e `task` não pode ser vazia; a validação acontece antes de qualquer chamada HTTP.
- A leitura das mensagens do assistente percorre as páginas (`cursor.next`) até cobrir o início da tarefa, com limite de segurança de 20 páginas.
- Chamadas consecutivas ao mesmo serviço **continuam** a sessão (contexto mantido).
- `service_status` apenas consulta o agente: não envia prompt. Se houver permissão/formulário pendente, devolve o pedido; se a tarefa já terminou, devolve o resultado final; caso contrário, informa que ainda está em execução.
- `service_reset` remove a sessão no agente (`DELETE /api/session/:id`), **interrompendo uma execução ativa**, e limpa o estado local (mantendo o modelo e o esforço). A próxima chamada cria uma nova sessão. Com `force: true`, limpa só o estado local quando o agente está inacessível.
- Após um timeout da tool `service`, use `service_status` — não reenvie a tarefa. Para cancelar a execução, use `service_interrupt`.
- Mensagens de erro das tools incluem o nome do serviço e, quando a sessão já existe, o `sessionID`.

## Limitações

- **Uma tarefa por serviço.** Enquanto uma execução estiver em andamento — inclusive depois de um timeout —, novas chamadas a `service` para o mesmo serviço são recusadas. Acompanhe com `service_status` e cancele com `service_interrupt`.
- **Estado volátil.** Sessão, modelo, esforço e início da última tarefa ficam em `/tmp/opencode-agent/sessions.json` dentro do container principal. O arquivo é perdido quando o `dockercode` encerra, e o controle de tarefa pendente também é em memória: após reiniciar o principal, use `service_status`/`service_reset` para reconciliar o estado com o agente.
- **Porta fixa.** O agente escuta somente em `4096`, na rede interna `dockercode`; não há publicação de porta no host. Um serviço = um container = um nome de serviço.
- **Formulários em lote.** `formID: "*"` só é aceito com `cancel: true`. Não é possível responder vários formulários com o mesmo `answer`, pois os campos podem ser diferentes.
- **Apenas o principal orquestra.** Os agentes não chamam uns aos outros; as tools `service_*` existem somente na sessão principal.

## Testes e smoke

### Testes unitários

As funções puras de formatação (`formatField`, `formatPermissionRequest`, `formatFormRequest`, `formatOutcome`, `resolveEffort`, `formatModelEfforts` e `formatEffortList`) ficam em `config/lib/service-format.ts` e são testadas com `node:test`. A resolução da configuração global do usuário (`bin/dockercode-config.sh`) também tem testes, executados via bash:

```bash
npm test
# equivalente: node --test test/*.test.ts
```

Requer Node 22.18+ (type stripping nativo; as imagens do projeto usam Node 26) e bash para os testes dos launchers.

### Smoke end-to-end

O `scripts/smoke.sh` sobe (ou reutiliza) o agente de uma pasta de serviço, espera `/api/info` e executa as tools reais `service_models`, `service_efforts`, `service` (tarefa simples), `service_status` e `service_setEffort` (volta ao esforço padrão):

```bash
./scripts/smoke.sh /caminho/do/servico
./scripts/smoke.sh /caminho/do/servico "Responda apenas: ok"
```

- Requer Docker e imagens instaladas (`./install.sh`). Se precisar subir o agente, também exige `OPENCODE_API_KEY` exportada e uma configuração de provider (na pasta do serviço ou global do usuário); um agente já em execução é reutilizado sem essas checagens.
- Se o agente já estiver rodando, ele é reutilizado e **não** é parado ao final; se o smoke subiu o container, ele é parado no `trap` de saída.
- A espera máxima da tarefa é `120000` ms por padrão; ajuste com `SMOKE_MAX_WAIT_MS`. Os demais timeouts usam as variáveis `OPENCODE_AGENT_*`.
- O harness `scripts/smoke.mjs` carrega `config/plugins/service.ts` com um stub de `@opencode/plugin` e chama as tools de verdade, sem depender do TUI.

## Permissões do agente

O OpenCode v2, por padrão, **permite tudo** (só pergunta ao ler arquivos `.env`). Para o agente **pedir aprovação** antes de usar uma ferramenta (ex.: `shell`, `edit`), configure regras `permissions` com `effect: "ask"` no `opencode.json` **de cada serviço** — ou na configuração global do usuário, se quiser o mesmo comportamento em todos os serviços:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "edit",  "resource": "*", "effect": "ask" }
  ]
}
```

A **última regra que casa vence**. Sem essas regras, nenhum pedido de permissão é gerado (o agente roda tudo sozinho). Para pedir aprovação de **tudo**, use `{ "action": "*", "resource": "*", "effect": "ask" }` e libere `read`/`grep`/`glob` com `allow` se quiser menos interrupções.

Quando uma regra resolve `ask`, o pedido volta para você:

- Pela tool `service` ou `service_status`: a resposta é substituída pelo pedido de permissão (ação, recursos e `id` do pedido). Você decide chamando `service_permission` com `decision`:
  - `allow` — permitir só desta vez (`once`)
  - `allow_always` — permitir e lembrar (`always`)
  - `deny` — negar (`reject`)
  - `requestID: "*"` responde a todos os pedidos pendentes de uma vez.
- Depois da decisão, a tool continua esperando: devolve a resposta final, um novo pedido de permissão ou um formulário (pode haver vários durante uma tarefa).
- Tempo máximo de espera por tarefa: `15min` (ajustável via `OPENCODE_AGENT_MAX_WAIT_MS`). Se estourar, a tool avisa e você acompanha com `service_status`; para cancelar, use `service_interrupt`.

## Perguntas do agente (formulários)

Quando o agente precisa de uma resposta sua (pergunta/`question`), isso usa o mecanismo de **formulário** do OpenCode, separado das permissões:

- Pela tool `service` ou `service_status`: a resposta é substituída pela descrição do formulário (título, campos e `id`). Você responde com a tool `service_form`:
  - `formID` — o id de **um** formulário retornado (obrigatório para responder);
  - `answer` — objeto `{ chave: valor }` em que a chave é o nome do campo (ex.: `q0`). Para campos de escolha (que listam opções), o valor deve ser o `value` da opção escolhida — não o `label` nem a `description`;
  - `cancel: true` — cancela o formulário em vez de responder. Com `formID: "*"` e `cancel: true`, cancela todos os pendentes.
- `formID: "*"` **sem** `cancel: true` é rejeitado: não é possível responder vários formulários com o mesmo `answer` (os campos podem ser diferentes).
- Depois da resposta, a tool continua esperando: devolve a resposta final, um novo pedido de permissão ou outro formulário.

## Encerramento com falha/interrupção

A conclusão do agente agora é detectada pela mensagem `idle` do OpenCode (com `outcome`), não mais por `time.idle`. Se o agente encerrar com `failed` ou `interrupted`, a resposta da tool `service` avisa explicitamente (com a mensagem de erro, quando houver) em vez de retornar vazio. O `service_interrupt` produz o `interrupted`; use `service_status` para ver o aviso e o texto final.

## Estrutura de arquivos

```
opencode-orchestration/
├── install.sh                     # instala tudo (idempotente)
├── package.json                   # scripts npm test / smoke
├── README.md
├── dockerfiles/
│   ├── OpencodeRunDockerfile      # imagem opencode-run (principal)
│   └── OpencodeAgentDockerfile    # imagem opencode-agent (agente)
├── bin/
│   ├── dockercode                 # launcher do principal
│   ├── dockeragent                # launcher do agente
│   └── dockercode-config.sh       # resolve a config global do usuário (sourced)
├── scripts/
│   ├── smoke.sh                   # smoke end-to-end (sobe/reutiliza o agente)
│   └── smoke.mjs                  # harness que executa as tools
├── test/
│   ├── service-format.test.ts     # testes node:test das funções puras
│   └── launcher-config.test.ts    # testes da config global do usuário (bash)
└── config/
    ├── plugins/service.ts         # plugin que registra as tools service / service_*
    ├── lib/service-format.ts      # funções puras de formatação (testáveis)
    └── agents/agent.md            # agente "Agent" (modo primário; Shift+Tab, /agents ou Ctrl+X + A)
```

## Referência da API HTTP usada

O agente é um `opencode serve` (v2). As tools/scripts falam com ele por HTTP (nome do container, porta `4096`) usando **Basic auth** (`Authorization: Basic base64("opencode:<senha>")`).

| Endpoint | Uso |
| --- | --- |
| `GET /api/info` | health check do agente (usado pelo `dockeragent` após subir o container) |
| `POST /api/session` | cria uma sessão (retorna `{ data: { id } }`) |
| `DELETE /api/session/:id` | remove a sessão (interrompe execução ativa); usado pelo `service_reset` |
| `POST /api/session/:id/interrupt` | interrompe uma execução ativa sem apagar a sessão; usado pelo `service_interrupt` |
| `POST /api/session/:id/prompt` | admite um prompt (corpo: `{ text }`) e agenda a execução |
| `GET /api/session/:id/message` | lê as mensagens (o texto do assistente vem em `data[].content[]`; a mensagem `type: "idle"` marca o fim com `outcome`) |
| `POST /api/session/:id/model` | define o modelo e o esforço/variant da sessão (corpo: `{ model: { id, providerID, variant? } }`) |
| `GET /api/session/:id/permission` | lista pedidos de permissão pendentes da sessão |
| `POST /api/session/:id/permission/:requestID/reply` | responde a um pedido (corpo: `{ decision: "once"\|"always"\|"reject", message? }`) |
| `GET /api/session/:id/form` | lista formulários (perguntas) pendentes da sessão |
| `POST /api/session/:id/form/:formID/reply` | responde a um formulário (corpo: `{ answer: { chave: valor } }`) |
| `DELETE /api/session/:id/form/:formID` | cancela um formulário |
| `GET /api/model` / `GET /api/model/default` | lista modelos / modelo padrão (retorna `{ data }`) |

A senha é compartilhada: o `dockeragent` gera `~/.config/dockercode/agent-password` (uma única vez) e passa como `OPENCODE_SERVER_PASSWORD` ao agente; o `dockercode` passa a mesma senha ao principal via `OPENCODE_AGENT_PASSWORD`.

## Personalização

- **Configuração global do usuário**: `~/.config/dockercode/opencode.json(c)` vale para o principal e para todos os agentes. Use `DOCKERCODE_CONFIG_FILE` (arquivo) ou `DOCKERCODE_CONFIG_DIR` (pasta) para apontar para outro local. O `opencode.json` do projeto, quando existe, tem precedência.
- **Porta do agente**: fixa em `4096`. O agente é o único que escuta; o principal apenas consome, sem publicar porta no host.
- **Credencial do provider**: fica fora do `opencode.json`; exporte `OPENCODE_API_KEY` antes de rodar `dockercode`/`dockeragent` (ou use `settings.apiKey: "{env:OPENCODE_API_KEY}"` e um `--env-file` com permissão `600`).
- **Timeouts**: `OPENCODE_AGENT_MAX_WAIT_MS` (espera máxima por tarefa, padrão `900000` = 15 min), `OPENCODE_AGENT_REQUEST_TIMEOUT_MS` (timeout de cada requisição HTTP, padrão `30000` = 30 s) e `OPENCODE_AGENT_POLL_INTERVAL_MS` (intervalo de polling, padrão `500`). Valores inválidos (vazio, `abc`, `0`, negativo ou infinito) usam o padrão.
- **Permissões do agente**: o agente sobe headless; o que ele aprova/pergunta é controlado pelas regras `permissions` no `opencode.json` de cada serviço (ver "Permissões do agente"). Para liberar tudo, basta não definir regras (o default v2 é permitir) ou usar `effect: "allow"`.
- **Esforço do modelo**: para os agentes remotos, use `service_setEffort` (ou `service_setModel` com `provider/model#esforço`). Para o modo `Agent` do principal, use `/effort` na sessão ou defina `model: provider/model#esforço` no frontmatter de `config/agents/agent.md`.
- **Nome do agente no seletor**: o agente `Agent` vem de `config/agents/agent.md` (instalado em `~/.config/dockercode/agents/agent.md`). Renomeie o arquivo para mudar o ID/nome exibido no seletor (`Shift+Tab`).
- **Senha da rede**: fica em `~/.config/dockercode/agent-password` (gerada automaticamente). Para regenerar, apague o arquivo e suba os agentes de novo.
- **Mais serviços**: basta rodar `dockeragent` na pasta de cada serviço; o nome do container vira o nome do serviço.

## Solução de problemas

- **`unexpected server error` ao enviar qualquer prompt no principal**: a tool (plugin) não carregou. Este projeto fixa `@opencode/cli@2.1.1`; se trocar a versão, o formato de plugin pode mudar (as tools são registradas via `@opencode/plugin` + `ctx.tool.transform`).
- **O modo `Agent` não aparece ao trocar de agente**: confira se `~/.config/dockercode/agents/agent.md` existe (reinstale com `./install.sh`) e reinicie a sessão principal — agentes são carregados na inicialização. Para trocar de agente use **Shift+Tab**, `/agents` ou `Ctrl+X` + `A` (`Tab` é autocomplete no V2).
- **Agente não responde**: confira se o container do agente está de pé (`docker ps`), se está na rede `dockercode` e se o nome bate com o usado no comando.
- **`dockeragent` falha no health check**: o launcher imprime as últimas 50 linhas de `docker logs`, para o container e sai com erro. Verifique `OPENCODE_API_KEY`, a configuração do provider (`opencode.json` da pasta do serviço ou global do usuário) e a porta interna `4096`.
- **Já existe um container com o nome**: para um agente, pare/remova o container anterior (`docker stop <nome>` ou `docker rm <nome>`). Para o principal, encerre a outra sessão `dockercode` que está usando o mesmo workspace.
- **Modelos não aparecem / erro de credencial**: confirme que `OPENCODE_API_KEY` está exportada no shell que rodou o launcher, que a configuração (do usuário ou do projeto) usa `providers` (plural) e que a chave antiga foi rotacionada. Teste no principal com `opencode api get /api/model` e, para um serviço, com a tool `service_models`. Se um `opencode.json` do projeto existir, ele tem precedência sobre a configuração global.
- **A configuração do usuário não é usada**: confirme o nome (`opencode.json` ou `opencode.jsonc`) e o caminho (`~/.config/dockercode/` por padrão, ou `DOCKERCODE_CONFIG_FILE`/`DOCKERCODE_CONFIG_DIR`); os launchers mostram a linha `config do usuário: ...` ao iniciar. O arquivo é montado como config global em `/tmp/.config/opencode/opencode.json(c)`; no agente ele é montado como arquivo único e somente leitura, então reinicie o container (`docker stop <nome>` e `dockeragent`) depois de editá-lo.
- **`scripts/smoke.sh` falha**: confirme a imagem `opencode-run`, a rede `dockercode` e, se o agente for subido pelo script, `OPENCODE_API_KEY` e a configuração do provider (pasta do serviço ou global do usuário); o script mostra os logs do agente quando `/api/info` não responde. Para permissões/formulários pendentes, o smoke falha de propósito em vez de responder sozinho.
- **Tools/comando não aparecem após instalar**: reinicie a sessão principal (`dockercode`) — tools e commands são carregados na inicialização.
- **Porta `4096`**: é interna à rede `dockercode`; conflitos de porta no host não a afetam. Se o agente não responder nessa porta, veja `docker logs <nome>` e confirme que ele está na rede.

## Desinstalar

```bash
rm -f ~/.local/bin/dockercode ~/.local/bin/dockeragent ~/.local/bin/dockercode-config.sh
rm -rf ~/.config/dockercode
docker rmi opencode-run opencode-agent
docker network rm dockercode
```

> O `rm -rf ~/.config/dockercode` também remove a configuração global do usuário (`opencode.json`/`opencode.jsonc`), se você a mantém lá. Faça backup antes se quiser reaproveitá-la.
