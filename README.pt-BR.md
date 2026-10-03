# SNACK

**Saiba antes de alimentar o modelo.**

SNACK é o Statistical Next-prompt Assessment & Calibration Kit: uma CLI local que descreve o uso
observado das suas ferramentas de IA e estima se o próximo prompt tende a passar. Roda inteiramente
na sua máquina, não guarda conteúdo de prompt nem de resposta, e nunca afirma conhecer a quota real
do provedor.

In English: [README.md](./README.md).

```bash
npm install -g --allow-scripts=better-sqlite3 @snack-ai/cli   # compila o driver SQLite; o npm 12 pula sem isso
snack setup opencode    # ou: snack setup claude, snack setup codex
snack status
```

## O problema

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
$ snack status --source work
work
  next prompt  95-100% chance it goes through · risk low
  evidence     moderate — some history, but few refusals seen yet
  pressure     high · higher than every window in your own history · typical prompt
  drivers      prompt count, input tokens
  as of        9m ago · sync ok · period since 2026-10-03
  ! The estimate is not yet calibrated against observed outcomes.
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
```

Pode ir — mas você está vivendo uma das suas horas mais pesadas de todas, então não se assuste se
isso mudar. O método por trás da faixa não aparece neste painel: o `--verbose` o acrescenta, junto
com os portões de evidência e a posição de cada fator no seu próprio histórico. O `snack status`
sozinho põe cada fonte numa linha, para compará-las.

## O que não faz

Não sabe a capacidade do seu provedor, então não reporta nem uma fração dela nem uma contagem
regressiva. Uma ferramenta que te mostra "63% da quota usada" inventou esse número, e número
inventado é pior que número nenhum, porque você vai se planejar em cima dele.

Nenhum comando que toca seus dados toca a rede. Não envia telemetria, não lê credenciais, e não
existe serviço por trás para onde mandar qualquer coisa. A única exceção é o `snack update`, que
instala pacotes: ele carrega um nome de pacote e uma versão, e nada sobre o seu uso, em nenhuma das
direções.

## Mais do que o próximo

A partir da `1.4`, `--sequence <n>` põe uma segunda estimativa abaixo da primeira: a chance de que
todos os próximos `<n>` passem, e não só o próximo.

```text
$ snack status --source work --sequence 10
work
  next prompt  95-100% chance it goes through · risk low
  next 10      61-100% chance all 10 go through · risk elevated
  evidence     moderate — some history, but few refusals seen yet
  pressure     moderate · above 74% of your own history · typical prompt
  drivers      input tokens, output tokens
  as of        11m ago · sync ok · period since 2026-10-03
  ! The estimate is not yet calibrated against observed outcomes.
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
  ! The 10-prompt estimate assumes each prompt meets the conditions the next one does; it does not model usage pressure rising as they are sent.
```

A linha `next 10` é o mesmo tipo de resposta que `next prompt`, tirada do mesmo posterior: um
intervalo, um rótulo de risco lido pela base desse intervalo, e o nível de evidência da estimativa
do próximo prompt. Ela tem um método nomeado próprio, aqui `sequence-bayesian-pressure-band@1`, que
o `--verbose` e o `--json` mostram.

O número é sempre seu — um inteiro de 1 a 100; qualquer outra coisa sai com `2` sem repetir o que
você digitou. O SNACK nunca calcula um para você, e nunca transforma uma probabilidade numa contagem
de prompts: essa contagem seria uma afirmação sobre capacidade restante, que é exatamente o que ele
não sabe. A última linha acima diz o que a estimativa supõe.

Quando o intervalo é mais largo que metade da escala de probabilidade, mais uma linha diz isso com
todas as letras. No mesmo histórico, `--sequence 25` dá `29-100%` e acrescenta "The 25-prompt
interval is too wide to say much; it cannot tell whether all of them going through is more likely
than not." Isso não é a ferramenta falhando. É um "não dá para dizer" honesto: a faixa atravessa o
meio a meio, então não consegue dizer se é mais provável a sequência inteira passar do que não. Ela
não sugere conserto, porque nem uma sequência mais curta nem mais histórico a estreitam sempre.

## Começando

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

## Comandos

| Comando                                     | O que faz                                                                                                                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snack setup opencode` / `claude` / `codex` | Mapeia uma fonte de capacidade; opcionalmente registra o plugin de captura ao vivo (só OpenCode)                                                                                                                                          |
| `snack sync`                                | Importa histórico novo; `--full` relê e reconcilia tudo                                                                                                                                                                                   |
| `snack status`                              | Avalia o próximo prompt, com pressão de uso contra a sua própria linha de base; `--verbose` mostra os portões de evidência, o método e as versões de política; `--sequence <n>` acrescenta a chance de que todos os próximos `<n>` passem |
| `snack stats`                               | Descreve o uso observado em horizontes móveis; `--verbose` detalha por modelo                                                                                                                                                             |
| `snack doctor`                              | Diagnostica a instalação local sem alterá-la                                                                                                                                                                                              |
| `snack config`                              | Consulta ou atualiza a configuração local                                                                                                                                                                                                 |
| `snack export`                              | Escreve suas observações e previsões em JSON ou CSV                                                                                                                                                                                       |
| `snack data purge`                          | Apaga observações armazenadas, opcionalmente bloqueando a reimportação                                                                                                                                                                    |
| `snack update`                              | Traz o CLI e o plugin de captura para versões que combinam entre si                                                                                                                                                                       |

