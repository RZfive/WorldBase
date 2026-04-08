#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <glob-pattern> <label>" >&2
  exit 1
fi

pattern="$1"
label="$2"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
parser_script="${repo_root}/.github/scripts/parse-fileio-response.mjs"
file_io_url="${FILE_IO_URL:-https://file.io}"
connect_timeout="${FILE_IO_CONNECT_TIMEOUT:-15}"
max_time="${FILE_IO_MAX_TIME:-300}"
max_attempts="${FILE_IO_MAX_ATTEMPTS:-3}"

shopt -s nullglob
files=($pattern)

if [ ${#files[@]} -eq 0 ]; then
  echo "No ${label} package files found for pattern: ${pattern}" >&2
  exit 1
fi

printf '### File.io uploads (%s)\n' "$label" >> "$GITHUB_STEP_SUMMARY"

for file in "${files[@]}"; do
  filename="$(basename "$file")"
  response_file="$(mktemp)"
  uploaded=false

  for attempt in $(seq 1 "$max_attempts"); do
    echo "Uploading ${filename} to File.io (attempt ${attempt}/${max_attempts})..."
    if curl --show-error --fail --location \
      --connect-timeout "$connect_timeout" \
      --max-time "$max_time" \
      -F "file=@${file}" \
      "$file_io_url" >"$response_file"; then
      uploaded=true
      break
    fi

    echo "File.io upload failed for ${filename} on attempt ${attempt}/${max_attempts}." >&2
    if [ "$attempt" -lt "$max_attempts" ]; then
      sleep $((attempt * 5))
    fi
  done

  if [ "$uploaded" != true ]; then
    rm -f "$response_file"
    echo "Failed to upload ${filename} to File.io after ${max_attempts} attempts." >&2
    exit 1
  fi

  link="$(node "$parser_script" <"$response_file")"
  rm -f "$response_file"

  echo "File.io link for ${filename}: ${link}"
  echo "::notice title=File.io upload::${filename}: ${link}"
  printf -- "- %s: %s\n" "$filename" "$link" >> "$GITHUB_STEP_SUMMARY"
done
