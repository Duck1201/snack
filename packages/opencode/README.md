# @snack-ai/opencode

Live metadata capture for [SNACK](https://github.com/Duck1201/snack) — an OpenCode plugin that
records what happened to each prompt, and never what was in it.

[English](#english) · [Português](#português)

---

## English

### The friendly version

OpenCode already writes down what you did. This plugin watches it happen instead of reading about it
afterwards.

That difference matters more than it sounds. Some things simply do not survive to disk — a prompt
the provider refuses outright can leave no durable trace in OpenCode's own database, and a refusal
SNACK cannot see is a refusal it cannot learn from. The plugin catches those as they happen.

It is deliberately tiny. It appends one line of JSON per event to a private file and gets out of the
way. It never opens a database, never imports the SNACK CLI, never phones anywhere, and never —
under any failure — gets between you and your prompt.

### You do not install this yourself

The SNACK CLI registers it in OpenCode's own configuration for you:

```bash
npm install -g @snack-ai/cli
snack setup opencode --install-plugin
```

Setup shows the exact configuration change before making it, keeps a backup, and does nothing until
you confirm. `snack doctor` afterwards tells you whether the registration is one SNACK can read.

**SNACK works fine without it.** The CLI can read OpenCode's database directly, and that is the
default. The plugin is the upgrade: outcomes observed live, including the refusals that leave no
trace, and optional prompt-size features that are computed in memory and thrown away.

### What it writes

One line of JSON per event, appended to a private spool directory that setup configured, under a
versioned schema (`spool-event-v1`) that both packages ship a byte-identical copy of. Every field is
metadata:

- which prompt and session it belongs to, by identifier;
- the provider and model, and when it happened;
- how it ended: completed, cancelled, an operational error, or an observed restriction and its
  class;
- token counts and cost as the provider reported them.

There is no field for prompt text or response text, and the schema refuses unknown fields outright.

With `--enable-prospective-analysis`, each prompt additionally carries a few non-semantic shape
features: an estimated token count, a bucketed line count, a bucketed count of fenced code blocks,
and how many files were attached. They are derived in memory from text the plugin never writes down.

### What it will not do

**It will not break OpenCode.** Capture failures are swallowed, never thrown into the host, and
never allowed to block a prompt. If the spool cannot be written, the plugin warns at most once a
minute and OpenCode carries on exactly as if it were not installed. This is not best-effort
politeness; it is the plugin's first design constraint, and it is tested by faulting the write path
and asserting the host never sees an exception.

**It will not read what it does not need.** It never opens SQLite, never imports the SNACK CLI, and
never touches OpenCode's credentials. It writes to its own spool directory and nowhere else.

**It will not guess.** An event that does not validate against the shipped schema is dropped rather
than partially interpreted, because a canonical record built from a shape SNACK does not recognize
would carry an invented meaning downstream for as long as it lived.

---

### Under the hood

#### The spool

Events are appended as NDJSON to segment files with `0600` permissions in a `0700` directory. Append
is the only write operation; nothing is ever rewritten in place, which is what makes a crash
mid-write recoverable rather than corrupting.

A line cut short by a crash is exactly what truncation recovery expects: the reader validates each
line, discards the incomplete one with a sanitized diagnostic, and keeps everything before it. The
count of refused records surfaces in `snack sync` as `rejected_invalid` rather than disappearing.

Segments are removed only after **every configured source has committed past them**. A cursor that
advanced without its transaction committing would silently drop history, so cursors move only inside
the committing transaction.

#### Reconciliation with backfill

The plugin and the database reader will both see most prompts. That is the intended arrangement, not
a bug to avoid, and SNACK reconciles the two into one canonical record by stable identity, revision
domain, and finality — never by trusting whichever arrived first.

Restrictions are unioned across both paths: a refusal seen by either observer counts. Conflicting
final revisions that cannot be ordered are excluded rather than resolved by guesswork. Property
tests assert convergence under duplicates, reordering, and gaps, because "eventually consistent"
without a proof is just hope.

#### Content-free by construction

The schema has no field that could carry prompt or response text, so leakage is a schema violation
rather than a policy failure. The privacy canaries are shared byte-identically between both packages
and driven through the capture path in tests; a canary reaching any written byte fails the build.

The provider's own error **code** is stored on purpose — it is what distinguishes a rate limit from
a timeout, and classifying that difference correctly is the entire reason SNACK does not treat your
flaky Wi-Fi as a quota event. The error _message_ is not stored.

### Compatibility

Requires Node.js 24 and a `@snack-ai/cli` that accepts `spool-event-v1`. Event `schema_version` is
`1` and has been stable since the plugin's first release, so a current CLI reads any published
version of this plugin. `snack doctor` reports a registration pinned at an older version as outdated
rather than incompatible, and re-running `snack setup opencode --install-plugin` updates the pin.

Apache-2.0. Security reports go through the private channel in
[SECURITY.md](https://github.com/Duck1201/snack/blob/main/SECURITY.md).

---

## Português

### A versão amigável

O OpenCode já anota o que você fez. Este plugin assiste isso acontecer, em vez de ler sobre depois.

Essa diferença importa mais do que parece. Algumas coisas simplesmente não sobrevivem até o disco —
um prompt que o provedor recusa de cara pode não deixar rastro durável no banco do próprio OpenCode,
e uma recusa que o SNACK não enxerga é uma recusa com a qual ele não aprende. O plugin pega essas no
ato.

Ele é propositalmente minúsculo. Acrescenta uma linha de JSON por evento num arquivo privado e sai
da frente. Nunca abre banco, nunca importa a CLI do SNACK, nunca liga para lugar nenhum, e nunca —
sob falha alguma — entra entre você e o seu prompt.

### Você não instala isto por conta própria

A CLI do SNACK registra o plugin na configuração do próprio OpenCode para você:

```bash
npm install -g @snack-ai/cli
snack setup opencode --install-plugin
```

O setup mostra a mudança exata de configuração antes de fazê-la, guarda um backup, e não faz nada
até você confirmar. Depois, `snack doctor` diz se o registro é um que o SNACK consegue ler.

**O SNACK funciona bem sem ele.** A CLI lê o banco do OpenCode diretamente, e esse é o padrão. O
plugin é o upgrade: desfechos observados ao vivo, incluindo as recusas que não deixam rastro, e
features opcionais de tamanho de prompt calculadas em memória e descartadas.

### O que ele escreve

Uma linha de JSON por evento, acrescentada a um diretório de spool privado que o setup configurou,
sob um schema versionado (`spool-event-v1`) do qual os dois pacotes carregam uma cópia
byte-idêntica. Todo campo é metadado:

- a qual prompt e sessão pertence, por identificador;
- o provedor e o modelo, e quando aconteceu;
- como terminou: completado, cancelado, um erro operacional, ou uma restrição observada e sua
  classe;
- contagens de tokens e custo, como o provedor reportou.

Não existe campo para texto de prompt nem de resposta, e o schema recusa campos desconhecidos de
forma categórica.

Com `--enable-prospective-analysis`, cada prompt carrega também algumas features não semânticas de
formato: contagem estimada de tokens, contagem de linhas em faixas, contagem de blocos de código em
faixas, e quantos arquivos foram anexados. São derivadas em memória de um texto que o plugin nunca
escreve.

### O que ele não vai fazer

**Não vai quebrar o OpenCode.** Falhas de captura são engolidas, nunca lançadas para dentro do host,
e nunca podem bloquear um prompt. Se o spool não puder ser escrito, o plugin avisa no máximo uma vez
por minuto e o OpenCode segue exatamente como se ele não estivesse instalado. Isso não é gentileza
de melhor-esforço; é a primeira restrição de projeto do plugin, e é testada injetando falha no
caminho de escrita e verificando que o host nunca vê exceção.

**Não vai ler o que não precisa.** Nunca abre SQLite, nunca importa a CLI do SNACK, nunca toca nas
credenciais do OpenCode. Escreve no seu próprio diretório de spool e em nenhum outro lugar.

**Não vai chutar.** Um evento que não valida contra o schema publicado é descartado em vez de
interpretado pela metade, porque um registro canônico construído a partir de um formato que o SNACK
não reconhece carregaria um significado inventado rio abaixo por todo o tempo em que existisse.

---

### Por dentro

#### O spool

Eventos são acrescentados como NDJSON em arquivos de segmento com permissão `0600` num diretório
`0700`. Acrescentar é a única operação de escrita; nada é reescrito no lugar, e é isso que torna uma
queda no meio da escrita recuperável em vez de corruptora.

Uma linha cortada por uma queda é exatamente o que a recuperação de truncamento espera: o leitor
valida cada linha, descarta a incompleta com um diagnóstico sanitizado, e mantém tudo que veio
antes. A contagem de registros recusados aparece no `snack sync` como `rejected_invalid` em vez de
sumir.

Segmentos só são removidos depois que **toda fonte configurada commitou além deles**. Um cursor que
avançasse sem sua transação commitar descartaria histórico em silêncio, então cursores só se movem
dentro da transação que commita.

#### Reconciliação com o backfill

O plugin e o leitor de banco vão ver a maioria dos prompts. Esse é o arranjo pretendido, não um bug
a evitar, e o SNACK reconcilia os dois num único registro canônico por identidade estável, domínio
de revisão e finalidade — nunca confiando em quem chegou primeiro.

Restrições são unidas entre os dois caminhos: uma recusa vista por qualquer observador conta.
Revisões finais conflitantes que não podem ser ordenadas são excluídas em vez de resolvidas no
chute. Testes de propriedade garantem convergência sob duplicatas, reordenação e lacunas, porque
"eventualmente consistente" sem prova é só esperança.

#### Livre de conteúdo por construção

O schema não tem campo capaz de carregar texto de prompt ou resposta, então vazamento é violação de
schema, não falha de política. As strings-canário de privacidade são compartilhadas byte a byte
entre os dois pacotes e empurradas pelo caminho de captura nos testes; um canário chegando a
qualquer byte escrito quebra o build.

O **código** de erro do provedor é armazenado de propósito — é o que distingue um rate limit de um
timeout, e classificar essa diferença corretamente é a razão inteira de o SNACK não tratar o seu
Wi-Fi instável como evento de quota. A _mensagem_ de erro não é armazenada.

### Compatibilidade

Requer Node.js 24 e uma `@snack-ai/cli` que aceite `spool-event-v1`. O `schema_version` do evento é
`1` e está estável desde a primeira release do plugin, então uma CLI atual lê qualquer versão
publicada dele. O `snack doctor` reporta um registro fixado numa versão antiga como desatualizado, e
não como incompatível; rodar `snack setup opencode --install-plugin` de novo atualiza o pin.

Apache-2.0. Relatos de segurança vão pelo canal privado descrito em
[SECURITY.md](https://github.com/Duck1201/snack/blob/main/SECURITY.md).
