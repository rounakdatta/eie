# The site: design preview, Episode 45

One episode of *Everything is Everything* as a page you can make sense of, come back to and remember: its ideas, stories, books and laughs, each a click away from the moment it was said.

```sh
python3 site/build.py 45                                 # site/data/045.json and site/data/archive.json
python3 -m http.server 8745 --directory site             # then open http://127.0.0.1:8745
```

It must be served over http: YouTube won't play an embed on a page opened as a file, so there the play buttons open YouTube in a new tab instead.

## What's where

| Path | What |
|---|---|
| `build.py` | Turns the archive into what the page reads. Every moment is found in the transcript by its words, and widened to whole sentences. |
| `anchors.json` | The phrases that place recommendations and jokes the transcript can't place by itself, and the first and last words of each story. |
| `art/sprite.svg` | The pictogram library: every person in every plate is one of these. |
| `art/045/*.svg` | The plates, one per idea and story, plus the cover. |
| `art.css` | The inks: ISOTYPE pictograms printed as risograph spot colours that multiply where they overlap. |
| `index.html`, `style.css`, `app.js` | The page. No framework and no build step. |
| `tools/render.cjs` | Renders plates in light and dark, to look at while drawing. |
| `tools/shoot.cjs`, `tools/gallery.cjs` | Photograph the page on phone, narrow phone and desktop, light and dark. |
| `tools/checks.cjs` | The player and link checks: thirteen real bugs, each a scenario that failed before its fix. Run them against the served page before shipping a change. |
| `tools/record.cjs` | Records a walkthrough video (no sound). |

## Drawing a plate

A plate is a 400×300 SVG with no background. It is drawn in up to four coloured inks plus key (`y p r b g k`), people come from the sprite, and nothing is written in it. The picture has to carry the idea: someone who sees it should be able to recall what it means. A dashed outline is the imagined story, a solid shape is what's real, and an arrow is a cause.

# The newspaper: `site/paper/`

Episode 45 set as a four-page broadsheet after The Telegraph's Calcutta edition: a nameplate with the hosts cut out in front of it, a skyline of teasers, the blue folio, In Brief, a lead that jumps to page 2, op-ed pages for the five fallacies, illustrated features, a bookshelf, laugh lines, a crossword, a quiz and a glossary. Every picture is the episode's own (frames, silent loops, Simahina's chapter art) or a checked Wikimedia Commons photograph. Every play mark starts the video at its moment.

```sh
python3 site/paper/build-paper.py          # edition-045.built.json and paper.js (needs pyphen)
python3 -m http.server 8745 --directory site   # then open http://127.0.0.1:8745/paper/
node site/tools/paper-checks.cjs           # 13 checks: flush columns at three widths, the jump, the player, the crossword
node site/tools/paper-verify.cjs           # 8 more: the fit at nine widths, the jump keeps every word, resizing, crossword keys, phones
node site/tools/paper-fit.cjs 1440         # how each band was fitted: depth, column ends, tracking
node site/tools/paper-shots.cjs <dir>      # each page as an image
```

It is published in two places, both serving what `site/publish.sh` gathers: the paper, the one transcript it reads, and a front page that redirects to `paper/`.

- **https://eie.taptappers.club**, on the homelab (`kubernetes/apps/hugo-sites/sites/eie` in homelab.setup). Its pod fetches only `site/` from a tag of this repo (a blobless sparse clone, a few MB of the repo's 230) and runs `publish.sh` itself. To publish a change: merge it, tag main `site-vX.Y.Z`, and set `BRANCH` in that overlay to the tag; the deploy rolls the pod.
- **https://rounak.taptappers.club/eie/**, on GitHub Pages (`.github/workflows/pages.yml`), on every push to main that touches `site/`.

## The typesetting engine (`Fit` in paper-src.js)

The rule a newspaper keeps: no column ends short. On a desktop (1180 px and wider) every story is fitted:

- Everything sits on a 22 px baseline grid. Headlines, captions and boxes are whole numbers of lines; `.snap` pads the odd ones.
- A row of stories (`.band[data-fit]`) gets one depth, in lines. Each story (`.mod`) is fitted to exactly that depth, every column of its text ending on the same line.
- The levers, cheapest first:
  - a picture's crop (`data-r`: the least, natural and most height for its width);
  - a pull quote's size and air (`data-sizes`, `data-pad`);
  - the text's letter- and word-spacing, by hundredths of an em;
  - dropping an optional crosshead;
  - a two-line drop cap or none;
  - the column count (`data-cols="2,1"`).
- Each candidate setting is checked in real columns: flush feet, and no crosshead at a column's foot or head.
- The lead is cut at the line and "Continued on page 2": the cut falls only at a break opportunity, a word broken across it keeps its hyphen, and no play mark is split from its word.
- Page one is set first and shown at once (about 0.5 s); the inside pages are set band by band in the moments after, yielding to the browser between bands.
- Narrower windows read the paper story by story ("article mode"), where none of this is needed.

Things learned the hard way, so they stay fixed:
- An odd number of lines can never split into two equal columns, whatever the spacing; the drop-cap variants exist for that.
- A play mark bound to its whole word made a wide unbreakable block that stretched the justified line above it. In prose the mark is a bare disc, bound to the word's last syllable only.
- A word joiner does not stop Chrome breaking before an inline button. The last-syllable span does.
- Probing for the cut character by character went wrong at soft hyphens ("inge-n|uity"); only break opportunities are probed now.
- A half-line spacer took a whole module off the grid, so no depth could ever be whole. Every block is a whole number of lines.
