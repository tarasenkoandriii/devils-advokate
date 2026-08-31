module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  // 63 из 117 спеков написаны под собственный раннер (run() + process.exit,
  // без describe/it) — jest их запускать не может. Они отфильтровываются
  // по содержимому и запускаются через scripts/run-standalone-specs.js
  // (`npm run test:standalone`). См. аудит.
  filter: '<rootDir>/jest.filter.cjs',
};
