#!/bin/sh
# GitHub Pages / Vercel can only serve a branch's root or its /docs folder,
# so this is a build output, not a place to edit.
#
#   staff/index.html  -> docs/index.html   (the real app — nice root URL)
#   staff/ (rest)     -> docs/staff/       (css/js/vendor; ASSET_BASE for the
#                                           legacy Apps-Script-hosted
#                                           Staff.html points here too)
#
# index.html is deliberately NOT duplicated into docs/staff/ — its relative
# paths (./staff/staff.css etc.) only resolve correctly from the root.
#
# Run after any change under staff/, then commit both.
set -e
cd "$(dirname "$0")"
rm -rf docs
mkdir -p docs/staff
cp -r staff/. docs/staff/
rm -f docs/staff/index.html
cp staff/index.html docs/index.html
echo ".vercel" > docs/.gitignore
echo "docs/ rebuilt from staff/ (index.html promoted to root, not duplicated)"
