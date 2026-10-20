const fs = require('fs');
const path = require('path');
const os = require('os');
const dir = path.join(os.homedir(), 'Library/Application Support/WorldBase/conversations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('catalog'))
  .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
console.log('conv files', files.length);
console.log(files.slice(0, 6).map((x) => x.f + ' ' + new Date(x.m).toISOString().slice(0, 16)).join('\n'));
function shape(v, d = 0) {
  if (d > 4) return typeof v;
  if (Array.isArray(v)) return '[' + v.length + '] ' + (v.length ? shape(v[0], d + 1) : '');
  if (v && typeof v === 'object') {
    const ks = Object.keys(v);
    if (ks.length > 25) return '{' + ks.slice(0, 25).map((k) => k + ':' + shape(v[k], d + 1)).join(', ') + ', ...}';
    return '{' + ks.map((k) => k + ':' + shape(v[k], d + 1)).join(', ') + '}';
  }
  return typeof v;
}
console.log(shape(JSON.parse(fs.readFileSync(path.join(dir, files[0].f), 'utf8'))));
