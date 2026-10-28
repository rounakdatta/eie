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

# The newspaper: every episode as an edition

Each episode is set as a four-page broadsheet after The Telegraph's Calcutta edition: a nameplate with the hosts cut out in front of it, a skyline of teasers, the blue folio, In Brief, a lead that jumps to page 2, an opinion page that follows the episode's argument chapter by chapter, illustrated features, a bookshelf, laugh lines, a crossword, a quiz and a glossary. Every picture is the episode's own (frames, silent loops, Simahina's chapter art) or a checked Wikimedia Commons photograph. Every play mark starts the video at its moment. Episode 45 was made by hand and is the model the others follow.

An edition lives in `site/editions/NNN/`:

| File | What | Made by |
|---|---|---|
| `copy.json` | What the edition says: headlines, articles, captions' topics, the quiz, the crossword's words. Its shape and rules are in `paper/copydesk.py`. | `paper/write.py` (Episode 45: by hand) |
| `media.json`, `media/` | Its pictures, and where each came from. | `paper/media.py` (Episode 45: by hand) |
| `edition.json`, `data.json`, `index.html` | What the page reads: the copy made ready to set, the episode's words and moments, the page itself. | `paper/build-paper.py` |

```sh
. work/env.sh                                       # the venv's Pillow and numpy need it
work/venv/bin/python site/paper/write.py 12         # copy.json: Claude through auth2api (key in work/.auth2api-key)
PATH=<ffmpeg>/bin:<yt-dlp>/bin:$PATH work/venv/bin/python site/paper/media.py 12   # media.json and media/
work/venv/bin/python site/paper/build-paper.py      # every edition, editions/index.json and paper.js (needs pyphen)
sh site/publish.sh /tmp/pub && python3 -m http.server 8745 --directory /tmp/pub   # then open http://127.0.0.1:8745/
node site/tools/editions-verify.cjs                 # every edition: the fit at seven widths, three phones, errors, missing files
node site/tools/paper-checks.cjs                    # Episode 45 in depth: 13 checks (the player, the jump, the crossword)
node site/tools/paper-verify.cjs                    # and 8 more: nine widths, the jump keeps every word, resizing, keys, phones
```

**Writing** (`write.py`): a draft written to `paper/BRIEF.md` from the episode (its chapters, show notes, insights and transcript) with Episode 45's copy as the model; the checks in `copydesk.py`, everything a machine can check (references, marks, phrases and quotes found in the transcript as said, counts, lengths, the crossword); a review by a second call that reads the draft against the transcript as a sub-editor would; the checks again, and what still fails goes back twice at most; then the crossword's seed. The replies are JSON as text: structured outputs can't hold the copy's schema ("the compiled grammar is too large"). Logs: `work/editions/logs/`.

**Pictures** (`media.py`): the video is downloaded at 480p, video only, and deleted after (yt-dlp; seeking straight into YouTube's stream URLs is refused for some videos). Candidate frames for each slot (the hosts together near the start, the speaker of each story and point in close-up, chapter cards at chapter starts) go on numbered contact sheets that Claude reads against a reference sheet of the hosts, by appearance; code turns that into names, so every caption says who is on screen. A loop is cut only where the camera holds for its four seconds. Photographs are Wikidata's image for the person or subject the copy names, taken only when Wikidata's description fits the copy's hint, credited from Commons.

Things learned running all 128, so they stay fixed:
- Five writers at once ran the Claude subscription into "Rate limited on the configured account" and lost finished drafts. Run two at most; `write.py` and `media.py` now wait a rate limit out (5, 10, 20, then 30 minutes at a time) instead of failing.
- YouTube refuses some videos whole (HTTP 503, or a few hundred bytes and then nothing) while serving short sections of them, and after many downloads it asked this server to "sign in to confirm you're not a bot". `media.py` tries other formats, then fetches clips at just the times it needs, paces its requests, and leaves a refused episode alone for six hours.
- The copy writes curly apostrophes and the transcript straight ones: `build.tokens` reads them as one, or short quotes with contractions are "not found".
- Exemplar leakage is real: a glossary term from Episode 45 turned up in Episode 121. Glossary terms and crossword answers must be found in their own episode.

The site is published in two places, both serving what `site/publish.sh` gathers: the archive's front page (`site/front/`: where to start, the threads through the show, every edition and a search) at `/`, each edition at `/N/`, and the paper's shared files at `/paper/` (whose old address for Episode 45 now redirects to `/45/`).

- **https://eie.taptappers.club**, on the homelab (`kubernetes/apps/hugo-sites/sites/eie` in homelab.setup). Its pod fetches only `site/` from a tag of this repo (a blobless sparse clone) and runs `publish.sh` itself. To publish a change: merge it, tag main `site-vX.Y.Z`, and set `BRANCH` in that overlay to the tag; the deploy rolls the pod.
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
  - leaving out a paragraph the copy marks optional (`~ `), from the last one back;
  - the column count (`data-cols="2,1"`).
- Each candidate setting is checked in real columns: flush feet, and no crosshead at a column's foot or head.
- The lead is cut at the line and "Continued on page 2": the cut falls only at a break opportunity, a word broken across it keeps its hyphen, and no play mark is split from its word.
- Page one is set first and shown at once (about 0.5 s); the inside pages are set band by band in the moments after, yielding to the browser between bands.
- Narrower windows read the paper story by story ("article mode"), where none of this is needed and nothing is left out.
- How many sections and stories a page holds is the copy's: three to six opinion sections (two or three to a row after the first), three or four stories, and a shelf of more than 28 works, or one the episode hasn't the jokes to balance, takes the page's width.
- More levers for the books page: a shelf title may give up its line of air, a work's meta line or a laugh line past the fourth may be left out on a desktop (phones show everything), and the lead's picture may crop taller so a jump carries a real paragraph rather than a sentence.
- A text is laid out once for each measure, cap and spacing; what the other levers remove is whole lines, so their lengths are arithmetic (a page of books once took 16 seconds to set).

Things learned the hard way, so they stay fixed:
- An odd number of lines can never split into two equal columns, whatever the spacing; the drop-cap variants exist for that.
- A play mark bound to its whole word made a wide unbreakable block that stretched the justified line above it. In prose the mark is a bare disc, bound to the word's last syllable only.
- A word joiner does not stop Chrome breaking before an inline button. The last-syllable span does.
- Probing for the cut character by character went wrong at soft hyphens ("inge-n|uity"); only break opportunities are probed now.
- A half-line spacer took a whole module off the grid, so no depth could ever be whole. Every block is a whole number of lines.
