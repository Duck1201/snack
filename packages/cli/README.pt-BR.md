# @snack-ai/cli

**Saiba antes de alimentar o modelo.**

In English: [README.md](./README.md).

## A versão amigável

Você conhece a sensação. Três horas dentro de algo bom, o código finalmente tomando forma, você
manda mais um prompt — e o provedor diz não. Não "daqui a pouco". Só não. O fio esfriou, o embalo
foi embora, e você não teve aviso nenhum.

SNACK é um comando pequeno que tenta te dar esse aviso.

Ele lê o histórico que sua ferramenta de IA já guarda na sua própria máquina, calcula o quanto você
tem forçado ultimamente, e diz o quão provável é que o próximo prompt passe. É essa a ideia inteira.
Sem conta, sem cadastro, sem servidor, sem telemetria. Nenhum comando que toca seus dados toca a
rede, porque não existe lugar nenhum para onde mandar. O `snack update` é a única exceção, e ele só
instala pacotes.

```bash
npm install -g --allow-scripts=better-sqlite3 @snack-ai/cli   # compila o driver SQLite; o npm 12 pula sem isso
snack setup opencode    # ou: snack setup claude, snack setup codex
snack status
```

```text
$ snack status --source work
work
  next prompt  96-100% chance it goes through · risk low
  evidence     moderate — some history, but few refusals seen yet
  pressure     high · higher than every window in your own history · typical prompt
  drivers      prompt count, input tokens
  as of        5m ago · sync ok · period since 2026-10-03
  ! The estimate is not yet calibrated against observed outcomes.
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
```

Em português claro, essa linha diz: **pode ir, você está quase certamente bem — mas está vivendo uma
das suas horas mais pesadas de todas, então não se assuste se isso mudar.** As duas metades
importam. A primeira é a resposta; a segunda é o contexto que torna a resposta honesta.

O que cada pedaço quer dizer, sem exigir estatística:

| Você vê                                        | Quer dizer                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `96-100% chance it goes through`               | Uma faixa, não uma promessa. Em algum ponto dela está a chance do próximo prompt completar.                                        |
| `risk low`                                     | Lido pela **base** da faixa, nunca pelo meio. Uma faixa larga nunca consegue parecer confiante.                                    |
| `evidence moderate`                            | O quanto o seu próprio histórico sustenta isso. Instalação nova diz `very_low`, e é sincera.                                       |
| `pressure high`                                | Você, agora, comparado a você num dia normal. Nada a ver com os limites do provedor.                                               |
| `higher than every window in your own history` | Onde esta janela fica entre as suas — esta é a sua hora mais movimentada já registrada.                                            |
| `typical prompt`                               | O tamanho do seu próximo prompt perto dos seus prompts de sempre.                                                                  |
| `drivers`                                      | O que está puxando a pressão para cima: aqui, quantos prompts você mandou e quanta entrada eles levaram.                           |
| `as of`                                        | A idade do uso mais recente, se o último sync deu certo, e quando o período de capacidade atual (este plano, nesta conta) começou. |
| `!`                                            | O que o SNACK não pode afirmar. Estão em todo painel; num histórico ralo a primeira diz que a suposição inicial ainda domina.      |

O método, e o portão de evidência que segura o nível, estão a uma flag de distância. O `--verbose`
os acrescenta ao mesmo painel, e dá a posição de cada fator:

```text
$ snack status --source work --verbose
  ...
  drivers      prompt count higher than every window in your own history, input tokens higher than every window in your own history
  gates        sample high · restrictions moderate (limiting) · relevance moderate (limiting) · completeness high
  method       bayesian-pressure-band@1 · model stage5-prediction-v2
  ...
```

Dois portões seguram este em `moderate`: `restrictions`, porque o SNACK ainda não viu uma recusa
nesta pressão, e `relevance`, porque a estimativa junta prompts de todo tamanho nesta pressão em vez
de só prompts como o seu. Mais prompts, sozinhos, não o elevam. O `snack status` sozinho, sem
`--source`, põe cada fonte numa linha para você compará-las.

E o `snack stats` mostra como a sua semana realmente foi:

