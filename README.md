# SNACK

SNACK is the Statistical Next-prompt Assessment & Calibration Kit: a local-first CLI that describes
observed AI-tool usage and estimates next-prompt viability without claiming to know a provider's
real quota.

SNACK e o Statistical Next-prompt Assessment & Calibration Kit: uma CLI local que descreve o uso
observado de ferramentas de IA e estima a viabilidade do proximo prompt sem afirmar que conhece a
quota real do provedor.

The `0.5.x` preview adds an explainable Beta-Binomial forecast with auditable calibration on top of
fail-open OpenCode live capture, read-only backfill, explicit capacity-source mappings, source
diagnostics, and rolling-horizon usage statistics. It does not claim to know provider capacity or
retain prompt or response content.

## Quickstart

Requires Node.js 24. Pre-MVP releases publish to the `next` tag, so `@next` is required until
`0.6.0` becomes the default:

```bash
npm install -g @snack-ai/cli@next

snack setup opencode --non-interactive \
  --source work --provider anthropic --profile default --plan pro \
  --install-plugin --yes

snack doctor    # check the installation
snack sync      # import OpenCode history
snack status    # assess the next prompt
snack stats     # describe observed usage
```

See [packages/cli/README.md](./packages/cli/README.md) for what each setup flag means.

Requer Node.js 24. As versoes pre-MVP sao publicadas na tag `next`, entao `@next` e obrigatorio ate
a `0.6.0` virar o padrao. Use os mesmos comandos acima: `setup` mapeia a fonte de capacidade,
`doctor` verifica a instalacao, `sync` importa o historico, `status` avalia o proximo prompt e
`stats` descreve o uso observado.

See [PLAN.md](./PLAN.md) and [docs/specification.md](./docs/specification.md) for the accepted
scope. See [docs/opencode-support.md](./docs/opencode-support.md) for supported schema families.
