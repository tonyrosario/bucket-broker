/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleNameMapper: {
    // Consume the sibling library packages straight from their TypeScript
    // source (no build step): resolves in this dir AND in CI, where `npm ci`
    // runs per package and never builds the siblings' dist/. The authorizer
    // therefore does NOT declare them as npm deps — it maps the module
    // specifiers here (jest) and in tsconfig `paths` (tsc/eslint).
    "^@bucket-broker/resilience$": "<rootDir>/../lib/resilience/src/index.ts",
    "^@bucket-broker/logging$": "<rootDir>/../lib/logging/src/index.ts",
    // Strip the .js extension TypeScript emits for ESM-style relative imports
    // (used inside @bucket-broker/logging) so ts-jest resolves them to .ts.
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  collectCoverageFrom: ["src/**/*.ts"],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
