## What changes, and why

<!-- The reader is a stranger at 3am. Say what the change does, and what you ruled out. -->

## How you verified it

<!-- "npm run check passes" is the baseline. What did you actually observe? If the change touches
stdout streaming, prompts, wall-clock windows, or start-up cost, an injected-sink test cannot see
it — say what the installed binary did. -->

## Checklist

- [ ] `npm run check` passes locally
- [ ] A changeset is included, or the change is invisible to users (`npx changeset`)
- [ ] Domain terms follow `CONTEXT.md`, including the synonyms it rejects
- [ ] No prompt text, response text, path, or credential can reach the database, spool, logs,
      exports, or an error message — and a new capture path carries a canary assertion
- [ ] An interpretable contract that changed carries a new version (envelope, spool event, parser,
      classifier, analyzer)
- [ ] Any new migration is a new file; no released migration was edited
- [ ] Conflicts with an accepted ADR are named here rather than silently overridden
