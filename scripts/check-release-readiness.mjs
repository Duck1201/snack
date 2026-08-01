import { readFile } from "node:fs/promises";

const identity = await readFile(new URL("../docs/release/identity.md", import.meta.url), "utf8");
const platforms = await readFile(
  new URL("../docs/release/platform-smoke.md", import.meta.url),
  "utf8",
);
const opencodeSupport = await readFile(
  new URL("../docs/opencode-support.md", import.meta.url),
  "utf8",
);
const claudeSupport = await readFile(new URL("../docs/claude-support.md", import.meta.url), "utf8");
const compatibility = await readFile(new URL("../docs/compatibility.md", import.meta.url), "utf8");
const performance = await readFile(
  new URL("../docs/release/performance.md", import.meta.url),
  "utf8",
);
const artifacts = await readFile(new URL("../docs/release/artifacts.md", import.meta.url), "utf8");

if (!/^Trademark gate: passed$/mu.test(identity)) {
  throw new Error("Release blocked: trademark gate is not approved; review the trademark report.");
}
if (!/^npm trusted publisher gate: passed$/mu.test(identity)) {
  throw new Error("Release blocked: configure and verify the npm trusted publisher.");
}
if (!/^GitHub npm environment gate: passed$/mu.test(identity)) {
  throw new Error("Release blocked: protect and verify the GitHub npm environment.");
}
if (!/^WSL gate: passed$/mu.test(platforms)) {
  throw new Error("Release blocked: record a clean WSL package smoke result.");
}
if (/Status: in progress\./u.test(opencodeSupport)) {
  throw new Error("Release blocked: Stage 3 live-capture validation is incomplete.");
}
// Each client gets the same gate. A published support matrix is a claim about what SNACK reads,
// and shipping one that still says its own validation is unfinished publishes the claim anyway.
if (/^Status:(?![^\n]*\bcomplete\b)/mu.test(claudeSupport)) {
  throw new Error("Release blocked: Claude Code support validation is incomplete.");
}
// From 0.9 the frozen contract is a release artifact of its own. A release that publishes schemas
// without publishing what they promise is a freeze nobody outside the repository can rely on.
if (!/^Freeze gate: passed$/mu.test(compatibility)) {
  throw new Error("Release blocked: the 0.9 contract freeze is not recorded as passed.");
}
// CI reports the budgets and does not assert them, for the reasons docs/release/performance.md
// gives. That makes the recorded developer-machine measurement the gate, so a release without one
// has no evidence that the budgets hold at all.
if (!/^Performance gate: passed$/mu.test(performance)) {
  throw new Error("Release blocked: record a developer-machine performance measurement.");
}
// A stable release ships a checksum, an SBOM, and the claim that its source packs reproducibly.
// `release:evidence` writes that file from measurement and refuses to write it at all when the two
// packs disagree, so its presence at the release's own version is the gate.
if (!/^Artifact evidence gate: passed$/mu.test(artifacts)) {
  throw new Error("Release blocked: run `npm run release:evidence`.");
}
const releasedVersion = JSON.parse(
  await readFile(new URL("../packages/cli/package.json", import.meta.url), "utf8"),
).version;
if (!artifacts.includes(`CLI \`${releasedVersion}\``)) {
  throw new Error(
    `Release blocked: docs/release/artifacts.md records a different version than ${releasedVersion}; ` +
      "rerun `npm run release:evidence`.",
  );
}

process.stdout.write("Release identity gates passed.\n");
