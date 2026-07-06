/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleNameMapper: {
    // Resolve the sibling libs to their TypeScript source. There is no root
    // workspace/build step in CI (each package is self-contained per AGENTS.md),
    // so we reuse the real library code directly rather than a built dist/.
    "^@bucket-broker/logging$": "<rootDir>/../lib/logging/src/index.ts",
    "^@bucket-broker/resilience$": "<rootDir>/../lib/resilience/src/index.ts",
    // The logging lib's source uses explicit .js specifiers (NodeNext-style);
    // strip them so ts-jest resolves to the .ts sources.
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/index.ts"],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
