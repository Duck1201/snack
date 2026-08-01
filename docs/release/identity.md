# Package and Repository Identity

Status as of 2026-07-30:

- npm account `duck1201` is authenticated and is an owner of the `@snack-ai` organization.
- The npm organization currently contains no packages.
- `@snack-ai/cli` and `@snack-ai/opencode` return no public package metadata and are available for their planned release stages.
- The source repository will be public at `https://github.com/Duck1201/snack`.
- The distributed binary remains `snack`.

Package availability is established by authenticated npm organization access and registry queries. Trademark searches in INPI and USPTO remain a publication gate and are not legal advice; implementation may proceed under the provisional identity, but `0.1.0` must not publish until that gate is recorded as passed or the project is renamed.

Trademark gate: passed

The official-source screening is recorded in [trademark-search.md](./trademark-search.md). Live
exact `SNACK` software marks in the United States and relevant Brazilian near marks require a name
or legal-clearance decision before publication. On 2026-07-30, the owner selected the documented
go decision and accepted the identified risk under ADR-0005. This decision is not legal advice or a
finding that the mark is available.

npm trusted publisher gate: passed

On 2026-07-30, npm accepted the GitHub Actions trust relationship for `@snack-ai/cli`
with workflow `release.yml`, repository `Duck1201/snack`, environment `npm`, and publish-only
permission. The npm CLI request returned HTTP 201.

GitHub npm environment gate: passed

The public `Duck1201/snack` repository has an `npm` environment with `Duck1201` as a required
reviewer and a custom deployment policy that accepts only the `main` branch. The environment was
verified through the GitHub REST API on 2026-07-30.

npm publication gate: passed

