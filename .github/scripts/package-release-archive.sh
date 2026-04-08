#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <output-archive> <glob-pattern> [<glob-pattern>...]" >&2
  exit 1
fi

output_archive="$1"
shift

shopt -s nullglob

files=()
for pattern in "$@"; do
  matches=($pattern)
  if [ ${#matches[@]} -eq 0 ]; then
    continue
  fi

  for match in "${matches[@]}"; do
    if [ -f "$match" ]; then
      files+=("$match")
    fi
  done
done

if [ ${#files[@]} -eq 0 ]; then
  echo "No files found for archive: ${output_archive}" >&2
  exit 1
fi

python - "$output_archive" "${files[@]}" <<'PY'
from pathlib import Path
import sys
import zipfile

output = Path(sys.argv[1])
members = []
seen = set()

for raw_path in sys.argv[2:]:
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

with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for member in members:
        archive.write(member, arcname=member.name)

print(output.as_posix())
PY
