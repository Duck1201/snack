// Point the CLI's plugin pin, and the support matrix that names it, at the plugin version
// `changeset version` just wrote.
//
// `pluginPackageSpec` names another package's version, so bumping the plugin does not move it, and
// tests fail until both places agree -- which made the pin a hand edit in every release that
// republished the plugin. Part of `npm run release:prepare`.
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const { name, version } = JSON.parse(
  await readFile(new URL("packages/opencode/package.json", root), "utf8"),
);
const semver = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?`;

for (const [path, prefix] of [
  // The constant is written as a template on `packageName`; the matrix names the package.
  ["packages/cli/src/opencode-config.js", String.raw`\$\{packageName\}@`],
  ["docs/opencode-support.md", String.raw`@snack-ai/opencode@`],
]) {
  const pinned = new RegExp(`(${prefix})${semver}`, "gu");
  const url = new URL(path, root);
  const text = await readFile(url, "utf8");
  // Exactly one pin each; more or fewer means the file changed shape and a person should look.
  const found = text.match(pinned)?.length ?? 0;
  if (found !== 1) {
    throw new Error(`${path} names ${found} pinned ${name} versions; expected exactly one.`);
  }
  await writeFile(url, text.replace(pinned, `$1${version}`));
}
process.stdout.write(`Pinned ${name}@${version}.\n`);