`@snack-ai/cli@0.1.0` was published from commit
`0763e2bf9f8bf8989081aa480fc882aeb5f7e4bc` by protected release run
[30516808566](https://github.com/Duck1201/snack/actions/runs/30516808566). Registry metadata
records Node.js `24.18.1`, npm `11.16.0`, 14 files, SHA-512 integrity, and SLSA provenance at
`https://registry.npmjs.org/-/npm/v1/attestations/@snack-ai%2fcli@0.1.0`. The temporary GitHub
bootstrap secret was deleted after publication.

The requested release channel is `next`. npm also assigns `latest` to the first published version
and rejects removing that required tag with HTTP 400 while it is the package's only version. This
registry behavior is tracked in [npm/cli#8490](https://github.com/npm/cli/issues/8490); subsequent
technical previews continue to publish explicitly to `next`.

Stage 2 publication: passed

`@snack-ai/cli@0.2.0` was published to the `next` channel from commit
`51696842098cbf58cd55c9ee9c05acb6c265f12a` by protected release run
[30575846623](https://github.com/Duck1201/snack/actions/runs/30575846623). The registry confirms
`next` resolves to `0.2.0`; `latest` remains `0.1.0`.

Stage 3 publication: not performed

`0.3.0` was never published. The registry holds `0.1.0`, `0.2.0`, and `0.4.0` only. Release run
[30575846623](https://github.com/Duck1201/snack/actions/runs/30575846623) is recorded as
successful, but its `publish` job was skipped by the workflow's own confirmation gate, and a
skipped job reports success. Workflow success is therefore not evidence of publication; the
registry is. The release workflow now verifies both packages on the registry before a run can
report success.

Stage 4 publication: partial

`@snack-ai/cli@0.4.0` was published to the `next` channel from commit
`980b6a94a9f99c1eebddb5610aa6f403f174c0e6` by protected release run
[30596314853](https://github.com/Duck1201/snack/actions/runs/30596314853), with a provenance
statement recorded in the Sigstore transparency log at index `2297397654`. The registry confirms
`next` resolves to `0.4.0`; `latest` remains `0.1.0`.

`@snack-ai/opencode@0.1.0` was not published in that run. npm rejected its first publication:

```text
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/@snack-ai%2fopencode
```

On a `PUT`, that status means the request was not authorized to create the package, not that
the package is missing. npm cannot bind a trusted publisher to a package that does not exist,
so the package had to be created once by an authorized manual publication.

`@snack-ai/opencode@0.1.0` was published manually on 2026-07-31 to create the package. A local
publish cannot produce an attestation, and `publishConfig.provenance` makes npm refuse the
publish outright with `EUSAGE ... provider: null`, so that publication used `--no-provenance`
and carries no attestation. npm assigned it `latest`, as it does for any package's first
version.

Stage 4 publication: passed

With the package created, the scope's trusted publisher was configured for it, and
`@snack-ai/opencode@0.1.1` was published to `next` from commit
`04d4141` by protected release run
[30598743858](https://github.com/Duck1201/snack/actions/runs/30598743858), with provenance
recorded in the Sigstore transparency log at index `2298046236`.

The registry confirms both released artifacts carry SLSA provenance attestations:
`@snack-ai/cli@0.4.0` and `@snack-ai/opencode@0.1.1`. `next` resolves to `0.4.0` and `0.1.1`
respectively.

That run is nonetheless recorded as a failure. Both publications succeeded, and the
verification step then queried the registry immediately and did not yet see the just-published
plugin version. The step now retries before concluding a version is missing. This was a false
negative in the gate, not a failed release — which is the inverse of the Stage 3 problem and a
reminder that the registry, not a workflow's colour, is the evidence.

## Stage 6 release procedure

`0.6.0` is the first release that publishes to `latest` rather than `next`. The protected
`Publish release` workflow runs from `main` with the confirmation string `publish-0.6.0`, and it
verifies afterwards that both packages resolve on the registry and that `latest` and `next` point
at the versions the released commit declares.

Stage 6 publication: partial

`@snack-ai/cli@0.6.0` was published from commit `cbad0b378f3b0e529a795313d209bcec680c2952` by
protected release run
[30625883811](https://github.com/Duck1201/snack/actions/runs/30625883811). The registry records 39
files, `sha512-ewmyyYpI0CwpOcTVMzzKObWLt4Ltjt8oYEfeX9szIAng/buK5hcH4VBIhf3HQHP8/X4KAdcX1ErABxw8c+T27A==`,
and both a publish attestation and an SLSA provenance statement. `@snack-ai/cli@latest` resolves to
`0.6.0`.

That run is recorded as a failure, and it is one: it stopped before finishing the tag moves.

```text
npm error code E401
npm error Unable to authenticate, your authentication token seems to be invalid.
```

Trusted publishing provisions credentials per package, as a side effect of publishing that package.
`@snack-ai/opencode@0.1.1` was already on the registry and unchanged by the MVP, so its publish step
skipped, no credentials for it existed in the run, and `npm dist-tag add` against it answered E401.
The step aborted there, which also left `@snack-ai/cli@next` behind at `0.5.0`.

The workflow now publishes and tags each package in one step, so it only writes tags where the token
exists, and its verification covers `latest` and `next` for both packages instead of `latest` alone.
A release whose tags are not all in place fails, because a default install would resolve to
something other than what the released commit declares.

Two tags had to be moved by hand from an authenticated npm login, which a re-run could not repair
for the reason above:

```bash
npm dist-tag add @snack-ai/opencode@0.1.1 latest
npm dist-tag add @snack-ai/cli@0.6.0 next
```

Stage 6 publication: passed

On 2026-07-31 the registry resolves both packages to the versions this release declares, on both
tags:

| Package | `latest` | `next` | Attestations |
| --- | --- | --- | --- |
| `@snack-ai/cli` | `0.6.0` | `0.6.0` | publish + SLSA provenance |
| `@snack-ai/opencode` | `0.1.1` | `0.1.1` | publish + SLSA provenance |

`npm install -g @snack-ai/cli` therefore installs the MVP, and OpenCode resolves the
MVP-compatible plugin by default. The registry is the evidence, not the workflow's colour.

## Tags this workflow does not set

`npm publish --tag latest` is the only registry write the release workflow performs. A separate
`npm dist-tag add` is not authenticated by trusted publishing and answers E401 — even for the
package just published, in the same step, moments after the publish succeeded:

```text
+ @snack-ai/cli@0.6.1
npm error code E401
npm error Unable to authenticate, your authentication token seems to be invalid.
```

Two releases learned this the hard way. On `0.6.0` the failing call was the plugin's, which looked
like a per-package credential problem; the CLI's own call in the same run had appeared to succeed
only because npm no-ops when the tag already points at that version. On `0.6.1` the CLI's call
failed straight after its own publish, which settles it: the credential authorizes the publish
request, not the session.

So `latest` is set by the publish, and every other tag is moved by hand from an authenticated npm
login when the owner wants it moved:

```bash
npm dist-tag add @snack-ai/cli@0.6.1 next
npm dist-tag add @snack-ai/opencode@0.1.2 next
```

`next` is the pre-release channel. Between pre-releases it has no work to do, and it is allowed to
lag `latest` until someone moves it; what must never happen is a default install resolving to
anything other than the released version, and that is what the workflow verifies.

## 0.6.1 publication

`@snack-ai/cli@0.6.1` was published from commit `16fbb8e650e3859a4a72e489496f5f8b80bd3eab` by
protected release run
[30628093385](https://github.com/Duck1201/snack/actions/runs/30628093385), with provenance recorded
in the Sigstore transparency log at index `2300727520`. The registry resolves
`@snack-ai/cli@latest` to `0.6.1`.

That run is recorded as a failure, and it is one: it aborted on the `dist-tag` call described above,
before reaching the plugin, so `@snack-ai/opencode@0.1.2` was not published.

Two more runs were needed, and neither failed on publishing. Run
[30629146283](https://github.com/Duck1201/snack/actions/runs/30629146283) stopped at its own
`npm run check`, on a performance budget that a shared runner missed by three per cent; that budget
now reports on CI and asserts off it, like the others. Run
[30629734229](https://github.com/Duck1201/snack/actions/runs/30629734229) stopped at the CI gate,
because it was dispatched while CI for the same commit was still running and the gate only accepted
a completed run — correct, and now patient enough to wait for one.

Stage 6 publication: passed

`@snack-ai/opencode@0.1.2` was published from commit `bac5f5d` by protected release run
[30629996001](https://github.com/Duck1201/snack/actions/runs/30629996001), with provenance recorded
in the Sigstore transparency log at index `2300989264`. The CLI step skipped, `0.6.1` already being
on the registry.

| Package | Version | `latest` | Attestations |
| --- | --- | --- | --- |
| `@snack-ai/cli` | `0.6.1` | `0.6.1` | publish + SLSA provenance |
| `@snack-ai/opencode` | `0.1.2` | `0.1.2` | publish + SLSA provenance |

`next` still resolves to `0.6.0` and `0.1.1`. That is the documented consequence of publishing being
the only registry write this workflow makes, and it is corrected by hand when there is reason to;
`latest`, which a default install resolves, is what the release guarantees.


## 0.7.0

`@snack-ai/cli@0.7.0` was published from commit `7379c02` by protected release run
[30672396220](https://github.com/Duck1201/snack/actions/runs/30672396220). The plugin step skipped:
Stage 7 changed nothing in `@snack-ai/opencode`, which stays at `0.1.2`.

It published under `next`, which was the channel policy at the time of the dispatch, and was then
promoted to `latest` by hand. The policy changed with it: from `0.7.0` each minor takes `latest` on
release, so a default install resolves the newest supported product rather than a version the
project has moved past. `0.6.1` keeps the MVP surface under a new `stable` tag, for installs that
cannot absorb pre-1.0 contract churn.

| Package | Version | `latest` | `stable` | Attestations |
| --- | --- | --- | --- | --- |
| `@snack-ai/cli` | `0.7.0` | `0.7.0` | `0.6.1` | publish + SLSA provenance |
| `@snack-ai/opencode` | `0.1.2` | `0.1.2` | — | publish + SLSA provenance |

`latest` and `stable` were both moved with `npm dist-tag add` from an authenticated session, and
`next` was removed from both packages with `npm dist-tag rm` in the same session. Leaving it
pointing at the current release would have made `@next` and `@latest` the same install while
implying they are different channels.

**`next` is retired and does not come back.** The name promises "whatever is newest", and there is
no version of this project where that is a useful separate answer: while it agreed with `latest` it
was a duplicate, and the moment it disagreed it was a trap for anyone who installed it expecting the
newest supported product. Release candidates publish to `rc` instead, which says what it holds and
is absent whenever no candidate is outstanding. The channel columns above are `latest` and `stable`
because those are the two a released version can occupy.

None of that came from the workflow. Trusted publishing authorizes a publish request and not a
`dist-tag` call, which answers `E401` even for the package just published — the workflow sets a tag
only through `--tag` on the publish itself, and it is now an input of the dispatch rather than
hardcoded. `stable` is never set by a release: it moves by decision.

## 0.8.0

`@snack-ai/cli@0.8.0` was published from commit `ade53a4` by protected release run
[30681725922](https://github.com/Duck1201/snack/actions/runs/30681725922). The plugin step skipped
again: Stage 8 changed nothing in `@snack-ai/opencode`, which stays at `0.1.2`.

| Package | Version | `latest` | `stable` | Attestations |
| --- | --- | --- | --- | --- |
| `@snack-ai/cli` | `0.8.0` | `0.8.0` | `0.6.1` | publish + SLSA provenance |
| `@snack-ai/opencode` | `0.1.2` | `0.1.2` | — | publish + SLSA provenance |

This is the first release where no tag was moved by hand. `latest` was set by `--tag latest` on the
publish and asserted by the workflow's own verification step; `stable` did not move, because it
moves by decision and no decision was taken. The registry confirms it: `npm view @snack-ai/cli
dist-tags` answers `{ stable: '0.6.1', latest: '0.8.0' }`.

An `npm dist-tag add @snack-ai/cli@0.8.0 latest` was attempted before the dispatch and answered
`400 Bad Request`. The cause was ordering, not permissions: `0.8.0` was not yet in the registry, and
npm reports a tag pointed at a missing version with a bare status code and no explanation. The
release skill that suggested the command as a routine step has been corrected, and the same release
then completed without it.

## 0.8.1

`@snack-ai/cli@0.8.1` was published from commit `9933ace` by protected release run
[30685339807](https://github.com/Duck1201/snack/actions/runs/30685339807). The plugin step skipped
again: this release changed nothing in `@snack-ai/opencode`, which stays at `0.1.2`.

| Package | Version | `latest` | `stable` | Attestations |
| --- | --- | --- | --- | --- |
| `@snack-ai/cli` | `0.8.1` | `0.8.1` | `0.6.1` | publish + SLSA provenance |
| `@snack-ai/opencode` | `0.1.2` | `0.1.2` | — | publish + SLSA provenance |

No tag was moved by hand, and none was attempted. `latest` was set by `--tag latest` on the publish
and asserted by the workflow's own verification step, which skipped the plugin rather than
reasserting a tag this run did not set. `stable` did not move: it moves by decision, and no decision
was taken. The registry confirms it: `npm view @snack-ai/cli dist-tags` answers
`{ stable: '0.6.1', latest: '0.8.1' }`.

This is a patch release for three setup defects, each of which a green `npm run check` could not
see: the OpenCode fingerprint required primary keys to report `NOT NULL`, which only holds inside a
`STRICT` table that OpenCode does not create; setup validated its identifiers only after the whole
questionnaire; and guided setup printed the choices before the question they answered. The
fingerprint family stays `oc-sqlite-msgpart-v1` — the change widens what is accepted and refuses
nothing that was accepted before, so no configuration written by an earlier version needs to change.

## 0.8.2

`@snack-ai/cli@0.8.2` was published from commit `a522224` by protected release run
[30686491259](https://github.com/Duck1201/snack/actions/runs/30686491259). The plugin step skipped
again: this release changed nothing in `@snack-ai/opencode`, which stays at `0.1.2`.

| Package | Version | `latest` | `stable` | Attestations |
| --- | --- | --- | --- | --- |
| `@snack-ai/cli` | `0.8.2` | `0.8.2` | `0.6.1` | publish + SLSA provenance |
| `@snack-ai/opencode` | `0.1.2` | `0.1.2` | — | publish + SLSA provenance |

No tag was moved by hand, and none was attempted. `latest` was set by `--tag latest` on the publish
and asserted by the workflow's own verification step, which skipped the plugin rather than
reasserting a tag this run did not set. `stable` did not move. The registry confirms it:
`npm view @snack-ai/cli dist-tags` answers `{ stable: '0.6.1', latest: '0.8.2' }`.

This release takes the identifier rule off the guided-setup questions and leaves it on the refusal.
`0.8.1` had put the pattern on every question so the shape would be known before the answer was
typed; in use that reads as a regex in front of everyone who was going to type something ordinary
anyway. Nothing `0.8.1` fixed is given back: a refused answer still costs one answer rather than the
whole questionnaire, and the non-interactive flags are still checked before anything is written.

The version was cut on the same branch as the change it releases, rather than in a follow-up. `0.8.1`
was cut in a follow-up after its PR merged at the head it had, which stranded the version commit and
cost an extra PR — the failure the release skill warns about, reproduced once more.

## 1.1.0

`@snack-ai/cli@1.1.0` and `@snack-ai/opencode@1.0.2` were published from commit `ba57aaa` by
protected release run
[30724046781](https://github.com/Duck1201/snack/actions/runs/30724046781), directly to `latest`.
Tagged `v1.1.0` on that same commit, released on GitHub as Latest.

| Package | Version | `latest` | `stable` | Attestations |
| --- | --- | --- | --- | --- |
| `@snack-ai/cli` | `1.1.0` | `1.1.0` | pending decision | publish + SLSA provenance |
| `@snack-ai/opencode` | `1.0.2` | `1.0.2` | — | publish + SLSA provenance |

**The published artifacts match the recorded evidence exactly.** Packed from the registry rather
than from the tree, because the digest a consumer receives is the only one that settles it:

```
snack-ai-cli-1.1.0.tgz       sha256:55f2762250389f240ee7dd63d41ab0915ee4b7e1736b61b6328c238ed1cb2fc8
snack-ai-opencode-1.0.2.tgz  sha256:90b8740c9a43e5782f0e22632c5634bcbf62a50af01cc76dae12d25534103375
```

Both equal what `docs/release/artifacts.md` records. At `1.0.0` this same check found a mismatch
within minutes of publishing; here there is none.

**The plugin republished with no behavioural change**, which is the opposite case to `1.0.2` and was
taken deliberately rather than discovered. Its README was split by language and both files now ship,
so the contents of its tarball changed even though its source did not. Leaving it at `1.0.1` would
have made the artifact evidence record a plugin tarball nobody would ever receive, since
`release:check` compares what the tree packs against what the evidence claims. The CLI's
`pluginPackageSpec` moved with it, and the test tying the two together is what says so.

**`docs/opencode-support.md` went stale on that bump**, which is the `1.0.0` P1 one level out: a
version written by hand in a second place with nothing tying it to the first. It now carries the
same gate the constant does, and the gate was shown to fail before it was trusted to pass.

**The release turned `main` red once, on macOS, and it was not a regression.** `backfill took 30.2s`
against a 30 s budget, from a commit whose diff touches no ingestion file at all, which had passed
macOS minutes earlier on its own pull request, and against 14.5 s on the machine whose measurement
is the gate. The assertion was measuring the runner: `status --no-sync` p95 already carried an
exemption for exactly that and the two backfill assertions did not. Recorded in
`docs/release/performance.md` with the proof that the exemption still fails where it must.

## 1.0.2

`@snack-ai/cli@1.0.2` was published from commit `45a7a95` by protected release run
[30715693993](https://github.com/Duck1201/snack/actions/runs/30715693993), directly to `latest`.
`stable` was moved by hand afterwards. Tagged `v1.0.2` on that same commit, released on GitHub as
Latest.

| Package | Version | `latest` | `stable` | Attestations |
| --- | --- | --- | --- | --- |
| `@snack-ai/cli` | `1.0.2` | `1.0.2` | `1.0.2` | publish + SLSA provenance |
| `@snack-ai/opencode` | `1.0.1` | `1.0.1` | — | unchanged; publish step skipped |

Verified against the registry rather than against the workflow's own status:
`npm view @snack-ai/cli dist-tags` answers `{ stable: '1.0.2', latest: '1.0.2' }` and
`npm view @snack-ai/opencode dist-tags` answers `{ latest: '1.0.1' }`.

**The plugin did not republish, and that is the correct outcome.** No changeset named it because
nothing inside it changed — not its source, and not anything else in its `files` array. Its recorded
digest is byte-identical to `1.0.1`'s, which is the check that says so rather than an assumption:

```
snack-ai-cli-1.0.2.tgz       sha256:be4c0dd88c4fb0926c13a1bee93d650b1eb1b11e38d02e51febc331c9ce48cf1
snack-ai-opencode-1.0.1.tgz  sha256:96fbaa4299ad7381d60937b4f878c19af81914720a9d7b0e1d3aa0501fe61546
```

The published CLI tarball matches the recorded digest exactly.

**The plugin pin gate has now been exercised in both directions.** At `1.0.1` the plugin bumped and
the gate went red until `pluginPackageSpec` moved with it. Here the plugin did not bump, and the
gate stayed green while the CLI moved — which is the half that would have been easy to get wrong by
tying the constant to the CLI's own version instead of the plugin's.

Verified against the **published** artifact, over the real history the fixes were found on:

- `sync --full` reads 197 and accounts for all of it — 136 attributed plus 61 awaiting a mapping —
  against 197 eligible prompts in the source (203 user messages less 3 compaction and 3
  continuation). `1.0.1` read 183 of the same 197;
- `doctor` names the four providers holding those 61, their counts, and the command that attributes
  them;
- a no-op `sync` over 222 MB of Claude transcripts costs 147 MB and 0.58 s, against 238 MB and 1.2 s
  at `1.0.1`; `doctor` costs 136 MB against 241 MB. Both are under the 150 MB budget by peak process
  RSS as well as by the heap cap, which is the first release where those two agree.

## 1.0.1

`@snack-ai/cli@1.0.1` and `@snack-ai/opencode@1.0.1` were published from commit `9d18263` by
protected release run
[30711850333](https://github.com/Duck1201/snack/actions/runs/30711850333), directly to `latest`.
`stable` was moved by hand afterwards, as it always is. Tagged `v1.0.1` on that same commit,
released on GitHub as Latest.

| Package | Version | `latest` | `stable` | Attestations |
| --- | --- | --- | --- | --- |
| `@snack-ai/cli` | `1.0.1` | `1.0.1` | `1.0.1` | publish + SLSA provenance |
| `@snack-ai/opencode` | `1.0.1` | `1.0.1` | — | publish + SLSA provenance |

Verified against the registry rather than against the workflow's own status:
`npm view @snack-ai/cli dist-tags` answers `{ stable: '1.0.1', latest: '1.0.1' }` and
`npm view @snack-ai/opencode dist-tags` answers `{ latest: '1.0.1' }`.

**Published straight to `latest`, unlike `1.0.0`.** The `candidate` window exists so a bad artifact
harms nobody while its digest is checked, and `1.0.0` earned it within minutes. This release is the
opposite trade: it removes three P1s from `latest`, and PLAN.md's findings policy is that a known P1
does not sit there for the length of a feature release. The check `candidate` exists for was still
run, just before promoting rather than after publishing — `release:check` now compares packed
digests against `artifacts.md`, which is the gate `1.0.0` added *because* of what `candidate`
caught.

Both published tarballs match the recorded evidence:

```
snack-ai-cli-1.0.1.tgz       sha256:cb88cac961e1be5b38cb41e540661a1f89cec6919ec2725311bf869b2ad1fb71
snack-ai-opencode-1.0.1.tgz  sha256:96fbaa4299ad7381d60937b4f878c19af81914720a9d7b0e1d3aa0501fe61546
```

**The evidence was regenerated after the README edit, not before.** `packages/cli/README.md` gained
the paragraph the capacity-period change needs, and it is named in the CLI's `files` array — so the
CLI's digest moved and the plugin's did not. That is the exact asymmetry `1.0.0` discovered *after*
publishing; here it was handled before, which is what the widened `release:check` is for.

**The plugin pin gate fired on its first real bump.** `changeset version` took
`@snack-ai/opencode` to `1.0.1` and `npm run check` went red on
`the pinned plugin version is the one this workspace publishes`, comparing `1.0.0` against `1.0.1`.
The gate was added in this same release cycle to stop the defect it had just caught; it then caught
the next instance of it one version later, unprompted.

Verified against the **published** artifacts in throwaway XDG roots, because Phase 1's whole finding
is that a green suite does not reach these paths:

- `snack --version` answers `1.0.1`, and `setup opencode --install-plugin` writes
  `@snack-ai/opencode@1.0.1`, which `doctor` reports as compatible;
- over 606 real Claude Code prompts, a plan change prints
  `606 observed prompt(s) stop informing the estimate` and `doctor` then reports
  `source_freshness: Synchronized usage is available` — where `1.0.0` reported none;
- the published plugin, driven by real OpenCode `1.18.10`, writes `"provider":"opencode"` into the
  bound source directory rather than the holding directory, and `sync` reads it with
  `pending_mapping 0` where `1.0.0` read `2`.

## 1.0.0

`@snack-ai/cli@1.0.0` and `@snack-ai/opencode@1.0.0` were published from commit `6a59791` by
protected release run
[30700312799](https://github.com/Duck1201/snack/actions/runs/30700312799), under the temporary
`candidate` tag. Tagged `v1.0.0` on that same commit, released on GitHub as Latest.

| Package | Version | `latest` | `stable` | Attestations |
| --- | --- | --- | --- | --- |
| `@snack-ai/cli` | `1.0.0` | `1.0.0` | `1.0.0` | publish + SLSA provenance |
| `@snack-ai/opencode` | `1.0.0` | `1.0.0` | — | publish + SLSA provenance |

Verified against the registry rather than against the workflow's own status:
`npm view @snack-ai/cli dist-tags` answers `{ latest: '1.0.0', stable: '1.0.0' }` and
`npm view @snack-ai/opencode dist-tags` answers `{ latest: '1.0.0' }`. A plain
`npm install @snack-ai/cli` resolves `1.0.0`, and `0.6.1` remains installable by exact version.

**`stable` moved for the first time since the MVP**, off `0.6.1` and onto `1.0.0`. That channel
answers one question — which version's surface will not move underneath you — and before 1.0 the
honest answer was the MVP, because every minor after it could still evolve flags, JSON shapes, and
config and export schemas. From 1.0 breaking any frozen surface requires a major, so `latest` and
`stable` name the same version until a `2.0.0` exists. Moved by hand, like every tag that is not the
one the publish sets; so was the removal of `candidate` from both packages.

**No release candidate was published and there was no soak.** Both were required by `PLAN.md` and
both were dropped by decision. `1.0.0-rc.0` was cut and fully gated and then discarded, so no package
has ever carried the `rc` tag. What that gave up is recorded in
[compatibility.md](../compatibility.md): calendar time under real use, and the only rehearsal of the
npm publish path itself. This release is the first artifact to traverse that path, and it did so as
the final release.

**Publishing under `candidate` caught a defect within minutes, which is the entire reason for it.**
Comparing the registry's tarballs against `docs/release/artifacts.md` found the plugin matching and
the CLI not:

```
recorded  sha256:ef37befdaa246d436d5e2082b9b6f0d800b7a7326ed0c4a4830c83b34eef702a
served    sha256:cc8c52392302d5c9ba044eab2914202a00fe7bed5caaeda22e87c17f3337fd6e
```

The artifact was correct — packing `origin/main` reproduces the served digest exactly. The
**evidence** was stale: `release:evidence` had run at `0d534f0`, and a later commit edited
`packages/cli/README.md`, which is named in the CLI's `files` array. The plugin matched only because
its README did not change in that commit. `release:check` had compared the recorded version string,
which had not changed, so it passed.

That is the `0.9.0` lesson above in a new place, and the gate was widened to match it:
`currentTarballDigests()` packs the tree and `release:check` now requires every digest it produces
to appear in the evidence. Had that existed an hour earlier the mismatch would have blocked the
publish rather than being found after it. Because `latest` still pointed at `0.9.0` at the time,
nothing a user could install was ever wrong.

Product behaviour is `0.9.0`'s: `git diff v0.9.0 v1.0.0 -- packages/*/src packages/cli/migrations
packages/cli/schemas packages/opencode/schemas packages/cli/profiles` is empty. What 1.0 adds is the
promise about that behaviour, and the evidence that it holds.

## 0.9.0

`@snack-ai/cli@0.9.0` and `@snack-ai/opencode@0.1.3` were published from commit `5a5e8f1` by
protected release run
[30694400969](https://github.com/Duck1201/snack/actions/runs/30694400969).

| Package | Version | `latest` | `stable` | Attestations |
| --- | --- | --- | --- | --- |
| `@snack-ai/cli` | `0.9.0` | `0.9.0` | `0.6.1` | publish + SLSA provenance |
| `@snack-ai/opencode` | `0.1.3` | `0.1.3` | — | publish + SLSA provenance |

No tag was moved by hand, and none was attempted. `latest` was set by `--tag latest` on the publish
and asserted by the workflow's own verification step — for both packages this time, because both
published. `stable` did not move: it holds `0.6.1`, the newest release whose surface the project was
willing to hold still before this freeze, and it moves by decision. The registry confirms it:
`npm view @snack-ai/cli dist-tags` answers `{ stable: '0.6.1', latest: '0.9.0' }` and
`npm view @snack-ai/opencode dist-tags` answers `{ latest: '0.1.3' }`.

This is the Stage 9 feature freeze and public beta. The 1.0 public surface is frozen and recorded in
[compatibility.md](../compatibility.md), which `release:check` gates on.

**The plugin published for the first time in four releases, and nearly did not.** `0.6.1` through
`0.8.2` all skipped its publish step because nothing in `@snack-ai/opencode` had changed, and the
handoff into this wave said the same about `0.9.0`. Its *behaviour* was indeed unchanged — but
`schemas/spool-event.schema.json` is named in the package's `files` array, so it ships inside the
tarball, and Wave 2 rewrote it to compile under the Ajv configuration the product itself uses. The
question that decides whether a package republishes is not "did the behaviour change?" but "did
anything named in `files` change?".

Proven against the two published artifacts rather than against the tree. Compiling
`schemas/spool-event.schema.json` from `npm pack @snack-ai/opencode@0.1.2` under
`{ strict: true, allErrors: true }`:

```
strict mode: missing type "array" for keyword "maxItems" at
"https://snack-ai.dev/schemas/spool-event/v1#/allOf/0/then/properties/restrictions" (strictTypes)
```

The same file from `0.1.3` compiles. What the schema accepts is unchanged, so the republish corrects
the form of a contract and does not reset the freeze.

Verified against the published CLI in a throwaway XDG root, because the injected-sink tests cannot
reach process start-up: `snack --version` answers `0.9.0`; `snack doctor --json` emits
`schema_version` `2` and exits 0 with warnings on an uninitialized root;
`snack doctor --source nope --json` exits `4` with `source_not_configured`.
