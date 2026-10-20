const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = path.join(os.homedir(), 'Library/Application Support/WorldBase/conversations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const runs = [];

function walk(node, file, trail) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, file, trail.concat(i)));
    return;
  }
  if (typeof node.name === 'string' && typeof node.status === 'string' &&
      ['running', 'completed', 'failed'].includes(node.status) &&
      ('input' in node || 'toolUseId' in node || 'result' in node || 'output' in node)) {
    runs.push({ file, node, trail });
  }
  for (const k of Object.keys(node)) walk(node[k], file, trail.concat(k));
}

for (const f of files) {
  let o;
  try { o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { console.log('ERR', f, e.message); continue; }
  walk(o, f, []);
}

const count = {};
for (const r of runs) {
  const key = r.node.name + ' | ' + r.node.status;
  count[key] = (count[key] || 0) + 1;
}
console.log('files', files.length, 'runs', runs.length);
Object.entries(count).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(String(v).padStart(4), k));
console.log('--- failed samples ---');
const failed = runs.filter((r) => r.node.status === 'failed');
console.log('failed total', failed.length);
console.log(JSON.stringify(failed.slice(0, 3), null, 2).slice(0, 4000));
