const fs = require('fs');
const path = require('path');
const os = require('os');
const dir = path.join(os.homedir(), 'Library/Application Support/WorldBase/conversations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('catalog'));
const want = new Set(['rebuild_project', 'get_project_status', 'read_project_file', 'write_project_file', 'write_workspace_file']);
const seen = new Set();
for (const f of files) {
  const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const m of o.messages || []) {
    for (const b of m.blocks || []) {
      if (b.kind !== 'tool' || !b.toolRun) continue;
      const r = b.toolRun;
      const day = r.startedAt ? new Date(r.startedAt).toISOString().slice(0, 10) : 'unknown';
      if (day !== '2026-10-19') continue;
      if (r.status !== 'failed') continue;
      if (!want.has(r.name)) continue;
      if (!seen.has(r.name)) seen.add(r.name);
      else continue;
      console.log('=== file', f, '| tool', r.name, '| status', r.status);
      console.log('title:', r.title);
      console.log('progress:', typeof r.progress === 'string' ? r.progress.slice(0, 2500) : JSON.stringify(r.progress).slice(0, 2500));
      console.log('');
    }
  }
}
