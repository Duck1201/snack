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
npm install -g @snack-ai/cli
snack setup opencode    # ou: snack setup claude
snack status
```

```text
work
  viability  95-100%   risk low          evidence moderate
  pressure   high      category typical  ▁▄▅▇█
  drivers    prompts 100th, input_tokens 100th
  method     bayesian-pressure-band@1
  as of      40s ago · sync ok · period since 2026-01-02
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
```

Em português claro, essa linha diz: **pode ir, você está quase certamente bem — mas está vivendo uma
das suas horas mais pesadas de todas, então não se assuste se isso mudar.** As duas metades
importam. A primeira é a resposta; a segunda é o contexto que torna a resposta honesta.

O que cada pedaço quer dizer, sem exigir estatística:

| Você vê             | Quer dizer                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `95-100% viability` | Uma faixa, não uma promessa. Em algum ponto dela está a chance do próximo prompt completar.     |
| `risk low`          | Lido pela **base** da faixa, nunca pelo meio. Uma faixa larga nunca consegue parecer confiante. |
| `evidence moderate` | O quanto o seu próprio histórico sustenta isso. Instalação nova diz `very_low`, e é sincera.    |
| `pressure high`     | Você, agora, comparado a você num dia normal. Nada a ver com os limites do provedor.            |
| `prompts 100th`     | O percentil que está puxando — esta é a sua hora mais movimentada já registrada.                |
| `category typical`  | O tamanho do seu próximo prompt perto dos seus prompts de sempre.                               |

E o `snack stats` mostra como a sua semana realmente foi:

```text
work: plan profile generic@1.0.0 (bundled, as of 2026-01-01).
  pressure high (local baseline); trend rising over 4 windows against 14 baseline windows.
  calibration: backtest brier 0.010 (sample 980, coverage 1.00) over 980 forecasts.
  PT1H: 9 prompts; tokens in 22.620 / out 11.580; cost USD 0.24; duration p50 13,0s p90 44,0s.
  P1D:  87 prompts; restrictions rate_limit 2; cost USD 1,99; effective sample 70,06 prompts.
  P7D: 449 prompts; restrictions rate_limit 10; tokens in 909.266 / out 488.902; cost USD 10,06.
```

449 prompts em sete dias, dez vezes ouvindo não, dez dólares e seis centavos, e um prompt mediano de
doze segundos. Isso é uma semana da sua vida de trabalho, medida — e nunca saiu do seu notebook.

## A única coisa que o SNACK se recusa a fazer

Ele nunca vai te mostrar uma porcentagem da sua quota.

Não porque seria difícil. Porque seria **mentira**. Seu provedor não publica os seus limites reais,
eles mudam, e variam por conta e por modelo. Qualquer ferramenta que te mostre "63% da quota usada"
inventou esse número, e número inventado é pior que número nenhum, porque você vai se planejar em
cima dele.

Então o SNACK mostra o que ele consegue de fato enxergar: o seu uso, uma faixa honesta, quanta
evidência sustenta ela, e qual método a produziu. Quando sabe pouco, ele diz alto e claro, e uma
instalação nova recebe faixa larga e evidência `very_low` em vez de um conforto falso.

Nada do que você escreve é guardado. Nem texto de prompt, nem resposta, nem credencial, nem os
caminhos dos seus projetos. Isso não é uma nota de política — é um teste que empurra strings-canário
por todos os comandos e quebra o build se uma única delas aparecer em qualquer byte que o SNACK
escreve.

## Os comandos

| Comando                                       | O que faz                                                                                                                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snack setup opencode` / `snack setup claude` | Mapeia um cliente para uma fonte de capacidade. Mostra cada mudança antes, faz backup, não escreve nada sem sua confirmação.                                                              |
| `snack status`                                | A avaliação do próximo prompt: faixa, risco, evidência, pressão e o que a puxou, atualidade dos dados. `--verbose` acrescenta os portões de evidência, o método e as versões de política. |
| `snack stats`                                 | Como o seu uso realmente é ao longo de horizontes móveis, e como as previsões passadas se saíram.                                                                                         |
| `snack sync`                                  | Importa histórico novo. `--full` relê e reconcilia tudo sem duplicar nada.                                                                                                                |
| `snack export`                                | Exporta tudo em JSON ou CSV com schema e proveniência. Os dados continuam seus.                                                                                                           |
| `snack data purge`                            | Apaga o escopo que você escolher, transacionalmente, depois de mostrar exatamente o que vai.                                                                                              |
| `snack config`                                | Lê e edita a configuração local.                                                                                                                                                          |
| `snack doctor`                                | Diagnostica a instalação sem alterá-la: permissões, fingerprints de schema, integridade.                                                                                                  |
| `snack update`                                | Traz o CLI e o plugin de captura para versões que combinam. O único comando que instala.                                                                                                  |

Todo comando aceita `--json` e responde com um documento versionado, então automatizar nunca
significa fazer parsing de prosa. Todo comando também está no `man snack`, que vem no pacote e é
gerado a partir da própria superfície de flags do CLI — uma flag não documentada reprova o build em
vez de chegar até você.

Dois clientes podem dividir uma fonte de capacidade. Se OpenCode e Claude Code cobram da mesma
conta, mapeie ambos para o mesmo alias e o SNACK vai tratar o uso deles como o pote único que ele de
fato é.

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

## Clientes suportados

O suporte é decidido por fingerprint estrutural, não por string de versão, e um formato não
reconhecido recusa em vez de chutar. As matrizes publicadas são
[OpenCode](https://github.com/Duck1201/snack/blob/main/docs/opencode-support.md) e
[Claude Code](https://github.com/Duck1201/snack/blob/main/docs/claude-support.md); a promessa é a
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
