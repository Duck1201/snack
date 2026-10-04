// The collapse test, run for the answer's policy and every weighting variant: promotion condition 5
// of `recency-variant-promotion-v1` (docs/history/specs/half-life-shadows/spec.md §6.1, §12 D3).
//
// It computes and prints; it decides nothing. A variant that passes here has met one condition of
// five, and promotion is a later release's ADR on the maintainer's real histories -- so this script
// changes no file, no policy and no database, and its exit code says only whether it ran.
//
//   npm run collapse:check            # a table
//   npm run collapse:check -- --json  # one JSON document
import { PREDICTION_POLICY, WEIGHTING_VARIANTS } from "../packages/cli/src/prediction.js";
import {
  COLLAPSE_TEST,
  runCollapseTest,
} from "../packages/cli/test/fixtures/collapse-simulation.js";

const policies = [
  { method: "bayesian-pressure-band@1 (the answer)", policy: PREDICTION_POLICY },
  ...WEIGHTING_VARIANTS.map((variant) => ({
    method: `${variant.method.id}@${variant.method.version}`,
    policy: variant.policy,
  })),
];
const results = policies.map(({ method, policy }) => ({ method, ...runCollapseTest(policy) }));

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ test: COLLAPSE_TEST, results }, null, 2)}\n`);
} else {
  const limit = `${Math.floor(COLLAPSE_TEST.runs * COLLAPSE_TEST.max_still_safe_share)}/${COLLAPSE_TEST.runs}`;
  process.stdout.write(
    `collapse test: ${COLLAPSE_TEST.viability_before} -> ${COLLAPSE_TEST.viability_after} viability, ` +
      `still claiming a lower bound above ${COLLAPSE_TEST.safe_lower_bound} ` +
      `${COLLAPSE_TEST.prompts_into_collapse} prompts in; at most ${limit} runs may\n\n`,
  );
  for (const result of results) {
    const counts = result.cadences
      .map((cadence) => `${cadence.gap_minutes} min ${cadence.still_safe}/${result.runs}`)
      .join(" · ");
    process.stdout.write(
      `  ${result.method.padEnd(40)} ${String(result.recency_half_life_prompts).padStart(3)}-prompt half-life · ${counts} · ${result.passes ? "passes" : "fails"}\n`,
    );
  }
  process.stdout.write("\nNothing is promoted: passing is one of five conditions (spec §6.1).\n");
}
