/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleNameMapper: {
    // Strip the .js extension that TypeScript emits for module specifiers
    // so that ts-jest can resolve them to .ts source files.
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    // index.ts is a pure barrel re-export; excluding it avoids inflating the
    // denominator for function/statement coverage with lines that are trivially
    // not exercised in unit tests.
    "!src/index.ts",
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80
    }
  }
};
