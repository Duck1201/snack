import { readFile } from "node:fs/promises";

const identity = await readFile(new URL("../docs/release/identity.md", import.meta.url), "utf8");
const platforms = await readFile(
  new URL("../docs/release/platform-smoke.md", import.meta.url),
  "utf8",
);
const packageManifest = JSON.parse(
  await readFile(new URL("../packages/cli/package.json", import.meta.url), "utf8"),
);

async function verifyBootstrap() {
  if (process.env.SNACK_NPM_BOOTSTRAP !== "1" || packageManifest.version !== "0.1.0") {
    return false;
  }

  const response = await globalThis.fetch("https://registry.npmjs.org/@snack-ai%2fcli");
  if (response.status !== 404) {
    throw new Error("Release blocked: npm bootstrap is only valid before the first publication.");
  }
  return true;
}

if (!/^Trademark gate: passed$/mu.test(identity)) {
  throw new Error("Release blocked: trademark gate is not approved; review the trademark report.");
}
if (!/^npm trusted publisher gate: passed$/mu.test(identity) && !(await verifyBootstrap())) {
  throw new Error("Release blocked: configure and verify the npm trusted publisher.");
}
if (!/^GitHub npm environment gate: passed$/mu.test(identity)) {
  throw new Error("Release blocked: protect and verify the GitHub npm environment.");
}
if (!/^WSL gate: passed$/mu.test(platforms)) {
  throw new Error("Release blocked: record a clean WSL package smoke result.");
}

process.stdout.write("Release identity gates passed.\n");
