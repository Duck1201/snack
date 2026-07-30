import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
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
  const cliManifest = JSON.parse(
    await readFile(join(workspace, "packages", "cli", "package.json"), "utf8"),
  );
  const sqliteVersion = cliManifest.dependencies?.["better-sqlite3"];
  if (typeof sqliteVersion !== "string") throw new Error("better-sqlite3 version is missing.");
  await writeFile(
    join(temporary, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        allowScripts: { [`better-sqlite3@${sqliteVersion}`]: true },
      },
      null,
      2,
    )}\n`,
  );

  const result = (
    await packWorkspace(workspace, temporary, join(temporary, "pack-manifest.json"))
  )[0];
  if (!result || typeof result.filename !== "string" || !Array.isArray(result.files)) {
    throw new Error("npm pack returned an unexpected manifest.");
  }
  tarball = join(temporary, result.filename);
  const files = result.files.map((entry) => entry.path);
  const required = [
    "LICENSE",
    "NOTICE",
    "README.md",
    "migrations/001_initialize.sql",
    "migrations/002_open_code_tracer.sql",
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
    {
      cwd: workspace,
      env: { ...process.env, npm_config_cache: join(temporary, "npm-cache") },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const binary = join(
    temporary,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "snack.cmd" : "snack",
  );
  const smoke = await execute(binary, ["--version"], { cwd: temporary });
  assert.equal(smoke.stdout.trim(), cliManifest.version);

  process.stdout.write(`Package smoke passed for ${basename(tarball)} (${files.length} files).\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

/**
 * npm 11 can suppress `pack --json` when its stdout is a child-process pipe.
 * Directing stdout to a file preserves the manifest without leaving a tarball in the workspace.
 *
 * @param {string} cwd
 * @param {string} destination
 * @param {string} manifestFile
 */
async function packWorkspace(cwd, destination, manifestFile) {
  const manifest = await open(manifestFile, "w", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        "npm",
        ["pack", "--workspace", "@snack-ai/cli", "--json", "--pack-destination", destination],
        {
          cwd,
          env: { ...process.env, npm_config_cache: join(destination, "npm-cache") },
          stdio: ["ignore", manifest.fd, "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        // npm may write non-fatal notices (such as update notifications) to stderr.
        // The exit code is authoritative; retain stderr for failure diagnostics only.
        if (code === 0) resolve();
        else reject(new Error(`npm pack failed with exit code ${code}: ${stderr}`));
      });
    });
  } finally {
    await manifest.close();
  }
  return JSON.parse(await readFile(manifestFile, "utf8"));
}
