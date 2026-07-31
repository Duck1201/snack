import { Buffer } from "node:buffer";
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
import {
  ANALYTICS_POLICY,
  computeUsagePressure,
  horizonWindow,
  parseHorizon,
  summarizeUsageProfile,
} from "./analytics.js";
import { runDoctor } from "./doctor.js";
import { ExitCode, SnackError } from "./errors.js";
import { createOpenCodeAdapter, resolveOpenCodeDatabase } from "./opencode-adapter.js";
import {
  preparePluginRegistration,
  resolveOpenCodeConfig,
  writePluginRegistration,
} from "./opencode-config.js";
import { CALIBRATION_POLICY, backtest, summarizeCalibration } from "./calibration.js";
import { createEnvelope, formatJson } from "./output.js";
import { resolvePaths } from "./paths.js";
import { resolvePlanProfile } from "./plan-profile.js";
import {
  readSpoolEvents,
  removeAcknowledgedSegments,
  removeFullyConsumedSegments,
} from "./spool.js";
import { analyzePromptText, categorizeHistory, categorizePromptSize } from "./prompt-features.js";
import { createSourceStatus } from "./status.js";
import { clearSetupJournal, recoverSetupJournal, writeSetupJournal } from "./setup-journal.js";
import {
  ensureCapacityPeriod,
  createSetupDatabaseBackup,
  initializeDatabase,
  inspectDatabase,
  readIngestionCursor,
  readPendingSpoolObservations,
  readRestrictionWindowRows,
  readCategorizationRows,
  readOutcomeRows,
  linkPrimaryEvaluations,
  readCalibrationPairs,
  readPredictionAttemptCount,
  readPredictionSnapshots,
  recordPredictionAttempt,
  recordPredictionDelivery,
  readUsageWindowRows,
  readSpoolCursors,
  readSourceSummary,
  rollbackDatabaseInitialization,
  storeObservations,
  withStorageOperationLock,
  writeSizeCategories,
} from "./storage.js";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

