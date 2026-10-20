const fs = require('fs');
const path = require('path');
const os = require('os');
const dir = path.join(os.homedir(), 'Library/Application Support/WorldBase/conversations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('catalog'));
const perDay = {};
const rows = [];
for (const f of files) {
  const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const m of o.messages || []) {
    for (const b of m.blocks || []) {
      if (b.kind !== 'tool' || !b.toolRun) continue;
      const r = b.toolRun;
      const day = r.startedAt ? new Date(r.startedAt).toISOString().slice(0, 10) : 'unknown';
      const d = (perDay[day] = perDay[day] || { total: 0, failed: 0, byTool: {} });
      d.total++;
      if (r.status === 'failed') {
        d.failed++;
        d.byTool[r.name] = (d.byTool[r.name] || 0) + 1;
        rows.push({ day, name: r.name, progress: r.progress });
      }
    }
  }
}
console.log('day | total | failed | failedByTool');
Object.keys(perDay).sort().forEach((k) => {
  const v = perDay[k];
  console.log(k, v.total, v.failed, JSON.stringify(v.byTool));
});

// rebuild false positive: error field null in detail JSON
const today = rows.filter((r) => r.day === '2026-10-19');
console.log('\n2026-10-19 failures total', today.length);
const rebuiltNull = today.filter((r) => r.name === 'rebuild_project' && /"error":null/.test(JSON.stringify(r.progress)));
const rebuiltFail = today.filter((r) => r.name === 'rebuild_project' && /"buildStatus":"failed"/.test(JSON.stringify(r.progress)));
console.log('rebuild_project with error:null (false red):', rebuiltNull.length);
console.log('rebuild_project real build failure:', rebuiltFail.length);
console.log('other today failures:', JSON.stringify(today.filter((r) => r.name !== 'rebuild_project').reduce((a, r) => (a[r.name] = (a[r.name] || 0) + 1, a), {})));
