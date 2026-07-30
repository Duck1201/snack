import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import { parseAndValidateConfig } from "../src/config.js";

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