/**
 * @typedef {object} RunOptions
 * @property {{write(chunk: string): unknown}} [stdout]
 * @property {{write(chunk: string): unknown}} [stderr]
 * @property {AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>} [stdin]
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
  const stdin = options.stdin ?? process.stdin;
  const now = options.now ?? new Date();
  const invocationId = randomUUID();
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
            // Categories are a derived projection over the features just ingested; a late
            // arrival can move an older prompt, so the whole source is recategorized in
            // chronological order before any forecast reads it.
            recategorizeSource(paths.databaseFile, candidate.alias);
            // Each new outcome is attached to the forecast that preceded it, so live
            // calibration compares a prediction with the future it did not know about.
            linkPrimaryEvaluations(paths.databaseFile, candidate.alias, "stage5-evaluation-v1");
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
    .command("stats")
    .description("show observed usage, data quality, and pressure statistics")
    .option("--source <alias>", "capacity-source alias")
    .option("--horizon <duration>", "one configured analysis horizon")
    .option("--verbose", "add per-model detail and extra percentiles")
    .option("--json", "emit one versioned JSON document")
    .action(async function stats(commandOptions) {
      const current = await readConfig(paths.configFile);
      const configuredSources = Array.isArray(current.sources)
        ? current.sources.filter(isConfiguredOpenCodeSource)
        : [];
      const selected = commandOptions.source
        ? configuredSources.filter((source) => source.alias === commandOptions.source)
        : configuredSources;
      if (selected.length === 0) {
        throw new SnackError("The requested capacity source is not configured.", {
          code: ExitCode.unavailable,
          reason: "source_unavailable",
        });
      }
      const analysis = /** @type {{horizons?: unknown}} */ (current.analysis);
      const configuredHorizons = Array.isArray(analysis?.horizons)
        ? /** @type {string[]} */ (analysis.horizons)
        : defaultConfig.analysis.horizons;
      const horizons = commandOptions.horizon ? [commandOptions.horizon] : configuredHorizons;
      /** @type {{code: string, message: string}[]} */
      const statsWarnings = [];
      const reports = selected.map((source) => {
        const { profile: planProfile, warnings } = resolvePlanProfile(source);
        statsWarnings.push(...warnings);
        return buildSourceStats({
          databaseFile: paths.databaseFile,
          source,
          planProfile,
          horizons,
          now,
        });
      });
      const data = reports.length === 1 ? reports[0] : { sources: reports };
      if (wantsJson(this, configuredJson)) {
        stdout.write(formatJson(createEnvelope("stats", data, { warnings: statsWarnings, now })));
      } else {
        for (const report of reports) {
          stdout.write(renderStats(report, commandOptions.verbose === true));
        }
      }
    });

  program
    .command("status")
    .description("assess next-prompt viability")
    .option("--source <alias>", "capacity-source alias")
    .option("--no-sync", "use already synchronized observations")
    .option("--prompt-file <path>", "analyze an unsent prompt from a file, or - for stdin")
    .option("--json", "emit one versioned JSON document")
    .action(async function status(commandOptions) {
      /** @type {ReturnType<typeof createSourceStatus>[]} */
      const statuses = [];
      /** @type {number[]} */
      const attemptIds = [];
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
          if (synchronization.performed) {
            recategorizeSource(paths.databaseFile, source.alias);
            linkPrimaryEvaluations(paths.databaseFile, source.alias, "stage5-evaluation-v1");
          }
          const summary = readSourceSummary(paths.databaseFile, source.alias);
          const { profile: planProfile, warnings } = resolvePlanProfile(source);
          statusWarnings.push(...warnings);
          const pressure = computeSourcePressure({
            databaseFile: paths.databaseFile,
            source,
            planProfile,
            horizon: primaryHorizon(current),
            now,
          });
          /** @type {{category: string, prospective: object} | null} */
          let prospective = null;
          if (typeof commandOptions.promptFile === "string") {
            try {
              prospective = await analyzeProspectivePrompt({
                promptFile: commandOptions.promptFile,
                stdin,
                databaseFile: paths.databaseFile,
                alias: source.alias,
              });
            } catch {
              // The text is discarded either way; a missing or unreadable file must not
              // cost the user their forecast, and no part of the error is reported.
              statusWarnings.push({
                code: "prospective_analysis_failed",
                message: "The prompt could not be analyzed; assuming a typical prompt.",
              });
            }
          }
          const sourceStatus = createSourceStatus(source, summary, now, synchronization, pressure, {
            outcomes: readOutcomeRows(paths.databaseFile, source.alias),
            windowSeconds: parseHorizon(primaryHorizon(current)),
            ...(prospective
              ? { category: prospective.category, prospective: prospective.prospective }
              : {}),
          });
          statuses.push(sourceStatus);
          if (summary.active_period_id !== null) {
            attemptIds.push(
              recordPredictionAttempt(
                paths.databaseFile,
                toPredictionAttempt(source.alias, summary.active_period_id, sourceStatus, now),
              ),
            );
          }
        }
        await removeConsumedPendingSegments(paths, configuredSources);
      });
      const data = statuses.length === 1 ? statuses[0] : { sources: statuses };
      // A forecast the evidence gates rate `very_low` is reported as degraded health, so a
      // machine consumer never reads a prior-dominated estimate as a settled result.
      const uncalibrated = statuses.some((entry) => entry.evidence.level === "very_low");
      if (wantsJson(this, configuredJson)) {
        stdout.write(
          formatJson(
            createEnvelope("status", data, {
              status: uncalibrated ? "degraded" : "ok",
              warnings: [
                ...(uncalibrated
                  ? [
                      {
                        code: "very_low_evidence",
                        message:
                          "The evidence gates cap this forecast at very low; it is not calibrated.",
                      },
                    ]
                  : []),
                ...statusWarnings,
              ],
              now,
            }),
          ),
        );
      } else {
        for (const status of statuses) {
          stdout.write(
            `${status.source.alias}: ${(status.viability.lower * 100).toFixed(0)}-${(status.viability.upper * 100).toFixed(0)}% viability; risk ${status.risk.label}; evidence ${status.evidence.level}; method ${status.method.id}@${status.method.version}; pressure ${status.pressure.band}; category ${status.expected_prompt_category}; as_of ${status.freshness.as_of ?? "unknown"}; sync ${status.synchronization.status}.\n`,
          );
          for (const caveat of status.caveats) stdout.write(`Caveat: ${caveat}\n`);
        }
      }
      // Only now, with the bytes written, is an attempt a snapshot the user actually saw.
      confirmPredictionDelivery(paths.databaseFile, attemptIds, {
        now,
        format: wantsJson(this, configuredJson) ? "json" : "human",
        invocationId: invocationId,
      });
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

