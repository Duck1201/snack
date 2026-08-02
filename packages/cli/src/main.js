import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { Command, CommanderError, Option } from "commander";

import {
  checkSourceIdentifier,
  defaultConfig,
  getConfigValue,
  isConfiguredSource,
  prepareConfigValue,
  prepareConfigValues,
  readConfig,
  requireConfiguredSource,
  withConfigLock,
  writePrivateAtomic,
} from "./config.js";
import {
  ANALYTICS_POLICY,
  TREND_POLICY,
  compareOutcomeGroups,
  computeUsagePressure,
  computeUsageTrend,
  horizonWindow,
  parseHorizon,
  summarizeUsageProfile,
} from "./analytics.js";
import { runDoctor } from "./doctor.js";
import { ExitCode, SnackError } from "./errors.js";
import {
  EXPORT_SCHEMA_VERSION,
  EXPORT_TABLES,
  exportCsvChunks,
  exportJsonChunks,
} from "./export.js";
import { createClaudeAdapter, resolveClaudeProjectsDirectory } from "./claude-adapter.js";
import { createSourceAdapter } from "./source-adapter.js";
import { createOpenCodeAdapter, resolveOpenCodeDatabase } from "./opencode-adapter.js";
import {
  inspectPluginRegistration,
  pluginPackageSpec,
  preparePluginRegistration,
  readRegisteredInstallationId,
  resolveOpenCodeConfig,
  writePluginRegistration,
} from "./opencode-config.js";
import { CALIBRATION_POLICY, backtest, summarizeCalibration } from "./calibration.js";
import { ENVELOPE_SCHEMA_VERSION, createEnvelope, formatJson } from "./output.js";
import { resolvePaths } from "./paths.js";
import { renderStats, renderStatus, renderStatusTable } from "./render.js";
import { resolvePlanProfile } from "./plan-profile.js";
import { executeCommand, readLockfiles, resolveUpdatePlan, updateModulePath } from "./update.js";
import {
  readSpoolEvents,
  removeAcknowledgedSegments,
  removeFullyConsumedSegments,
} from "./spool.js";
import { PREDICTION_POLICY, classifyIngestionCompleteness } from "./prediction.js";
import { analyzePromptText, categorizeHistory, categorizePromptSize } from "./prompt-features.js";
import { createSourceStatus } from "./status.js";
import { clearSetupJournal, recoverSetupJournal, writeSetupJournal } from "./setup-journal.js";
import {
  assertReadableStorage,
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
  readSpoolIssueCount,
  readPendingMappingCount,
  purgeScope,
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
 * @property {SetupPrompt | undefined} [prompt]
 * @property {string | undefined} [modulePath]
 * @property {ExecuteCommand | undefined} [execute]
 */

/**
 * Runs an executable to completion, and rejects when it does not succeed.
 *
 * `update` is the only command that uses it, for the two processes it has to start: the package
 * manager, and the newly installed binary it re-execs. Injected the way `writeConfig` and `prompt`
 * already are, so no test runs a package manager or spawns anything.
 *
 * @typedef {(command: string, args: string[]) => Promise<void>} ExecuteCommand
 */

/**
 * Asks the user one question and resolves to their answer.
 *
 * Injected rather than reached for, so command tests can script a terminal that does not
 * exist. The default implementation is built on `node:readline/promises`.
 *
 * @typedef {(question: {id: string, message: string, choices?: {value: string, label: string}[], default?: string}) => Promise<string>} SetupPrompt
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
    .option("--source <alias>", "capacity-source alias")
    .option("--provider <identifier>", "provider identifier")
    .option("--profile <alias>", "local account/profile alias")
    .option("--plan <identifier>", "how you refer to your plan; a label, not a lookup key")
    .option("--plan-profile <identifier>", "bundled or custom plan profile to use as the prior")
    .option("--dry-run", "validate and show the proposal without mutation")
    .option("--install-plugin", "register @snack-ai/opencode in the global OpenCode configuration")
    .option("--yes", "confirm a non-interactive global OpenCode configuration change")
    .option("--enable-prospective-analysis", "enable allowlisted ephemeral prompt features")
    .option("--json", "emit one versioned JSON document")
    .action(async function setupOpenCode(commandOptions) {
      let recoveredSetupJournal = false;
      /** @type {{rotated: boolean, retired_prompts: number} | null} */
      let capacityPeriod = null;
      const databaseFile = resolveOpenCodeDatabase({
        ...(options.env ? { env: options.env } : {}),
        ...(options.home ? { home: options.home } : {}),
      });
      const adapter = createOpenCodeAdapter({ databaseFile });
      const fingerprint = adapter.fingerprint();
      // Fail closed on an unknown schema before anything else, so a guided setup never walks
      // someone through a questionnaire that cannot lead anywhere.
      if (!fingerprint.supported || fingerprint.family === null) {
        throw new SnackError("The OpenCode database fingerprint is unsupported.", {
          code: ExitCode.unavailable,
          reason: "source_schema_unsupported",
        });
      }
      const dryRun = adapter.readAll();
      const resolved = await resolveSetupValues({
        commandOptions,
        observations: dryRun.observations,
        existingSources: await readConfiguredSources(paths.configFile),
        prompt: options.prompt,
        stdout,
      });
      if (resolved === null) {
        stdout.write("Setup cancelled; nothing was changed.\n");
        return;
      }
      if (
        resolved.installPlugin === true &&
        resolved.dryRun !== true &&
        commandOptions.nonInteractive === true &&
        commandOptions.yes !== true
      ) {
        throw new SnackError("Plugin registration requires --yes in non-interactive setup.", {
          code: ExitCode.usage,
          reason: "plugin_registration_confirmation_required",
        });
      }
      /** @type {{alias: string, installation_id: string, adapter: string, database: string, provider: string, profile: string, plan: string, plan_profile: string, fingerprint: string}} */
      let configuredSource = {
        alias: resolved.source,
        installation_id: randomUUID(),
        adapter: "opencode",
        database: databaseFile,
        provider: resolved.provider,
        profile: resolved.profile,
        plan: resolved.plan,
        // Recorded separately from `plan`, because the plan a user names and the profile SNACK
        // holds a prior for are different things. Defaulting here keeps a free-text plan label
        // from being resolved as a profile id and warning on every later command.
        plan_profile: resolved.planProfile ?? "generic",
        fingerprint: fingerprint.family,
      };
      /** @type {{content: string, change: {target: string, package: string, action: string, prospective_analysis: boolean}} | null} */
      let pluginRegistration = null;
      if (resolved.dryRun !== true) {
        const committed = await commitConfiguredSource({
          paths,
          now,
          source: configuredSource,
          locationKey: "database",
          enableProspectiveAnalysis: resolved.enableProspectiveAnalysis === true,
          writeConfig: options.writeConfig,
          registerPlugin:
            resolved.installPlugin === true
              ? async (updatedSources, installationId) => {
                  const configFile = resolveOpenCodeConfig({
                    ...(options.env ? { env: options.env } : {}),
                    ...(options.home ? { home: options.home } : {}),
                  });
                  return {
                    configFile,
                    registration: await preparePluginRegistration(configFile, {
                      installation_id: installationId,
                      spool_directory: paths.spoolDir,
                      prospective_analysis: resolved.enableProspectiveAnalysis === true,
                      source_bindings: pluginBindings(updatedSources, installationId, paths),
                    }),
                  };
                }
              : undefined,
        });
        configuredSource = /** @type {typeof configuredSource} */ (committed.source);
        pluginRegistration = /** @type {typeof pluginRegistration} */ (
          committed.pluginRegistration
        );
        recoveredSetupJournal = committed.recoveredSetupJournal;
        capacityPeriod = committed.capacityPeriod;
      } else if (resolved.installPlugin === true) {
        const configFile = resolveOpenCodeConfig({
          ...(options.env ? { env: options.env } : {}),
          ...(options.home ? { home: options.home } : {}),
        });
        pluginRegistration = await preparePluginRegistration(configFile, {
          installation_id: configuredSource.installation_id,
          spool_directory: paths.spoolDir,
          prospective_analysis: resolved.enableProspectiveAnalysis === true,
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
          plan_profile: configuredSource.plan_profile,
        },
        fingerprint: { family: fingerprint.family, supported: fingerprint.supported },
        // `applied` is emitted on both paths. It is the only thing in this object that says which
        // of the two happened, and the key it sits under names the wrong one.
        dry_run: {
          observations: dryRun.observations.length,
          applied: resolved.dryRun !== true,
        },
        ...(pluginRegistrationChange(pluginRegistration)
          ? { plugin_registration: pluginRegistrationChange(pluginRegistration) }
          : {}),
        ...(recoveredSetupJournal ? { recovered_setup_journal: true } : {}),
      };
      if (wantsJson(this, configuredJson)) {
        stdout.write(
          formatJson(
            createEnvelope("setup opencode", data, {
              now,
              warnings: capacityPeriodWarnings(capacityPeriod),
            }),
          ),
        );
      } else {
        stdout.write(
          resolved.dryRun === true
            ? `Validated OpenCode source ${configuredSource.alias}; no changes applied.\n`
            : `Configured OpenCode source ${configuredSource.alias}.\n`,
        );
        reportWarnings(stderr, capacityPeriodWarnings(capacityPeriod));
      }
    });

  setup
    .command("claude")
    .description("configure read-only Claude Code history")
    .option("--non-interactive", "require all setup values as flags")
    .option("--source <alias>", "capacity-source alias")
    .option("--provider <identifier>", "provider identifier")
    .option("--profile <alias>", "local account/profile alias")
    .option("--plan <identifier>", "how you refer to your plan; a label, not a lookup key")
    .option("--plan-profile <identifier>", "bundled or custom plan profile to use as the prior")
    .option("--dry-run", "validate and show the proposal without mutation")
    .option("--enable-prospective-analysis", "enable allowlisted ephemeral prompt features")
    .option("--json", "emit one versioned JSON document")
    .action(async function setupClaude(commandOptions) {
      const projectsDirectory = resolveClaudeProjectsDirectory({
        ...(options.env ? { env: options.env } : {}),
        ...(options.home ? { home: options.home } : {}),
      });
      const adapter = createClaudeAdapter({ projectsDirectory });
      // Reading the history is what proves it is there and readable, so it comes before any
      // question: a guided setup must never walk someone through a questionnaire that cannot lead
      // anywhere. An absent directory throws `source_unavailable` from here.
      const fingerprint = adapter.fingerprint();
      if (!fingerprint.supported || fingerprint.family === null) {
        throw new SnackError("The Claude Code history fingerprint is unsupported.", {
          code: ExitCode.unavailable,
          reason: "source_schema_unsupported",
        });
      }
      const dryRun = adapter.readAll();
      const resolved = await resolveSetupValues({
        commandOptions,
        observations: dryRun.observations,
        existingSources: await readConfiguredSources(paths.configFile),
        prompt: options.prompt,
        stdout,
        // Claude Code registers no plugin, so the question that would offer one is not asked.
        offerPluginInstall: false,
      });
      if (resolved === null) {
        stdout.write("Setup cancelled; nothing was changed.\n");
        return;
      }
      const configuredSource = {
        alias: resolved.source,
        installation_id: randomUUID(),
        adapter: "claude",
        projects: projectsDirectory,
        provider: resolved.provider,
        profile: resolved.profile,
        plan: resolved.plan,
        plan_profile: resolved.planProfile ?? "generic",
        fingerprint: fingerprint.family,
      };
      /** @type {{rotated: boolean, retired_prompts: number} | null} */
      let capacityPeriod = null;
      let committed = configuredSource;
      if (resolved.dryRun !== true) {
        const result = await commitConfiguredSource({
          paths,
          now,
          source: configuredSource,
          locationKey: "projects",
          enableProspectiveAnalysis: resolved.enableProspectiveAnalysis === true,
          writeConfig: options.writeConfig,
          registerPlugin: undefined,
        });
        committed = /** @type {typeof configuredSource} */ (result.source);
        capacityPeriod = result.capacityPeriod;
      }
      const data = {
        source: {
          alias: committed.alias,
          installation_id: committed.installation_id,
          adapter: committed.adapter,
          provider: committed.provider,
          profile: committed.profile,
          plan: committed.plan,
          plan_profile: committed.plan_profile,
        },
        fingerprint: { family: fingerprint.family, supported: fingerprint.supported },
        dry_run: {
          observations: dryRun.observations.length,
          applied: resolved.dryRun !== true,
        },
      };
      if (wantsJson(this, configuredJson)) {
        stdout.write(
          formatJson(
            createEnvelope("setup claude", data, {
              now,
              warnings: capacityPeriodWarnings(capacityPeriod),
            }),
          ),
        );
      } else {
        stdout.write(
          resolved.dryRun === true
            ? `Validated Claude Code source ${committed.alias}; no changes applied.\n`
            : `Configured Claude Code source ${committed.alias}.\n`,
        );
        reportWarnings(stderr, capacityPeriodWarnings(capacityPeriod));
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
          if (!isConfiguredSource(candidate)) continue;
          const mappings = providerMappings(configuredSources, candidate.installation_id);
          try {
            results.push(
              ...(await synchronizeSource({
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
              tombstoned: 0,
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
            `${result.alias}: ${result.read} read, ${result.inserted} inserted, ${result.updated} updated, ${result.unchanged} unchanged, ${result.excluded} excluded, ${result.pending_mapping} pending_mapping, ${result.rejected_invalid} rejected_invalid, ${result.tombstoned ?? 0} tombstoned, ${result.failed} failed.\n`,
          );
        }
        reportWarnings(stderr, syncWarnings);
      }
    });

  program
    .command("stats")
    .description("show observed usage, data quality, and pressure statistics")
    .option("--source <alias>", "capacity-source alias")
    .option("--horizon <duration|all>", "one configured analysis horizon, or all of them")
    .option("--verbose", "add per-dimension and per-model detail")
    .option("--by-client", "compare the clients feeding each capacity source")
    .option("--json", "emit one versioned JSON document")
    .action(async function stats(commandOptions) {
      const current = await readConfig(paths.configFile);
      const allConfigured = Array.isArray(current.sources)
        ? current.sources.filter(isConfiguredSource)
        : [];
      // Kept before the per-alias dedupe: a capacity source is one lineage however many clients
      // feed it, and this is the only place that still knows which clients those are.
      const clientsByAlias = new Map();
      for (const source of allConfigured) {
        const clients = clientsByAlias.get(source.alias) ?? [];
        clients.push({ installation_id: source.installation_id, client: source.adapter });
        clientsByAlias.set(source.alias, clients);
      }
      const configuredSources = byCapacitySource(allConfigured);
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
      await assertReadableStorage(paths.databaseFile);
      // `all` is the documented way to ask for every configured horizon in one report, which is
      // also the default; naming it explicitly is what makes a script's intent readable.
      const horizons =
        commandOptions.horizon && commandOptions.horizon !== "all"
          ? [commandOptions.horizon]
          : configuredHorizons;
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
          clients:
            commandOptions.byClient === true ? (clientsByAlias.get(source.alias) ?? []) : null,
        });
      });
      const data = reports.length === 1 ? reports[0] : { sources: reports };
      if (wantsJson(this, configuredJson)) {
        stdout.write(formatJson(createEnvelope("stats", data, { warnings: statsWarnings, now })));
      } else {
        for (const report of reports) {
          stdout.write(renderStats(report, { verbose: commandOptions.verbose === true }));
        }
        reportWarnings(stderr, statsWarnings);
      }
    });

  program
    .command("status")
    .description("assess next-prompt viability")
    .option("--source <alias>", "capacity-source alias")
    .option("--no-sync", "use already synchronized observations")
    .option("--prompt-file <path>", "analyze an unsent prompt from a file, or - for stdin")
    .option("--verbose", "add the evidence gates, the method and the policy versions")
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
        // Two lists, because they answer two different questions. Ingestion reads a client, so it
        // needs every configured client; reporting describes a capacity source, so it needs one
        // entry per lineage. Using the collapsed list for both left the second client of a shared
        // source unread until someone ran `sync` by hand.
        const configuredSources = Array.isArray(current.sources)
          ? current.sources.filter(isConfiguredSource)
          : [];
        const inScope = commandOptions.source
          ? configuredSources.filter((source) => source.alias === commandOptions.source)
          : configuredSources;
        const selected = byCapacitySource(inScope);
        if (selected.length === 0) {
          throw new SnackError("The requested capacity source is unavailable or ambiguous.", {
            code: ExitCode.unavailable,
            reason: "source_unavailable",
          });
        }
        if (commandOptions.sync !== false) {
          await initializeDatabase(paths, { applicationVersion: packageJson.version, now });
        } else {
          await assertReadableStorage(paths.databaseFile);
        }
        for (const source of selected) {
          let synchronization = { performed: false, status: "not_requested" };
          if (commandOptions.sync !== false) {
            try {
              /** @type {Awaited<ReturnType<typeof synchronizeSource>>} */
              const syncResults = [];
              // Every client feeding this capacity source, one at a time: they write to the same
              // storage, so there is nothing to win by overlapping them.
              for (const client of inScope.filter((entry) => entry.alias === source.alias)) {
                syncResults.push(
                  ...(await synchronizeSource({
                    paths,
                    source: client,
                    full: false,
                    now,
                    mappings: providerMappings(configuredSources, client.installation_id),
                  })),
                );
              }
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
            // The usage-pressure sparkline is drawn from these window scores. They reach the
            // `--json` payload too, in the `pressure.trend` slot `status.schema.json` has declared
            // since the 0.9 freeze -- see the amended 1.1.0 exit criterion in PLAN.md.
            includeTrend: true,
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
            outcomes: readOutcomeRows(paths.databaseFile, source.alias, {
              limit: PREDICTION_POLICY.evidence_window_prompts,
            }),
            windowSeconds: parseHorizon(primaryHorizon(current)),
            completeness: classifyIngestionCompleteness({
              synchronized: readIngestionCursor(paths.databaseFile, source.alias) !== null,
              issues: readSpoolIssueCount(paths.databaseFile, source.alias),
              pendingMappings: readPendingMappingCount(paths.databaseFile, source),
              pendingSpoolObservations: readPendingSpoolObservations(paths.databaseFile, source)
                .length,
            }),
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
      const reportedWarnings = [
        ...(uncalibrated
          ? [
              {
                code: "very_low_evidence",
                message: "The evidence gates cap this forecast at very low; it is not calibrated.",
              },
            ]
          : []),
        ...statusWarnings,
      ];
      if (wantsJson(this, configuredJson)) {
        stdout.write(
          formatJson(
            createEnvelope("status", data, {
              status: uncalibrated ? "degraded" : "ok",
              warnings: reportedWarnings,
              now,
            }),
          ),
        );
      } else {
        const env = options.env ?? process.env;
        const color = supportsColor(stdout, env);
        // Two readings, two shapes. Without a selection the reader is choosing which source to
        // reach for, which is a comparison and wants one row each; having named one, they are
        // reading that source, which wants the detail a row cannot hold.
        //
        // `--verbose` takes the panel shape for the same reason, even without a selection: it adds
        // four rows per source, and four more rows each is a stack of panels wearing a table's
        // header rather than a comparison. Asking for the detail is asking for the shape with room
        // for it.
        stdout.write(
          commandOptions.source || commandOptions.verbose === true
            ? renderStatus(statuses, { color, verbose: commandOptions.verbose === true })
            : renderStatusTable(statuses, { color, columns: terminalColumns(stdout, env) }),
        );
        reportWarnings(stderr, reportedWarnings);
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
          return {
            key,
            value: getConfigValue(prepared.config, key),
            // Renamed at the boundary rather than inside storage: the JavaScript names are the
            // storage layer's own business, and every published payload is snake_case.
            storage: {
              applied: storage.applied,
              backup_created: storage.backupCreated,
              backup_file: storage.backupFile,
              migration_count: storage.migrationCount,
            },
          };
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
    .option("--source <alias>", "narrow the source checks to one capacity source")
    .option("--json", "emit one versioned JSON document")
    .action(async function doctor(commandOptions) {
      const result = await runDoctor(paths, {
        nodeVersion: options.nodeVersion,
        platform: options.platform,
        now,
        ...(typeof commandOptions.source === "string" ? { source: commandOptions.source } : {}),
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

  const data = program.command("data").description("manage locally stored observations");

  data
    .command("purge")
    .description("permanently delete stored observations for a selected scope")
    .option("--source <alias>", "capacity-source alias")
    .option("--all", "every configured capacity source")
    .option("--since <time>", "delete records at or after this time")
    .option("--until <time>", "delete records before this time")
    .option("--include-config", "also remove the selected sources from configuration")
    .option("--prevent-reimport", "refuse to re-import the purged range on a later sync")
    .option("--dry-run", "report what would be deleted without deleting it")
    .option("--yes", "confirm the deletion without prompting")
    .option("--json", "emit one versioned JSON document")
    .action(async function dataPurge(commandOptions) {
      if ((commandOptions.source === undefined) === (commandOptions.all !== true)) {
        throw new SnackError("Purge requires exactly one of --source or --all.", {
          code: ExitCode.usage,
          reason: "purge_scope_required",
        });
      }
      const config = await readConfig(paths.configFile);
      await assertReadableStorage(paths.databaseFile);
      const scope = buildExportScope(commandOptions, config);
      const json = wantsJson(this, configuredJson);
      const preview = await purgeScope(paths, scope, { now, preview: true });

      if (commandOptions.dryRun !== true && commandOptions.yes !== true) {
        // Prompting is impossible without a terminal, and impossible in JSON mode without
        // breaking the one-document contract. Refuse rather than delete unasked.
        if (json || options.prompt === undefined) {
          throw new SnackError(
            "Purge permanently deletes records; re-run with --yes to confirm, or --dry-run to preview.",
            { code: ExitCode.usage, reason: "confirmation_required" },
          );
        }
        // Typing the scope back, rather than a keystroke, is what makes this a decision instead
        // of a reflex: the records it removes are not restorable.
        const expected = scope.source ?? "all";
        const answer = await options.prompt({
          id: "purge_confirmation",
          message: `This permanently deletes ${preview.counts.prompts} prompts and ${preview.counts.predictions} prediction snapshots${
            scope.source === undefined ? " across every source" : ` for ${scope.source}`
          }. Type ${expected} to confirm:`,
        });
        if (answer.trim() !== expected) {
          stdout.write("Purge cancelled; nothing was deleted.\n");
          return;
        }
      }

      const result =
        commandOptions.dryRun === true
          ? preview
          : await purgeScope(paths, scope, {
              now,
              ...(commandOptions.preventReimport === true ? { preventReimport: true } : {}),
            });
      /** @type {{code: string, message: string}[]} */
      const warnings = [];
      if (commandOptions.dryRun !== true && commandOptions.preventReimport !== true) {
        warnings.push({
          code: "reimport_possible",
          message:
            "These records remain in the source; a later synchronization may restore them. " +
            "Use --prevent-reimport to refuse them.",
        });
      }
      if (commandOptions.includeConfig === true && commandOptions.dryRun !== true) {
        warnings.push(
          ...(await removePurgedSources(
            paths,
            config,
            scope,
            options.writeConfig,
            resolveOpenCodeConfig({
              ...(options.env ? { env: options.env } : {}),
              ...(options.home ? { home: options.home } : {}),
            }),
          )),
        );
      }

      const document = {
        dry_run: commandOptions.dryRun === true,
        scope,
        counts: result.counts,
        cursor_reset: result.cursor_reset,
        tombstones: result.tombstones ?? 0,
      };
      if (json) {
        stdout.write(
          formatJson(
            createEnvelope("data purge", document, {
              now,
              ...(warnings.length > 0 ? { status: "degraded", warnings } : {}),
            }),
          ),
        );
      } else {
        const verb = commandOptions.dryRun === true ? "Would delete" : "Deleted";
        stdout.write(
          `${verb} ${document.counts.prompts} prompts and ${document.counts.predictions} prediction snapshots` +
            `${scope.source === undefined ? " across every source" : ` for ${scope.source}`}.\n`,
        );
        reportWarnings(stderr, warnings);
      }
    });

  program
    .command("export")
    .description("write observed usage and predictions to an interpretable file")
    .requiredOption("--format <json|csv>", "export format")
    .requiredOption("--output <path>", "destination path, or - for stdout in JSON")
    .option("--source <alias>", "capacity-source alias")
    .option("--since <time>", "include records at or after this time")
    .option("--until <time>", "include records before this time")
    // Accepted here all along as a global option, but absent from `export --help` -- so the one
    // command whose whole purpose is a machine-readable document was also the one that never told
    // anyone how to ask for a machine-readable summary of it.
    .option("--json", "emit one versioned JSON document")
    .action(async function exportData(commandOptions) {
      if (commandOptions.format !== "json" && commandOptions.format !== "csv") {
        throw new SnackError("Export format must be json or csv.", {
          code: ExitCode.usage,
          reason: "export_format_unsupported",
        });
      }
      const config = await readConfig(paths.configFile);
      await assertReadableStorage(paths.databaseFile);
      const scope = buildExportScope(commandOptions, config);
      const provenance = await buildExportProvenance(config, scope);
      const context = { command: "export", now, provenance };

      if (commandOptions.format === "csv" && commandOptions.output === "-") {
        // Six related tables cannot share one stream without either repeating prompt columns
        // per usage slice or inventing a separator no CSV reader understands. Both invite a
        // silent miscount, so CSV requires a directory instead.
        throw new SnackError("CSV export requires a directory; use --output <dir>.", {
          code: ExitCode.usage,
          reason: "csv_stream_unsupported",
        });
      }

      if (commandOptions.output === "-") {
        for (const chunk of exportJsonChunks(paths.databaseFile, scope, context)) {
          stdout.write(chunk);
        }
        return;
      }

      const counts =
        commandOptions.format === "json"
          ? await writeJsonExport(paths.databaseFile, scope, context, commandOptions.output)
          : await writeCsvExport(paths.databaseFile, scope, context, commandOptions.output);
      const data = { output: commandOptions.output, format: commandOptions.format, counts };
      if (wantsJson(this, configuredJson)) {
        stdout.write(formatJson(createEnvelope("export", data, { now })));
      } else {
        stdout.write(
          `Exported ${Object.values(counts).reduce((total, count) => total + count, 0)} records to ${commandOptions.output}.\n`,
        );
      }
    });

  program
    .command("update")
    .description("bring the CLI and the capture plugin to versions that belong together")
    .option("--yes", "skip the confirmation")
    .option("--dry-run", "print what would run and exit")
    .option("--json", "emit one versioned JSON document")
    // Internal, and hidden on purpose: it exists because a process cannot become a different
    // version of itself, not because anyone has a reason to type it. Naming it in the help would
    // invite a re-registration with no install behind it.
    .addOption(new Option("--finish").hideHelp())
    .action(async function update(commandOptions) {
      if (commandOptions.finish === true) {
        const change = await finishUpdate();
        if (wantsJson(this, configuredJson)) {
          stdout.write(formatJson(createEnvelope("update", { applied: true, ...change }, { now })));
        } else {
          stdout.write(
            change.registered_plugin === null
              ? "No OpenCode plugin is registered; nothing to re-register.\n"
              : `Re-registered ${change.registered_plugin}.\n`,
          );
        }
        return;
      }

      const modulePath = options.modulePath ?? updateModulePath;
      const cwd = process.cwd();
      const plan = resolveUpdatePlan({
        modulePath,
        cwd,
        env: options.env ?? process.env,
        lockfiles: await readLockfiles(cwd),
      });

      if (commandOptions.dryRun === true) {
        if (wantsJson(this, configuredJson)) {
          stdout.write(formatJson(createEnvelope("update", { applied: false, plan }, { now })));
        } else {
          stdout.write(`Would run: ${plan.command}\n`);
        }
        return;
      }

      if (commandOptions.yes !== true) {
        // Installing into a place the user did not expect is the failure this whole detection
        // exists to avoid, so the resolved command is named in the question itself.
        if (wantsJson(this, configuredJson) || options.prompt === undefined) {
          throw new SnackError(
            `Update installs packages; re-run with --yes to confirm, or --dry-run to see what would run.\nCommand: ${plan.command}`,
            { code: ExitCode.usage, reason: "confirmation_required" },
          );
        }
        const answer = await options.prompt({
          id: "update_confirmation",
          message: `Run ${plan.command} to update SNACK?`,
          choices: [
            { value: "y", label: "yes" },
            { value: "n", label: "no" },
          ],
          default: "y",
        });
        if (answer.trim().toLowerCase() !== "y") {
          stdout.write("Update cancelled; nothing was changed.\n");
          return;
        }
      }

      const execute = options.execute ?? executeCommand;
      try {
        await execute(plan.manager, plan.args);
      } catch (error) {
        // Offline, a proxy, a registry outage, a private mirror. ADR-0010 requires this to read as
        // what it is and not as a SNACK defect, and nothing has been rewritten yet -- the
        // registration is only touched by the process that comes after a successful install, so a
        // failure here leaves a working, older, matched pair.
        throw new SnackError(
          `The update did not install, and nothing was changed.\n` +
            `Command: ${plan.command}\n` +
            `${error instanceof Error ? error.message : String(error)}`,
          { code: ExitCode.unavailable, reason: "update_install_failed", cause: error },
        );
      }

      // The install replaced this package in place, so the path this process was launched from now
      // resolves to the new code. Only that build knows the plugin pin it was validated against.
      await execute(argv[1] ?? "snack", ["update", "--finish"]);
    });

  /**
   * Rewrite the OpenCode plugin registration at the pin this build carries.
   *
   * Deliberately does not go through `setup`. `setup` calls `ensureCapacityPeriod`, which rotates
   * the period whenever provider, profile, plan or plan profile differs from the open one -- right
   * for `setup` and catastrophic here, because an upgrade is not a change of capacity regime. The
   * roadmap's "never rotates a capacity period it was not asked to" is met structurally, by not
   * calling the code that could.
   */
  async function finishUpdate() {
    const configFile = resolveOpenCodeConfig({
      ...(options.env ? { env: options.env } : {}),
      ...(options.home ? { home: options.home } : {}),
    });
    const installationId = await readRegisteredInstallationId(configFile);
    // Nothing registered means the user never asked for live capture. Creating a registration here
    // would enable a capture path they did not choose, on a command they ran to upgrade.
    if (installationId === null) return { registered_plugin: null };

    const config = await readConfig(paths.configFile);
    const sources = Array.isArray(config.sources) ? config.sources : [];
    const registration = await preparePluginRegistration(configFile, {
      installation_id: installationId,
      spool_directory: paths.spoolDir,
      prospective_analysis: getConfigValue(config, "prospective_analysis.enabled") === true,
      source_bindings: pluginBindings(sources, installationId, paths),
    });
    await prepareSpoolDirectories(paths, registration);
    await writePluginRegistration(configFile, registration.content, registration.previous_content);
    return { registered_plugin: pluginPackageSpec };
  }

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
        command: commandName(argv, program),
        message: "Invalid command usage.",
        reason: "invalid_usage",
        exitCode: ExitCode.usage,
        humanDetail: withoutRejectedValues(commanderError),
        now,
      });
    }
    if (error instanceof SnackError) {
      return renderError({
        stdout,
        stderr,
        json: argv.includes("--json") || configuredJson,
        command: commandName(argv, program),
        message: error.message,
        reason: error.reason,
        exitCode: error.exitCode,
        now,
      });
    }
    // An unexpected failure is the one case where SNACK has nothing useful to say, and the user
    // has nothing to attach to a report. `SNACK_DEBUG` prints the underlying error to stderr for
    // that purpose only: never into the JSON document, never to stdout, never to a file, and only
    // when it is asked for, because a stack trace carries absolute paths.
    if ((options.env ?? process.env).SNACK_DEBUG) {
      stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    }
    return renderError({
      stdout,
      stderr,
      json: argv.includes("--json") || configuredJson,
      command: commandName(argv, program),
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
 * @param {{paths: import("./paths.js").SnackPaths, source: {alias: string, installation_id: string, database?: string, projects?: string, fingerprint: string, provider: string, profile: string, plan: string, adapter: string}, full: boolean, now: Date, mappings: {mappedProviders: Set<string>, providerMappingCounts: Map<string, number>}}} options
 */
async function synchronizeSource(options) {
  const results = [];
  // Every write path must agree on the active plan profile, otherwise storing
  // observations would reopen the capacity period the resolved profile just stamped.
  const mappings = {
    ...options.mappings,
    planProfile: resolvePlanProfile(options.source).profile,
  };
  try {
    const adapter = createSourceAdapter(options.source);
    const cursor = options.full
      ? null
      : readIngestionCursor(options.paths.databaseFile, options.source.alias);
    const backfill = options.full ? adapter.readAll() : adapter.readSince(cursor);
    results.push(
      storeObservations(options.paths.databaseFile, options.source, backfill, options.now, {
        ...mappings,
        // Records the adapter could not parse travel with the batch, so a quietly incomplete
        // read is reported rather than looking like a complete one.
        ...("rejected" in backfill ? { rejected: backfill.rejected } : {}),
      }),
    );
  } catch {
    results.push(emptySyncResult(options.source.alias, "backfill", 1));
  }
  // The spool is OpenCode's capture plugin writing into it. Claude Code registers no plugin and
  // has no spool of its own, so a Claude source simply has nothing to read here.
  if (options.source.adapter !== "opencode") return results;
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
 * Whether this stream should carry colour.
 *
 * `hasColors()` is where Node reconciles `TERM`, `COLORTERM`, `FORCE_COLOR` and `NO_COLOR`, and it
 * would be the whole answer except that **it exists only on a TTY**. A piped stdout is not a
 * `tty.WriteStream` and has no `hasColors` at all -- so leaving the question to the stream drops
 * `FORCE_COLOR` exactly where it is meant to work, which is `snack status | less -R`. Driving the
 * real binary is what showed this; the stream alone answers "no colour" for every pipe regardless
 * of what the user asked for.
 *
 * Calling `tty.WriteStream.prototype.hasColors` on the pipe instead was tried and is worse: it
 * answers `true` for a plain pipe with no environment set at all, which would colour every
 * redirect into a file.
 *
 * So the two environment variables are read here, in Node's own precedence -- `FORCE_COLOR` wins
 * over `NO_COLOR`, and Node warns when both are set -- and everything else is still left to the
 * stream. There is no `--color` flag. An injected sink has no `hasColors` and gets no colour,
 * which is what keeps command tests asserting plain text.
 *
 * @param {{write(chunk: string): unknown, hasColors?: () => boolean}} stream
 * @param {NodeJS.ProcessEnv} env
 */
function supportsColor(stream, env) {
  const forced = env.FORCE_COLOR ?? "";
  if (forced !== "" && forced !== "0") return true;
  if ((env.NO_COLOR ?? "") !== "") return false;
  return typeof stream.hasColors === "function" && stream.hasColors();
}

/**
 * How many columns the reader has, for the one view whose shape depends on it.
 *
 * `COLUMNS` is read before the stream because it is the only answer available where the answer
 * matters most: a pipe has no width, and `snack status | less -R` is read at a terminal that the
 * pipe cannot see. It is also what makes the behaviour testable through an injected sink.
 *
 * The fallback is 80 rather than "unlimited". A stream with no width is usually a pipe into a file
 * or a log, and a table that assumed an infinite terminal there would produce lines nobody can read
 * back without horizontal scrolling.
 *
 * @param {{write(chunk: string): unknown, columns?: number}} stream
 * @param {NodeJS.ProcessEnv} env
 */
function terminalColumns(stream, env) {
  const declared = Number.parseInt(env.COLUMNS ?? "", 10);
  if (Number.isFinite(declared) && declared > 0) return declared;
  return typeof stream.columns === "number" && stream.columns > 0 ? stream.columns : 80;
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
    tombstoned: 0,
    failed,
  };
}

/** @param {Command} command @param {boolean} configuredJson */
function wantsJson(command, configuredJson) {
  return command.optsWithGlobals().json === true || configuredJson;
}

/**
 * Speak in human mode the warnings the JSON envelope would have carried.
 *
 * Warnings go to stderr so a piped result stays exactly the result, and every human branch that
 * builds an envelope's warnings has to call this: a warning a machine reads and a person does not
 * is the two output modes disagreeing about what happened.
 *
 * @param {{write: (text: string) => void}} stderr
 * @param {{code: string, message: string}[]} warnings
 */
function reportWarnings(stderr, warnings) {
  for (const warning of warnings) stderr.write(`Warning: ${warning.message}\n`);
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

/** The bundled plan-profile archetypes a guided setup can offer. */
const PLAN_PROFILE_CHOICES = [
  { value: "generic", label: "generic - neutral weighting, no assumption about billing" },
  {
    value: "subscription-window",
    label: "subscription-window - flat subscription; requests and generated volume weigh most",
  },
  {
    value: "metered-credit",
    label: "metered-credit - billed per token or credit; cumulative volume weighs most",
  },
];

/** @param {string} configFile */
async function readConfiguredSources(configFile) {
  try {
    const config = await readConfig(configFile);
    return (Array.isArray(config.sources) ? config.sources : []).filter(isConfiguredSource);
  } catch {
    // A missing or unreadable configuration simply means there is nothing to propose.
    return [];
  }
}

/**
 * Write one configured source into the configuration and open the storage behind it.
 *
 * This is the part of setup that has nothing to do with which client is being configured, and the
 * part where the two clients must never drift: the alias-rebind refusal, reusing the installation
 * identity a source at the same location already has, and the rollback that leaves nothing behind
 * when any of it fails. `locationKey` names the field that says where a client's history lives —
 * a database file for OpenCode, a projects directory for Claude Code.
 *
 * @param {{
 *   paths: import("./paths.js").SnackPaths,
 *   now: Date,
 *   source: {alias: string, installation_id: string, adapter: string, provider: string, profile: string, plan: string, plan_profile: string, fingerprint: string, database?: string, projects?: string},
 *   locationKey: string,
 *   enableProspectiveAnalysis: boolean,
 *   writeConfig: typeof writePrivateAtomic | undefined,
 *   registerPlugin: ((sources: Record<string, unknown>[], installationId: string) => Promise<{
 *     configFile: string,
 *     registration: Awaited<ReturnType<typeof preparePluginRegistration>>,
 *   } | null>) | undefined,
 * }} input
 * @returns {Promise<{source: Record<string, string>, pluginRegistration: unknown, recoveredSetupJournal: boolean, capacityPeriod: {rotated: boolean, retired_prompts: number} | null}>}
 */
async function commitConfiguredSource(input) {
  let configuredSource = input.source;
  let pluginRegistration = null;
  let recoveredSetupJournal = false;
  /** @type {{rotated: boolean, retired_prompts: number} | null} */
  let capacityPeriod = null;
  await withStorageOperationLock(input.paths, async () => {
    recoveredSetupJournal = await recoverSetupJournal(input.paths);
    await withConfigLock(input.paths.configFile, async () => {
      /** @type {Record<string, unknown>} */
      let current = { ...defaultConfig };
      try {
        current = await readConfig(input.paths.configFile);
      } catch (error) {
        if (!(error instanceof SnackError) || error.reason !== "config_missing") throw error;
      }
      const sources = /** @type {Record<string, unknown>[]} */ (
        (Array.isArray(current.sources) ? current.sources : []).filter(
          (source) => typeof source === "object" && source !== null,
        )
      );
      const merged = mergeConfiguredSource(sources, configuredSource, input.locationKey);
      configuredSource = merged.source;
      const updatedSources = merged.sources;
      /** @type {[string, unknown][]} */
      const configUpdates = [["sources", updatedSources]];
      if (input.enableProspectiveAnalysis) {
        configUpdates.push(["prospective_analysis.enabled", true]);
      }
      const prepared = await prepareConfigValues(input.paths.configFile, configUpdates);
      let previousSnackConfig = null;
      try {
        previousSnackConfig = await readFile(input.paths.configFile, "utf8");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      // A client that registers something in its host's own configuration hands it over here, so
      // the journal, the pre-change backup and the rollback stay in one place rather than being
      // written a second time per client.
      const plugin = await input.registerPlugin?.(updatedSources, configuredSource.installation_id);
      const existed = (await inspectDatabase(input.paths.databaseFile)).exists;
      const databaseBackupFile = plugin ? await createSetupDatabaseBackup(input.paths) : null;
      let pluginWritten = false;
      try {
        if (plugin) {
          await writeSetupJournal(input.paths, {
            opencode_config_file: plugin.configFile,
            config_existed: plugin.registration.config_existed,
            plugin_property_existed: plugin.registration.plugin_property_existed,
            previous_plugin: plugin.registration.previous_plugin,
            previous_plugin_index: plugin.registration.previous_plugin_index,
            installed_plugin_hash: plugin.registration.installed_plugin_hash,
            previous_snack_config: previousSnackConfig,
            database_backup_file: databaseBackupFile,
          });
        }
        await initializeDatabase(input.paths, {
          applicationVersion: packageJson.version,
          now: input.now,
        });
        if (plugin) {
          await prepareSpoolDirectories(input.paths, plugin.registration);
          await writePluginRegistration(
            plugin.configFile,
            plugin.registration.content,
            plugin.registration.previous_content,
          );
          pluginWritten = true;
        }
        await (input.writeConfig ?? writePrivateAtomic)(input.paths.configFile, prepared.content, {
          backup: true,
        });
        capacityPeriod = ensureCapacityPeriod(
          input.paths.databaseFile,
          configuredSource,
          input.now,
          resolvePlanProfile(configuredSource).profile,
        );
        pluginRegistration = plugin?.registration ?? null;
        await clearSetupJournal(input.paths);
        if (databaseBackupFile !== null) {
          await rm(databaseBackupFile, { force: true }).catch(() => {});
        }
      } catch (error) {
        if (plugin) {
          if (!pluginWritten) {
            try {
              pluginWritten =
                (await readFile(plugin.configFile, "utf8")) === plugin.registration.content;
            } catch {
              pluginWritten = false;
            }
          }
          await recoverSetupJournal(input.paths, { restorePlugin: pluginWritten });
        } else if (previousSnackConfig === null) {
          await rm(input.paths.configFile, { force: true });
        } else {
          await writePrivateAtomic(input.paths.configFile, previousSnackConfig);
        }
        await rollbackDatabaseInitialization(input.paths, existed);
        throw error;
      }
    });
  });
  return { source: configuredSource, pluginRegistration, recoveredSetupJournal, capacityPeriod };
}

/**
 * Say what a capacity-period rotation costs, when one happened.
 *
 * `setup` starts a new period whenever provider, profile, plan or plan profile changes, because
 * those describe a different capacity regime. The prompts already stored stay readable and stay
 * counted in `observed`, but they no longer train the forecast -- so the estimate drops to the
 * bundled prior with `evidence very_low`. `1.0.0` did that silently, and a user who only corrected
 * a plan label watched the number collapse with nothing connecting the two events.
 *
 * @param {{rotated: boolean, retired_prompts: number} | null} capacityPeriod
 * @returns {import("./output.js").Diagnostic[]}
 */
function capacityPeriodWarnings(capacityPeriod) {
  if (capacityPeriod === null || !capacityPeriod.rotated) return [];
  return [
    {
      code: "capacity_period_rotated",
      message:
        `This is a different capacity regime, so ${capacityPeriod.retired_prompts} observed ` +
        "prompt(s) stop informing the estimate. They are still stored and still reported; the " +
        "next forecasts lean on the plan profile until this regime has its own history.",
    },
  ];
}

/**
 * Decide the values setup will apply, from flags or by asking.
 *
 * Both paths produce the same shape and then run the identical journal, backup, and rollback
 * block, because that block is the riskiest code in the command and must not be duplicated.
 *
 * @param {{commandOptions: Record<string, unknown>, observations: {provider: string | null, model: string | null}[], existingSources: {alias: string, provider: string, profile: string, plan?: string, plan_profile?: string}[], prompt: SetupPrompt | undefined, stdout: {write(chunk: string): unknown}, offerPluginInstall?: boolean}} input
 * @returns {Promise<{source: string, provider: string, profile: string, plan: string, planProfile: string, dryRun: boolean, installPlugin: boolean, enableProspectiveAnalysis: boolean} | null>} null when the user declined
 */
async function resolveSetupValues(input) {
  const { commandOptions } = input;
  const fromFlags = {
    dryRun: commandOptions.dryRun === true,
    installPlugin: commandOptions.installPlugin === true,
    enableProspectiveAnalysis: commandOptions.enableProspectiveAnalysis === true,
  };

  if (commandOptions.nonInteractive === true) {
    const missing = ["source", "provider", "profile", "plan"].filter(
      (flag) => typeof commandOptions[flag] !== "string",
    );
    if (missing.length > 0) {
      throw new SnackError(
        `Non-interactive setup requires ${missing.map((flag) => `--${flag}`).join(", ")}.`,
        { code: ExitCode.usage, reason: "setup_values_required" },
      );
    }
    // The same rules the questions enforce, applied to the flags, so neither road reaches the
    // schema with a value it will refuse. Rejecting here names the field and the value; the schema
    // error it replaces names only the path it rejected, after the source has been assembled.
    const invalid = /** @type {const} */ ([
      ["source", "alias"],
      ["provider", "provider"],
      ["profile", "profile"],
      ["plan", "plan"],
    ]).flatMap(([flag, field]) => {
      const problem = checkSourceIdentifier(field, String(commandOptions[flag]));
      return problem === null ? [] : [problem];
    });
    if (invalid.length > 0) {
      throw new SnackError(
        `Non-interactive setup was given values it cannot use: ${invalid.join(" ")}`,
        { code: ExitCode.usage, reason: "setup_values_invalid" },
      );
    }
    return {
      source: String(commandOptions.source),
      provider: String(commandOptions.provider),
      profile: String(commandOptions.profile),
      plan: String(commandOptions.plan),
      planProfile:
        typeof commandOptions.planProfile === "string" ? commandOptions.planProfile : "generic",
      ...fromFlags,
    };
  }

  if (input.prompt === undefined) {
    throw new SnackError(
      "Guided setup needs a terminal; pass --non-interactive with --source, --provider, --profile, and --plan instead.",
      { code: ExitCode.usage, reason: "setup_requires_tty" },
    );
  }
  // Pressing Ctrl+D, or having stdin close, rejects the pending question. That is someone
  // walking away from a questionnaire, not a failure: cancel quietly rather than reporting an
  // internal error over a setup that changed nothing.
  const cancelled = Symbol("cancelled");
  /** @param {Parameters<SetupPrompt>[0]} question */
  const ask = async (question) => {
    try {
      return await /** @type {SetupPrompt} */ (input.prompt)(question);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw cancelled;
      throw error;
    }
  };
  /**
   * Ask until the answer is one the configuration will accept.
   *
   * The question stays the question. The rule appears on the refusal instead, where it is the
   * answer to something that just happened — carrying it on every question spends a line of regex
   * on everyone who was going to type something ordinary anyway. A refusal still costs one answer
   * rather than the whole questionnaire, which is the part that mattered.
   *
   * @param {"alias" | "provider" | "profile" | "plan"} field
   * @param {Parameters<SetupPrompt>[0]} question
   */
  const askIdentifier = async (field, question) => {
    for (;;) {
      const answer = await ask(question);
      const problem = checkSourceIdentifier(field, answer);
      if (problem === null) return answer;
      input.stdout.write(`${problem}\n`);
    }
  };
  const existing = input.existingSources[0];

  // Discovered rather than asked. The local account alias is deliberately not in this list:
  // OpenCode does not expose account identity, and SNACK never reads credentials.
  const providers = [
    ...new Set(
      input.observations.flatMap((observation) =>
        typeof observation.provider === "string" && observation.provider.length > 0
          ? [observation.provider]
          : [],
      ),
    ),
  ].sort();

  try {
    const source = await askIdentifier("alias", {
      id: "alias",
      message: "Name this capacity source",
      ...(existing ? { default: existing.alias } : { default: "default" }),
    });
    const provider = await askIdentifier("provider", {
      id: "provider",
      message: "Which provider does it map to?",
      ...(providers.length > 0
        ? { choices: providers.map((value) => ({ value, label: value })) }
        : {}),
      ...(existing
        ? { default: existing.provider }
        : providers[0]
          ? { default: providers[0] }
          : {}),
    });
    const profile = await askIdentifier("profile", {
      id: "profile",
      message: "Name the local account or profile this maps to (SNACK cannot discover it)",
      default: existing?.profile ?? "default",
    });
    const plan = await askIdentifier("plan", {
      id: "plan",
      message: "What do you call your plan? This is a label SNACK records, not a lookup key",
      default: existing?.plan ?? "default",
    });
    const planProfile = await ask({
      id: "plan_profile",
      message: "Which billing archetype should the initial prior assume?",
      choices: PLAN_PROFILE_CHOICES,
      default: existing?.plan_profile ?? "generic",
    });
    const prospective = await ask({
      id: "prospective_analysis",
      message:
        "Analyze unsent prompts locally for size only? Text is never stored, logged, or sent",
      choices: yesNo,
      default: "no",
    });
    // Claude Code registers no capture plugin, so the question is not asked for it rather than
    // asked and ignored.
    const installPlugin =
      input.offerPluginInstall === false
        ? "no"
        : await ask({
            id: "install_plugin",
            message: "Register the OpenCode capture plugin for live capture?",
            choices: yesNo,
            default: "no",
          });

    input.stdout.write(
      `\nProposed: source ${source} -> ${provider}/${profile}, plan ${plan} ` +
        `(profile ${planProfile}), prospective analysis ${prospective}` +
        `${input.offerPluginInstall === false ? "" : `, plugin ${installPlugin}`}.\n`,
    );
    const confirmed = await ask({
      id: "confirm",
      message: "Apply this?",
      choices: yesNo,
      default: "yes",
    });
    if (!isYes(confirmed)) return null;

    return {
      source,
      provider,
      profile,
      plan,
      planProfile,
      dryRun: fromFlags.dryRun,
      installPlugin: isYes(installPlugin),
      enableProspectiveAnalysis: isYes(prospective),
    };
  } catch (error) {
    if (error === cancelled) return null;
    throw error;
  }
}

const yesNo = [
  { value: "yes", label: "yes" },
  { value: "no", label: "no" },
];

/** @param {string} answer */
function isYes(answer) {
  return /^(y|yes)$/iu.test(answer.trim());
}

/**
 * Remove purged sources from the configuration, after their records are already gone.
 *
 * The database deletion is unrecoverable while the configuration file is recoverable from its
 * backup, so the transaction commits first and a failed configuration write degrades with a
 * named warning instead of reversing anything. The OpenCode plugin registration is left alone:
 * that file may contain credentials and belongs to `setup`.
 *
 * @param {import("./paths.js").SnackPaths} paths
 * @param {Record<string, unknown>} config
 * @param {import("./export.js").ExportScope} scope
 * @param {typeof writePrivateAtomic | undefined} writeConfig
 * @param {string} opencodeConfigFile
 */
async function removePurgedSources(paths, config, scope, writeConfig, opencodeConfigFile) {
  const sources = Array.isArray(config.sources) ? config.sources : [];
  const remaining = sources.filter((source) =>
    scope.source !== undefined && isConfiguredSource(source) && source.alias !== scope.source
      ? true
      : scope.source === undefined
        ? false
        : !isConfiguredSource(source),
  );
  try {
    await withConfigLock(paths.configFile, async () => {
      const prepared = await prepareConfigValues(paths.configFile, [["sources", remaining]]);
      await (writeConfig ?? writePrivateAtomic)(paths.configFile, prepared.content, {
        backup: true,
      });
    });
  } catch (error) {
    return [
      {
        code: "config_not_updated",
        message: `Records were deleted, but the configuration still lists the source: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    ];
  }
  // Only true when there is a registration to be still registered. Reported unconditionally, it
  // told a Claude-only installation -- and every OpenCode user who never installed the plugin --
  // to undo something that was never done, while `doctor` said the opposite on the same machine.
  const registration = await inspectPluginRegistration(opencodeConfigFile);
  if (registration === "missing") return [];
  return [
    {
      code: "plugin_still_registered",
      message:
        "The OpenCode plugin is still registered and will keep writing to the spool; " +
        "run `snack setup opencode` to change that.",
    },
  ];
}

/**
 * Write a JSON export to a file, one chunk at a time.
 *
 * The chunks are written through an open handle rather than joined into a string, so the
 * memory a six-figure export needs stays independent of how much history it covers.
 *
 * @param {string} databaseFile
 * @param {import("./export.js").ExportScope} scope
 * @param {{command: string, now: Date, provenance: unknown}} context
 * @param {string} target
 */
async function writeJsonExport(databaseFile, scope, context, target) {
  /** @type {Record<string, number>} */
  let counts = {};
  await withExportFile(target, async (handle) => {
    // Counting as the rows stream past keeps the file to a single pass over the history.
    const chunks = exportJsonChunks(databaseFile, scope, context);
    let step = chunks.next();
    while (step.done !== true) {
      await handle.write(step.value);
      step = chunks.next();
    }
    counts = step.value;
  });
  return counts;
}

/**
 * Write one CSV file per exported table, plus the manifest that makes them interpretable.
 *
 * @param {string} databaseFile
 * @param {import("./export.js").ExportScope} scope
 * @param {{command: string, now: Date, provenance: unknown}} context
 * @param {string} directory
 */
async function writeCsvExport(databaseFile, scope, context, directory) {
  // The directory is part of the destination, so failing to create it is the same failure as
  // failing to open a file inside it. Without this, an `--output` naming an existing file
  // escapes the export's own classifier and lands as an unexplained internal failure.
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  } catch (error) {
    throw new SnackError(`Export destination '${directory}' could not be opened.`, {
      code: ExitCode.io,
      reason: "export_write_error",
      cause: error,
    });
  }
  /** @type {Record<string, number>} */
  const counts = {};
  // The manifest is what makes the CSVs interpretable, and it can only be written once every
  // row is counted. So the whole set is staged and published together: an export is complete or
  // it is not there, never a directory of plausible CSVs missing the file that describes them.
  const staged = [
    ...EXPORT_TABLES.map((table) => join(directory, `${table.name}.csv`)),
    join(directory, "manifest.json"),
  ];
  try {
    for (const table of EXPORT_TABLES) {
      await withExportFile(
        join(directory, `${table.name}.csv`),
        async (handle) => {
          const chunks = exportCsvChunks(databaseFile, scope, table);
          let step = chunks.next();
          while (step.done !== true) {
            await handle.write(step.value);
            step = chunks.next();
          }
          counts[table.name] = step.value;
        },
        { defer: true },
      );
    }
    await withExportFile(
      join(directory, "manifest.json"),
      async (handle) => {
        await handle.write(
          formatJson({
            export_schema_version: EXPORT_SCHEMA_VERSION,
            generated_at: context.now.toISOString(),
            scope,
            provenance: context.provenance,
            tables: EXPORT_TABLES.map((table) => ({
              name: table.name,
              file: `${table.name}.csv`,
              columns: table.columns,
              rows: counts[table.name] ?? 0,
            })),
          }),
        );
      },
      { defer: true },
    );
    await settleStagedExport(staged, "publish");
  } catch (error) {
    await settleStagedExport(staged, "discard");
    throw error;
  }
  return counts;
}

/**
 * Create one private export file, reporting a failed write as an export I/O failure.
 *
 * Every artifact is written beside its destination as `.partial` and only takes its real name
 * once the whole export is whole: a CSV export is several files plus the manifest that makes them
 * interpretable, and a command killed halfway through must not leave files that look finished.
 * `defer` holds a file at its staged name so the caller can publish the set together.
 *
 * @param {string} target
 * @param {(handle: import("node:fs/promises").FileHandle) => Promise<void>} write
 * @param {{defer?: boolean}} [options]
 */
async function withExportFile(target, write, options = {}) {
  const partial = stagedExportName(target);
  let handle;
  try {
    handle = await open(partial, "w", 0o600);
  } catch (error) {
    throw new SnackError(`Export destination '${target}' could not be opened.`, {
      code: ExitCode.io,
      reason: "export_write_error",
      cause: error,
    });
  }
  try {
    await write(handle);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(partial, 0o600).catch(() => {});
    if (options.defer !== true) await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw new SnackError(`Export to '${target}' could not be completed.`, {
      code: ExitCode.io,
      reason: "export_write_error",
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

/** @param {string} target */
function stagedExportName(target) {
  return `${target}.partial`;
}

/**
 * Publish a staged export, or remove every staged file if any of it failed.
 *
 * @param {string[]} targets
 * @param {"publish" | "discard"} outcome
 */
async function settleStagedExport(targets, outcome) {
  for (const target of targets) {
    if (outcome === "publish") await rename(stagedExportName(target), target);
    else await rm(stagedExportName(target), { force: true }).catch(() => {});
  }
}

/**
 * Resolve which records an export covers.
 *
 * `--since` is inclusive and `--until` exclusive, the same half-open convention `horizonWindow`
 * uses, so adjacent exports neither drop nor duplicate a record on the boundary.
 *
 * @param {{source?: string, since?: string, until?: string}} commandOptions
 * @param {Record<string, unknown>} config
 * @returns {import("./export.js").ExportScope}
 */
function buildExportScope(commandOptions, config) {
  requireConfiguredSource(commandOptions.source, config.sources);
  const since =
    commandOptions.since === undefined
      ? undefined
      : parseExportBound(commandOptions.since, "--since");
  const until =
    commandOptions.until === undefined
      ? undefined
      : parseExportBound(commandOptions.until, "--until");
  // The window is half-open, so a bound that closes at or before it opens can only ever select
  // nothing. Reporting that as a successful export of zero records, or as a purge that deleted
  // nothing, hides a mistyped bound behind an exit code that says everything went fine.
  if (since !== undefined && until !== undefined && until <= since) {
    throw new SnackError("--until must be later than --since.", {
      code: ExitCode.usage,
      reason: "time_window_invalid",
    });
  }
  return {
    ...(commandOptions.source === undefined ? {} : { source: commandOptions.source }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
  };
}

/** @param {string} raw @param {string} flag */
function parseExportBound(raw, flag) {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new SnackError(`${flag} is not a valid time.`, {
      code: ExitCode.usage,
      reason: "export_bound_invalid",
    });
  }
  return parsed.toISOString();
}

/**
 * Describe the build that produced an export, without re-stamping the rows.
 *
 * Row-level versions already record how each record was produced and must survive unchanged.
 * This block only says which SNACK wrote the file and which plan profile each source resolved
 * to, so a reader can interpret the priors behind the exported predictions.
 *
 * @param {Record<string, unknown>} config
 * @param {import("./export.js").ExportScope} scope
 */
async function buildExportProvenance(config, scope) {
  const sources = (Array.isArray(config.sources) ? config.sources : [])
    .filter(isConfiguredSource)
    .filter((source) => scope.source === undefined || source.alias === scope.source);
  return {
    cli_version: packageJson.version,
    export_schema_version: EXPORT_SCHEMA_VERSION,
    envelope_schema_version: ENVELOPE_SCHEMA_VERSION,
    plan_profiles: sources.map((source) => {
      const { profile } = resolvePlanProfile(source);
      return {
        source: source.alias,
        id: profile.id,
        version: profile.version,
        provenance: profile.provenance,
        as_of: profile.as_of,
      };
    }),
  };
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

/** @param {string[]} argv @param {import("commander").Command} program */
function commandName(argv, program) {
  // Every invocation is `snack <command> [<subcommand>] [--flag [value]]...`, so scanning stops
  // at the first flag. Skipping flags but keeping what follows them put option values — a
  // source alias, a time bound, a configuration value — into the `command` field of every
  // error envelope, which is a document users share.
  //
  // Stopping at the first flag was not enough. A positional argument no command takes is not a
  // flag, so `snack doctor <pasted-secret>` reported `command: "doctor <pasted-secret>"` and put it
  // in the document. Walking the command tree answers the question the field is actually asking —
  // which command was invoked — and a token that names no command ends the walk.
  const tokens = [];
  let node = program;
  for (const part of argv.slice(2)) {
    if (part.startsWith("-")) break;
    const child = node.commands.find(
      (candidate) => candidate.name() === part || candidate.aliases().includes(part),
    );
    if (!child) break;
    tokens.push(part);
    node = child;
  }
  return tokens.join(" ") || "snack";
}

/**
 * @param {unknown} value
 * @returns {value is {alias: string, installation_id: string, adapter: "opencode", database: string, provider: string, profile: string, plan: string, fingerprint: string}}
 */
function isConfiguredOpenCodeSource(value) {
  return isConfiguredSource(value) && value.adapter === "opencode" && "database" in value;
}

/**
 * Place one configured source into the list of configured sources.
 *
 * Both setup commands route through this, because the rule they have to agree on is subtle and
 * they already drifted apart once: a capacity source is a lineage, not a client, so two clients
 * that talk to the same provider, account, and plan share an alias on purpose and neither may
 * evict the other. What stays refused is the same client's alias being pointed at a different
 * history, which would silently reinterpret every observation already stored under it.
 *
 * @template {Record<string, unknown>} T
 * @param {Record<string, unknown>[]} sources
 * @param {T} configuredSource
 * @param {string} locationKey the field naming where this client keeps its history
 * @returns {{source: T, sources: Record<string, unknown>[]}}
 */
function mergeConfiguredSource(sources, configuredSource, locationKey) {
  const location = configuredSource[locationKey];
  // One history behind two capacity sources would be read twice and counted twice, inventing usage
  // that never happened. This belongs to the mapping rather than to a client, so both setups get it.
  const ambiguous = sources.some(
    (source) =>
      source.alias !== configuredSource.alias &&
      source.adapter === configuredSource.adapter &&
      source[locationKey] === location &&
      source.provider === configuredSource.provider &&
      source.profile === configuredSource.profile,
  );
  if (ambiguous) {
    throw new SnackError(
      "A provider/profile combination can map to only one capacity source per client installation.",
      { code: ExitCode.config, reason: "source_mapping_ambiguous" },
    );
  }
  const existingBinding = sources.find(
    (source) =>
      source.alias === configuredSource.alias && source.adapter === configuredSource.adapter,
  );
  if (existingBinding && existingBinding[locationKey] !== location) {
    throw new SnackError("A capacity-source alias cannot be rebound to another history.", {
      code: ExitCode.config,
      reason: "source_rebind_rejected",
    });
  }
  // One client installation keeps one identity however many capacity sources it feeds, so a
  // history already known under another alias contributes its identity rather than a new one.
  const existingInstallation = sources.find(
    (source) => source[locationKey] === location && typeof source.installation_id === "string",
  );
  const source =
    typeof existingInstallation?.installation_id === "string"
      ? { ...configuredSource, installation_id: existingInstallation.installation_id }
      : configuredSource;
  return {
    source,
    sources: [
      ...sources.filter(
        (candidate) =>
          candidate.alias !== configuredSource.alias ||
          candidate.adapter !== configuredSource.adapter,
      ),
      source,
    ],
  };
}

/**
 * Reduce configured sources to one entry per capacity source.
 *
 * Configuration records one entry per client feeding a capacity source, because each client has
 * its own installation identity and its own history to find. Reporting is about the capacity
 * source: usage from every client behind one lineage is already combined in storage, so listing
 * the lineage twice would describe two capacities that do not exist.
 *
 * @template {{alias: string}} T
 * @param {T[]} sources
 * @returns {T[]}
 */
function byCapacitySource(sources) {
  /** @type {Map<string, T>} */
  const unique = new Map();
  for (const source of sources) {
    if (!unique.has(source.alias)) unique.set(source.alias, source);
  }
  return [...unique.values()];
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
    completeness: status.completeness.level,
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
 * The trend is reported by `stats` only. `status` answers whether the next prompt is viable,
 * and a direction over past windows is not part of that answer.
 *
 * @param {{databaseFile: string, source: {alias: string}, planProfile: import("./plan-profile.js").PlanProfile, horizon: string, now: Date, includeTrend?: boolean}} input
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
  /** @type {Record<string, number[]>} */
  const trendBaselines = {};
  /** @type {Record<string, number>[]} */
  const trendWindows = [];
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
      // The trend ranks the recent windows against what came before all of them, so the
      // windows it compares are excluded from the baseline it compares them against.
      if (offset > TREND_POLICY.windows) (trendBaselines[dimension] ??= []).push(value);
    }
  }
  for (let offset = TREND_POLICY.windows - 1; offset >= 0; offset -= 1) {
    const window = summarizeWindow(/** @type {typeof rows} */ (buckets[offset]), input.now);
    if ((window.values.prompts ?? 0) > 0) trendWindows.push(window.values);
  }
  const trend =
    input.includeTrend === true
      ? {
          trend: computeUsageTrend({
            windows: trendWindows,
            baselines: trendBaselines,
            profileWeights: input.planProfile.weights,
            effectiveSampleSize: current.effectiveSampleSize,
          }),
        }
      : {};
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
      ...trend,
    };
  }
  return {
    horizon: input.horizon,
    baseline_windows: observedWindows,
    ...trend,
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
 * @param {{databaseFile: string, source: {alias: string, provider: string, profile: string, plan: string}, planProfile: import("./plan-profile.js").PlanProfile, horizons: string[], now: Date, clients?: {installation_id: string, client: string}[] | null}} input
 */
function buildSourceStats(input) {
  /** @type {{groups: {key: string, prompts: number, eligible: number, restricted: number}[], unattributed: number} | null} */
  let attribution = null;
  // The comparison reads the widest configured horizon, because separating two refusal rates needs
  // every observation there is and the narrow horizons are the ones that will say "not comparable".
  // It reuses the rows that horizon was read for rather than fetching per client: a per-client
  // re-scan of the window is the shape of mistake that passes on a small history and doubles the
  // work on a real one.
  const widest = input.clients
    ? input.horizons.reduce(
        (best, horizon, index) =>
          parseHorizon(horizon) > parseHorizon(String(input.horizons[best])) ? index : best,
        0,
      )
    : -1;
  const horizons = input.horizons.map((horizon, index) => {
    const window = horizonWindow(input.now, parseHorizon(horizon));
    const rows = readUsageWindowRows(input.databaseFile, input.source.alias, window);
    // Counted here and immediately, rather than by keeping the rows for later. Retaining the widest
    // window's rows until the end of this function kept a hundred thousand objects alive across the
    // pressure and calibration work, and under the heap cap that doubled what `stats` costs.
    if (index === widest) attribution = countByClient(rows);
    return summarizeUsageProfile(
      rows,
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
        includeTrend: true,
      }),
    },
    calibration: buildCalibrationReport(input.databaseFile, input.source.alias, input.planProfile),
    ...(input.clients
      ? {
          by_client: buildClientComparison({
            attribution: attribution ?? { groups: [], unattributed: 0 },
            pairs: readCalibrationPairs(input.databaseFile, input.source.alias),
            clients: input.clients,
          }),
        }
      : {}),
  };
}

/**
 * Count one analysis window by the client each prompt was attributed to.
 *
 * One pass, three counters per client, nothing retained. The rows belong to the horizon that read
 * them and are released with it; keeping them so the comparison could count them later is what made
 * `stats --by-client` cost twice what `stats` costs on a hundred-thousand-prompt history.
 *
 * @param {import("./storage.js").UsageWindowRow[]} rows
 */
function countByClient(rows) {
  /** @type {Map<string, {key: string, prompts: number, eligible: number, restricted: number}>} */
  const groups = new Map();
  let unattributed = 0;
  for (const row of rows) {
    // A prompt stored before attribution existed, or one on a source two clients already shared
    // when the column arrived. It is counted and reported rather than dropped or assigned: the
    // honest answer is that nobody knows which client produced it.
    if (row.installation_id === null) {
      unattributed += 1;
      continue;
    }
    let group = groups.get(row.installation_id);
    if (group === undefined) {
      group = { key: row.installation_id, prompts: 0, eligible: 0, restricted: 0 };
      groups.set(row.installation_id, group);
    }
    group.prompts += 1;
    // Excluded observations are not evidence either way: seen, never refused. The same rule
    // `countOutcomes` applies, applied here because here is where the rows already are.
    if (row.outcome === "excluded") continue;
    group.eligible += 1;
    if (row.outcome === "restricted") group.restricted += 1;
  }
  return { groups: [...groups.values()], unattributed };
}

/**
 * Compare the clients feeding one capacity source against each other.
 *
 * The comparison itself lives in analytics and knows nothing about clients: it is handed keys and
 * observations. This function is what turns an installation id into the name of a client, which is
 * a fact about configuration rather than about the data, and it does it by looking the id up rather
 * than by testing it against any particular client's name -- so a third client needs no edit here.
 *
 * @param {{attribution: {groups: {key: string, prompts: number, eligible: number, restricted: number}[], unattributed: number}, pairs: import("./storage.js").CalibrationPair[], clients: {installation_id: string, client: string}[]}} input
 */
function buildClientComparison(input) {
  const names = new Map(input.clients.map((client) => [client.installation_id, client.client]));
  const unattributed = input.attribution.unattributed;

  /** @type {Map<string, import("./storage.js").CalibrationPair[]>} */
  const pairsByClient = new Map();
  for (const pair of input.pairs) {
    if (pair.installation_id === null) continue;
    const pairs = pairsByClient.get(pair.installation_id) ?? [];
    pairs.push(pair);
    pairsByClient.set(pair.installation_id, pairs);
  }

  const comparison = compareOutcomeGroups(input.attribution.groups);
  return {
    policy_version: comparison.policy_version,
    status: comparison.status,
    reason: comparison.reason,
    groups: comparison.groups.map((group) => ({
      client: names.get(group.key) ?? null,
      installation_id: group.key,
      prompts: group.prompts,
      eligible: group.eligible,
      restricted: group.restricted,
      restriction_share: group.restriction_share,
      difference: group.difference,
      calibration: summarizeCalibration(pairsByClient.get(group.key) ?? []),
    })),
    unattributed: { prompts: unattributed },
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
    prior: { strength: planProfile.prior_strength, viability: planProfile.prior_viability },
  });
  return {
    policy_version: CALIBRATION_POLICY.version,
    snapshots: snapshots.length,
    undelivered_attempts: readPredictionAttemptCount(databaseFile, alias) - snapshots.length,
    live: summarizeCalibration(pairs),
    backtest: { ...replay.calibration, forecasts: replay.forecasts },
  };
}

/** @param {unknown[]} sources @param {string} installationId */
function providerMappings(sources, installationId) {
  const providerMappingCounts = new Map();
  for (const source of sources) {
    if (!isConfiguredSource(source) || source.installation_id !== installationId) continue;
    providerMappingCounts.set(
      source.provider,
      (providerMappingCounts.get(source.provider) ?? 0) + 1,
    );
  }
  return { mappedProviders: new Set(providerMappingCounts.keys()), providerMappingCounts };
}

/**
 * Strip the values Commander quotes back when it refuses a command line.
 *
 * SNACK never echoes a rejected value: an alias, a key or a bound arrives from argv, and argv is
 * where someone pastes something private by accident. Commander does not share that rule -- "too
 * many arguments ... but got 1: <value>" prints whatever was typed -- so its message is the one
 * place on the CLI surface where the rule did not hold. The JSON document was already clean; this
 * is the human line.
 *
 * Only the trailing value list is removed. Which argument count was wrong, and which unknown option
 * was given, are what makes the message worth printing at all.
 *
 * @param {string} detail
 */
function withoutRejectedValues(detail) {
  return detail.replace(/(arguments? but got \d+):[^\n]*/gu, "$1.");
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
