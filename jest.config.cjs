module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  transform: {},
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1.js',
  },
};