```text
$ snack stats
work · anthropic max · generic@1.0.0 · pressure high, rising

  WINDOW  PROMPTS  COUNTED    REFUSED     SET ASIDE  COST  TYPICAL  SLOWEST 10%
  1h        28       28          —            0       —      25s        40s
  5h        38       38          —            0       —      22s        38s
  1d        41       41          —            0       —      23s        40s
  7d        234      234    2 rate limit      0       —      25s        40s

  WINDOW  INPUT  OUTPUT  REASONING  CACHE READ  CACHE WRITE
  1h      3.23K  37.7K       —        1.83M        41.8K
  5h      4.08K  53.5K       —        2.60M        67.1K
  1d      4.49K  56.9K       —        2.76M        70.7K
  7d      25.2K   316K       —        14.7M        466K

  3 forecasts checked against what happened next
  observed up to 2026-10-03T08:57:06.752Z
```

234 prompts em sete dias, duas vezes ouvindo não, um prompt típico de vinte e cinco segundos, e
quase quinze milhões de tokens relidos do cache. O custo aparece como `—` porque o Claude Code não o
registra, e o SNACK não inventa um. Isso é uma semana da sua vida de trabalho, medida — e nunca saiu
do seu notebook.

## A única coisa que o SNACK se recusa a fazer

Ele nunca vai te mostrar uma porcentagem da sua quota.

Não porque seria difícil. Porque seria **mentira**. Seu provedor não publica os seus limites reais,
eles mudam, e variam por conta e por modelo. Qualquer ferramenta que te mostre "63% da quota usada"
inventou esse número, e número inventado é pior que número nenhum, porque você vai se planejar em
cima dele.

Então o SNACK mostra o que ele consegue de fato enxergar: o seu uso, uma faixa honesta, quanta
evidência sustenta ela, e qual método a produziu. Quando sabe pouco, ele diz alto e claro, e uma
instalação nova recebe faixa larga e evidência `very_low` em vez de um conforto falso.

Um cliente declara, sim, um número próprio. O Codex CLI registra, para cada janela que acompanha,
uma fração, a duração da janela e quando ela reinicia. O SNACK cita isso como declaração do cliente
— numa linha `reported` ao lado da estimativa, nunca dentro dela — e não transforma isso em
afirmação sobre capacidade nenhuma, nem mesmo sobre aquela de que o Codex está falando.

Nada do que você escreve é guardado. Nem texto de prompt, nem resposta, nem credencial, nem os
caminhos dos seus projetos. Isso não é uma nota de política — é um teste que empurra strings-canário
por todos os comandos e quebra o build se uma única delas aparecer em qualquer byte que o SNACK
escreve.

## Os comandos

