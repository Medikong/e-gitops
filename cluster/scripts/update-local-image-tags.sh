#!/usr/bin/env bash
set -euo pipefail

tag="${1:-}"
kustomization_file="${2:-}"
registry="${3:-10.10.10.10:5000}"

if [[ -z "$tag" ]]; then
  printf "usage: %s <image-tag> <kustomization-file> [registry]\n" "$0" >&2
  exit 2
fi

if [[ ! "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  printf "invalid Docker image tag: %s\n" "$tag" >&2
  exit 2
fi

if [[ -z "$kustomization_file" || ! -f "$kustomization_file" ]]; then
  printf "missing kustomization file: %s\n" "${kustomization_file:-<empty>}" >&2
  exit 2
fi

app_images="zexpand/auth-service zexpand/patient-service zexpand/appointment-service zexpand/prescription-service zexpand/notification-service zexpand/dashboard"
tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

awk -v tag="$tag" -v registry="$registry" -v apps="$app_images" '
BEGIN {
  split(apps, names, " ")
  for (i in names) {
    app[names[i]] = 1
    short = names[i]
    sub(/^zexpand\//, "", short)
    image_short[names[i]] = short
  }
}
{
  if ($0 ~ /^[[:space:]]*-[[:space:]]*name:[[:space:]]*/) {
    current = $0
    sub(/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/, "", current)
    sub(/[[:space:]]*#.*/, "", current)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", current)
  }

  if ((current in app) && $0 ~ /^[[:space:]]*newName:[[:space:]]*/) {
    match($0, /^[[:space:]]*/)
    print substr($0, RSTART, RLENGTH) "newName: " registry "/" image_short[current]
    next
  }

  if ((current in app) && $0 ~ /^[[:space:]]*newTag:[[:space:]]*/) {
    match($0, /^[[:space:]]*/)
    print substr($0, RSTART, RLENGTH) "newTag: " tag
    next
  }

  print
}
' "$kustomization_file" > "$tmp_file"

mv "$tmp_file" "$kustomization_file"
trap - EXIT

printf "updated app image registry/tag to %s/*:%s in %s\n" "$registry" "$tag" "$kustomization_file"
