// The artifact evidence a stable release has to carry: an SBOM per package, a checksum per tarball,
// and proof that packing the same source twice produces the same bytes.
//
// PLAN.md delivery principle 9 is that a release advances on reproducible technical evidence and not
// on an agent's assertion, so this writes `docs/release/artifacts.md` from measurement rather than
// leaving the numbers to be pasted in by hand. `release:check` gates on the line it emits.
//
// Importable: `compareArtifacts` is pure and tested in `release-evidence.test.mjs`. Running the file
// directly is what produces the evidence.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);

/**
 * The entries whose content differs between two packs of the same source, named rather than
 * counted. Union of both key sets, so a file that appears in only one pack is a difference too --
 * that is `files` having resolved differently, which changes what a consumer downloads.
 *
 * @param {Record<string, string>} first
 * @param {Record<string, string>} second
 * @returns {string[]} sorted, so two runs of the evidence are comparable
 */
export function compareArtifacts(first, second) {
  const names = new Set([...Object.keys(first), ...Object.keys(second)]);
  return [...names].filter((name) => first[name] !== second[name]).sort();
}

if (import.meta.filename === process.argv[1]) await main();

async function main() {
  const workspace = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const packages = ["@snack-ai/cli", "@snack-ai/opencode"];
  const temporary = await mkdtemp(join(tmpdir(), "snack-release-evidence-"));
  /** @type {string[]} */
  const rows = [];
  /** @type {string[]} */
  const sbomRows = [];

  try {
    for (const name of packages) {
      // Packed twice into separate directories. Same source, same npm, so the bytes are expected to
      // match; npm normalizes the mtimes that would otherwise make a tarball a record of when it
      // was built rather than of what went into it.
      const first = await packInto(workspace, name, join(temporary, "first"));
      const second = await packInto(workspace, name, join(temporary, "second"));
      const differing = compareArtifacts(await entryDigests(first), await entryDigests(second));
      if (differing.length > 0) {
        throw new Error(
          `${name} did not pack reproducibly. Entries that differ between two packs of the same ` +
            `source:\n  ${differing.join("\n  ")}`,
        );
      }
      const tarball = await digestOf(first);
      const outer = await digestOf(second);
      rows.push(`| \`${name}\` | \`${basename(first)}\` | \`${tarball}\` |`);
      if (outer !== tarball) {
        // Reachable in principle: identical entries inside a gzip stream that framed them
        // differently. Reported rather than asserted away, because it is still a tarball a consumer
        // could receive two versions of.
        rows.push(`| | second pack | \`${outer}\` — **outer bytes differ, entries do not** |`);
      }

      const sbom = await sbomFor(workspace, name);
      const sbomFile = join(workspace, "docs", "release", "sbom", `${fileNameFor(name)}.cdx.json`);
      await mkdir(dirname(sbomFile), { recursive: true });
      await writeFile(sbomFile, `${JSON.stringify(sbom, null, 2)}\n`, { mode: 0o644 });
      // The components, not the document. A CycloneDX document carries a fresh `serialNumber` and
      // `timestamp` on every run, so hashing the whole file would publish a digest that never
      // reproduces and prove nothing about the dependencies it exists to pin.
      const components = createHash("sha256")
        .update(JSON.stringify(sbom.components ?? []))
        .digest("hex");
      sbomRows.push(
        `| \`${name}\` | ${(sbom.components ?? []).length} | \`sha256:${components}\` |`,
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  const cli = JSON.parse(
    await readFile(join(workspace, "packages", "cli", "package.json"), "utf8"),
  );
  const plugin = JSON.parse(
    await readFile(join(workspace, "packages", "opencode", "package.json"), "utf8"),
  );
  const document = `# Release artifact evidence

Artifact evidence gate: passed

Written by \`npm run release:evidence\` from measurement, never by hand. PLAN.md delivery principle
9 is that a release advances on reproducible technical evidence rather than on an assertion, and a
checksum somebody typed is an assertion.

CLI \`${cli.version}\`, OpenCode plugin \`${plugin.version}\`.

## Tarball checksums

Compare these against what the registry serves before moving a dist-tag. A mismatch means the
published artifact is not the one that passed the gates, and the release restarts through a new
\`rc.N\` rather than being patched.

| Package | Tarball | sha256 |
| --- | --- | --- |
${rows.join("\n")}

## Reproducible build

Each package is packed twice, from the same source, into separate directories, and every entry
inside the two tarballs is compared by content digest. A difference names the entry rather than
reporting only that the tarballs disagree.

Result: every entry identical for both packages.

## SBOM

CycloneDX, generated with \`npm sbom --package-lock-only\` so the bill describes what the lockfile
declares rather than what one machine happens to have installed. The documents are under
[sbom/](./sbom/).

The digest covers the \`components\` array alone. A CycloneDX document carries a fresh
\`serialNumber\` and \`timestamp\` on every run, so a digest of the whole file would never reproduce
and would prove nothing about the dependencies it exists to pin.

| Package | Components | sha256 of components |
| --- | --- | --- |
${sbomRows.join("\n")}
`;

  const artifactsFile = join(workspace, "docs", "release", "artifacts.md");
  await writeFile(artifactsFile, document, { mode: 0o644 });
  process.stdout.write(`Release evidence written to ${artifactsFile}\n`);
}

/** @param {string} name */
function fileNameFor(name) {
  return name.replace("@snack-ai/", "snack-ai-");
}

/** @param {string} workspace @param {string} name @param {string} destination */
async function packInto(workspace, name, destination) {
  await mkdir(destination, { recursive: true });
  // `--json` on stdout, read from a file for the same reason `package-smoke.mjs` does: npm 11
  // suppresses it when stdout is a child-process pipe.
  const { stdout } = await execute(
    process.execPath,
    [
      npmCli(),
      "pack",
      "--workspace",
      name,
      "--json",
      "--pack-destination",
      destination,
      "--silent",
    ],
    { cwd: workspace, maxBuffer: 10 * 1024 * 1024 },
  );
  const [result] = JSON.parse(stdout);
  if (!result || typeof result.filename !== "string") {
    throw new Error(`npm pack returned an unexpected manifest for ${name}.`);
  }
  return join(destination, result.filename);
}

/**
 * Every entry inside a tarball, by content digest. `tar -xO` streams the members in archive order,
 * which is the order npm wrote them, so the names and the contents line up.
 *
 * @param {string} tarball
 * @returns {Promise<Record<string, string>>}
 */
async function entryDigests(tarball) {
  const { stdout: listing } = await execute("tar", ["-tzf", tarball], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const names = listing.split("\n").filter((name) => name !== "" && !name.endsWith("/"));
  /** @type {Record<string, string>} */
  const digests = {};
  for (const name of names) {
    const { stdout } = await execute("tar", ["-xzOf", tarball, name], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: "buffer",
    });
    digests[name] = createHash("sha256").update(stdout).digest("hex");
  }
  return digests;
}

/** @param {string} file */
async function digestOf(file) {
  return `sha256:${createHash("sha256")
    .update(await readFile(file))
    .digest("hex")}`;
}

/** @param {string} workspace @param {string} name */
async function sbomFor(workspace, name) {
  const { stdout } = await execute(
    process.execPath,
    [
      npmCli(),
      "sbom",
      "--sbom-format",
      "cyclonedx",
      "--package-lock-only",
      "--workspace",
      name,
      "--silent",
    ],
    { cwd: workspace, maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

function npmCli() {
  const path = process.env.npm_execpath;
  if (!path) throw new Error("Run release evidence through npm.");
  return path;
}
