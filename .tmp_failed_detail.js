const fs = require('fs');
const path = require('path');
const os = require('os');
const dir = path.join(os.homedir(), 'Library/Application Support/WorldBase/conversations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('catalog'));
const out = [];
for (const f of files) {
  const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const created = (o.createdAt || '').slice(0, 10);
  (o.messages || []).forEach((m) => {
    const blocks = m.blocks || [];
    blocks.forEach((b, i) => {
      if (b.kind !== 'tool' || !b.toolRun || b.toolRun.status !== 'failed') return;
      const r = b.toolRun;
      // find next content block in same message
      let next = '';
      for (let j = i + 1; j < blocks.length; j++) {
        if (blocks[j].kind === 'content' && blocks[j].content) { next = blocks[j].content; break; }
      }
      out.push({ created, name: r.name, dur: ((r.endedAt - r.startedAt) / 1000).toFixed(1), progress: r.progress, next: next.slice(0, 260).replace(/\n/g, ' ⏎ ') });
    });
  });
}
const byTool = {};
out.forEach((x) => (byTool[x.name] = (byTool[x.name] || []).concat(x)));
for (const [name, arr] of Object.entries(byTool)) {
  if (!/rebuild_project|get_project_status|write_project_file|read_project_file|ask_user|interact_current_page|read_current_page|write_active_terminal/.test(name)) continue;
  console.log('\n#####', name, arr.length);
  arr.slice(0, 6).forEach((x) => {
    console.log(' -', x.created, x.dur + 's', '| progress:', JSON.stringify(x.progress).slice(0, 400));
    console.log('    next content:', x.next);
  });
}
