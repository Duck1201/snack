import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * The `run:` script of one step of `.github/workflows/release.yml`, as the runner would execute it.
 * Read from the text rather than a YAML parser, which this repository does not depend on: the
 * block is every line indented deeper than its `run: |` key.
 *
 * @param {string} name the step's `name:`
 */
async function stepScript(name) {
  const lines = (await readFile(join(root, ".github/workflows/release.yml"), "utf8")).split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `no step named ${name}`);
  const run = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  const indent = /** @type {string} */ (lines[run]).search(/\S/u);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.search(/\S/u) <= indent) break;
    body.push(line.slice(indent + 2));
  }
  return body.join("\n");
}

/**
 * Run the tag step with `gh` and `npm` stubbed: no GitHub release exists yet, the registry says the
 * version was published from this commit, and `dist-tags.<tag>` resolves to `channel`.
 *
 * @param {{published: string, channel: string}} state
 */
async function tagStep(state) {
  const directory = await mkdtemp(join(tmpdir(), "snack-release-workflow-"));
  try {
    const version = JSON.parse(
      await readFile(join(root, "packages/cli/package.json"), "utf8"),
    ).version;
    const calls = join(directory, "calls");
    await writeFile(calls, "");
    const stub = (/** @type {string} */ body) => `#!/usr/bin/env bash\n${body}\n`;
    await writeFile(
      join(directory, "gh"),
      stub(`echo "gh $*" >> "${calls}"\nif [ "$1 $2" = "release view" ]; then exit 1; fi\nexit 0`),
    );
    await writeFile(
      join(directory, "npm"),
      stub(
        [
          `echo "npm $*" >> "${calls}"`,
          `case "$*" in`,
          `  *gitHead*) echo "deadbeef" ;;`,
          `  *dist-tags.*) echo "${state.channel}" ;;`,
          `  *) exit 1 ;;`,
          `esac`,
        ].join("\n"),
      ),
    );
    await chmod(join(directory, "gh"), 0o755);
    await chmod(join(directory, "npm"), 0o755);
    const result = spawnSync("bash", ["-e", "-c", await stepScript(TAG_STEP)], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        CLI_PUBLISHED: state.published,
        DIST_TAG: "latest",
        GITHUB_SHA: "deadbeef",
        GITHUB_SERVER_URL: "https://github.invalid",
        GITHUB_REPOSITORY: "snack/snack",
        GITHUB_RUN_ID: "1",
        GITHUB_STEP_SUMMARY: join(directory, "summary"),
        RUNNER_TEMP: directory,
      },
    });
    return { ...result, version, calls: await readFile(calls, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const TAG_STEP = "Tag the published commit and create its GitHub release";

test("a run that did not publish creates no release while the channel names another version", async () => {
  // The dist-tag check in the verify step is skipped for a package this run did not publish, so a
  // retried run would otherwise mark the release Latest under "npm latest" with nothing checking
  // that `latest` is this version.
  const result = await tagStep({ published: "", channel: "0.0.1" });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + result.stderr, /resolves to '0\.0\.1', not /u);
  assert.doesNotMatch(result.calls, /gh release create/u);
});

test("a run that did not publish records the release once the channel names this version", async () => {
  const probe = await tagStep({ published: "", channel: "" });
  const result = await tagStep({ published: "", channel: probe.version });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, new RegExp(`gh release create v${probe.version} `, "u"));
});
