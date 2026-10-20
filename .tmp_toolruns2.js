const fs = require('fs');
const path = require('path');
const os = require('os');
const dir = path.join(os.homedir(), 'Library/Application Support/WorldBase/conversations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('catalog'));
const counts = {};
const failed = [];
let total = 0;
for (const f of files) {
  const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const created = (o.createdAt || '').slice(0, 10);
  for (const m of o.messages || []) {
    for (const b of m.blocks || []) {
      if (b.kind !== 'tool' || !b.toolRun) continue;
      const r = b.toolRun;
      total++;
      const key = r.name + ' | ' + r.status;
      counts[key] = (counts[key] || 0) + 1;
      if (r.status === 'failed') failed.push({ file: f, convCreated: created, name: r.name, run: r });
    }
  }
}
console.log('total tool runs', total);
Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(String(v).padStart(4), k));
console.log('\nfailed', failed.length);
const fcount = {};
failed.forEach((x) => (fcount[x.name] = (fcount[x.name] || 0) + 1));
console.log(fcount);
console.log('\n--- samples (name, duration, hasError) ---');
for (const x of failed.slice(0, 40)) {
  const r = x.run;
  console.log(x.convCreated, r.name, '| dur', ((r.endedAt - r.startedAt) / 1000).toFixed(1) + 's', '| keys', Object.keys(r).join(','));
}
console.log('\n=== full first 2 failed ===');
console.log(JSON.stringify(failed.slice(0, 2), null, 2).slice(0, 3000));
