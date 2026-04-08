#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <output-archive> <glob-pattern> [<glob-pattern>...]" >&2
  exit 1
fi

output_archive="$1"
shift

if command -v python3 >/dev/null 2>&1; then
  python_cmd=python3
elif command -v python >/dev/null 2>&1; then
  python_cmd=python
else
  echo "Python is required to package release artifacts." >&2
  exit 1
fi

archive_path="$("$python_cmd" - "$output_archive" "$@" <<'PY'
import glob
from pathlib import Path
import sys
import zipfile

output = Path(sys.argv[1])
patterns = sys.argv[2:]
members = []
seen = set()

for pattern in patterns:
    for raw_path in sorted(glob.glob(pattern)):
        path = Path(raw_path)
        if not path.is_file():
            continue

        resolved = path.resolve()
        if resolved in seen:
            continue

        seen.add(resolved)
        members.append(path)

if not members:
    raise SystemExit("No files available to archive.")

output.parent.mkdir(parents=True, exist_ok=True)
if output.exists():
    output.unlink()

with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for member in members:
        archive.write(member, arcname=member.name)

print(output.as_posix())
PY
)"

printf '%s\n' "$archive_path"
