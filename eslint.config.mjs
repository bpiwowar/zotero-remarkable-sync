// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  overrides: [
    {
      files: ["**/*.ts"],
      rules: {
        // We disable this rule here because the template
        // contains some unused examples and variables
        "@typescript-eslint/no-unused-vars": "off",
      },
    },
    {
      // Standalone Node test harnesses (run outside Zotero).
      files: ["test/**/*.mjs", "packages/*/test/**/*.mjs"],
      languageOptions: {
        globals: {
          console: "readonly",
          process: "readonly",
        },
      },
    },
  ],
});
