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

```bash
npm install -g @snack-ai/cli
snack setup opencode    # or: snack setup claude
snack status
```

---

## English

### The problem

You are deep in something good. The code is finally taking shape. You send one more prompt — and the
provider says no. Not "in a minute". Just no.

Nobody warned you, because nobody could. Your provider does not publish your real limits, they move,
and they differ per account and per model. The only evidence anyone has about your usage is the
history sitting on your own disk.

SNACK reads that history and turns it into three things:

- **an estimate** — how likely your next prompt is to complete, as a range with a stated evidence
  level and a named method, never as a percentage of anything;
- **a description** — prompts, outcomes, restrictions, token dimensions, cost and durations over
  rolling horizons, with anything the source did not report left `unknown` rather than zeroed;
- **an audit trail** — every forecast is stored and later scored against what actually happened, so
  you can check whether SNACK has been right.

```text
work: 95-100% viability; risk low; evidence moderate; method bayesian-pressure-band@1;
pressure high; contributors prompts 100th, input_tokens 100th; category typical; sync ok.
Caveat: Real provider capacity is unknown.
```

Go ahead — but you are having one of your heaviest hours ever, so do not be surprised if that
changes.

### What it will not do

It does not know your provider's capacity, so it reports neither a share of it nor a countdown to
it. A tool showing you "63% of quota used" made that number up, and a made-up number is worse than
no number, because you will plan around it.

It makes no network calls, sends no telemetry, and reads no credentials. There is no service behind
it to send anything to.

### Quickstart

Requires Node.js 24 on Linux, macOS, or Windows through WSL2.

```bash
snack setup opencode   # guided: finds your history, asks only what it cannot observe
snack doctor           # check the installation
snack sync             # import history
snack status           # assess the next prompt
```

`setup` discovers your client's history, its schema fingerprint, and the providers already in it,
then asks for the few things it cannot see. Nothing is written until you confirm, and `Ctrl+D`
cancels cleanly. Two clients billing the same account can map to one capacity source, and SNACK will
treat their usage as the single pool it really is.

### Commands

| Command                                       | What it does                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `snack setup opencode` / `snack setup claude` | Map a capacity source; optionally register the live-capture plugin               |
| `snack sync`                                  | Import new history; `--full` re-reads and reconciles everything                  |
| `snack status`                                | Assess the next prompt, with usage pressure against your own baseline            |
| `snack stats`                                 | Describe observed usage over rolling horizons; `--verbose` adds per-model detail |
| `snack doctor`                                | Diagnose the local installation without changing it                              |
| `snack config`                                | Inspect or update local configuration                                            |
| `snack export`                                | Write your observations and predictions to JSON or CSV                           |
| `snack data purge`                            | Delete stored observations, optionally blocking their re-import                  |

Every command takes `--json` and emits one versioned document.

### How it decides, briefly

Observed outcomes update a **Beta-Binomial** posterior under a `Beta(½, ½)` Jeffreys prior, weighted
by exponential time decay with a seven-day half-life. Evidence is grouped into cells of capacity
period × usage-pressure band × prompt-size category, and the estimate uses the narrowest cell with
enough support, backing off to broader ones and reporting which level it used.

Four evidence gates cap what a history is allowed to claim, and the weakest one wins — a source that
has never been restricted cannot sound authoritative about restrictions. Risk reads off the lower
bound of the range, never the middle. Forecasts are scored against what followed, live and by
rolling-origin backtest, and reported as a Brier score with reliability buckets and empirical
interval coverage, each beside its sample size.