/**
 * Shape a status result as the immutable attempt row that records it.
 *
 * Only approved aggregates travel: the pressure contributors keep their dimension and
 * numbers, never anything derived from prompt content.
 *
 * @param {string} alias
 * @param {number} capacityPeriodId
 * @param {ReturnType<typeof createSourceStatus>} status
 * @param {Date} now
 * @returns {Record<string, unknown>}
 */
function toPredictionAttempt(alias, capacityPeriodId, status, now) {
  return {
    source_alias: alias,
    capacity_period_id: capacityPeriodId,
    generated_at: now.toISOString(),
    method_id: status.method.id,
    method_version: status.method.version,
    model_policy_version: status.model_policy_version,
    risk_policy_version: status.risk.policy_version,
    evidence_policy_version: status.evidence.policy_version,
    weight_policy_version: status.pressure.policy_version,
    analytics_policy_version: status.pressure.policy_version,
    category_policy_version:
      /** @type {{policy_version?: string} | null} */ (status.prospective)?.policy_version ?? null,
    lower: status.viability.lower,
    point: status.viability.point,
    upper: status.viability.upper,
    coverage_target: status.viability.coverage_target,
    risk_label: status.risk.label,
    evidence_level: status.evidence.level,
    expected_size_category: status.expected_prompt_category,
    backoff_level: status.contributors.backoff_level,
    pressure_band: status.pressure.band,
    pressure_score: /** @type {{score?: number | null}} */ (status.pressure).score ?? null,
    pressure_contributors_json: JSON.stringify(
      /** @type {{contributors?: unknown[]}} */ (status.pressure).contributors ?? [],
    ),
    plan_profile_id: status.source.plan_profile.id,
    plan_profile_version: status.source.plan_profile.version,
    data_as_of: status.freshness.as_of,
    completeness: status.completeness,
  };
}

/**
 * Confirm that forecasts reached the user, promoting the attempts to snapshots.
 *
 * @param {string} databaseFile
 * @param {number[]} attemptIds
 * @param {{now: Date, format: string, invocationId: string}} delivery
 */
function confirmPredictionDelivery(databaseFile, attemptIds, delivery) {
  for (const id of attemptIds) {
    recordPredictionDelivery(databaseFile, {
      prediction_attempt_id: id,
      delivered_at: delivery.now.toISOString(),
      channel: "stdout",
      format: delivery.format,
      invocation_id: delivery.invocationId,
    });
  }
}

/**
 * Read an unsent prompt without letting its text reach argv, the log, or storage.
 *
 * @param {string} promptFile Path, or `-` for standard input.
 * @param {AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>} stdin
 * @returns {Promise<string>}
 */
async function readProspectiveText(promptFile, stdin) {
  if (promptFile !== "-") return readFile(promptFile, "utf8");
  /** @type {string[]} */
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("");
}

/**
 * Derive the prompt-size category of an unsent prompt against local history.
 *
 * The text is held only for the duration of `analyzePromptText`; only the allowlisted
 * feature vector survives this function, and only its category leaves it.
 *
 * @param {{promptFile: string, stdin: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>, databaseFile: string, alias: string}} input
 * @returns {Promise<{category: string, prospective: object} | null>}
 */
async function analyzeProspectivePrompt(input) {
  const text = await readProspectiveText(input.promptFile, input.stdin);
  const features = analyzePromptText(text);
  const baseline = readCategorizationRows(input.databaseFile, input.alias)
    .map((row) => row.estimated_input_tokens)
    .filter((tokens) => tokens !== null);
  const sized = categorizePromptSize(features, baseline);
  return {
    category: sized.category,
    prospective: {
      analyzer_version: features.analyzer_version,
      policy_version: sized.policy_version,
      baseline_kind: sized.baseline_kind,
      baseline_sample: sized.baseline_sample,
    },
  };
}

/**
 * Recompute the derived size categories of a source after ingestion.
 *
 * ponytail: recategorizes the whole source on every sync. The chronological suffix from
 * the earliest changed prompt would be enough; narrow this if the sync budget demands it.
 *
 * @param {string} databaseFile
 * @param {string} alias
 */
function recategorizeSource(databaseFile, alias) {
  const categorized = categorizeHistory(readCategorizationRows(databaseFile, alias));
  writeSizeCategories(
    databaseFile,
    categorized.map((row) => ({
      prompt_execution_id: row.prompt_execution_id,
      size_category: row.size_category,
      category_policy_version: row.category_policy_version,
      category_baseline_as_of: row.category_baseline_as_of,
    })),
  );
}

