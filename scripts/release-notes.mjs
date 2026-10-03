// The body of a GitHub release, read from the two CHANGELOGs `changeset version` already wrote.
//
// The release workflow creates the tag and the GitHub release itself, and that release is the
// record of the publication. Before, both were written by hand after every publish and then
// recorded a second time in `docs/release/identity.md` by a pull request of its own.
//
// Usage: node scripts/release-notes.mjs <cli-version> <plugin-version>
// Importable: `changelogSection` is pure and tested in `release-notes.test.mjs`.
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The body under `## <version>` in a changesets CHANGELOG, without its heading, or null.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string | null}
 */
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cliVersion, pluginVersion] = process.argv.slice(2);
  if (!cliVersion || !pluginVersion) {
    throw new Error("Usage: node scripts/release-notes.mjs <cli-version> <plugin-version>");
  }
  const read = (/** @type {string} */ path) =>
    readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const cli = changelogSection(await read("packages/cli/CHANGELOG.md"), cliVersion);
  // A CLI release always has its own entry; a missing one means the version was never cut.
  if (cli === null) throw new Error(`packages/cli/CHANGELOG.md has no ## ${cliVersion} section.`);
  const plugin = changelogSection(await read("packages/opencode/CHANGELOG.md"), pluginVersion);
  const parts = [`## @snack-ai/cli ${cliVersion}`, cli];
  if (plugin !== null) parts.push(`## @snack-ai/opencode ${pluginVersion}`, plugin);
  process.stdout.write(`${parts.join("\n\n")}\n`);
}
