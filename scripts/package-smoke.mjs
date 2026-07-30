import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const workspace = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run package smoke through npm.");

const temporary = await mkdtemp(join(tmpdir(), "snack-package-smoke-"));
let tarball;
try {
  const packed = await execute(
    process.execPath,
    [npmCli, "pack", "--workspace", "@snack-ai/cli", "--json"],
    {
      cwd: workspace,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const result = JSON.parse(packed.stdout)[0];
  if (!result || typeof result.filename !== "string" || !Array.isArray(result.files)) {
    throw new Error("npm pack returned an unexpected manifest.");
  }
  tarball = join(workspace, result.filename);
  const files = result.files.map((entry) => entry.path);
  const required = [
    "LICENSE",
    "NOTICE",
    "README.md",
    "migrations/001_initialize.sql",
    "package.json",
    "schemas/config.schema.json",
    "src/cli.js",
  ];
  for (const path of required) assert.ok(files.includes(path), `tarball is missing ${path}`);
  for (const path of files) {
    assert.doesNotMatch(path, /(^|\/)(?:test|fixtures?|\.env)(?:\/|$)/iu);
  }

  await execute(
    process.execPath,
    [npmCli, "install", "--prefix", temporary, "--ignore-scripts=false", tarball],
    { cwd: workspace, maxBuffer: 10 * 1024 * 1024 },
  );
  const binary = join(
    temporary,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "snack.cmd" : "snack",
  );
  const smoke = await execute(binary, ["--version"], { cwd: temporary });
  assert.equal(smoke.stdout.trim(), "0.1.0");

  process.stdout.write(`Package smoke passed for ${basename(tarball)} (${files.length} files).\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
  if (tarball) await rm(tarball, { force: true });
}
