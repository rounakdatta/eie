#!/bin/sh
# Gather the newspaper into one folder: the archive's front page, every edition at /N/ (its page, its
# copy and data, its pictures), and the paper's shared files at /paper/. Both places it is published
# serve exactly this: GitHub Pages (.github/workflows/pages.yml) and eie.taptappers.club, whose pod
# runs this script itself (homelab.setup: kubernetes/apps/hugo-sites/sites/eie).
#
#   sh site/publish.sh <out-dir>
set -eu
site=$(dirname "$0")
out=$1
mkdir -p "$out/paper"
cp -r "$site/paper/paper.js" "$site/paper/paper.css" "$site/paper/fonts" "$site/paper/media" "$out/paper/"
cp "$site/paper/index.html" "$out/paper/index.html"   # the old address of Episode 45's paper
cp "$site/grain.png" "$out/"
cp -r "$site/front/." "$out/"
cp "$site/editions/index.json" "$out/editions.json"
for d in "$site"/editions/[0-9][0-9][0-9]; do
  [ -f "$d/edition.json" ] || continue
  n=$(basename "$d" | sed 's/^0*//')
  mkdir -p "$out/$n"
  cp -r "$d/index.html" "$d/edition.json" "$d/data.json" "$d/media" "$out/$n/"
done