| Comando                                     | O que faz                                                                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snack setup opencode` / `claude` / `codex` | Mapeia um cliente para uma fonte de capacidade. Mostra cada mudança antes, faz backup, não escreve nada sem sua confirmação.                                                              |
| `snack status`                              | A avaliação do próximo prompt: faixa, risco, evidência, pressão e o que a puxou, atualidade dos dados. `--verbose` acrescenta os portões de evidência, o método e as versões de política. |
| `snack stats`                               | Como o seu uso realmente é ao longo de horizontes móveis, e como as previsões passadas se saíram.                                                                                         |
| `snack sync`                                | Importa histórico novo. `--full` relê e reconcilia tudo sem duplicar nada.                                                                                                                |
| `snack export`                              | Exporta tudo em JSON ou CSV com schema e proveniência. Os dados continuam seus.                                                                                                           |
| `snack data purge`                          | Apaga o escopo que você escolher, transacionalmente, depois de mostrar exatamente o que vai.                                                                                              |
| `snack config`                              | Lê e edita a configuração local.                                                                                                                                                          |
| `snack doctor`                              | Diagnostica a instalação sem alterá-la: permissões, fingerprints de schema, integridade.                                                                                                  |
| `snack update`                              | Traz o CLI e o plugin de captura para versões que combinam. O único comando que instala.                                                                                                  |

Todo comando aceita `--json` e responde com um documento versionado, então automatizar nunca
significa fazer parsing de prosa. Todo comando também está no `man snack`, que vem no pacote e é
gerado a partir da própria superfície de flags do CLI — uma flag não documentada reprova o build em
vez de chegar até você.

Dois clientes podem dividir uma fonte de capacidade. Se OpenCode, Claude Code ou Codex CLI cobram da
mesma conta, mapeie todos para o mesmo alias e o SNACK vai tratar o uso deles como o pote único que
ele de fato é.

---

## Por dentro

Tudo acima é uma casca relativamente fina sobre um punhado de resultados estatísticos bem
estabelecidos. O SNACK não reivindica novidade; o valor está em aplicá-los com honestidade a dados
esparsos e auto-coletados, e em se recusar a exagerar o resultado. O que vem a seguir é a maquinaria
de verdade, com referências, para você conferir o raciocínio em vez de confiar nele.

#### A previsão

A viabilidade do prompt é estimada como uma taxa de sucesso Bernoulli com um modelo conjugado
**Beta-Binomial**. Os desfechos observados de uma fonte de capacidade atualizam uma posterior Beta,
e a faixa reportada é um par de quantis Beta num alvo de cobertura declarado (`0,8` por padrão,
reportado no documento como `coverage_target`).

O prior é `Beta(½, ½)` — o **prior de Jeffreys** para uma proporção binomial (Jeffreys, 1946),
invariante a reparametrização e que, diferente do intervalo de Wald, não colapsa para largura zero
quando uma fonte nunca viu restrição alguma. Brown, Cai & DasGupta (2001) comparam as alternativas e
recomendam exatamente esse intervalo para amostras pequenas — que é o regime em que quase toda
instalação do SNACK vive.

Os desfechos são ponderados por **decaimento exponencial no tempo** com meia-vida de sete dias,
então um padrão de um mês atrás ainda conta, mas não vence esta semana no voto. O resultado aparece
como `effective_samples`: o tamanho de amostra que a ponderação realmente vale, sempre menor que a
contagem bruta e sempre exibido ao lado dela.

#### Backoff, e por que células

Prever a partir de "todos os seus prompts, sempre" joga fora o fato de que um prompt pesado na sua
hora mais cheia não é a mesma aposta que um pequeno num domingo calmo. Então os desfechos são
agrupados em células de **período de capacidade × faixa de pressão de uso × categoria de tamanho do
prompt**, e a estimativa usa a célula mais estreita com evidência suficiente, recuando por células
progressivamente mais largas:

```
período + faixa de pressão + categoria de tamanho  →  período + faixa de pressão  →  período  →  só o prior
```

O nível efetivamente usado é reportado em `contributors.backoff_level`, então uma previsão nunca
esconde o quão específica era a evidência dela. Isso é pooling parcial hierárquico comum: tomar
força emprestada do grupo mais amplo quando o estreito está ralo, no espírito de Efron & Morris
(1975). Só um período de capacidade sem nenhum desfecho elegível cai para o prior sozinho, e esse
caso reporta o método como `initial-generic` em vez de fingir ser uma estimativa aprendida.

**Um período de capacidade recomeça quando você muda o provedor, o perfil, o plano ou o perfil de
plano** — rodar `snack setup` de novo com um `--plan` diferente já basta. Isso é deliberado: um
plano diferente é um regime de capacidade diferente, e desfechos do antigo não são evidência sobre o
novo. Então as próximas previsões se apoiam no perfil de plano até o novo regime ter história
própria, e o `setup` avisa quantos prompts observados deixam de informar a estimativa antes de isso
acontecer. Nada é apagado — `stats`, `observed` e `as_of` seguem reportando tudo que a fonte guarda.

#### Portões de evidência, e por que um histórico longo ainda pode ser fraco

Uma faixa sozinha convida à leitura exagerada, então toda previsão carrega um nível de evidência na
escada `very_low → low → moderate → high`. Quatro portões independentes nomeiam cada um o nível mais
alto que conseguem sustentar, e **o portão mais fraco limita o resultado**:

| Portão         | Pergunta                                                        |
| -------------- | --------------------------------------------------------------- |
| `sample`       | Há evidência efetiva suficiente depois do decaimento?           |
| `restrictions` | Alguma restrição chegou a ser observada?                        |
| `relevance`    | Quanto o backoff precisou viajar para longe da célula estreita? |
| `completeness` | A ingestão está completa, ou falta histórico?                   |

O portão `restrictions` é o que sustenta a estrutura. Uma fonte que rodou meses sem uma única recusa
tem dados de sobra sobre sucesso e quase nenhum sobre falha, e não pode soar autoritária justamente
sobre a coisa que nunca viu. Essa é a forma prática da distinção que Gneiting, Balabdaoui & Raftery
(2007) fazem entre **calibração** e **nitidez**: estar certo na média não é o mesmo que ser
útilmente preciso, e uma previsão jamais deve comprar a segunda ao custo da primeira.

Os rótulos de risco derivam do **limite inferior** do intervalo sob uma política de limiares
versionada, nunca da estimativa pontual — é isso que faz uma faixa larga ser lida de forma
conservadora em vez de rachar a diferença.

#### Pressão de uso

A pressão ordena a janela móvel atual contra as suas próprias janelas anteriores do mesmo tamanho,
por dimensão — prompts, cada tipo de token, custo, duração. Os percentis são combinados sob uma
ponderação versionada, mesclada do perfil de plano em direção a uma ponderação neutra conforme a
evidência local se acumula, e as dimensões que mais contribuíram são reportadas para que a faixa
nunca seja um veredito pelado.

Os horizontes padrão são `PT1H`, `PT5H`, `P1D`, `P7D`, semiabertos, e uma janela sem prompts é
tratada como **ausência de observação**, não como zero — a distinção que impede um fim de semana
tranquilo de parecer um colapso de uso. Um número mínimo de janelas de linha de base é exigido antes
de qualquer janela ser ordenada; abaixo disso, a pressão reporta `unknown` em vez de chutar.

Pressão é relativa a você. Não é, e nunca é apresentada como, uma fração da capacidade do provedor.

#### Calibração: isso tudo funciona mesmo?

Afirmar 90% é fácil. Acertar 90% das vezes é a parte que precisa ser medida, e o SNACK mede de duas
formas, mantidas como fluxos separados que nunca são misturados numa média:

- **Live** — previsões efetivamente entregues a você, pontuadas contra o que aconteceu em seguida.
- **Backtest** — replay de origem móvel, onde cada previsão é reconstruída apenas com o prefixo de
  histórico que a precedeu, com o relógio ajustado para aquele prompt. É o desenho de avaliação
  fora-da-amostra descrito por Tashman (2000); os testes de propriedade garantem que acrescentar
  histórico futuro nunca muda uma previsão passada — o que transforma vazamento temporal em build
  quebrado, não em preocupação.

Ambos reportam:

- **Brier score** (Brier, 1950) — erro quadrático médio da previsão probabilística. `0` é perfeito,
  `0,25` é o que se ganha dizendo sempre 50%. No exemplo acima, `0,010` sobre 980 previsões
  reproduzidas.
- **Confiabilidade por bucket** — faixas de 0,1, comparando probabilidade afirmada com frequência
  observada. É o componente de confiabilidade da decomposição do Brier de Murphy (1973).
- **Cobertura empírica do intervalo** — com que frequência o desfecho real caiu dentro da faixa
  publicada, medida por bucket contra o intervalo daquele bucket.

Todo número vem ao lado do seu tamanho de amostra, e nunca como zero quando a amostra está vazia:
`not_available` e `0,000` são afirmações muito diferentes, e confundir as duas é como um painel
começa a se elogiar sozinho.

Em simulação com 1.500 ensaios por taxa, a cobertura empírica mediu 0,911 / 0,880 / 0,863 / 0,864
contra taxas reais de restrição de 0,02 / 0,05 / 0,10 / 0,25. O alvo declarado de `0,8` é portanto
um **piso**, não uma afirmação exata, e está documentado como tal.

#### Versionamento

Toda política capaz de mudar uma interpretação carrega uma versão, carimbada na linha que produziu:
o parser, o classificador, o analisador, a política de previsão, a de evidência, os limiares de
risco, as definições de calibração. Uma previsão feita mês passado pode ser lida com as regras que a
fizeram, e não com as de hoje. A partir da `1.0`, o envelope JSON, o documento de export, o schema
de configuração, os códigos de saída, as flags documentadas e o contrato do spool são contratos
públicos sob SemVer estrito.

#### Referências

- Brier, G. W. (1950). Verification of forecasts expressed in terms of probability. _Monthly Weather
  Review_, 78(1), 1–3.
- Brown, L. D., Cai, T. T., & DasGupta, A. (2001). Interval estimation for a binomial proportion.
  _Statistical Science_, 16(2), 101–133.
- Efron, B., & Morris, C. (1975). Data analysis using Stein's estimator and its generalizations.
  _Journal of the American Statistical Association_, 70(350), 311–319.
- Gneiting, T., Balabdaoui, F., & Raftery, A. E. (2007). Probabilistic forecasts, calibration and
  sharpness. _Journal of the Royal Statistical Society: Series B_, 69(2), 243–268.
- Gneiting, T., & Raftery, A. E. (2007). Strictly proper scoring rules, prediction, and estimation.
  _Journal of the American Statistical Association_, 102(477), 359–378.
- Jeffreys, H. (1946). An invariant form for the prior probability in estimation problems.
  _Proceedings of the Royal Society A_, 186(1007), 453–461.
- Murphy, A. H. (1973). A new vector partition of the probability score. _Journal of Applied
  Meteorology_, 12(4), 595–600.
- Tashman, L. J. (2000). Out-of-sample tests of forecasting accuracy: an analysis and review.
  _International Journal of Forecasting_, 16(4), 437–450.

## Setup sem as perguntas

```bash
snack setup opencode --non-interactive \
  --source work --provider anthropic --profile default --plan pro \
  --install-plugin --yes
