#!/usr/bin/env bash
set -euo pipefail

tag="${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"
vsix="${1:?VSIX path is required}"

if gh release view "${tag}" >/dev/null 2>&1; then
  echo "Release ${tag} already exists; replacing its VSIX asset."
  gh release upload "${tag}" "${vsix}" --clobber
else
  echo "Creating GitHub Release ${tag}."
  gh release create "${tag}" "${vsix}" \
    --verify-tag \
    --title "${tag}" \
    --generate-notes
fi
