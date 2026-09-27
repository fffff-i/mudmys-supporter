const path = require('node:path');

function getCaseDir(root, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw new Error('不正なシナリオIDです。');
  return path.join(root, id);
}

module.exports = { getCaseDir };