/**
 * The first configured horizon drives the pressure shown alongside a forecast.
 *
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
function primaryHorizon(config) {
  const configured = /** @type {{horizons?: unknown}} */ (config.analysis)?.horizons;
  return Array.isArray(configured) && typeof configured[0] === "string"
    ? configured[0]
    : /** @type {string} */ (defaultConfig.analysis.horizons[0]);
}

/**
 * Rank the current analysis window against the preceding windows of the same length.
 *
 * @param {{databaseFile: string, source: {alias: string}, planProfile: import("./plan-profile.js").PlanProfile, horizon: string, now: Date}} input
 */
function computeSourcePressure(input) {
  const horizonSeconds = parseHorizon(input.horizon);
  const windowCount = ANALYTICS_POLICY.pressure_baseline_windows;
  // One read covers the current window and every baseline window behind it. Reading each
  // window separately meant one SQLite connection and one scan per window.
  const span = horizonWindow(input.now, horizonSeconds * (windowCount + 1));
  const rows = readUsageWindowRows(input.databaseFile, input.source.alias, span);

  /** @type {import("./storage.js").UsageWindowRow[][]} */
  const buckets = Array.from({ length: windowCount + 1 }, () => []);
  for (const row of rows) {
    // Windows are half-open as `[start, end)`, so an age of exactly one horizon still
    // belongs to the newer window.
    const ageSeconds = (input.now.getTime() - Date.parse(row.started_at)) / 1000;
    const bucket = Math.ceil(ageSeconds / horizonSeconds) - 1;
    buckets[bucket]?.push(row);
  }

  const current = summarizeWindow(/** @type {typeof rows} */ (buckets[0]), input.now);
  /** @type {Record<string, number[]>} */
  const baselines = {};
  let observedWindows = 0;
  for (let offset = 1; offset <= windowCount; offset += 1) {
    const past = summarizeWindow(/** @type {typeof rows} */ (buckets[offset]), input.now);
    // A window with no prompts means the tool was not used then, which is absence of
    // observation rather than evidence of low usage. Ranking against it would call a
    // brand new user's first prompt the heaviest window on record.
    if (past.values.prompts === 0) continue;
    observedWindows += 1;
    for (const [dimension, value] of Object.entries(past.values)) {
      (baselines[dimension] ??= []).push(value);
    }
  }
  if (observedWindows < ANALYTICS_POLICY.pressure_minimum_baseline_windows) {
    return {
      horizon: input.horizon,
      score: null,
      band: "unknown",
      policy_version: ANALYTICS_POLICY.version,
      baseline_kind: "insufficient",
      completeness: "partial",
      contributors: [],
      baseline_windows: observedWindows,
    };
  }
  return {
    horizon: input.horizon,
    baseline_windows: observedWindows,
    ...computeUsagePressure({
      current: current.values,
      baselines,
      profileWeights: input.planProfile.weights,
      effectiveSampleSize: current.effectiveSampleSize,
    }),
  };
}

/**
 * @param {import("./storage.js").UsageWindowRow[]} rows
 * @param {Date} now
 */
function summarizeWindow(rows, now) {
  const profile = summarizeUsageProfile(rows, [], {
    horizon: "",
    window: { from: "", to: "" },
    now,
  });
  /** @type {Record<string, number>} */
  const values = { prompts: profile.prompts.count };
  for (const [dimension, summary] of Object.entries(profile.dimensions)) {
    if ("value" in summary) {
      values[dimension] = summary.value;
    }
  }
  return { values, effectiveSampleSize: profile.effective_sample_size.value };
}

/**
 * Describe observed usage for one capacity source across the requested horizons.
 *
 * @param {{databaseFile: string, source: {alias: string, provider: string, profile: string, plan: string}, planProfile: import("./plan-profile.js").PlanProfile, horizons: string[], now: Date}} input
 */
