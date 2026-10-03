import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, test } from "node:test";

import { runDoctor } from "../src/doctor.js";
import { ExitCode, SnackError } from "../src/errors.js";
import { run } from "../src/main.js";
import { isDriverLoadFailure, probeSqliteDriver } from "../src/sqlite-driver.js";
import {
  cleanupRunFixtures,
  createOpenCodeDatabase,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

// What Node throws when `better-sqlite3` was compiled under Node.js 22 and is loaded by 24 -- the
// shape found on a real machine with a second global prefix left behind. The path is the part a
// message must never repeat.
function abiMismatch() {
  return Object.assign(
    new Error(
      "The module '/home/someone/.local/lib/node_modules/@snack-ai/cli/node_modules/" +
        "better-sqlite3/build/Release/better_sqlite3.node'\n" +
        "was compiled against a different Node.js version using\n" +
        "NODE_MODULE_VERSION 127. This version of Node.js requires\n" +
        "NODE_MODULE_VERSION 137. Please try re-compiling or re-installing\n" +
        "the module (for instance, using `npm rebuild` or `npm install`).",
    ),
    { code: "ERR_DLOPEN_FAILED" },
  );
}

const brokenDriver = () => {
  throw abiMismatch();
};

test("an addon built for another Node.js is a driver failure, wherever it sits in the causes", () => {
  assert.equal(isDriverLoadFailure(abiMismatch()), true);
  const wrapped = new SnackError("Storage could not be read.", {
    code: ExitCode.storage,
    reason: "storage_read_error",
    cause: abiMismatch(),
  });
  assert.equal(isDriverLoadFailure(wrapped), true);
  assert.equal(
    isDriverLoadFailure(new Error("Could not locate the bindings file. Tried: ...")),
    true,
  );
});

test("a database SQLite itself refuses is not a driver failure", () => {
  const corrupt = Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" });
  assert.equal(isDriverLoadFailure(corrupt), false);
  assert.equal(isDriverLoadFailure("not an error"), false);
  assert.equal(
    probeSqliteDriver(() => {
      throw corrupt;
    }),
    null,
  );
});

test("the driver failure names both ABIs, clears the data, and carries no path", () => {
  const failure = probeSqliteDriver(brokenDriver);
  assert.ok(failure);
  assert.equal(failure.reason, "storage_driver_unavailable");
  assert.equal(failure.exitCode, ExitCode.storage);
  assert.match(failure.message, /ABI 127 and this Node\.js is 137/u);
  assert.match(failure.message, /Stored data was not read and is not at fault/u);
  assert.doesNotMatch(failure.message, /\/home\/|node_modules|\.node\b/u);
});

test("a driver that was never built says so, and names the flag that builds it", () => {
  // What a global install under npm 12 leaves behind: the install succeeds, the addon's build
  // script never ran.
  const failure = probeSqliteDriver(() => {
    throw new Error("Could not locate the bindings file. Tried:\n → /home/someone/x.node");
  });
  assert.ok(failure);
  assert.equal(failure.reason, "storage_driver_unavailable");
  assert.match(failure.message, /native build is missing/u);
  assert.match(failure.message, /--allow-scripts=better-sqlite3/u);
  assert.doesNotMatch(failure.message, /\/home\//u);
});

test("a working driver probes clean", () => {
  assert.equal(probeSqliteDriver(), null);
});

/** A configured source whose SNACK database SQLite will refuse to open. */
async function unreadableStorage() {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "work",
      "--provider",
      "anthropic",
      "--profile",
      "default",
      "--plan",
      "pro",
    ],
    fixture.options,
  );
  await mkdir(dirname(fixture.paths.databaseFile), { recursive: true, mode: 0o700 });
  await writeFile(fixture.paths.databaseFile, "not a database", { mode: 0o600 });
  fixture.stdout.value = "";
  fixture.stderr.value = "";
  return fixture;
}

test("a command that cannot open storage says the driver, not the data, when the driver is the cause", async () => {
  const fixture = await unreadableStorage();
  const code = await run(["node", "snack", "status", "--no-sync", "--json"], {
    ...fixture.options,
    openSqliteDriver: brokenDriver,
  });
  const document = JSON.parse(fixture.stdout.value);
  assert.equal(code, ExitCode.storage);
  assert.equal(document.errors[0].code, "storage_driver_unavailable");
});

test("the same unreadable storage with a working driver keeps its own reason", async () => {
  const fixture = await unreadableStorage();
  const code = await run(["node", "snack", "status", "--no-sync", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);
  assert.equal(code, ExitCode.storage);
  assert.notEqual(document.errors[0].code, "storage_driver_unavailable");
});

test("doctor names the driver as its own failed check, and only when it fails", async () => {
  const fixture = await makeRunFixture();
  const broken = await runDoctor(fixture.paths, { openSqliteDriver: brokenDriver });
  const check = broken.checks.find((entry) => entry.id === "sqlite_driver");
  assert.equal(check?.status, "fail");
  assert.match(check?.message ?? "", /ABI 127/u);

  const healthy = await runDoctor(fixture.paths, {});
  assert.equal(
    healthy.checks.some((entry) => entry.id === "sqlite_driver"),
    false,
  );
});
