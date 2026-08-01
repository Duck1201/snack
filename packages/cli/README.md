# @snack-ai/cli

**Know before you feed the model.**

[English](#english) · [Português](#português)

---

## English

### The friendly version

You know the feeling. You are three hours into something good, the code is finally taking shape, and
you hit send on one more prompt — and the provider says no. Not "in a minute". Just no. The thread
is cold, the flow is gone, and you had no warning at all.

SNACK is a small command that tries to give you that warning.

It reads the history your AI coding tool already keeps on your own machine, works out how hard you
have been going lately, and tells you how likely your next prompt is to go through. That is the
whole idea. No account, no signup, no server, no telemetry. No command that touches your data
touches the network, because there is nowhere for it to send anything to. `snack update` is the one
exception, and it only installs packages.

```bash
npm install -g @snack-ai/cli
snack setup opencode    # or: snack setup claude
snack status
```

```text
work: 95-100% viability; risk low; evidence moderate; method bayesian-pressure-band@1;
period 2026-01-02T03:04:05.000Z; pressure high; contributors prompts 100th, input_tokens 100th;
category typical; as_of 2026-01-02T03:04:10.000Z; sync ok.
Caveat: Real provider capacity is unknown.
Caveat: Usage pressure compares this window with local history; it is not a share of capacity.
```

In plain words, that line says: **go ahead, you are almost certainly fine — but you are having one
of your heaviest hours ever, so do not be surprised if that changes.** Both halves matter. The first
is the answer; the second is the context that makes the answer honest.

Here is what each piece means, no statistics required:

| You see             | It means                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `95-100% viability` | A range, not a promise. Somewhere in there is the chance your next prompt completes.             |
| `risk low`          | Read off the **bottom** of that range, never the middle. A wide range can never look confident.  |
| `evidence moderate` | How much your own history actually backs this up. A fresh install says `very_low`, and means it. |
| `pressure high`     | You, right now, compared to you on a normal day. Nothing to do with your provider's limits.      |
| `prompts 100th`     | The percentile that is driving it — this is your busiest hour on record.                         |
| `category typical`  | How big your next prompt looks next to your usual ones.                                          |

And `snack stats` shows you what your week actually looked like:

```text
work: plan profile generic@1.0.0 (bundled, as of 2026-01-01).
  pressure high (local baseline); trend rising over 4 windows against 14 baseline windows.
  calibration: backtest brier 0.010 (sample 980, coverage 1.00) over 980 forecasts.
  PT1H: 9 prompts; tokens in 22,620 / out 11,580; cost USD 0.24; duration p50 13.0s p90 44.0s.
  P1D:  87 prompts; restrictions rate_limit 2; cost USD 1.99; effective sample 70.06 prompts.
  P7D: 449 prompts; restrictions rate_limit 10; tokens in 909,266 / out 488,902; cost USD 10.06.
```

449 prompts in seven days, ten times told no, ten dollars and six cents, and a median prompt that
took twelve seconds. That is a week of your working life, measured — and it never left your laptop.

### The one thing SNACK refuses to do

It will never show you a percentage of your quota.

Not because it would be hard. Because it would be a **lie**. Your provider does not publish your
real limits, they move, and they differ per account and per model. Any tool showing you "63% of
quota used" made that number up, and a made-up number is worse than no number, because you will plan
around it.

So SNACK shows you what it can actually see: your own usage, an honest range, how much evidence sits
behind it, and which method produced it. When it knows little, it says so loudly, and a fresh
install gets a wide range and `very_low` evidence rather than false comfort.

Nothing you write is stored. Not prompt text, not responses, not credentials, not even your project
paths. That is not a policy note — it is a test that pushes canary strings through every command and
fails the build if a single one shows up in any byte SNACK writes.

### The commands

| Command                                       | What it does                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `snack setup opencode` / `snack setup claude` | Maps a client to a capacity source. Shows every change first, backs up, writes nothing until you confirm. |
| `snack status`                                | The next-prompt assessment: range, risk, evidence, pressure and what drove it, freshness.                 |
| `snack stats`                                 | What your usage really looks like over rolling horizons, and how well past forecasts scored.              |
| `snack sync`                                  | Imports new history. `--full` re-reads and reconciles everything without duplicating it.                  |
| `snack export`                                | Streams everything to JSON or CSV with schema and provenance. Your data stays yours.                      |
| `snack data purge`                            | Deletes a scope you choose, transactionally, after showing you exactly what goes.                         |
| `snack config`                                | Reads and edits local configuration.                                                                      |
| `snack doctor`                                | Diagnoses the installation without changing it: permissions, schema fingerprints, integrity.              |
| `snack update`                                | Brings the CLI and the capture plugin to versions that belong together. The only command that installs.   |

Every command takes `--json` and answers with one versioned document, so scripting it never means
parsing prose.

Two clients can share one capacity source. If OpenCode and Claude Code bill against the same
account, map them to the same alias and SNACK will treat their usage as the single pool it really
is.

---

### Under the hood

Everything above is a fairly thin wrapper over a small number of well-understood statistical
results. SNACK claims no novelty; the value is in applying them honestly to sparse, self-collected
data and refusing to overstate the result. What follows is the actual machinery, with references, so
you can check the reasoning rather than take it on trust.

#### The forecast

Prompt viability is estimated as a Bernoulli success rate with a **Beta-Binomial** conjugate model.
Observed outcomes for a capacity source update a Beta posterior, and the reported range is a pair of
Beta quantiles at a declared coverage target (`0.8` by default, reported in the document as
`coverage_target`).

The prior is `Beta(½, ½)` — the **Jeffreys prior** for a binomial proportion (Jeffreys, 1946), which
is invariant under reparameterization and, unlike the Wald interval, does not collapse to zero width
when a source has seen no restrictions at all. Brown, Cai & DasGupta (2001) survey the alternatives
and recommend exactly this interval for small samples, which is the regime nearly every SNACK
installation lives in.

Outcomes are weighted by **exponential time decay** with a seven-day half-life, so a month-old
pattern still counts but does not outvote this week. The result is reported as `effective_samples` —
the sample size the weighting is actually worth, always smaller than the raw count, and always shown
next to it.

#### Backoff, and why cells

Forecasting from "all your prompts, ever" throws away the fact that a heavy prompt during your
busiest hour is not the same bet as a small one on a quiet Sunday. So outcomes are grouped into
cells of **capacity period × usage-pressure band × prompt-size category**, and the estimate uses the
narrowest cell that carries enough evidence, backing off through progressively broader ones:

```
period + pressure band + size category  →  period + pressure band  →  period  →  prior alone
```

The level actually used is reported as `contributors.backoff_level`, so a forecast never hides how
specific its evidence was. This is ordinary hierarchical partial pooling: borrow strength from the
broader group when the narrow one is thin, in the spirit of Efron & Morris (1975). Only a capacity
period with no eligible outcome at all falls through to the prior alone, and that case reports its
method as `initial-generic` rather than pretending to be a learned estimate.

**A capacity period starts over when you change your provider, profile, plan or plan profile** —
running `snack setup` again with a different `--plan` is enough. That is deliberate: a different
plan is a different capacity regime, and outcomes from the old one are not evidence about the new
one. So the next forecasts lean on the plan profile until the new regime has its own history, and
`setup` tells you how many observed prompts stop informing the estimate before it happens. Nothing
is deleted — `stats`, `observed` and `as_of` still report everything the source holds.

#### Evidence gates, and why a long history can still be weak

A range on its own invites over-reading, so every forecast carries an evidence level on the ladder
`very_low → low → moderate → high`. Four independent gates each name the highest level they can
support, and **the weakest gate caps the result**:

| Gate           | Asks                                                     |
| -------------- | -------------------------------------------------------- |
| `sample`       | Is there enough effective evidence after decay?          |
| `restrictions` | Have any restrictions actually been observed?            |
| `relevance`    | How far did backoff have to travel from the narrow cell? |
| `completeness` | Is ingestion complete, or is some history missing?       |

The `restrictions` gate is the load-bearing one. A source that has run for months without a single
refusal has plenty of data about success and nearly none about failure, and it must not be allowed
to sound authoritative about the thing it has never seen. This is the practical form of the
distinction Gneiting, Balabdaoui & Raftery (2007) draw between **calibration** and **sharpness**:
being right on average is not the same as being usefully precise, and a forecast should never buy
the second at the cost of the first.

Risk labels derive from the **lower bound** of the interval under a versioned threshold policy,
never from the point estimate, which is what makes a wide interval read conservatively instead of
splitting the difference.

#### Usage pressure

Pressure ranks the current rolling window against your own preceding windows of the same length, per
dimension — prompts, each token type, cost, duration. The percentiles are combined under a versioned
weighting blended from the plan profile toward a neutral weighting as local evidence accumulates,
and the top contributing dimensions are reported so the band is never a bare verdict.

Standard horizons are `PT1H`, `PT5H`, `P1D`, `P7D`, half-open, and a window with no prompts is
treated as **absence of observation** rather than as a zero — the distinction that stops a quiet
weekend from looking like a collapse in usage. A minimum number of baseline windows is required
before any window is ranked at all; below it, pressure reports `unknown` instead of guessing.

Pressure is relative to you. It is not, and is never presented as, a fraction of provider capacity.

#### Calibration: does any of this work?

Claiming 90% is easy. Being right 90% of the time is the part that has to be measured, and SNACK
measures it two ways, kept as separate streams that are never averaged together:

- **Live** — forecasts actually delivered to you, scored against what happened next.
- **Backtest** — rolling-origin replay, where each forecast is rebuilt from only the prefix of
  history that preceded it, with the clock set to that prompt. This is the out-of-sample evaluation
  design described by Tashman (2000); the property tests assert that appending future history never
  changes a past forecast, which is what makes leakage a build failure rather than a worry.

Both report:

- **Brier score** (Brier, 1950) — mean squared error of the probability forecast. `0` is perfect,
  `0.25` is what you get by always saying 50%. In the example above, `0.010` over 980 replayed
  forecasts.
- **Reliability by bucket** — 0.1-wide bins, comparing claimed probability to observed frequency.
  This is the reliability component of Murphy's (1973) decomposition of the Brier score.
- **Empirical interval coverage** — how often the true outcome fell inside the published range,
  measured per bucket against that bucket's own interval.

Every figure is reported beside its sample size, and never as zero when the sample is empty:
`not_available` and `0.000` are very different statements, and conflating them is how a dashboard
starts flattering itself.

Under simulation at 1,500 trials per rate, empirical coverage measured 0.911 / 0.880 / 0.863 / 0.864
against true restriction rates of 0.02 / 0.05 / 0.10 / 0.25. The declared `0.8` target is therefore
a **floor**, not an exact claim, and it is documented as one.

#### Versioning

Every policy that can change an interpretation carries a version, stamped on the row it produced:
the parser, the classifier, the analyzer, the prediction policy, the evidence policy, the risk
thresholds, the calibration definitions. A forecast made last month can be read with the rules that
made it, rather than with today's. From `1.0`, the JSON envelope, the export document, the config
schema, the exit codes, the documented flags, and the spool contract are public contracts under
strict SemVer.

#### References

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

### Setup without the questions

```bash
snack setup opencode --non-interactive \
  --source work --provider anthropic --profile default --plan pro \
  --install-plugin --yes
```

- `--source` names the capacity source in SNACK; `--provider` and `--profile` say which provider
  account it maps to. Run without `--install-plugin` to configure backfill only.
- `--plan` records what you call your plan. It is a label, not a lookup key.
- `--plan-profile` selects the prior SNACK starts from, and defaults to `generic`. Profiles are
  named after a billing archetype rather than a provider: `subscription-window` for a flat
  subscription, where pressure follows requests and generated volume concentrating in a window, and
  `metered-credit` for per-token or credit billing, where it tracks cumulative volume. The choice
  changes how usage is weighed, never what SNACK claims your capacity is, and local evidence blends
  it away as history accumulates.
- `--install-plugin` registers `@snack-ai/opencode` in the global OpenCode configuration and needs
  `--yes` to confirm; `--dry-run` shows the proposal and changes nothing.
- `--enable-prospective-analysis` is opt-in and enables local, ephemeral, allowlisted prompt-size
  features only. The text itself is never stored, and no option accepts it on the command line,
  where other processes could read it.

### Supported clients

Support is decided by a structural fingerprint, not by a version string, and an unrecognized shape
refuses rather than guesses. The published matrices are
[OpenCode](https://github.com/Duck1201/snack/blob/main/docs/opencode-support.md) and
[Claude Code](https://github.com/Duck1201/snack/blob/main/docs/claude-support.md); the promise is
the newest validated schema family plus one previous, per client.

Requires Node.js 24 on Linux, macOS, or Windows through WSL2.

### Upgrading

**From `1.1.0`, run `snack update`.** It works out how this CLI was installed, shows you the exact
command before running it, installs, and then re-registers the capture plugin at the version this
release was validated against. Doing that by hand meant reading your own configuration back and
retyping five values into `setup` exactly — and any one of them typed differently starts a new
capacity period, which retires everything SNACK has learned about that source. `snack update` never
rotates a capacity period.

It is also the only command in the product that reaches the network, and it carries a package name
and a version and nothing else. If SNACK cannot tell how it was installed, it refuses and prints the
command to run yourself rather than installing somewhere you did not expect.

`0.6.0` is the guaranteed migration baseline: every release from it forward preserves your data and
configuration through documented migrations. After installing, run `snack sync` — the first command
that opens storage for writing applies pending migrations, taking a backup first. Read-only commands
refuse rather than crash until it has.

The full upgrade path, including the one payload that changed shape at the `0.9` freeze, is in
[docs/compatibility.md](https://github.com/Duck1201/snack/blob/main/docs/compatibility.md).

**If you pinned the `stable` tag**, this is the release you were waiting for. `stable` held `0.6.1`
through the whole pre-1.0 line, because until now the newest release was allowed to evolve flags and
JSON shapes and the MVP was the only surface being held still. From `1.0.0` breaking any public
contract requires a major version, so `latest` and `stable` name the same release again. `0.6.1`
stays installable by exact version; it just stops being what `stable` resolves to.

### More

Source, roadmap, threat model, architecture, and the full specification live at
[github.com/Duck1201/snack](https://github.com/Duck1201/snack). Security reports go through the
private channel in [SECURITY.md](https://github.com/Duck1201/snack/blob/main/SECURITY.md).

Apache-2.0.

---

## Português

### A versão amigável

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
work: 95-100% viability; risk low; evidence moderate; method bayesian-pressure-band@1;
period 2026-01-02T03:04:05.000Z; pressure high; contributors prompts 100th, input_tokens 100th;
category typical; as_of 2026-01-02T03:04:10.000Z; sync ok.
Caveat: Real provider capacity is unknown.
Caveat: Usage pressure compares this window with local history; it is not a share of capacity.
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

### A única coisa que o SNACK se recusa a fazer

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

### Os comandos

| Comando                                       | O que faz                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `snack setup opencode` / `snack setup claude` | Mapeia um cliente para uma fonte de capacidade. Mostra cada mudança antes, faz backup, não escreve nada sem sua confirmação. |
| `snack status`                                | A avaliação do próximo prompt: faixa, risco, evidência, pressão e o que a puxou, atualidade dos dados.                       |
| `snack stats`                                 | Como o seu uso realmente é ao longo de horizontes móveis, e como as previsões passadas se saíram.                            |
| `snack sync`                                  | Importa histórico novo. `--full` relê e reconcilia tudo sem duplicar nada.                                                   |
| `snack export`                                | Exporta tudo em JSON ou CSV com schema e proveniência. Os dados continuam seus.                                              |
| `snack data purge`                            | Apaga o escopo que você escolher, transacionalmente, depois de mostrar exatamente o que vai.                                 |
| `snack config`                                | Lê e edita a configuração local.                                                                                             |
| `snack doctor`                                | Diagnostica a instalação sem alterá-la: permissões, fingerprints de schema, integridade.                                     |
| `snack update`                                | Traz o CLI e o plugin de captura para versões que combinam. O único comando que instala.                                     |

Todo comando aceita `--json` e responde com um documento versionado, então automatizar nunca
significa fazer parsing de prosa.

Dois clientes podem dividir uma fonte de capacidade. Se OpenCode e Claude Code cobram da mesma
conta, mapeie ambos para o mesmo alias e o SNACK vai tratar o uso deles como o pote único que ele de
fato é.

---

### Por dentro

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

### Setup sem as perguntas

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

### Clientes suportados

O suporte é decidido por fingerprint estrutural, não por string de versão, e um formato não
reconhecido recusa em vez de chutar. As matrizes publicadas são
[OpenCode](https://github.com/Duck1201/snack/blob/main/docs/opencode-support.md) e
[Claude Code](https://github.com/Duck1201/snack/blob/main/docs/claude-support.md); a promessa é a
família de schema validada mais recente mais uma anterior, por cliente.

Requer Node.js 24 em Linux, macOS ou Windows via WSL2.

### Atualizando

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

### Mais

Código, roadmap, modelo de ameaças, arquitetura e a especificação completa estão em
[github.com/Duck1201/snack](https://github.com/Duck1201/snack). Relatos de segurança vão pelo canal
privado descrito em [SECURITY.md](https://github.com/Duck1201/snack/blob/main/SECURITY.md).

Apache-2.0.
