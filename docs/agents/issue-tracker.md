# Issue tracker: Local Markdown

Issues and specs (you may know a spec as a PRD) for this repo live as markdown files in `.scratch/`.
`.scratch/` holds **open work only**; when it is empty, nothing is in flight.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`; never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## When a feature closes

Once the spec's `Status:` line says it shipped (or was closed) and every issue under it is `fixed`, `done`, `invalid` or `wontfix`, move the whole directory with `git mv .scratch/<feature-slug> docs/history/specs/` in the change that closes it. The directory keeps its shape, so links between its own files survive; fix any link elsewhere that pointed into `.scratch/<feature-slug>/`. The roadmap and the release records cite these files as the causal account of a defect, so they are archived, never deleted.
