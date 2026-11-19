/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: { module: 'CommonJS', moduleResolution: 'node', isolatedModules: true },
      },
    ],
  },
  testTimeout: 30000,
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  // Exclude integration/e2e tests that require a live DB + Redis.
  // Product integration targets remain disabled until their ERTAD contracts are adapted.
  testPathIgnorePatterns: [
    '/node_modules/',
    'tests/foundation.test.ts', // Executed by Node's test runner.
    'tests/enrollment-e2e.test.ts',
    'tests/auth.test.ts',
    'tests/nonce.test.ts',
    'tests/health.test.ts',
    'tests/sanity.test.ts',
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60
    }
  },
  moduleNameMapper: {
    '^uuid$': '<rootDir>/tests/__mocks__/uuid.ts',
  },
};
