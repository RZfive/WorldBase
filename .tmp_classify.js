const fs = require('fs');
const path = require('path');
const os = require('os');
const dir = path.join(os.homedir(), 'Library/Application Support/WorldBase/conversations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('catalog'));
const counts = {};
const samples = {};
let falseRed = 0;
let real = 0;
const falseRedUnder = {};
for (const f of files) {
  const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const m of o.messages || []) {
    for (const b of m.blocks || []) {
      if (b.kind !== 'tool' || !b.toolRun) continue;
      const r = b.toolRun;
      const day = r.startedAt ? new Date(r.startedAt).toISOString().slice(0, 10) : 'unknown';
      if (day !== '2026-10-19') continue;
      counts[r.status] = (counts[r.status] || 0) + 1;
      if (r.status !== 'failed') continue;
      const p = r.progress;
      let detail = '';
      try {
        const arr = typeof p === 'string' ? JSON.parse(p) : p;
        detail = (Array.isArray(arr) ? arr : []).map((x) => x && x.detail).filter(Boolean).join(' | ');
      } catch { detail = String(p); }
      let fake = false;
      try {
        const obj = JSON.parse(detail);
        if (obj && (obj.success === true || (obj.alive === true && obj.healthy === true))) fake = true;
      } catch {}
      if (fake) { falseRed++; falseRedUnder[r.name] = (falseRedUnder[r.name] || 0) + 1; }
      else real++;
      if (!samples[r.name]) samples[r.name] = detail.slice(0, 160);
    }
  }
}
console.log('statuses today:', JSON.stringify(counts));
console.log('false-red (payload says success):', falseRed, JSON.stringify(falseRedUnder));
console.log('real failures:', real);
console.log('\nfirst detail per tool:');
for (const k of Object.keys(samples)) console.log('-', k, '::', JSON.stringify(samples[k]));