The full treatment, with references, is in
[packages/cli/README.md](./packages/cli/README.md#under-the-hood).

### Privacy

No prompt text, response text, project paths, titles, or credentials reach SNACK's database, spool,
logs, or exports. This is enforced by canary strings the test suite feeds through every capture path
in both output modes; one reaching any written byte fails the build. Configuration, database,
backups, and spool files are created `0600`, and `doctor` fails if it finds anything more
permissive.

### Live capture

`@snack-ai/opencode` is an optional plugin that appends content-free metadata to a local spool as
you work, so restrictions are observed when they happen rather than reconstructed later. It fails
open: it never throws into OpenCode and never blocks it. Claude Code needs no plugin — its JSONL
history already records refusals as structured fields, which is why no hook is registered in your
Claude settings ([ADR-0006](./docs/adr/0006-claude-jsonl-backfill-without-hooks.md)).

### How it got here

Ten releases, each with a single job. Nothing shipped until the thing before it was proven.

| Version | What it added                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.1.0` | Foundation: install, config, private storage, checksummed migrations, CI and a release pipeline. No forecast at all.                                                                  |
| `0.2.0` | First useful journey. Read-only OpenCode backfill, guided setup, and a deliberately broad initial estimate declaring `very_low` evidence.                                             |
| `0.3.0` | Live capture and the crash-safe spool, reconciled with backfill into one canonical history. Built but never published — superseded by `0.4.0`.                                        |
| `0.4.0` | Explainable analytics. Rolling horizons, token and cost dimensions, usage pressure as percentiles against your own past, plan profiles.                                               |
| `0.5.0` | The learned forecast. Beta-Binomial with hierarchical backoff, evidence gates, prediction snapshots, and rolling-origin backtesting.                                                  |
| `0.6.0` | **SNACK MVP.** All eight command groups, export and purge, security and platform hardening. The guaranteed migration baseline: every later release preserves your data.               |
| `0.7.0` | Claude Code, read through its JSONL history by a second adapter behind the same internal seam. Proof the core was not OpenCode-shaped.                                                |
| `0.8.0` | Client neutrality made executable. No client-specific type reaches the domain, two clients converge on one capacity source, and the public contracts became schemas instead of prose. |
| `0.9.0` | Feature freeze and public beta. Fuzzing four trust boundaries found three defects a green fixture suite never would. Six surfaces frozen and published.                               |
| `1.0.0` | First stable release. Strict SemVer on the public contracts, migration chains rehearsed from every published release, artifacts staged on an isolated registry before npm sees them.  |

The full staged plan, with per-wave exit criteria and everything deliberately left out, is in
[PLAN.md](./PLAN.md).

### Documentation

[PLAN.md](./PLAN.md) for scope and boundaries · [docs/specification.md](./docs/specification.md) for
behavior · [docs/architecture.md](./docs/architecture.md) for modules and data flow ·
[docs/compatibility.md](./docs/compatibility.md) for what the published contracts promise ·
[CONTEXT.md](./CONTEXT.md) for the domain vocabulary ·
[docs/opencode-support.md](./docs/opencode-support.md) and
[docs/claude-support.md](./docs/claude-support.md) for supported schema families ·
[docs/troubleshooting.md](./docs/troubleshooting.md) when something refuses.

Contributions: [CONTRIBUTING.md](./CONTRIBUTING.md). Security: [SECURITY.md](./SECURITY.md).
Apache-2.0.

---

## Português

### O problema

Você está fundo em algo bom. O código finalmente tomando forma. Manda mais um prompt — e o provedor
diz não. Não "daqui a pouco". Só não.

Ninguém te avisou, porque ninguém tinha como. Seu provedor não publica os seus limites reais, eles
mudam, e variam por conta e por modelo. A única evidência que existe sobre o seu uso é o histórico
parado no seu próprio disco.

O SNACK lê esse histórico e transforma em três coisas:

- **uma estimativa** — quão provável é o próximo prompt completar, como uma faixa com nível de
  evidência declarado e método nomeado, nunca como porcentagem de coisa alguma;
- **uma descrição** — prompts, desfechos, restrições, dimensões de token, custo e durações em
  horizontes móveis, com tudo que a fonte não reportou ficando `unknown` em vez de virar zero;
- **uma trilha de auditoria** — toda previsão é armazenada e depois pontuada contra o que de fato
  aconteceu, então dá para conferir se o SNACK vem acertando.

```text
work: 95-100% viability; risk low; evidence moderate; method bayesian-pressure-band@1;
pressure high; contributors prompts 100th, input_tokens 100th; category typical; sync ok.
Caveat: Real provider capacity is unknown.
```

Pode ir — mas você está vivendo uma das suas horas mais pesadas de todas, então não se assuste se
isso mudar.

### O que não faz

Não sabe a capacidade do seu provedor, então não reporta nem uma fração dela nem uma contagem
regressiva. Uma ferramenta que te mostra "63% da quota usada" inventou esse número, e número
inventado é pior que número nenhum, porque você vai se planejar em cima dele.

Não faz chamadas de rede, não envia telemetria e não lê credenciais. Não existe serviço por trás
para onde mandar qualquer coisa.

### Começando

Requer Node.js 24 em Linux, macOS ou Windows via WSL2.

```bash
snack setup opencode   # guiado: acha seu histórico, pergunta só o que não consegue observar
snack doctor           # confere a instalação
snack sync             # importa o histórico
snack status           # avalia o próximo prompt
```

O `setup` descobre o histórico do seu cliente, o fingerprint do schema e os provedores já presentes
nele, depois pergunta as poucas coisas que não consegue enxergar. Nada é escrito até você confirmar,
e `Ctrl+D` cancela sem sujeira. Dois clientes que cobram da mesma conta podem mapear para uma única
fonte de capacidade, e o SNACK trata o uso deles como o pote único que de fato é.

### Comandos

| Comando                                       | O que faz                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `snack setup opencode` / `snack setup claude` | Mapeia uma fonte de capacidade; opcionalmente registra o plugin de captura ao vivo |
| `snack sync`                                  | Importa histórico novo; `--full` relê e reconcilia tudo                            |
| `snack status`                                | Avalia o próximo prompt, com pressão de uso contra a sua própria linha de base     |
| `snack stats`                                 | Descreve o uso observado em horizontes móveis; `--verbose` detalha por modelo      |
| `snack doctor`                                | Diagnostica a instalação local sem alterá-la                                       |
| `snack config`                                | Consulta ou atualiza a configuração local                                          |
| `snack export`                                | Escreve suas observações e previsões em JSON ou CSV                                |
| `snack data purge`                            | Apaga observações armazenadas, opcionalmente bloqueando a reimportação             |

Todo comando aceita `--json` e emite um documento versionado.

### Como ele decide, em resumo

Os desfechos observados atualizam uma posterior **Beta-Binomial** sob prior de Jeffreys
`Beta(½, ½)`, ponderada por decaimento exponencial com meia-vida de sete dias. A evidência é
agrupada em células de período de capacidade × faixa de pressão de uso × categoria de tamanho do
prompt, e a estimativa usa a célula mais estreita com sustentação suficiente, recuando para as mais
amplas e reportando qual nível usou.

Quatro portões de evidência limitam o que um histórico pode afirmar, e o mais fraco vence — uma
fonte que nunca foi restringida não pode soar autoritária sobre restrições. O risco é lido pelo
limite inferior da faixa, nunca pelo meio. As previsões são pontuadas contra o que veio depois, ao
vivo e por backtest de origem móvel, e reportadas como Brier score com buckets de confiabilidade e
cobertura empírica do intervalo, cada um ao lado do seu tamanho de amostra.

O tratamento completo, com referências, está em
[packages/cli/README.md](./packages/cli/README.md#por-dentro).

### Privacidade

Nenhum texto de prompt, texto de resposta, caminho de projeto, título ou credencial chega ao banco,
ao spool, aos logs ou aos exports do SNACK. Isso é garantido por strings-canário que a suíte de
testes empurra por todos os caminhos de captura nos dois modos de saída; uma delas chegando a
qualquer byte escrito quebra o build. Configuração, banco, backups e arquivos de spool são criados
`0600`, e o `doctor` falha se encontrar algo mais permissivo.

### Captura ao vivo

`@snack-ai/opencode` é um plugin opcional que acrescenta metadados livres de conteúdo a um spool
local enquanto você trabalha, para que restrições sejam observadas quando acontecem em vez de
reconstruídas depois. Ele falha aberto: nunca lança exceção para dentro do OpenCode e nunca o
bloqueia. O Claude Code não precisa de plugin — o histórico JSONL dele já registra recusas como
campos estruturados, e é por isso que nenhum hook é registrado nas suas configurações do Claude
([ADR-0006](./docs/adr/0006-claude-jsonl-backfill-without-hooks.md)).

### Como chegamos aqui

Dez releases, cada uma com um único trabalho. Nada foi adiante antes de a anterior estar provada.

| Versão  | O que acrescentou                                                                                                                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.1.0` | Fundação: instalação, configuração, armazenamento privado, migrações com checksum, CI e pipeline de release. Nenhuma previsão ainda.                                                                     |
| `0.2.0` | Primeira jornada útil. Backfill somente-leitura do OpenCode, setup guiado e uma estimativa inicial propositalmente larga declarando evidência `very_low`.                                                |
| `0.3.0` | Captura ao vivo e o spool à prova de queda, reconciliado com o backfill num histórico canônico único. Construída e nunca publicada — superada pela `0.4.0`.                                              |
| `0.4.0` | Analítica explicável. Horizontes móveis, dimensões de token e custo, pressão de uso como percentis contra o seu próprio passado, perfis de plano.                                                        |
| `0.5.0` | A previsão aprendida. Beta-Binomial com backoff hierárquico, portões de evidência, snapshots de previsão e backtest de origem móvel.                                                                     |
| `0.6.0` | **SNACK MVP.** Os oito grupos de comando, export e purge, endurecimento de segurança e de plataforma. A linha de base garantida de migração: toda release posterior preserva os seus dados.              |
| `0.7.0` | Claude Code, lido pelo histórico JSONL por um segundo adaptador atrás da mesma costura interna. Prova de que o núcleo não tinha o formato do OpenCode.                                                   |
| `0.8.0` | Neutralidade de cliente virou executável. Nenhum tipo específico de cliente chega ao domínio, dois clientes convergem numa fonte de capacidade, e os contratos públicos viraram schemas em vez de prosa. |
| `0.9.0` | Congelamento de escopo e beta pública. Fuzzing em quatro fronteiras de confiança achou três defeitos que uma suíte de fixtures verde jamais acharia. Seis superfícies congeladas e publicadas.           |
| `1.0.0` | Primeira release estável. SemVer estrito nos contratos públicos, cadeias de migração ensaiadas a partir de toda release publicada, artefatos testados num registry isolado antes de o npm vê-los.        |

O plano completo por estágios, com critérios de saída por onda e tudo que ficou deliberadamente de
fora, está no [PLAN.md](./PLAN.md).

### Documentação

[PLAN.md](./PLAN.md) para escopo e limites · [docs/specification.md](./docs/specification.md) para
comportamento · [docs/architecture.md](./docs/architecture.md) para módulos e fluxo de dados ·
[docs/compatibility.md](./docs/compatibility.md) para o que os contratos publicados prometem ·
[CONTEXT.md](./CONTEXT.md) para o vocabulário do domínio ·
[docs/opencode-support.md](./docs/opencode-support.md) e
[docs/claude-support.md](./docs/claude-support.md) para as famílias de schema suportadas ·
[docs/troubleshooting.md](./docs/troubleshooting.md) quando algo recusar.

Contribuições: [CONTRIBUTING.md](./CONTRIBUTING.md). Segurança: [SECURITY.md](./SECURITY.md).
Apache-2.0.