Todo comando aceita `--json` e emite um documento versionado. Todo comando também está no
`man snack`, gerado a partir da própria superfície de flags do CLI, então ele não descreve uma
versão que você não está rodando.

## Como ele decide, em resumo

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
[packages/cli/README.pt-BR.md](./packages/cli/README.pt-BR.md#por-dentro).

## Privacidade

Nenhum texto de prompt, texto de resposta, caminho de projeto, título ou credencial chega ao banco,
ao spool, aos logs ou aos exports do SNACK. Isso é garantido por strings-canário que a suíte de
testes empurra por todos os caminhos de captura nos dois modos de saída; uma delas chegando a
qualquer byte escrito quebra o build. Configuração, banco, backups e arquivos de spool são criados
`0600`, e o `doctor` falha se encontrar algo mais permissivo.

## Captura ao vivo

`@snack-ai/opencode` é um plugin opcional que acrescenta metadados livres de conteúdo a um spool
local enquanto você trabalha, para que restrições sejam observadas quando acontecem em vez de
reconstruídas depois. Ele falha aberto: nunca lança exceção para dentro do OpenCode e nunca o
bloqueia. O Claude Code não precisa de plugin — o histórico JSONL dele já registra recusas como
campos estruturados, e é por isso que nenhum hook é registrado nas suas configurações do Claude
([ADR-0006](./docs/adr/0006-claude-jsonl-backfill-without-hooks.md)).

## Codex CLI

A partir da `1.3`, `snack setup codex` lê os rollouts que o Codex CLI já escreve em `$CODEX_HOME`
(`~/.codex` quando não está definido): `sessions/**/rollout-*.jsonl` e `archived_sessions/`. Nada é
registrado na configuração do Codex e nenhum plugin entra na história. Cada linha é projetada numa
lista explícita de campos permitidos e o resto é descartado sem ser lido — mensagens, raciocínio,
chamadas de ferramenta e a saída delas, diretórios de trabalho e metadados de git nunca saem do
parser. O `~/.codex/history.jsonl`, o histórico bruto de prompts do Codex, nunca é aberto.

O Codex também declara um número próprio: uma fração de cada janela que ele acompanha, a duração
dessa janela e quando ela reinicia. O SNACK o cita — é **uso de capacidade reportado**, a declaração
do cliente, não do SNACK — numa linha só dele, ao lado da estimativa:

```text
$ snack status --source codex
codex
  next prompt  95-100% chance it goes through · risk low
  evidence     moderate — some history, but few refusals seen yet
  pressure     high · higher than every window in your own history · typical prompt
  drivers      prompt count, input tokens
  reported     Codex states 34% of its 5h window, resets in 3h 10m · 19% of its 7d window, resets Wed UTC · 9m ago
  as of        9m ago · sync ok · period since 2026-10-03
  ! The estimate is not yet calibrated against observed outcomes.
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
```

A linha `reported` nunca faz parte do intervalo de `next prompt`, do nível de evidência nem da
pressão de uso; nada na previsão a lê, e um teste garante que a estimativa é idêntica com e sem ela
([ADR-0007](./docs/adr/0007-quote-codex-reported-capacity.md)). No `--json` ela é o array opcional
`reported_capacity` no relatório daquela fonte. Na `1.3` ela fica local: o `export` não a carrega.
As versões do Codex suportadas e o que é lido estão em
[docs/codex-support.md](./docs/codex-support.md).

## Como chegamos aqui

Cada release teve um único trabalho. Nada foi adiante antes de a anterior estar provada.

| Versão          | O que acrescentou                                                                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0.1.0`         | Fundação: instalação, configuração, armazenamento privado, migrações com checksum, CI e pipeline de release. Nenhuma previsão ainda.                                                                                                                                                                                           |
| `0.2.0`         | Primeira jornada útil. Backfill somente-leitura do OpenCode, setup guiado e uma estimativa inicial propositalmente larga declarando evidência `very_low`.                                                                                                                                                                      |
| `0.3.0`         | Captura ao vivo e o spool à prova de queda, reconciliado com o backfill num histórico canônico único. Construída e nunca publicada — superada pela `0.4.0`.                                                                                                                                                                    |
| `0.4.0`         | Analítica explicável. Horizontes móveis, dimensões de token e custo, pressão de uso como percentis contra o seu próprio passado, perfis de plano.                                                                                                                                                                              |
| `0.5.0`         | A previsão aprendida. Beta-Binomial com backoff hierárquico, portões de evidência, snapshots de previsão e backtest de origem móvel.                                                                                                                                                                                           |
| `0.6.0`         | **SNACK MVP.** Os oito grupos de comando, export e purge, endurecimento de segurança e de plataforma. A linha de base garantida de migração: toda release posterior preserva os seus dados.                                                                                                                                    |
| `0.7.0`         | Claude Code, lido pelo histórico JSONL por um segundo adaptador atrás da mesma costura interna. Prova de que o núcleo não tinha o formato do OpenCode.                                                                                                                                                                         |
| `0.8.0`         | Neutralidade de cliente virou executável. Nenhum tipo específico de cliente chega ao domínio, dois clientes convergem numa fonte de capacidade, e os contratos públicos viraram schemas em vez de prosa.                                                                                                                       |
| `0.9.0`         | Congelamento de escopo e beta pública. Fuzzing em quatro fronteiras de confiança achou três defeitos que uma suíte de fixtures verde jamais acharia. Seis superfícies congeladas e publicadas.                                                                                                                                 |
| `1.0.0`         | Primeira release estável. SemVer estrito nos contratos públicos, cadeias de migração ensaiadas a partir de toda release publicada, artefatos testados num registry isolado antes de o npm vê-los.                                                                                                                              |
| `1.0.1` `1.0.2` | As primeiras releases guiadas por _usar_ o produto. Instalar a `1.0.0` publicada do npm e rodá-la contra um histórico real achou doze defeitos, três deles bloqueadores, todos invisíveis para uma suíte de testes verde.                                                                                                      |
| `1.1.0`–`1.1.3` | Feito para ser lido. `snack update` põe o CLI e o plugin de captura em versões que combinam, e é o único comando que alcança a rede. `status` virou um painel e `stats` um par de tabelas, ambos escritos em palavras em vez de linhas para decifrar. Três patches saíram de rodar a build publicada contra um histórico real. |
| `1.2.0` `1.2.1` | `status --verbose` dá ao método e aos portões de evidência um caminho humano, `man snack` é gerado da própria superfície de flags do CLI e verificado pela build, e um driver SQLite que não carrega é nomeado em vez de reportado como armazenamento danificado.                                                              |
| `1.3.0`         | Codex CLI, o terceiro cliente, lido dos rollouts por lista de campos permitidos. O número que o Codex declara sobre as próprias janelas é citado ao lado da estimativa, nunca dentro dela.                                                                                                                                     |
| `1.4.0`         | `status --sequence <n>`: a chance de que todos os próximos `<n>` passem, do mesmo posterior, com intervalo, rótulo de risco e método nomeado próprios, e uma palavra clara quando esse intervalo é largo demais para informar. O número é sempre seu; o SNACK nunca deriva um.                                                 |

O plano completo por estágios, com critérios de saída por onda e tudo que ficou deliberadamente de
fora, está no [PLAN.md](./PLAN.md).

## Documentação

[PLAN.md](./PLAN.md) para escopo e limites · [docs/specification.md](./docs/specification.md) para
comportamento · [docs/architecture.md](./docs/architecture.md) para módulos e fluxo de dados ·
[docs/compatibility.md](./docs/compatibility.md) para o que os contratos publicados prometem ·
[CONTEXT.md](./CONTEXT.md) para o vocabulário do domínio ·
[docs/opencode-support.md](./docs/opencode-support.md),
[docs/claude-support.md](./docs/claude-support.md) e
[docs/codex-support.md](./docs/codex-support.md) para as famílias de schema suportadas ·
[docs/troubleshooting.md](./docs/troubleshooting.md) quando algo recusar.

Contribuições: [CONTRIBUTING.md](./CONTRIBUTING.md). Segurança: [SECURITY.md](./SECURITY.md).
Apache-2.0.
