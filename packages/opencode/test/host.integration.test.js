import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const opencode = process.env.OPENCODE_BIN ?? "/home/duck/.opencode/bin/opencode";
const enabled = process.env.SNACK_OPENCODE_HOST_TEST === "1";
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

test(
  "OpenCode loads the packed plugin and dispatches chat.message",
  { skip: !enabled || !existsSync(opencode) },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "snack-opencode-host-"));
    const configDirectory = join(root, "config", "opencode");
    const spoolDirectory = join(root, "spool");
    try {
      await mkdir(configDirectory, { recursive: true });
      // The tarball's name carries the version, so writing it out by hand made this test
      // unrunnable the moment the plugin left `0.1.0` -- and it is skipped by default, so nothing
      // said so. `npm pack --json` reports the filename it wrote; take it from there.
      const packed = await execute(
        "npm",
        ["pack", packageDirectory, "--pack-destination", root, "--json"],
        { timeout: 60_000 },
      );
      const tarball = join(root, JSON.parse(packed.stdout)[0].filename);
      await execute(
        "npm",
        [
          "install",
          "--prefix",
          configDirectory,
          "--ignore-scripts",
          "--engine-strict=false",
          "@opencode-ai/plugin@1.18.10",
          tarball,
        ],
        { timeout: 60_000 },
      );
      await writeFile(
        join(configDirectory, "opencode.json"),
        `${JSON.stringify({
          plugin: [
            [
              join(configDirectory, "node_modules", "@snack-ai", "opencode"),
              {
                installation_id: "host-installation",
                spool_directory: spoolDirectory,
                prospective_analysis: true,
                // Without a binding every event lands in `_pending`, which is where an
                // unattributable event goes -- so a test that asserts only "an event was written"
                // passes while live capture produces nothing a `sync` can use. That is what
                // shipped in `1.0.0`. Bind the provider the request below names, and assert the
                // segment lands under it.
                source_bindings: [
                  {
                    provider: "openai",
                    source_alias: "oc-host",
                    spool_directory: join(spoolDirectory, "oc-host"),
                  },
                ],
              },
            ],
          ],
        })}\n`,
      );
      const hostEnvironment = {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        OPENCODE_CONFIG_DIR: configDirectory,
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_TEST_HOME: root,
        OPENCODE_DB: join(root, "data", "opencode", "opencode.db"),
        npm_config_engine_strict: "false",
      };
      assert.equal(
        (await execute(opencode, ["--version"], { env: hostEnvironment })).stdout.trim(),
        "1.18.10",
      );

      const port = await availablePort();
      const child = spawn(
        opencode,
        ["serve", "--port", String(port), "--print-logs", "--log-level", "DEBUG"],
        { cwd: root, env: hostEnvironment, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      try {
        const origin = `http://127.0.0.1:${port}`;
        await waitForServer(origin);
        const sessionResponse = await request(origin, "/session", root, {});
        assert.equal(typeof sessionResponse.id, "string", stderr);
        await request(origin, `/session/${sessionResponse.id}/message`, root, {
          noReply: true,
          model: { providerID: "openai", modelID: "gpt-4o" },
          parts: [{ type: "text", text: "PRIVATE_HOST_CANARY" }],
        });
        const content = await readEventually(
          join(spoolDirectory, "oc-host", "current.open"),
          stderr,
        );
        assert.match(content, /"event_type":"prompt_started"/u);
        assert.match(content, /"provider":"openai"/u);
        assert.match(content, /"analyzer_version":"opencode-input-v1"/u);
        assert.doesNotMatch(content, /PRIVATE_HOST_CANARY/u);
        assert.doesNotMatch(stderr, /PRIVATE_HOST_CANARY/u);
      } finally {
        child.kill("SIGKILL");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a host-test port.");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

/** @param {string} origin */
async function waitForServer(origin) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await globalThis.fetch(`${origin}/global/health`, {
        signal: globalThis.AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The isolated host is still starting.
    }
    await delay(20);
  }
  throw new Error("OpenCode host did not become healthy.");
}

/** @param {string} origin @param {string} path @param {string} directory @param {object} body */
async function request(origin, path, directory, body) {
  const response = await globalThis.fetch(
    `${origin}${path}?directory=${encodeURIComponent(directory)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: globalThis.AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

/** @param {string} file @param {string} diagnostics */
async function readEventually(file, diagnostics) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(file, "utf8");
    } catch {
      await delay(20);
    }
  }
  throw new Error(`OpenCode did not dispatch chat.message to the plugin.\n${diagnostics}`);
}
