import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import { getConfigValue, parseAndValidateConfig } from "../src/config.js";

test("generated valid horizons survive schema validation without coercion", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(
        fc.integer({ min: 1, max: 999 }).map((hours) => `PT${hours}H`),
        {
          minLength: 1,
          maxLength: 12,
        },
      ),
      (horizons) => {
        const config = parseAndValidateConfig(
          JSON.stringify({ schema_version: 1, analysis: { horizons } }),
        );
        assert.deepEqual(config.analysis, { horizons });
      },
    ),
    { numRuns: 100 },
  );
});

test("every configured source is reachable by its index, whatever the array length", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/u), {
        minLength: 1,
        maxLength: 8,
      }),
      (aliases) => {
        const config = parseAndValidateConfig(
          JSON.stringify({
            schema_version: 1,
            sources: aliases.map((alias) => ({
              alias,
              installation_id: "11111111-2222-4333-8444-555555555555",
              adapter: "opencode",
              database: "/tmp/opencode.db",
              provider: "anthropic",
              profile: "default",
              plan: "generic",
              fingerprint: "oc-sqlite-msgpart-v1",
            })),
          }),
        );

        aliases.forEach((alias, index) => {
          assert.equal(getConfigValue(config, `sources.${index}.alias`), alias);
        });
        // One past the end is a missing key, never a silent undefined.
        assert.throws(() => getConfigValue(config, `sources.${aliases.length}.alias`));
      },
    ),
    { numRuns: 100 },
  );
});
