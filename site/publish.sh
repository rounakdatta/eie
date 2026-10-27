#!/bin/sh
# Gather the newspaper into one folder, keeping the relative paths it reads (paper/, data/045.json,
# grain.png), with a front page that sends readers on to paper/. Both places it is published serve
# exactly this: GitHub Pages (.github/workflows/pages.yml) and eie.taptappers.club, whose pod runs
# this script itself (homelab.setup: kubernetes/apps/hugo-sites/sites/eie).
#
#   sh site/publish.sh <out-dir>
set -eu
site=$(dirname "$0")
out=$1
mkdir -p "$out/paper" "$out/data"
cp -r "$site/paper/index.html" "$site/paper/paper.js" "$site/paper/paper.css" "$site/paper/edition-045.built.json" "$site/paper/fonts" "$site/paper/media" "$out/paper/"
cp "$site/data/045.json" "$out/data/"
cp "$site/grain.png" "$out/"
cp "$site/pages-index.html" "$out/index.html"
