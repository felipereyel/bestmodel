#!/usr/bin/env sh
# Assemble the deployable site into dist/ (page + data + Cloudflare headers).
set -eu
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
cp index.html _headers dist/
cp -R data dist/data
echo "dist/ ready:" && find dist -type f | sort
