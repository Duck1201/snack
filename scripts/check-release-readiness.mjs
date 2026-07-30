import { readFile } from "node:fs/promises";

const identity = await readFile(new URL("../docs/release/identity.md", import.meta.url), "utf8");
const platforms = await readFile(
  new URL("../docs/release/platform-smoke.md", import.meta.url),
  "utf8",
);

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

process.stdout.write("Release identity gates passed.\n");
