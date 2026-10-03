import { shownForecast } from "./render.js";

/**
 * The key a dash snapshot is written on: what the reader is shown of one source's answer, and the
 * versions that make it that answer.
 *
 * The interval enters as `shownForecast` rounds it -- the very function every printed interval goes
 * through -- so two readings that print the same line share a key, and a reading that moves the
 * printed interval, the risk word or the evidence level gets a new one (ADR-0008, stated for a
 * screen). The capacity period is in the key because an outcome is linked only to an attempt of its
 * own period. The unrounded interval, the point, freshness, synchronization, the pressure reading
 * and the shadows are not: they are not the answer, or they change with the clock alone.
 *
 * @param {{source: {alias: string, plan_profile: {id: string, version: string}}, viability: {lower: number, upper: number}, risk: {label: string, policy_version: string}, evidence: {level: string, policy_version: string}, method: {id: string, version: string}, model_policy_version: string, pressure: {policy_version: string}}} report
 * @param {number | null} capacityPeriodId
 * @returns {string}
 */
export function snapshotKey(report, capacityPeriodId) {
  const shown = shownForecast(report);
  return JSON.stringify([
    report.source.alias,
    capacityPeriodId,
    shown.interval.lower,
    shown.interval.upper,
    shown.risk,
    shown.evidence,
    report.method.id,
    report.method.version,
    report.model_policy_version,
    report.risk.policy_version,
    report.evidence.policy_version,
    report.pressure.policy_version,
    report.source.plan_profile.id,
    report.source.plan_profile.version,
  ]);
}