```

- `--source` nomeia a fonte de capacidade no SNACK; `--provider` e `--profile` dizem para qual conta
  do provedor ela mapeia. Rode sem `--install-plugin` para configurar só o backfill.
- `--plan` registra como você chama o seu plano. É um rótulo, não uma chave de busca.
- `--plan-profile` escolhe o prior de onde o SNACK parte, e o padrão é `generic`. Os perfis levam o
  nome de um arquétipo de cobrança, não de um provedor: `subscription-window` para assinatura fixa,
  onde a pressão segue requisições e volume gerado concentrando numa janela, e `metered-credit` para
  cobrança por token ou crédito, onde ela acompanha volume acumulado. A escolha muda como o uso é
  pesado, nunca o que o SNACK afirma sobre a sua capacidade, e a evidência local a dilui conforme o
  histórico cresce.
- `--install-plugin` registra o `@snack-ai/opencode` na configuração global do OpenCode e exige
  `--yes` para confirmar; `--dry-run` mostra a proposta e não muda nada.
- `--enable-prospective-analysis` é opt-in e habilita apenas features locais, efêmeras e em
  allowlist sobre o tamanho do prompt. O texto em si nunca é armazenado, e nenhuma opção o aceita
  pela linha de comando, onde outros processos poderiam lê-lo.

`snack setup claude` e `snack setup codex` aceitam as mesmas flags, sem `--install-plugin`: os dois
clientes são lidos do histórico que já escrevem, e nada é registrado em nenhum deles.

## Codex CLI

```bash
snack setup codex --non-interactive --source work --provider openai --profile default --plan plus
```

O SNACK procura em `$CODEX_HOME` quando está definido — um valor relativo é resolvido do jeito que o
Codex resolve, e o setup registra o caminho resolvido — e em `~/.codex` caso contrário. Ele lê
`sessions/**/rollout-*.jsonl` e `archived_sessions/rollout-*.jsonl`, e nada mais nesse diretório. O
setup confere o fingerprint do histórico antes de perguntar qualquer coisa e sai com `4` quando não
existe diretório de sessões.

Cada linha de rollout é projetada numa lista explícita de campos permitidos, e o resto é descartado
sem ser lido: mensagens, raciocínio, chamadas de ferramenta e a saída delas, diretórios de trabalho,
metadados de git, identificadores de conta e mensagens de erro nunca saem do parser. O
`~/.codex/history.jsonl`, que guarda o histórico bruto de prompts do Codex, nunca é aberto. O Codex
`0.145`–`0.147` e o `0.159` escrevem duas famílias de schema diferentes, e uma sessão iniciada por
um e retomada pelo outro guarda as duas no mesmo arquivo; cada turno é lido pela própria família.
Uma recusa é observada pelo `codex_error_info` além do `rate_limit_reached_type`, porque a única
recusa real registrada foi escrita só no primeiro.

O número que o Codex declara sobre as próprias janelas é citado na linha `reported` do
`snack status`:

```text
$ snack status --source codex
codex
  next prompt  96-100% chance it goes through · risk low
  evidence     moderate — some history, but few refusals seen yet
  pressure     high · higher than every window in your own history · typical prompt
  drivers      prompt count, input tokens
  reported     Codex states 34% of its 5h window, resets in 3h 10m · 19% of its 7d window, resets Wed UTC · 5m ago
  as of        5m ago · sync ok · period since 2026-10-03
  ! The estimate is not yet calibrated against observed outcomes.
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
```

As janelas são nomeadas pela duração, nunca pelo slot `primary`/`secondary` do Codex, que mudou de
significado entre versões. Uma janela cujo reinício já passou não é repetida. A linha não faz parte
do intervalo de `next prompt`, do nível de evidência nem da pressão de uso, e nada na previsão a lê.
No `--json` ela é o array opcional `reported_capacity` no relatório daquela fonte. Na `1.3` ela fica
local: o `export` não a inclui, e o `data purge` a apaga junto com o resto do escopo. O
`snack doctor` avisa sobre o que um histórico do Codex guarda e o SNACK deliberadamente não conta —
subagentes bifurcados do Codex `0.147` ou anterior, arquivos comprimidos `rollout-*.jsonl.zst` e
números declarados que não puderam ser citados.

## Clientes suportados

O suporte é decidido por fingerprint estrutural, não por string de versão, e um formato não
reconhecido recusa em vez de chutar. As matrizes publicadas são
[OpenCode](https://github.com/Duck1201/snack/blob/main/docs/opencode-support.md),
[Claude Code](https://github.com/Duck1201/snack/blob/main/docs/claude-support.md) e
[Codex CLI](https://github.com/Duck1201/snack/blob/main/docs/codex-support.md); a promessa é a
família de schema validada mais recente mais uma anterior, por cliente.

Requer Node.js 24 em Linux, macOS ou Windows via WSL2.

## Atualizando

**A partir da `1.1.0`, rode `snack update`.** Ele descobre como este CLI foi instalado, mostra o
comando exato antes de rodar, instala, e depois re-registra o plugin de captura na versão contra a
qual esta release foi validada. Fazer isso à mão significava ler a sua própria configuração de volta
e redigitar cinco valores no `setup` exatamente iguais — e qualquer um deles digitado diferente abre
um novo período de capacidade, o que aposenta tudo o que o SNACK aprendeu sobre aquela fonte. O
`snack update` nunca rotaciona um período de capacidade.

Ele também é o único comando do produto que alcança a rede, e carrega um nome de pacote e uma
versão, mais nada. Se o SNACK não conseguir descobrir como foi instalado, ele recusa e imprime o
comando para você rodar, em vez de instalar num lugar que você não esperava.

`0.6.0` é a linha de base garantida de migração: toda release a partir dela preserva seus dados e
configuração através de migrações documentadas. Depois de instalar, rode `snack sync` — o primeiro
comando que abre o armazenamento para escrita aplica as migrações pendentes, tirando um backup
antes. Comandos somente-leitura recusam em vez de quebrar até que isso aconteça.

O caminho completo de atualização, incluindo o único payload que mudou de formato no congelamento da
`0.9`, está em
[docs/compatibility.md](https://github.com/Duck1201/snack/blob/main/docs/compatibility.md).

**Se você fixou a tag `stable`**, esta é a release que você esperava. `stable` segurou a `0.6.1` por
toda a linha pré-1.0, porque até agora a release mais nova podia evoluir flags e formatos de JSON, e
o MVP era a única superfície mantida parada. A partir da `1.0.0`, quebrar qualquer contrato público
exige uma major, então `latest` e `stable` voltam a apontar para a mesma release. A `0.6.1` continua
instalável por versão exata; ela só deixa de ser o que `stable` resolve.

## Mais

Código, roadmap, modelo de ameaças, arquitetura e a especificação completa estão em
[github.com/Duck1201/snack](https://github.com/Duck1201/snack). Relatos de segurança vão pelo canal
privado descrito em [SECURITY.md](https://github.com/Duck1201/snack/blob/main/SECURITY.md).

Apache-2.0.
