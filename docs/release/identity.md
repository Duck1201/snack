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