function buildSourceStats(input) {
  const horizons = input.horizons.map((horizon) => {
    const window = horizonWindow(input.now, parseHorizon(horizon));
    return summarizeUsageProfile(
      readUsageWindowRows(input.databaseFile, input.source.alias, window),
      readRestrictionWindowRows(input.databaseFile, input.source.alias, window),
      { horizon, window, now: input.now },
    );
  });
  return {
    source: {
      alias: input.source.alias,
      provider: input.source.provider,
      profile: input.source.profile,
      plan: input.source.plan,
      plan_profile: {
        id: input.planProfile.id,
        version: input.planProfile.version,
        provenance: input.planProfile.provenance,
        as_of: input.planProfile.as_of,
      },
    },
    horizons,
    pressure: {
      ...computeSourcePressure({
        databaseFile: input.databaseFile,
        source: input.source,
        planProfile: input.planProfile,
        horizon: /** @type {string} */ (input.horizons[0]),
        now: input.now,
      }),
      // Trend needs pressure history, which only prediction snapshots will carry.
      trend: { status: "not_available", reason: "no_pressure_history_yet" },
    },
    calibration: buildCalibrationReport(input.databaseFile, input.source.alias, input.planProfile),
  };
}

/**
 * Report predictive quality from the two streams that must never be mixed: forecasts the
 * user actually saw, and forecasts replayed from history.
 *
 * @param {string} databaseFile
 * @param {string} alias
 * @param {import("./plan-profile.js").PlanProfile} planProfile
 */
function buildCalibrationReport(databaseFile, alias, planProfile) {
  const pairs = readCalibrationPairs(databaseFile, alias);
  const snapshots = readPredictionSnapshots(databaseFile, alias);
  const replay = backtest(readOutcomeRows(databaseFile, alias), {
    now: new Date(),
    prior: { strength: planProfile.prior_strength, viability: 0.5 },
  });
  return {
    policy_version: CALIBRATION_POLICY.version,
    snapshots: snapshots.length,
    undelivered_attempts: readPredictionAttemptCount(databaseFile, alias) - snapshots.length,
    live: summarizeCalibration(pairs),
    backtest: { ...replay.calibration, forecasts: replay.forecasts },
  };
}

/**
 * @param {ReturnType<typeof buildSourceStats>} report
 * @param {boolean} verbose
 */
function renderStats(report, verbose) {
  let text = `${report.source.alias}: plan profile ${report.source.plan_profile.id}@${report.source.plan_profile.version} (${report.source.plan_profile.provenance}, as of ${report.source.plan_profile.as_of}).\n`;
  text += `  pressure ${report.pressure.band} (${report.pressure.baseline_kind} baseline, policy ${report.pressure.policy_version}); trend ${report.pressure.trend.status}.\n`;
  for (const horizon of report.horizons) {
    const restrictions = Object.entries(horizon.restrictions.by_class);
    const tokens = Object.entries(horizon.dimensions)
      .map(([dimension, value]) => `${dimension} ${"value" in value ? value.value : "unknown"}`)
      .join(", ");
    const cost = Object.entries(horizon.cost.by_currency)
      .map(([currency, amount]) => `${currency} ${amount}`)
      .join(", ");
    text +=
      `  ${horizon.horizon}: ${horizon.prompts.count} prompts` +
      ` (${horizon.prompts.eligible} eligible, ${horizon.prompts.excluded} excluded);` +
      ` restrictions ${restrictions.length === 0 ? "none" : restrictions.map(([klass, count]) => `${klass} ${count}`).join(", ")};` +
      ` tokens ${tokens};` +
      ` cost ${cost === "" ? "unknown" : cost};` +
      ` duration ${"p50" in horizon.duration ? `p50 ${horizon.duration.p50}ms p90 ${horizon.duration.p90}ms` : "unknown"};` +
      ` effective sample ${horizon.effective_sample_size.value.toFixed(2)} ${horizon.effective_sample_size.unit};` +
      ` as_of ${horizon.freshness.as_of ?? "unknown"}.\n`;
    if (verbose) {
      for (const [dimension, value] of Object.entries(horizon.dimensions)) {
        text += `    ${dimension}: ${"value" in value ? value.value : "unknown"} ${value.unit} (sample ${value.sample_size}, missing ${value.missing}).\n`;
      }
      text += `    cost: sample ${horizon.cost.sample_size}, missing ${horizon.cost.missing}.\n`;
    }
  }
  return text;
}

/** @param {unknown[]} sources @param {string} installationId */
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
  try {
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
  } catch {
    // The output stream is already gone — `snack status | head` closes it early. Reporting
    // the failure is impossible, but the exit code still has to reach the caller.
  }
  return details.exitCode;
}
