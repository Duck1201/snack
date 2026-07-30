import js from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "graphify-out/**"],
  },
  js.configs.recommended,
  jsdoc.configs["flat/recommended-typescript-flavor"],
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2024,
      globals: {
        process: "readonly",
        URL: "readonly",
      },
      sourceType: "module",
    },
    rules: {
      "jsdoc/escape-inline-tags": "off",
      "jsdoc/require-property-description": "off",
      "jsdoc/require-jsdoc": "off",
      "jsdoc/require-param": "off",
      "jsdoc/require-param-description": "off",
      "jsdoc/require-returns": "off",
      "jsdoc/require-returns-description": "off",
      "jsdoc/tag-lines": "off",
    },
  },
];
