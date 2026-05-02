/**
 * Jest configuration for the standalone recorder plugin package.
 *
 * The hook + state-machine tests run in a jsdom environment so React
 * hooks have a `window` global. Pure-function tests (waveform peaks,
 * vocal preset applier) run in the same env without harm.
 */

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  // Mirror the consumer's path alias for the SDK so jest can resolve
  // `@signalsandsorcery/plugin-sdk` against the locally-installed copy.
  moduleNameMapper: {
    '^@signalsandsorcery/plugin-sdk$': '<rootDir>/node_modules/@signalsandsorcery/plugin-sdk',
  },
};
