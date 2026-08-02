# Promoting a major through the `candidate` tag

Load this when the version being released is a **major** — `1.0.0`, `2.0.0`. An ordinary minor never
reaches any of it: the workflow's `--tag` does the whole job, and step 9 of `SKILL.md` only checks
the result.

## Publish to `candidate`, never straight to `latest`

`dist_tag` is an input of the release dispatch (`latest` | `rc` | `candidate`). For a major, choose
`candidate`. Publishing to `latest` immediately is not faster — it just removes the only window in
which a bad artifact harms nobody, which is the window step 7's checksum comparison lives in.

## The promotion, after step 7 passes

Hand these to the user; every one is a dist-tag call the workflow cannot make (`E401`, see the
Gotchas in `SKILL.md`). **Order matters** — `latest` and `stable` are added before `candidate` is
removed, so the version is never unreachable by any tag:

```bash
npm dist-tag add @snack-ai/cli@1.0.0 latest
npm dist-tag add @snack-ai/cli@1.0.0 stable
npm dist-tag add @snack-ai/opencode@1.0.0 latest
npm dist-tag rm @snack-ai/cli candidate
npm dist-tag rm @snack-ai/opencode candidate
```

`stable` moves at 1.0 and only at 1.0 — before then it held the MVP, because the newest release
could still evolve flags and JSON shapes, and from 1.0 the newest release is also the one whose
contracts are held. The previous `stable` version stays installable by exact version; it just stops
being what the tag resolves to.

## What the window caught, the one time it was used

`@snack-ai/cli@1.0.0` and `@snack-ai/opencode@1.0.0` published from `6a59791` by run
[30700312799](https://github.com/Duck1201/snack/actions/runs/30700312799) under `candidate`.
Comparing the registry's tarballs against `docs/release/artifacts.md` found the plugin matching and
the CLI not:

```
recorded  sha256:ef37befdaa246d436d5e2082b9b6f0d800b7a7326ed0c4a4830c83b34eef702a
served    sha256:cc8c52392302d5c9ba044eab2914202a00fe7bed5caaeda22e87c17f3337fd6e
```

Packing `origin/main` reproduced the served digest exactly — the artifact was right and the evidence
was stale, the `files` trap in the Gotchas. `latest` still pointed at `0.9.0` throughout, so nothing
installable was ever wrong. Then `latest` and `stable` moved to `1.0.0` by hand, `candidate` was
removed, and `npm view` was the only source consulted before writing `identity.md`.
