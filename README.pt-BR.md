# SNACK

**Saiba antes de alimentar o modelo.**

O SNACK estima a chance de o seu próximo prompt passar sem que o provedor o recuse por um limite de
requisições ou de uso. Trabalha só com metadados de uso, e nunca guarda nem julga o que os seus
prompts dizem.

SNACK é o Statistical Next-prompt Assessment & Calibration Kit: uma CLI local que descreve o uso
observado das suas ferramentas de IA e o transforma nessa estimativa. Roda inteiramente na sua
máquina, não guarda conteúdo de prompt nem de resposta, e nunca afirma conhecer a quota real do
provedor.

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
não sugere conserto, porque nem uma sequência mais curta nem mais histórico a estreitam sempre. A
partir da `1.6`, esse histórico ganha mais uma linha, porque nenhuma recusa sua está na evidência
ainda: "Your recent history has no restriction to learn from, so the low end of this interval comes
from SNACK's starting assumption rather than from your history." O piso de `29-100%` é a suposição
do SNACK, não algo que você viu acontecer.

Até onde uma resposta de sequência alcança está documentado no sentido direto. A resposta pesa mais
o histórico recente — o peso de um desfecho cai à metade a cada 30 desfechos posteriores nas mesmas
condições — então a evidência por trás dela satura perto de uma amostra efetiva de 44: dali em
diante, um histórico mais longo não estreita mais o intervalo.
[How far the answer reaches](./docs/specification/analysis.md#how-far-the-answer-reaches) tabula
isso num sentido só: um histórico e um comprimento entram, o intervalo típico sai. Lida de trás para
frente, para achar o comprimento em que um intervalo deixa de informar, ela seria uma contagem
calculada para você — a única coisa que o `--sequence` se recusa a fazer.

## Deixe aberto: `snack dash`

A partir da `1.6`, o `snack dash` põe todas as fontes de capacidade numa só tela cheia, que se
mantém atual enquanto você trabalha. Em cima, cada fonte numa linha, com as colunas que o
`snack status` simples imprime. Embaixo, a fonte selecionada em detalhe: a linha `next prompt`, a
evidência, a pressão com um marcador numa escala, um gráfico das últimas 24 horas, o que a puxou, e
as ressalvas.

```text
 snack dash · 2 capacity sources                    synced 6s ago · next in 54s
   SOURCE  NEXT PROMPT   RISK   EVIDENCE  PRESSURE  LAST SEEN   SYNC
 ▸ work      96-100%     low    moderate    low      35m ago     ok
   home      84-100%     low    very_low  unknown    3h ago      ok
 ──────────────────────────────────────────────────────────────────────────────
 work
   next prompt  96-100% chance it goes through · risk low
   evidence     moderate — some history, but few refusals seen yet
   pressure     low · lower than every window in your own history · typical pr…
                lightest ├●────────────────────────┤ heaviest
   by hour      ▃···········▆▅▇▃▆▅▅▁▃▃▃▁  each hour against your own history
                24h ago              now
   drivers      prompt count, input tokens
   as of        35m ago · period since 2026-10-03
   ! The estimate is not yet calibrated against observed outcomes.
   ! Real provider capacity is unknown.
   ! Usage pressure compares this window with local history; it is not a share
     of capacity.

 ↑↓ select   s next N   r sync now   ? help   q quit
```

A escala é um marcador entre as suas próprias horas mais leve e mais pesada, nunca uma barra
preenchida: uma barra se lê como quanto de um tanque já foi, e o SNACK não conhece o tanque. No
gráfico `by hour` cada hora é comparada com o seu próprio histórico, e `·` é uma hora sem nenhum
prompt, nunca uma hora calma.

`↑` `↓` selecionam uma fonte. `s` mostra ou esconde uma linha `next N` sob `next prompt`, e `+` e
`-` mudam `N` de um em um, de 1 a 100; começa em 10 e é sempre seu. Quando esse intervalo é largo
demais para informar, a linha não imprime número nenhum — só a frase que o `status --sequence`
imprimiria, com a linha da cauda da suposição inicial quando ela se aplica — e as teclas nunca pulam
nem param num comprimento por causa disso. `r` sincroniza agora, `?` abre a ajuda, `q` sai. Por
conta própria o dash sincroniza 60 segundos depois que a sincronização anterior terminou, num
processo filho, e o redesenho a cada segundo não lê nada do armazenamento. Estimativas-sombra nunca
aparecem nesta tela; o lugar delas é o `snack status --verbose`. Um aviso que uma leitura trouxe —
um perfil de plano que não pôde ser lido, por exemplo — é impresso uma vez quando você sai, depois
que o terminal é restaurado.

Ele precisa de um terminal. `snack dash | cat`, uma entrada redirecionada ou `--json` saem com `2` e
apontam para o `snack status`, que dá a mesma leitura por um pipe. Toda previsão que a tela desenha
é registrada como a de uma execução do `status`, e só quando o que ela mostra muda, então uma tela
deixada aberta o dia inteiro não conta como mil previsões.

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

| Comando                                     | O que faz                                                                                                                                                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snack setup opencode` / `claude` / `codex` | Mapeia uma fonte de capacidade; opcionalmente registra o plugin de captura ao vivo (só OpenCode)                                                                                                                                                                 |
| `snack sync`                                | Importa histórico novo; `--full` relê e reconcilia tudo                                                                                                                                                                                                          |
| `snack status`                              | Avalia o próximo prompt, com pressão de uso contra a sua própria linha de base; `--verbose` mostra os portões de evidência, o método, as versões de política e as estimativas-sombra; `--sequence <n>` acrescenta a chance de que todos os próximos `<n>` passem |
| `snack dash`                                | Acompanha todas as fontes numa tela cheia ao vivo; precisa de um terminal                                                                                                                                                                                        |
| `snack stats`                               | Descreve o uso observado em horizontes móveis; `--verbose` detalha por modelo e a calibração por método                                                                                                                                                          |
| `snack doctor`                              | Diagnostica a instalação local sem alterá-la                                                                                                                                                                                                                     |
| `snack config`                              | Consulta ou atualiza a configuração local                                                                                                                                                                                                                        |
| `snack export`                              | Escreve suas observações e previsões em JSON ou CSV                                                                                                                                                                                                              |
| `snack data purge`                          | Apaga observações armazenadas, opcionalmente bloqueando a reimportação                                                                                                                                                                                           |
| `snack update`                              | Traz o CLI e o plugin de captura para versões que combinam entre si                                                                                                                                                                                              |

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
`reported_capacity` no relatório daquela fonte. Ela fica local: o `export` não a carrega. As versões
do Codex suportadas e o que é lido estão em [docs/codex-support.md](./docs/codex-support.md).

### Um segundo método, em sombra

A partir da `1.5`, uma fonte do Codex também recebe uma **estimativa-sombra** (_shadow estimate_) de
um segundo método nomeado, `reported-capacity@1`. A linha de base agrupa o seu histórico por pressão
de uso; este o agrupa por **faixa declarada** (_stated band_) — `clear` abaixo de 80, `near` a
partir de 80, `full` em 100 — do número que o Codex declarou, quando cada prompt começou, sobre a
sua **janela determinante** (_binding window_): a janela da última declaração com o número mais
alto. As faixas são o jeito de o SNACK separar os seus próprios desfechos, não uma fração da
capacidade, e uma declaração com mais de seis horas não determina nada.

Ela é registrada e calibrada, e nunca é a resposta. A linha `next prompt`, o risco, a evidência e o
`--sequence` são os da linha de base, exatamente como a `1.4` os imprimia. Você vê a sombra em só
três lugares — a linha `shadow` do `status --verbose`, que diz que ela não é a resposta:

```text
$ snack status --source codex --verbose
codex
  next prompt  94-100% chance it goes through · risk low
  evidence     moderate — some history, but few refusals seen yet
  ...
  method       bayesian-pressure-band@1 · model stage5-prediction-v2
  reported     Codex states 85% of its 5h window, resets in 1h 32m · 30% of its 7d window, resets Thu UTC · 4m ago
  shadow       reported-capacity@1 would say 90-100% · risk low · evidence low — recorded to compare, not the answer above
               reads what Codex states about its 5h window — in the near band · reported-capacity-v1
               bayesian-pressure-band-hl50@1 would say 95-100% · risk low · evidence moderate
               bayesian-pressure-band-hl100@1 would say 96-100% · risk low · evidence moderate
               the answer's model with a 50- and a 100-prompt recency half-life instead of the answer's 30-prompt
  as of        3m ago · sync ok · period since 2026-10-03
  ...
```

— as três linhas `shadow` depois de `reported-capacity-v1` são as meias-vidas de recência mais
longas que toda fonte recebe a partir da `1.6`, [abaixo](#memórias-mais-longas-em-sombra) — o membro
aditivo `shadow` no relatório daquela fonte em `status --json` (a partir da `1.6`, também a primeira
entrada de `shadows`), e o bloco `by method` do `stats --verbose` (`calibration.by_method` no
`--json`), onde cada método é avaliado por si e cada sombra mais uma vez exatamente nos desfechos em
que a linha de base foi avaliada:

```text
$ snack stats --verbose
  ...
  by method
    bayesian-pressure-band@1        answer · live not available yet · backtest brier 0.004, sample 297
    reported-capacity@1             shadow · live not available yet · backtest brier 0.004, sample 281
                                    same outcomes as the baseline · live not available yet · backtest brier 0.004 against 0.004, sample 281, 1 restricted
    bayesian-pressure-band-hl50@1   shadow · live not available yet · backtest brier 0.004, sample 297
                                    same outcomes as the baseline · live not available yet · backtest brier 0.004 against 0.004, sample 297, 1 restricted
    bayesian-pressure-band-hl100@1  shadow · live not available yet · backtest brier 0.004, sample 297
                                    same outcomes as the baseline · live not available yet · backtest brier 0.004 against 0.004, sample 297, 1 restricted
```

Por que não deixá-la responder? No histórico real do Codex a partir do qual ela foi desenhada, 65
dias tiveram uma recusa, o Codex nunca declarou um número de 100, e o número em mãos quando o prompt
recusado começou era 20%. Um método que esse histórico não consegue calibrar não ganha o direito de
responder só pelo raciocínio. Uma minor futura só o promove se a calibração dele vencer a da linha
de base por uma regra escrita agora (`reported-capacity-promotion-v1`): num histórico real do Codex,
ao menos 200 previsões ao vivo conferidas, ao menos 5 restrições tanto ao vivo quanto no backtest, e
um Brier estritamente menor que o da linha de base nos mesmos desfechos, nos dois. Até lá nenhuma
configuração a liga, nem a desliga.

## Memórias mais longas, em sombra

A resposta pesa mais o histórico recente que o antigo: o peso de um desfecho cai à metade em sete
dias, e cai à metade de novo a cada 30 desfechos posteriores nas mesmas condições — a sua
**meia-vida de recência** (_recency half-life_). A partir da `1.6`, toda fonte — OpenCode, Claude
Code e Codex igualmente — recebe mais duas estimativas-sombra, `bayesian-pressure-band-hl50@1` e
`bayesian-pressure-band-hl100@1`: o próprio modelo da resposta com meias-vidas de recência de 50 e
de 100, e nada mais mudado. Uma memória mais longa estreita o intervalo num histórico estável;
também demora mais para perceber uma mudança.

As duas são registradas e calibradas ao lado da resposta e nunca mostradas como ela. O
`status --verbose` lista o que cada uma diria sob `shadow`, como acima; o `status --json` traz toda
estimativa-sombra num novo array `shadows` em toda fonte, enquanto o membro `shadow` do Codex fica
exatamente como a `1.5` o escrevia; e o `stats --verbose` (`calibration.by_method` no `--json`)
agora avalia toda fonte por método, cada variante pareada com a resposta nos mesmos desfechos. O
painel padrão, o `--sequence` e o `snack dash` nunca as mostram.

Qualquer uma delas só pode virar a resposta numa minor futura, pelo mesmo tipo de regra acima
(`recency-variant-promotion-v1`), mais uma condição que a calibração não compra: uma memória mais
longa só pode virar a resposta se ainda perceber um provedor mudando de comportamento tão rápido
quanto a atual percebe. É o teste de colapso pelo qual a meia-vida de 30 da resposta foi escolhida —
numa queda súbita simulada de quantos prompts passam, no máximo 2 execuções em 25 podem ainda
parecer seguras vinte desfechos depois do início da queda — e hoje as duas variantes falham nele. O
`npm run collapse:check` no repositório imprime as contagens.

## Como chegamos aqui

Cada release teve um único trabalho. Nada foi adiante antes de a anterior estar provada.

| Versão          | O que acrescentou                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.1.0`         | Fundação: instalação, configuração, armazenamento privado, migrações com checksum, CI e pipeline de release. Nenhuma previsão ainda.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `0.2.0`         | Primeira jornada útil. Backfill somente-leitura do OpenCode, setup guiado e uma estimativa inicial propositalmente larga declarando evidência `very_low`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `0.3.0`         | Captura ao vivo e o spool à prova de queda, reconciliado com o backfill num histórico canônico único. Construída e nunca publicada — superada pela `0.4.0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `0.4.0`         | Analítica explicável. Horizontes móveis, dimensões de token e custo, pressão de uso como percentis contra o seu próprio passado, perfis de plano.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `0.5.0`         | A previsão aprendida. Beta-Binomial com backoff hierárquico, portões de evidência, snapshots de previsão e backtest de origem móvel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `0.6.0`         | **SNACK MVP.** Os oito grupos de comando, export e purge, endurecimento de segurança e de plataforma. A linha de base garantida de migração: toda release posterior preserva os seus dados.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `0.7.0`         | Claude Code, lido pelo histórico JSONL por um segundo adaptador atrás da mesma costura interna. Prova de que o núcleo não tinha o formato do OpenCode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `0.8.0`         | Neutralidade de cliente virou executável. Nenhum tipo específico de cliente chega ao domínio, dois clientes convergem numa fonte de capacidade, e os contratos públicos viraram schemas em vez de prosa.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `0.9.0`         | Congelamento de escopo e beta pública. Fuzzing em quatro fronteiras de confiança achou três defeitos que uma suíte de fixtures verde jamais acharia. Seis superfícies congeladas e publicadas.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `1.0.0`         | Primeira release estável. SemVer estrito nos contratos públicos, cadeias de migração ensaiadas a partir de toda release publicada, artefatos testados num registry isolado antes de o npm vê-los.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `1.0.1` `1.0.2` | As primeiras releases guiadas por _usar_ o produto. Instalar a `1.0.0` publicada do npm e rodá-la contra um histórico real achou doze defeitos, três deles bloqueadores, todos invisíveis para uma suíte de testes verde.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `1.1.0`–`1.1.3` | Feito para ser lido. `snack update` põe o CLI e o plugin de captura em versões que combinam, e é o único comando que alcança a rede. `status` virou um painel e `stats` um par de tabelas, ambos escritos em palavras em vez de linhas para decifrar. Três patches saíram de rodar a build publicada contra um histórico real.                                                                                                                                                                                                                                                                                                  |
| `1.2.0` `1.2.1` | `status --verbose` dá ao método e aos portões de evidência um caminho humano, `man snack` é gerado da própria superfície de flags do CLI e verificado pela build, e um driver SQLite que não carrega é nomeado em vez de reportado como armazenamento danificado.                                                                                                                                                                                                                                                                                                                                                               |
| `1.3.0`         | Codex CLI, o terceiro cliente, lido dos rollouts por lista de campos permitidos. O número que o Codex declara sobre as próprias janelas é citado ao lado da estimativa, nunca dentro dela.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `1.4.0`         | `status --sequence <n>`: a chance de que todos os próximos `<n>` passem, do mesmo posterior, com intervalo, rótulo de risco e método nomeado próprios, e uma palavra clara quando esse intervalo é largo demais para informar. O número é sempre seu; o SNACK nunca deriva um.                                                                                                                                                                                                                                                                                                                                                  |
| `1.5.0`         | Um segundo método, `reported-capacity@1`, rodando em sombra nas fontes do Codex: agrupa o histórico pela faixa do número que o Codex declara, é registrado e calibrado ao lado da linha de base, e nunca responde a não ser que a calibração dele vença a da linha de base por uma regra escrita antes de ser lançado.                                                                                                                                                                                                                                                                                                          |
| `1.6.0` `1.6.1` | `snack dash`, todas as fontes numa tela ao vivo, com um marcador numa escala onde uma barra preenchida teria afirmado um tanque. Duas meias-vidas de recência mais longas rodam em sombra em toda fonte, e nenhuma pode responder sem passar também no teste de colapso pelo qual a meia-vida da resposta foi escolhida. O `1.6.1` confere todo registro do Claude Code contra a família pela qual é lido, não uma amostra, e mantém o uso guardado que uma releitura na mesma revisão contradiz; o plugin de captura dela, `1.0.5`, registra o primeiro prompt de cada sessão do OpenCode `1.18.15` sob o provedor dele mesmo. |

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
