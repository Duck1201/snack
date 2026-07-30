import { readFile } from "node:fs/promises";

import { Command, CommanderError } from "commander";

import {
  getConfigValue,
  prepareConfigValue,
  readConfig,
  withConfigLock,
  writePrivateAtomic,
} from "./config.js";
import { runDoctor } from "./doctor.js";
import { ExitCode, SnackError } from "./errors.js";
import { createEnvelope, formatJson } from "./output.js";
import { resolvePaths } from "./paths.js";
import { initializeDatabase } from "./storage.js";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

/**
 * @typedef {object} RunOptions
 * @property {{write(chunk: string): unknown}} [stdout]
 * @property {{write(chunk: string): unknown}} [stderr]
 * @property {NodeJS.ProcessEnv | undefined} [env]
 * @property {NodeJS.Platform | undefined} [platform]
 * @property {string | undefined} [home]
 * @property {Date | undefined} [now]
 * @property {string | undefined} [nodeVersion]
 */

/**
 * @param {string[]} argv
 * @param {RunOptions} [options]
 * @returns {Promise<number>}
 */
export async function run(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? new Date();
  const paths = resolvePaths({ env: options.env, platform: options.platform, home: options.home });
  let configuredJson = false;
  try {
    configuredJson =
      getConfigValue(await readConfig(paths.configFile), "presentation.json") === true;
  } catch {
    // Each command reports missing or invalid configuration through its own result contract.
  }
  const program = new Command();
  /** @type {number} */
  let commandExitCode = ExitCode.success;
  let commanderError = "";

  program
    .name("snack")
    .description("Know before you feed the model.")
    .version(packageJson.version)
    .option("--json", "emit one versioned JSON document")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => stdout.write(text),
      writeErr: (text) => {
        commanderError += text;
      },
    });

  const config = program.command("config").description("inspect or update local configuration");

  config
    .command("path")
    .description("show the SNACK configuration path")
    .option("--json", "emit one versioned JSON document")
    .action(function configPath() {
      if (wantsJson(this, configuredJson)) {
        stdout.write(
          formatJson(createEnvelope("config path", { path: paths.configFile }, { now })),
        );
      } else {
        stdout.write(`${paths.configFile}\n`);
      }
    });

  config
    .command("get")
    .description("read all configuration or one dotted key")
    .argument("[key]")
    .option("--json", "emit one versioned JSON document")
    .action(async function configGet(key) {
      const value = getConfigValue(await readConfig(paths.configFile), key);
      if (wantsJson(this, configuredJson)) {
        stdout.write(
          formatJson(createEnvelope("config get", { key: key ?? null, value }, { now })),
        );
      } else {
        stdout.write(formatHumanValue(value));
      }
    });

  config
    .command("set")
    .description("validate and atomically update one dotted key")
    .argument("<key>")
    .argument("<value>")
    .option("--json", "emit one versioned JSON document")
    .action(async function configSet(key, value) {
      await prepareConfigValue(paths.configFile, key, value);
      const data = await withConfigLock(paths.configFile, async () => {
        const prepared = await prepareConfigValue(paths.configFile, key, value);
        const storage = await initializeDatabase(paths, {
          applicationVersion: packageJson.version,
          now,
        });
        await writePrivateAtomic(paths.configFile, prepared.content, { backup: true });
        return { key, value: getConfigValue(prepared.config, key), storage };
      });
      if (wantsJson(this, configuredJson)) {
        stdout.write(formatJson(createEnvelope("config set", data, { now })));
      } else {
        stdout.write(`Updated ${key}.\n`);
      }
    });

  program
    .command("doctor")
    .description("diagnose local structure without changing it")
    .option("--json", "emit one versioned JSON document")
    .action(async function doctor() {
      const result = await runDoctor(paths, {
        nodeVersion: options.nodeVersion,
        platform: options.platform,
      });
      if (wantsJson(this, configuredJson)) {
        const warnings = result.checks
          .filter((check) => check.status === "warn")
          .map((check) => ({ code: check.id, message: check.message }));
        const errors = result.checks
          .filter((check) => check.status === "fail")
          .map((check) => ({ code: check.id, message: check.message }));
        stdout.write(
          formatJson(
            createEnvelope(
              "doctor",
              { checks: result.checks },
              {
                status: result.status,
                warnings,
                errors,
                now,
              },
            ),
          ),
        );
      } else {
        for (const check of result.checks) {
          const destination = check.status === "pass" ? stdout : stderr;
          destination.write(`[${check.status}] ${check.id}: ${check.message}\n`);
        }
      }
      commandExitCode = doctorExitCode(result.checks);
    });

  try {
    if (argv.length <= 2) {
      program.outputHelp();
      return ExitCode.success;
    }
    await program.parseAsync(argv);
    return commandExitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return ExitCode.success;
      return renderError({
        stdout,
        stderr,
        json: argv.includes("--json") || configuredJson,
        command: commandName(argv),
        message: "Invalid command usage.",
        reason: "invalid_usage",
        exitCode: ExitCode.usage,
        humanDetail: commanderError,
        now,
      });
    }
    if (error instanceof SnackError) {
      return renderError({
        stdout,
        stderr,
        json: argv.includes("--json") || configuredJson,
        command: commandName(argv),
        message: error.message,
        reason: error.reason,
        exitCode: error.exitCode,
        now,
      });
    }
    return renderError({
      stdout,
      stderr,
      json: argv.includes("--json") || configuredJson,
      command: commandName(argv),
      message: "Unexpected internal failure.",
      reason: "internal_error",
      exitCode: ExitCode.internal,
      now,
    });
  }
}

/** @param {Command} command @param {boolean} configuredJson */
function wantsJson(command, configuredJson) {
  return command.optsWithGlobals().json === true || configuredJson;
}

/** @param {unknown} value */
function formatHumanValue(value) {
  if (typeof value === "string") return `${value}\n`;
  if (value === null || typeof value !== "object") return `${String(value)}\n`;
  return formatJson(value);
}

/** @param {{id: string, status: "pass" | "warn" | "fail"}[]} checks */
function doctorExitCode(checks) {
  if (!checks.some((check) => check.status === "fail")) return ExitCode.success;
  if (checks.some((check) => check.status === "fail" && check.id.startsWith("config"))) {
    return ExitCode.config;
  }
  const storageChecks = new Set([
    "storage",
    "storage_integrity",
    "storage_migrations",
    "data_directory",
    "database_file",
    "backup_directory",
    "backup_files",
  ]);
  if (checks.some((check) => check.status === "fail" && storageChecks.has(check.id))) {
    return ExitCode.storage;
  }
  return ExitCode.internal;
}

/** @param {string[]} argv */
function commandName(argv) {
  return (
    argv
      .slice(2)
      .filter((part) => !part.startsWith("-"))
      .slice(0, 2)
      .join(" ") || "snack"
  );
}

/**
 * @param {{stdout: {write(chunk: string): unknown}, stderr: {write(chunk: string): unknown}, json: boolean, command: string, message: string, reason: string, exitCode: number, humanDetail?: string, now: Date}} details
 */
function renderError(details) {
  if (details.json) {
    details.stdout.write(
      formatJson(
        createEnvelope(details.command, null, {
          status: "error",
          errors: [{ code: details.reason, message: details.message }],
          now: details.now,
        }),
      ),
    );
  } else {
    details.stderr.write(details.humanDetail || `Error: ${details.message}\n`);
  }
  return details.exitCode;
}
