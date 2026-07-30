import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { Command, CommanderError } from "commander";

import {
  defaultConfig,
  getConfigValue,
  prepareConfigValue,
  prepareConfigValues,
  readConfig,
  withConfigLock,
  writePrivateAtomic,
} from "./config.js";
import { runDoctor } from "./doctor.js";
import { ExitCode, SnackError } from "./errors.js";
import { createOpenCodeAdapter, resolveOpenCodeDatabase } from "./opencode-adapter.js";
import {
  preparePluginRegistration,
  resolveOpenCodeConfig,
  writePluginRegistration,
} from "./opencode-config.js";
import { createEnvelope, formatJson } from "./output.js";
import { resolvePaths } from "./paths.js";
import { resolvePlanProfile } from "./plan-profile.js";
import {
  readSpoolEvents,
  removeAcknowledgedSegments,
  removeFullyConsumedSegments,
} from "./spool.js";
import { createInitialStatus } from "./status.js";
import { clearSetupJournal, recoverSetupJournal, writeSetupJournal } from "./setup-journal.js";
import {
  ensureCapacityPeriod,
  createSetupDatabaseBackup,
  initializeDatabase,
  inspectDatabase,
  readIngestionCursor,
  readPendingSpoolObservations,
  readSpoolCursors,
  readSourceSummary,
  rollbackDatabaseInitialization,
  storeObservations,
  withStorageOperationLock,
} from "./storage.js";

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
 * @property {typeof writePrivateAtomic | undefined} [writeConfig]
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

  const setup = program.command("setup").description("configure a local client source");

  setup
    .command("opencode")
    .description("configure read-only OpenCode history")
    .option("--non-interactive", "require all setup values as flags")
    .requiredOption("--source <alias>", "capacity-source alias")
    .requiredOption("--provider <identifier>", "provider identifier")
    .requiredOption("--profile <alias>", "local account/profile alias")
    .requiredOption("--plan <identifier>", "plan profile identifier")
    .option("--dry-run", "validate and show the proposal without mutation")
    .option("--install-plugin", "register @snack-ai/opencode in the global OpenCode configuration")
    .option("--yes", "confirm a non-interactive global OpenCode configuration change")
    .option("--enable-prospective-analysis", "enable allowlisted ephemeral prompt features")
    .option("--json", "emit one versioned JSON document")
    .action(async function setupOpenCode(commandOptions) {
      if (commandOptions.nonInteractive !== true) {
        throw new SnackError("Interactive setup is not available in this release.", {
          code: ExitCode.usage,
          reason: "interactive_setup_unavailable",
        });
      }
      let recoveredSetupJournal = false;
      const databaseFile = resolveOpenCodeDatabase({
        ...(options.env ? { env: options.env } : {}),
        ...(options.home ? { home: options.home } : {}),
      });
      const adapter = createOpenCodeAdapter({ databaseFile });
      const fingerprint = adapter.fingerprint();
      if (!fingerprint.supported || fingerprint.family === null) {
        throw new SnackError("The OpenCode database fingerprint is unsupported.", {
          code: ExitCode.unavailable,
          reason: "source_schema_unsupported",
        });
      }
      const dryRun = adapter.readAll();
      if (
        commandOptions.installPlugin === true &&
        commandOptions.dryRun !== true &&
        commandOptions.yes !== true
      ) {
        throw new SnackError("Plugin registration requires --yes in non-interactive setup.", {
          code: ExitCode.usage,
          reason: "plugin_registration_confirmation_required",
        });
      }
      /** @type {{alias: string, installation_id: string, adapter: string, database: string, provider: string, profile: string, plan: string, fingerprint: string}} */
      let configuredSource = {
        alias: commandOptions.source,
        installation_id: randomUUID(),
        adapter: "opencode",
        database: databaseFile,
        provider: commandOptions.provider,
        profile: commandOptions.profile,
        plan: commandOptions.plan,
        fingerprint: fingerprint.family,
      };
      /** @type {{content: string, change: {target: string, package: string, action: string, prospective_analysis: boolean}} | null} */
      let pluginRegistration = null;
      if (commandOptions.dryRun !== true) {
        await withStorageOperationLock(paths, async () => {
          recoveredSetupJournal = await recoverSetupJournal(paths);
          await withConfigLock(paths.configFile, async () => {
            /** @type {Record<string, unknown>} */
            let current = { ...defaultConfig };
            try {
              current = await readConfig(paths.configFile);
            } catch (error) {
              if (!(error instanceof SnackError) || error.reason !== "config_missing") throw error;
            }
            const sources = /** @type {unknown[]} */ (
              Array.isArray(current.sources) ? current.sources : []
            );
            const existingAlias = sources.find(
              (source) =>
                typeof source === "object" &&
                source !== null &&
                "alias" in source &&
                source.alias === configuredSource.alias,
            );
            if (
              typeof existingAlias === "object" &&
              existingAlias !== null &&
              "database" in existingAlias &&
              existingAlias.database !== databaseFile
            ) {
              throw new SnackError(
                "A capacity-source alias cannot be rebound to another database.",
                {
                  code: ExitCode.config,
                  reason: "source_rebind_rejected",
                },
              );
            }
            const ambiguousMapping = sources.some(
              (source) =>
                typeof source === "object" &&
                source !== null &&
                "alias" in source &&
                source.alias !== configuredSource.alias &&
                "database" in source &&
                source.database === databaseFile &&
                "provider" in source &&
                source.provider === configuredSource.provider &&
                "profile" in source &&
                source.profile === configuredSource.profile,
            );
            if (ambiguousMapping) {
              throw new SnackError(
                "A provider/profile combination can map to only one capacity source per OpenCode installation.",
                {
                  code: ExitCode.config,
                  reason: "source_mapping_ambiguous",
                },
              );
            }
            const existingInstallation = sources.find(
              (source) =>
                typeof source === "object" &&
                source !== null &&
                "database" in source &&
                source.database === databaseFile &&
                "installation_id" in source &&
                typeof source.installation_id === "string",
            );
            if (
              typeof existingInstallation === "object" &&
              existingInstallation !== null &&
              "installation_id" in existingInstallation &&
              typeof existingInstallation.installation_id === "string"
            ) {
              configuredSource = {
                ...configuredSource,
                installation_id: existingInstallation.installation_id,
              };
            }
            const updatedSources = [
              ...sources.filter(
                (source) =>
                  typeof source !== "object" ||
                  source === null ||
                  !("alias" in source) ||
                  source.alias !== configuredSource.alias,
              ),
              configuredSource,
            ];
            /** @type {[string, unknown][]} */
            const configUpdates = [["sources", updatedSources]];
            if (commandOptions.enableProspectiveAnalysis === true) {
              configUpdates.push(["prospective_analysis.enabled", true]);
            }
            const prepared = await prepareConfigValues(paths.configFile, configUpdates);
            let previousSnackConfig = null;
            try {
              previousSnackConfig = await readFile(paths.configFile, "utf8");
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                throw error;
            }
            let registration = null;
            let pluginConfigFile = null;
            if (commandOptions.installPlugin === true) {
              pluginConfigFile = resolveOpenCodeConfig({
                ...(options.env ? { env: options.env } : {}),
                ...(options.home ? { home: options.home } : {}),
              });
              registration = await preparePluginRegistration(pluginConfigFile, {
                installation_id: configuredSource.installation_id,
                spool_directory: paths.spoolDir,
                prospective_analysis: commandOptions.enableProspectiveAnalysis === true,
                source_bindings: pluginBindings(
                  updatedSources,
                  configuredSource.installation_id,
                  paths,
                ),
              });
            }
            const existed = (await inspectDatabase(paths.databaseFile)).exists;
            const databaseBackupFile =
              registration === null ? null : await createSetupDatabaseBackup(paths);
            let pluginRegistrationWritten = false;
            try {
              if (registration !== null && pluginConfigFile !== null) {
                await writeSetupJournal(paths, {
                  opencode_config_file: pluginConfigFile,
                  config_existed: registration.config_existed,
                  plugin_property_existed: registration.plugin_property_existed,
                  previous_plugin: registration.previous_plugin,
                  previous_plugin_index: registration.previous_plugin_index,
                  installed_plugin_hash: registration.installed_plugin_hash,
                  previous_snack_config: previousSnackConfig,
                  database_backup_file: databaseBackupFile,
                });
              }
              await initializeDatabase(paths, {
                applicationVersion: packageJson.version,
                now,
              });
              if (registration !== null && pluginConfigFile !== null) {
                await prepareSpoolDirectories(paths, registration);
                await writePluginRegistration(
                  pluginConfigFile,
                  registration.content,
                  registration.previous_content,
                );
                pluginRegistrationWritten = true;
              }
              await (options.writeConfig ?? writePrivateAtomic)(
                paths.configFile,
                prepared.content,
                {
                  backup: true,
                },
              );
              ensureCapacityPeriod(
                paths.databaseFile,
                configuredSource,
                now,
                resolvePlanProfile(configuredSource).profile,
              );
              pluginRegistration = registration;
              await clearSetupJournal(paths);
              if (databaseBackupFile !== null) {
                await rm(databaseBackupFile, { force: true }).catch(() => {});
              }
            } catch (error) {
              if (registration !== null) {
                if (!pluginRegistrationWritten && pluginConfigFile !== null) {
                  try {
                    pluginRegistrationWritten =
                      (await readFile(pluginConfigFile, "utf8")) === registration.content;
                  } catch {
                    pluginRegistrationWritten = false;
                  }
                }
                await recoverSetupJournal(paths, { restorePlugin: pluginRegistrationWritten });
              } else if (previousSnackConfig === null) await rm(paths.configFile, { force: true });
              else await writePrivateAtomic(paths.configFile, previousSnackConfig);
              await rollbackDatabaseInitialization(paths, existed);
              throw error;
            }
          });
        });
      } else if (commandOptions.installPlugin === true) {
        const configFile = resolveOpenCodeConfig({
          ...(options.env ? { env: options.env } : {}),
          ...(options.home ? { home: options.home } : {}),
        });
        pluginRegistration = await preparePluginRegistration(configFile, {
          installation_id: configuredSource.installation_id,
          spool_directory: paths.spoolDir,
          prospective_analysis: commandOptions.enableProspectiveAnalysis === true,
          source_bindings: [
            {
              provider: configuredSource.provider,
              source_alias: configuredSource.alias,
              spool_directory: join(paths.spoolDir, configuredSource.alias),
            },
          ],
        });
      }
      const data = {
        source: {
          alias: configuredSource.alias,
          installation_id: configuredSource.installation_id,
          adapter: configuredSource.adapter,
          provider: configuredSource.provider,
          profile: configuredSource.profile,
          plan: configuredSource.plan,
        },
        fingerprint: { family: fingerprint.family, supported: fingerprint.supported },
        dry_run: {
          observations: dryRun.observations.length,
          ...(commandOptions.dryRun === true ? { applied: false } : {}),
        },
        ...(pluginRegistrationChange(pluginRegistration)
          ? { plugin_registration: pluginRegistrationChange(pluginRegistration) }
          : {}),
        ...(recoveredSetupJournal ? { recovered_setup_journal: true } : {}),
      };
      if (wantsJson(this, configuredJson)) {
        stdout.write(formatJson(createEnvelope("setup opencode", data, { now })));
      } else {
        stdout.write(
          commandOptions.dryRun === true
            ? `Validated OpenCode source ${configuredSource.alias}; no changes applied.\n`
            : `Configured OpenCode source ${configuredSource.alias}.\n`,
        );
      }
    });

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

  program
    .command("sync")
    .description("synchronize configured source history")
    .option("--source <alias>", "capacity-source alias")
    .option("--full", "re-read all supported source history")
    .option("--json", "emit one versioned JSON document")
    .action(async function sync(commandOptions) {
      /** @type {ReturnType<typeof emptySyncResult>[]} */
      const results = [];
      const syncWarnings = [];
      await withStorageOperationLock(paths, async () => {
        await recoverSetupJournal(paths);
        const current = await readConfig(paths.configFile);
        const configuredSources = Array.isArray(current.sources) ? current.sources : [];
        const selected = commandOptions.source
          ? configuredSources.filter(
              (source) =>
                typeof source === "object" &&
                source !== null &&
                "alias" in source &&
                source.alias === commandOptions.source,
            )
          : configuredSources;
        if (selected.length === 0) {
          throw new SnackError("The requested capacity source is not configured.", {
            code: ExitCode.unavailable,
            reason: "source_unavailable",
          });
        }
        await initializeDatabase(paths, { applicationVersion: packageJson.version, now });
        for (const candidate of selected) {
          if (!isConfiguredOpenCodeSource(candidate)) continue;
          const mappings = providerMappings(configuredSources, candidate.installation_id);
          try {
            results.push(
              ...(await synchronizeOpenCodeSource({
                paths,
                source: candidate,
                full: commandOptions.full === true,
                now,
                mappings,
              })),
            );
          } catch {
            results.push({
              alias: candidate.alias,
              path: "backfill",
              read: 0,
              inserted: 0,
              updated: 0,
              unchanged: 0,
              excluded: 0,
              pending_mapping: 0,
              rejected_invalid: 0,
              failed: 1,
            });
          }
        }
        await removeConsumedPendingSegments(paths, configuredSources);
      });
      for (const result of results) {
        if (result.failed > 0) {
          syncWarnings.push({
            code: "source_sync_failed",
            message: `Synchronization failed for source ${result.alias} (${result.path}).`,
          });
        }
      }
      const data = { sources: results };
      if (wantsJson(this, configuredJson)) {
        stdout.write(
          formatJson(
            createEnvelope("sync", data, {
              status: syncWarnings.length > 0 ? "degraded" : "ok",
              warnings: syncWarnings,
              now,
            }),
          ),
        );
      } else {
        for (const result of results) {
          stdout.write(
            `${result.alias}: ${result.read} read, ${result.inserted} inserted, ${result.updated} updated, ${result.unchanged} unchanged, ${result.excluded} excluded, ${result.pending_mapping} pending_mapping, ${result.rejected_invalid} rejected_invalid, ${result.failed} failed.\n`,
          );
        }
      }
    });

  program
    .command("status")
    .description("assess next-prompt viability")
    .option("--source <alias>", "capacity-source alias")
    .option("--no-sync", "use already synchronized observations")
    .option("--json", "emit one versioned JSON document")
    .action(async function status(commandOptions) {
      /** @type {ReturnType<typeof createInitialStatus>[]} */
      const statuses = [];
      /** @type {{code: string, message: string}[]} */
      const statusWarnings = [];
      await withStorageOperationLock(paths, async () => {
        await recoverSetupJournal(paths);
        const current = await readConfig(paths.configFile);
        const configuredSources = Array.isArray(current.sources)
          ? current.sources.filter(isConfiguredOpenCodeSource)
          : [];
        const selected = commandOptions.source
          ? configuredSources.filter((source) => source.alias === commandOptions.source)
          : configuredSources;
        if (selected.length === 0) {
          throw new SnackError("The requested capacity source is unavailable or ambiguous.", {
            code: ExitCode.unavailable,
            reason: "source_unavailable",
          });
        }
        if (commandOptions.sync !== false) {
          await initializeDatabase(paths, { applicationVersion: packageJson.version, now });
        }
        for (const source of selected) {
          let synchronization = { performed: false, status: "not_requested" };
          if (commandOptions.sync !== false) {
            try {
              const syncResults = await synchronizeOpenCodeSource({
                paths,
                source,
                full: false,
                now,
                mappings: providerMappings(configuredSources, source.installation_id),
              });
              synchronization = {
                performed: true,
                status: syncResults.some((result) => result.failed > 0) ? "failed" : "ok",
              };
            } catch {
              synchronization = { performed: true, status: "failed" };
            }
          }
          const summary = readSourceSummary(paths.databaseFile, source.alias);
          statusWarnings.push(...resolvePlanProfile(source).warnings);
          statuses.push(createInitialStatus(source, summary, now, synchronization));
        }
        await removeConsumedPendingSegments(paths, configuredSources);
      });
      const data = statuses.length === 1 ? statuses[0] : { sources: statuses };
      if (wantsJson(this, configuredJson)) {
        stdout.write(
          formatJson(
            createEnvelope("status", data, {
              status: "degraded",
              warnings: [
                {
                  code: "initial_estimate",
                  message: "The estimate is an uncalibrated Stage 2 heuristic.",
                },
                ...statusWarnings,
              ],
              now,
            }),
          ),
        );
      } else {
        for (const status of statuses) {
          stdout.write(
            `${status.source.alias}: ${(status.viability.lower * 100).toFixed(0)}-${(status.viability.upper * 100).toFixed(0)}% viability; risk ${status.risk.label}; evidence ${status.evidence}; method ${status.method.id}@${status.method.version}; pressure ${status.pressure.band}; category ${status.expected_prompt_category}; as_of ${status.freshness.as_of ?? "unknown"}; sync ${status.synchronization.status}.\n`,
          );
          for (const caveat of status.caveats) stdout.write(`Caveat: ${caveat}\n`);
        }
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
      const data = await withStorageOperationLock(paths, async () => {
        await recoverSetupJournal(paths);
        return withConfigLock(paths.configFile, async () => {
          const prepared = await prepareConfigValue(paths.configFile, key, value);
          const storage = await initializeDatabase(paths, {
            applicationVersion: packageJson.version,
            now,
          });
          await writePrivateAtomic(paths.configFile, prepared.content, { backup: true });
          return { key, value: getConfigValue(prepared.config, key), storage };
        });
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
        now,
        opencodeConfigFile: resolveOpenCodeConfig({
          ...(options.env ? { env: options.env } : {}),
          ...(options.home ? { home: options.home } : {}),
        }),
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

/** @param {import("./paths.js").SnackPaths} paths @param {{spool_directories: string[]}} registration */
async function prepareSpoolDirectories(paths, registration) {
  for (const directory of new Set([paths.spoolDir, ...registration.spool_directories])) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}

/**
 * @param {{paths: import("./paths.js").SnackPaths, source: {alias: string, installation_id: string, database: string, fingerprint: string, provider: string, profile: string, plan: string, adapter: string}, full: boolean, now: Date, mappings: {mappedProviders: Set<string>, providerMappingCounts: Map<string, number>}}} options
 */
async function synchronizeOpenCodeSource(options) {
  const results = [];
  // Every write path must agree on the active plan profile, otherwise storing
  // observations would reopen the capacity period the resolved profile just stamped.
  const mappings = {
    ...options.mappings,
    planProfile: resolvePlanProfile(options.source).profile,
  };
  try {
    const adapter = createOpenCodeAdapter({ databaseFile: options.source.database });
    const cursor = options.full
      ? null
      : readIngestionCursor(options.paths.databaseFile, options.source.alias);
    const backfill = options.full ? adapter.readAll() : adapter.readSince(cursor);
    results.push(
      storeObservations(
        options.paths.databaseFile,
        options.source,
        backfill,
        options.now,
        mappings,
      ),
    );
  } catch {
    results.push(emptySyncResult(options.source.alias, "backfill", 1));
  }
  try {
    const retained = readPendingSpoolObservations(options.paths.databaseFile, options.source);
    if (retained.length > 0) {
      results.push(
        storeObservations(
          options.paths.databaseFile,
          options.source,
          { observations: retained, cursor: null },
          options.now,
          { ...mappings, path: "spool" },
        ),
      );
    }
    const spool = await readSpoolEvents({
      spoolDirectory: join(options.paths.spoolDir, options.source.alias),
      installationId: options.source.installation_id,
      cursors: readSpoolCursors(options.paths.databaseFile, options.source.alias),
    });
    const spoolResult = storeObservations(
      options.paths.databaseFile,
      options.source,
      { observations: spool.observations, cursor: null },
      options.now,
      {
        ...mappings,
        path: "spool",
        spoolCursors: spool.cursors,
        rejected: spool.rejected,
      },
    );
    spoolResult.read = spool.read;
    if (spool.read > 0 || spool.rejected.length > 0 || spool.truncated > 0)
      results.push(spoolResult);
    if (spool.acknowledgedSegments.length > 0) {
      await removeAcknowledgedSegments(
        join(options.paths.spoolDir, options.source.alias),
        spool.acknowledgedSegments,
      );
    }
    const pending = await readSpoolEvents({
      spoolDirectory: join(options.paths.spoolDir, "_pending"),
      installationId: options.source.installation_id,
      cursors: readSpoolCursors(options.paths.databaseFile, options.source.alias),
      segmentPrefix: "_pending",
    });
    if (pending.read > 0 || pending.rejected.length > 0 || pending.truncated > 0) {
      const pendingResult = storeObservations(
        options.paths.databaseFile,
        options.source,
        { observations: pending.observations, cursor: null },
        options.now,
        {
          ...mappings,
          path: "spool",
          spoolCursors: pending.cursors,
          rejected: pending.rejected,
        },
      );
      pendingResult.read = pending.read;
      results.push(pendingResult);
    }
  } catch {
    results.push(emptySyncResult(options.source.alias, "spool", 1));
  }
  return results;
}

/** @param {import("./paths.js").SnackPaths} paths @param {unknown[]} sources */
async function removeConsumedPendingSegments(paths, sources) {
  const configured = sources.filter(isConfiguredOpenCodeSource);
  await removeFullyConsumedSegments({
    spoolDirectory: join(paths.spoolDir, "_pending"),
    segmentPrefix: "_pending",
    sourceCursors: new Map(
      configured.map((source) => [
        source.alias,
        readSpoolCursors(paths.databaseFile, source.alias),
      ]),
    ),
  });
}

/**
 * @param {unknown[]} sources
 * @param {string} installationId
 * @param {import("./paths.js").SnackPaths} paths
 */
function pluginBindings(sources, installationId, paths) {
  const configured = sources
    .filter(isConfiguredOpenCodeSource)
    .filter((source) => source.installation_id === installationId);
  return configured.flatMap((source) =>
    configured.filter((candidate) => candidate.provider === source.provider).length === 1
      ? [
          {
            provider: source.provider,
            source_alias: source.alias,
            spool_directory: join(paths.spoolDir, source.alias),
          },
        ]
      : [],
  );
}

/** @param {string} alias @param {"backfill" | "spool"} path @param {number} failed */
function emptySyncResult(alias, path, failed) {
  return {
    alias,
    path,
    read: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    excluded: 0,
    pending_mapping: 0,
    rejected_invalid: 0,
    failed,
  };
}

/** @param {Command} command @param {boolean} configuredJson */
function wantsJson(command, configuredJson) {
  return command.optsWithGlobals().json === true || configuredJson;
}

/**
 * @param {unknown} value
 * @returns {{target: string, package: string, action: string, prospective_analysis: boolean} | null}
 */
function pluginRegistrationChange(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("change" in value) ||
    typeof value.change !== "object" ||
    value.change === null
  ) {
    return null;
  }
  const change = value.change;
  return "target" in change &&
    "package" in change &&
    "action" in change &&
    "prospective_analysis" in change &&
    typeof change.target === "string" &&
    typeof change.package === "string" &&
    typeof change.action === "string" &&
    typeof change.prospective_analysis === "boolean"
    ? {
        target: change.target,
        package: change.package,
        action: change.action,
        prospective_analysis: change.prospective_analysis,
      }
    : null;
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
    "spool_directory",
  ]);
  if (checks.some((check) => check.status === "fail" && storageChecks.has(check.id))) {
    return ExitCode.storage;
  }
  if (checks.some((check) => check.status === "fail" && check.id.startsWith("source_"))) {
    return ExitCode.unavailable;
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
 * @param {unknown} value
 * @returns {value is {alias: string, installation_id: string, adapter: "opencode", database: string, provider: string, profile: string, plan: string, fingerprint: string}}
 */
function isConfiguredOpenCodeSource(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "alias" in value &&
    typeof value.alias === "string" &&
    "installation_id" in value &&
    typeof value.installation_id === "string" &&
    "adapter" in value &&
    value.adapter === "opencode" &&
    "database" in value &&
    typeof value.database === "string" &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "profile" in value &&
    typeof value.profile === "string" &&
    "plan" in value &&
    typeof value.plan === "string" &&
    "fingerprint" in value &&
    typeof value.fingerprint === "string"
  );
}

/**
 * @param {unknown[]} sources
 * @param {string} installationId
 * @returns {{mappedProviders: Set<string>, providerMappingCounts: Map<string, number>}}
 */
function providerMappings(sources, installationId) {
  const providerMappingCounts = new Map();
  for (const source of sources) {
    if (!isConfiguredOpenCodeSource(source) || source.installation_id !== installationId) continue;
    providerMappingCounts.set(
      source.provider,
      (providerMappingCounts.get(source.provider) ?? 0) + 1,
    );
  }
  return { mappedProviders: new Set(providerMappingCounts.keys()), providerMappingCounts };
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
