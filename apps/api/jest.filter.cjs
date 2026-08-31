const { readFileSync } = require('node:fs');
module.exports = (paths) => ({
  filtered: paths
    .filter((p) => /^\s*describe\(/m.test(readFileSync(p, 'utf8')))
    .map((test) => ({ test })),
});
