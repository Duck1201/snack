import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseJsonc } from "jsonc-parser";

const profileDirectory = fileURLToPath(new URL("../profiles/plans", import.meta.url));
const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../schemas/plan-profile.schema.json", import.meta.url)),
    "utf8",
  ),
);
const ajv = new Ajv2020.default({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

/**
 * Viability assumed when a profile declares none. It is deliberately uninformative: SNACK
 * does not know a provider's real behaviour, and one observed outcome already outweighs it
 * at the bundled prior strength.
 */
const NEUTRAL_PRIOR_VIABILITY = 0.5;

/**
 * @typedef {object} PlanProfile
 * @property {string} id
 * @property {string} version
 * @property {string} as_of
 * @property {"bundled" | "user-defined"} provenance
 * @property {number} prior_strength
 * @property {number} prior_viability
 * @property {Record<string, number>} weights
 */

/**
 * Resolve the plan profile for one configured source.
 *
 * A profile is a weak, versioned prior. When the requested profile is missing or invalid
 * SNACK falls back to the bundled generic profile and reports why, because an unusable
 * assumption must never stop a command from describing observed usage.
 *
 * @param {{plan?: string, plan_profile?: string}} source
 * @returns {{profile: PlanProfile, warnings: {code: string, message: string}[]}}
 */
export function resolvePlanProfile(source) {
  const requested = source.plan_profile ?? source.plan ?? "generic";
  if (requested === "generic") {
    return { profile: loadBundled("generic"), warnings: [] };
  }
  try {
    return { profile: load(requested), warnings: [] };
  } catch (error) {
    return {
      profile: loadBundled("generic"),
      warnings: [
        {
          code: "plan_profile_unavailable",
          message: `Plan profile "${requested}" is unavailable; using the generic profile. ${
            error instanceof Error ? error.message : "Unknown reason."
          }`,
        },
      ],
    };
  }
}

/**
 * @param {string} reference bundled profile id, or a path to a local JSONC profile
 * @returns {PlanProfile}
 */
function load(reference) {
  return reference.includes("/")
    ? parseProfile(readFileSync(reference, "utf8"))
    : loadBundled(reference);
}

/** @param {string} id @returns {PlanProfile} */
function loadBundled(id) {
  return parseProfile(readFileSync(join(profileDirectory, `${id}.json`), "utf8"));
}

/** @param {string} contents @returns {PlanProfile} */
function parseProfile(contents) {
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  const parsed = parseJsonc(contents, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error("Profile is not valid JSONC.");
  }
  if (!validate(parsed)) {
    throw new Error(ajv.errorsText(validate.errors, { dataVar: "profile" }));
  }
  // A profile that says nothing about how viable prompts are gets the neutral assumption:
  // claiming anything else on the user's behalf would be an invented plan limit.
  const profile = /** @type {PlanProfile} */ (parsed);
  return { ...profile, prior_viability: profile.prior_viability ?? NEUTRAL_PRIOR_VIABILITY };
}
