#!/bin/sh
# GitHub Pages can only serve a branch's root or its /docs folder, so this
# mirrors staff/ into docs/staff/ for Pages to serve. Run after any change
# under staff/, then commit both.
set -e
cd "$(dirname "$0")"
rm -rf docs/staff
mkdir -p docs/staff
cp -r staff/. docs/staff/
echo "docs/staff rebuilt from staff/"
