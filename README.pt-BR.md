# SNACK

**Saiba antes de alimentar o modelo.**

SNACK é o Statistical Next-prompt Assessment & Calibration Kit: uma CLI local que descreve o uso
observado das suas ferramentas de IA e estima se o próximo prompt tende a passar. Roda inteiramente
na sua máquina, não guarda conteúdo de prompt nem de resposta, e nunca afirma conhecer a quota real
do provedor.

In English: [README.md](./README.md).

```bash
npm install -g @snack-ai/cli
snack setup opencode    # ou: snack setup claude
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
work
  viability  95-100%   risk low          evidence moderate
  pressure   high      category typical  ▁▄▅▇█
  drivers    prompts 100th, input_tokens 100th
  method     bayesian-pressure-band@1
  as of      40s ago · sync ok · period since 2026-01-02
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
```

Pode ir — mas você está vivendo uma das suas horas mais pesadas de todas, então não se assuste se
isso mudar.

## O que não faz

Não sabe a capacidade do seu provedor, então não reporta nem uma fração dela nem uma contagem
regressiva. Uma ferramenta que te mostra "63% da quota usada" inventou esse número, e número
inventado é pior que número nenhum, porque você vai se planejar em cima dele.

Nenhum comando que toca seus dados toca a rede. Não envia telemetria, não lê credenciais, e não
existe serviço por trás para onde mandar qualquer coisa. A única exceção é o `snack update`, que
instala pacotes: ele carrega um nome de pacote e uma versão, e nada sobre o seu uso, em nenhuma das
direções.

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
| `snack update`                                | Traz o CLI e o plugin de captura para versões que combinam entre si                |

Todo comando aceita `--json` e emite um documento versionado.

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

## Como chegamos aqui

Onze releases, cada uma com um único trabalho. Nada foi adiante antes de a anterior estar provada.

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

O plano completo por estágios, com critérios de saída por onda e tudo que ficou deliberadamente de
fora, está no [PLAN.md](./PLAN.md).

## Documentação

[PLAN.md](./PLAN.md) para escopo e limites · [docs/specification.md](./docs/specification.md) para
comportamento · [docs/architecture.md](./docs/architecture.md) para módulos e fluxo de dados ·
[docs/compatibility.md](./docs/compatibility.md) para o que os contratos publicados prometem ·
[CONTEXT.md](./CONTEXT.md) para o vocabulário do domínio ·
[docs/opencode-support.md](./docs/opencode-support.md) e
[docs/claude-support.md](./docs/claude-support.md) para as famílias de schema suportadas ·
[docs/troubleshooting.md](./docs/troubleshooting.md) quando algo recusar.

Contribuições: [CONTRIBUTING.md](./CONTRIBUTING.md). Segurança: [SECURITY.md](./SECURITY.md).
Apache-2.0.
