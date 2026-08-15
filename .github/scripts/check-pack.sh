#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"

name=$(node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync('package.json','utf8')).name)")
version=$(node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync('package.json','utf8')).version)")
dest=${PACK_DEST:-/tmp}
tgz="$dest/$name-$version.tgz"

pnpm pack --pack-destination "$dest" >/dev/null

if [[ ! -f $tgz ]]; then
  echo "missing tarball: $tgz" >&2
  exit 1
fi

mapfile -t files < <(tar -tzf "$tgz" | sed 's|^package/||' | sort)

must=(
  LICENSE
  README.md
  package.json
  cordis.patch.yml
  lib/host.js
  lib/client.js
  lib/install.js
  lib/unzip.js
)

missing=0
for f in "${must[@]}"; do
  if ! printf '%s\n' "${files[@]}" | grep -qx "$f"; then
    echo "package missing: $f" >&2
    missing=1
  fi
done

leaked=$(printf '%s\n' "${files[@]}" | grep -E '^(src/|lib/tests/|node_modules/|\.env)' || true)
if [[ -n $leaked ]]; then
  echo "package leaked:" >&2
  echo "$leaked" >&2
  missing=1
fi

if [[ $missing -ne 0 ]]; then
  echo "package files:" >&2
  printf '  %s\n' "${files[@]}" >&2
  exit 1
fi

echo "ok $tgz (${#files[@]} files)"
