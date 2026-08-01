# @snack-ai/opencode

Captura de metadados ao vivo para o [SNACK](https://github.com/Duck1201/snack) — um plugin do
OpenCode que registra o que aconteceu com cada prompt, e nunca o que havia nele.

In English: [README.md](./README.md).

## A versão amigável

O OpenCode já anota o que você fez. Este plugin assiste isso acontecer, em vez de ler sobre depois.

Essa diferença importa mais do que parece. Algumas coisas simplesmente não sobrevivem até o disco —
um prompt que o provedor recusa de cara pode não deixar rastro durável no banco do próprio OpenCode,
e uma recusa que o SNACK não enxerga é uma recusa com a qual ele não aprende. O plugin pega essas no
ato.

Ele é propositalmente minúsculo. Acrescenta uma linha de JSON por evento num arquivo privado e sai
da frente. Nunca abre banco, nunca importa a CLI do SNACK, nunca liga para lugar nenhum, e nunca —
sob falha alguma — entra entre você e o seu prompt.

## Você não instala isto por conta própria

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

## O que ele escreve

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

## O que ele não vai fazer

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

## Por dentro

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

## Compatibilidade

Requer Node.js 24 e uma `@snack-ai/cli` que aceite `spool-event-v1`. O `schema_version` do evento é
`1` e está estável desde a primeira release do plugin, então uma CLI atual lê qualquer versão
publicada dele. O `snack doctor` reporta um registro fixado numa versão antiga como desatualizado, e
não como incompatível; rodar `snack setup opencode --install-plugin` de novo atualiza o pin.

Apache-2.0. Relatos de segurança vão pelo canal privado descrito em
[SECURITY.md](https://github.com/Duck1201/snack/blob/main/SECURITY.md).
