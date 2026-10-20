import json, glob, os
from collections import Counter

d = os.path.expanduser('~/Library/Application Support/WorldBase/conversations')
files = sorted(glob.glob(os.path.join(d, '*.json')))
print('files', len(files))

runs = []
def walk(node, path=''):
    if isinstance(node, dict):
        if 'name' in node and 'status' in node and isinstance(node.get('name'), str):
            if node.get('status') in ('running', 'completed', 'failed', 'neutral'):
                runs.append((os.path.basename(path), node))
        for k, v in node.items():
            walk(v, path)
    elif isinstance(node, list):
        for v in node:
            walk(v, path)

for f in files:
    try:
        o = json.load(open(f))
    except Exception as e:
        print('ERR', f, e)
        continue
    walk(o, f)

print('runs', len(runs))
by_name_status = Counter((r['name'], r['status']) for _, r in runs if r['status'] != 'neutral')
for (n, s), c in sorted(by_name_status.items(), key=lambda x: -x[1])[:40]:
    print(f'{c:4d} {s:10s} {n}')
