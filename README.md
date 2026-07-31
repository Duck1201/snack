# SNACK

**Know before you feed the model.**

SNACK is the Statistical Next-prompt Assessment & Calibration Kit: a local-first CLI that describes
your observed AI-tool usage and estimates whether the next prompt is likely to go through. It runs
entirely on your machine, stores no prompt or response content, and never claims to know a
provider's real quota.

SNACK é o Statistical Next-prompt Assessment & Calibration Kit: uma CLI local que descreve o uso
observado das suas ferramentas de IA e estima se o próximo prompt tende a passar. Roda inteiramente
na sua máquina, não guarda conteúdo de prompt nem de resposta, e nunca afirma conhecer a quota real
do provedor.

[English](#english) · [Português](#português)

---

## English

### What it does

SNACK reads what your AI tool already recorded — currently [OpenCode](https://opencode.ai) — and
turns it into three things:

- **an estimate**: how likely your next prompt is to complete, as an interval with a stated evidence
  level and a named method, never a percentage of anything;
- **a description**: prompt counts, outcomes, restrictions, token dimensions, cost and durations
  over rolling horizons, with anything the source did not report left `unknown` rather than zeroed;
- **an audit trail**: every forecast is stored and later compared against what actually happened, so
  you can check whether SNACK has been right.

### What it does not do

It does not know your provider's capacity, so it reports neither a share of it nor a countdown to it
— nothing a local tool can observe supports either. Every estimate comes with an interval, an
evidence level, and the name of the method behind it. It makes no network calls, sends no telemetry,
and reads no credentials.

### Install

Requires Node.js 24. `0.6.0` is the MVP and the default install:

```bash
npm install -g @snack-ai/cli
```

### Quickstart

```bash
snack setup opencode   # guided: finds your database, asks only what it cannot observe
snack doctor           # check the installation
snack sync             # import history
snack status           # assess the next prompt
```

`setup` discovers your OpenCode database, its schema fingerprint, and the providers already in it,
then asks for the few things it cannot see. Nothing is written until you confirm, and `Ctrl+D`
cancels cleanly. To script it, pass every value as a flag — see
[packages/cli/README.md](./packages/cli/README.md).

### Commands

| Command                | What it does                                                                     |
| ---------------------- | -------------------------------------------------------------------------------- |
| `snack setup opencode` | Map a capacity source, and optionally register the live-capture plugin           |
| `snack sync`           | Import new history; `--full` re-reads everything                                 |
| `snack status`         | Assess the next prompt, with usage pressure against your own baseline            |
| `snack stats`          | Describe observed usage over rolling horizons; `--verbose` adds per-model detail |
| `snack doctor`         | Diagnose the local installation without changing it                              |
| `snack config`         | Inspect or update local configuration                                            |
| `snack export`         | Write your observations and predictions to JSON or CSV                           |
| `snack data purge`     | Delete stored observations, optionally blocking their re-import                  |

Every command takes `--json` and emits one versioned document.

### Privacy

No prompt text, response text, project paths, titles, or credentials reach SNACK's database, spool,
logs, or exports — this is enforced by canary strings the test suite feeds through every capture
path. Configuration, database, backups, and spool files are created `0600`, and `doctor` fails if it
finds anything more permissive.

### Live capture

`@snack-ai/opencode` is an optional plugin that appends content-free metadata to a local spool as
you work, so restrictions are observed when they happen rather than reconstructed later. It fails
open: it never throws into OpenCode and never blocks it.

### Documentation

[PLAN.md](./PLAN.md) for scope and boundaries · [docs/specification.md](./docs/specification.md) for
behavior · [CONTEXT.md](./CONTEXT.md) for the domain vocabulary ·
[docs/opencode-support.md](./docs/opencode-support.md) for supported schema families.

---

## Português

### O que faz

SNACK lê o que sua ferramenta de IA já registrou — hoje o [OpenCode](https://opencode.ai) — e
transforma isso em três coisas:

- **uma estimativa**: quão provável é o próximo prompt completar, como um intervalo com nível de
  evidência declarado e método nomeado, nunca como porcentagem de coisa alguma;
- **uma descrição**: contagem de prompts, desfechos, restrições, dimensões de token, custo e
  durações em horizontes móveis, com tudo que a fonte não reportou ficando `unknown` em vez de virar
  zero;
- **uma trilha de auditoria**: toda previsão é armazenada e depois comparada com o que de fato
  aconteceu, então dá para conferir se o SNACK vem acertando.

### O que não faz

Não sabe a capacidade do seu provedor, então não reporta nem uma fração dela nem uma contagem
regressiva para ela — nada que uma ferramenta local consegue observar sustenta isso. Toda estimativa
vem com intervalo, nível de evidência e o nome do método por trás dela. Não faz chamadas de rede,
não envia telemetria e não lê credenciais.

### Instalação

Requer Node.js 24. A `0.6.0` é o MVP e a instalação padrão:

```bash
npm install -g @snack-ai/cli
```

### Primeiros passos

```bash
snack setup opencode   # guiado: acha seu banco e pergunta só o que não dá para observar
snack doctor           # verifica a instalação
snack sync             # importa o histórico
snack status           # avalia o próximo prompt
```

O `setup` descobre o banco do OpenCode, a impressão digital do schema e os provedores já presentes
nele, depois pergunta as poucas coisas que não consegue ver. Nada é escrito até você confirmar, e
`Ctrl+D` cancela sem deixar rastro. Para automatizar, passe todos os valores como flags — veja
[packages/cli/README.md](./packages/cli/README.md).

### Comandos

| Comando                | O que faz                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `snack setup opencode` | Mapeia uma fonte de capacidade e, opcionalmente, registra o plugin de captura ao vivo |
| `snack sync`           | Importa histórico novo; `--full` relê tudo                                            |
| `snack status`         | Avalia o próximo prompt, com pressão de uso contra a sua própria linha de base        |
| `snack stats`          | Descreve o uso observado em horizontes móveis; `--verbose` detalha por modelo         |
| `snack doctor`         | Diagnostica a instalação local sem alterar nada                                       |
| `snack config`         | Consulta ou atualiza a configuração local                                             |
| `snack export`         | Escreve suas observações e previsões em JSON ou CSV                                   |
| `snack data purge`     | Apaga observações armazenadas, opcionalmente bloqueando a reimportação                |

Todo comando aceita `--json` e emite um documento versionado.

### Privacidade

Nenhum texto de prompt, texto de resposta, caminho de projeto, título ou credencial chega ao banco,
ao spool, aos logs ou às exportações do SNACK — isso é garantido por strings-canário que a suíte de
testes faz atravessar cada caminho de captura. Configuração, banco, backups e spool são criados
`0600`, e o `doctor` falha se encontrar qualquer coisa mais permissiva.

### Captura ao vivo

`@snack-ai/opencode` é um plugin opcional que acrescenta metadados sem conteúdo a um spool local
enquanto você trabalha, para que restrições sejam observadas quando acontecem em vez de
reconstruídas depois. Ele falha aberto: nunca lança exceção para dentro do OpenCode nem o bloqueia.

### Documentação

[PLAN.md](./PLAN.md) para escopo e limites · [docs/specification.md](./docs/specification.md) para
comportamento · [CONTEXT.md](./CONTEXT.md) para o vocabulário de domínio ·
[docs/opencode-support.md](./docs/opencode-support.md) para as famílias de schema suportadas.
