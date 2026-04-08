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

    http_code_file="$(mktemp)"
    curl_exit=0
    curl --show-error --location \
      --connect-timeout "$connect_timeout" \
      --max-time "$max_time" \
      --header 'Accept: application/json' \
      --output "$response_file" \
      --write-out '%{http_code}' \
      -F "file=@${file}" \
      "$file_io_url" >"$http_code_file" 2>/dev/null || curl_exit=$?

    http_code="$(tr -dc '0-9' < "$http_code_file" | tail -c 3)"
    http_code="${http_code:-000}"
    rm -f "$http_code_file"

    if [ "$curl_exit" -ne 0 ]; then
      echo "curl exited with code ${curl_exit} for ${filename} on attempt ${attempt}/${max_attempts}." >&2
    elif [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
      echo "File.io returned HTTP ${http_code} for ${filename} on attempt ${attempt}/${max_attempts}." >&2
    elif ! head -c 1 "$response_file" | grep -q '{'; then
      echo "File.io returned non-JSON response (HTTP ${http_code}) for ${filename} on attempt ${attempt}/${max_attempts}." >&2
      echo "Response preview: $(head -c 200 "$response_file")" >&2
    elif link="$(node "$parser_script" <"$response_file")"; then
      uploaded=true
      break
    else
      echo "File.io returned an invalid JSON response for ${filename} on attempt ${attempt}/${max_attempts}." >&2
    fi

    if [ "$attempt" -lt "$max_attempts" ]; then
      delay=$((10 * 2 ** (attempt - 1)))
      echo "Retrying in ${delay}s..."
      sleep "$delay"
    fi
  done

  if [ "$uploaded" != true ]; then
    rm -f "$response_file"
    echo "Failed to upload ${filename} to File.io after ${max_attempts} attempts." >&2
    exit 1
  fi

  rm -f "$response_file"

  echo "File.io link for ${filename}: ${link}"
  echo "::notice title=File.io upload::${filename}: ${link}"
  printf -- "- %s: %s\n" "$filename" "$link" >> "$GITHUB_STEP_SUMMARY"
done
