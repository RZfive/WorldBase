const fs = require('fs');
const path = require('path');
const os = require('os');
const dir = path.join(os.homedir(), 'Library/Application Support/WorldBase/conversations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('catalog'));
const kinds = {};
const blockSamples = {};
for (const f of files) {
  const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const m of o.messages || []) {
    for (const b of m.blocks || []) {
      kinds[b.kind] = (kinds[b.kind] || 0) + 1;
      if (!blockSamples[b.kind]) blockSamples[b.kind] = JSON.stringify(b).slice(0, 600);
    }
  }
}
console.log(kinds);
for (const [k, v] of Object.entries(blockSamples)) console.log('\n=== ' + k + ' ===\n' + v);
