const fs = require('fs');
const path = require('path');
const os = require('os');
const dir = path.join(os.homedir(), 'Library/Application Support/WorldBase/conversations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
console.log('files', files.length);
const p = path.join(dir, files[0].f);
console.log('newest', files[0].f, (files[0].m / 1e6).toFixed(0));
const o = JSON.parse(fs.readFileSync(p, 'utf8'));
function shape(v, d = 0) {
  if (d > 3) return typeof v;
  if (Array.isArray(v)) return '[' + v.length + '] ' + (v.length ? shape(v[0], d + 1) : '');
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).map((k) => k + ':' + shape(v[k], d + 1)).join(', ') + '}';
  }
  return typeof v;
}
console.log(shape(o));
