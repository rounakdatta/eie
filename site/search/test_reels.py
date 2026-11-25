"""The newsreel's feed and the words it captions, checked against the real data.

  python3 site/search/test_reels.py        (about ten seconds: it reads all 6,423 nuggets)

Each test is a promise the reel makes to a reader, and each would fail against a feed that did nothing.
"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(SITE, "reels"))
os.environ.setdefault("SITE", "/nonexistent")   # server.py's index isn't needed: only its tokenizer
import server  # noqa: E402
import reels  # noqa: E402
import build  # noqa: E402  (site/reels/build.py)

DATA = tempfile.mkdtemp(prefix="reels-test-")
R = reels.Reels(server.words, data=DATA)


def page(**p):
    return json.loads(R.page({k: str(v) for k, v in p.items()}))


class Feed(unittest.TestCase):
    def test_pages_follow_on_without_repeats_or_gaps(self):
        seen, at = [], 0
        for _ in range(6):
            d = page(at=at, n=8)
            seen += [x["id"] for x in d["items"]]
            at = d["next"]
        self.assertEqual(seen, R.reel[:48])
        self.assertEqual(len(set(seen)), 48)

    def test_a_shared_moment_opens_the_reel_at_itself(self):
        d = page(**{"from": "045-S01"})
        self.assertEqual(d["items"][0]["id"], "045-S01")
        self.assertEqual(d["at"], R.reel.index("045-S01"))
        self.assertNotIn("lead", d)

    def test_a_shared_moment_outside_a_filter_leads_and_the_filter_follows(self):
        d = page(**{"from": "045-S01", "kind": "J"})
        self.assertTrue(d["lead"])
        self.assertEqual(d["items"][0]["id"], "045-S01")
        self.assertTrue(all(x["k"] == "J" for x in d["items"][1:]))

    def test_an_episode_plays_in_the_order_it_was_said(self):
        d = page(ep=45, n=20)
        self.assertTrue(d["name"].startswith("No. 45: "))
        starts = [x["clip"][0] for x in d["items"]]
        self.assertTrue(all(x["ep"] == 45 for x in d["items"]))
        self.assertEqual(starts, sorted(starts))

    def test_filters_narrow_by_kind_and_voice(self):
        d = page(kind="S", who="ajay", n=20)
        self.assertGreater(d["total"], 100)
        self.assertTrue(all(x["k"] == "S" and x["spk"] == 1 for x in d["items"]))

    def test_a_big_idea_opens_with_its_own_quote(self):
        idea = next(iter(R.ideas.values()))
        d = page(idea=idea["id"], n=3)
        self.assertEqual(d["name"], idea["name"])
        self.assertEqual(d["items"][0]["id"], idea["ids"][0])

    def test_words_find_what_was_said_and_nonsense_finds_nothing(self):
        d = page(q="tiffin box", n=20)
        self.assertIn("088-J11", [x["id"] for x in d["items"]])
        self.assertEqual(page(q="zxqvwk")["total"], 0)

    def test_nonsense_parameters_give_the_newsreel_not_an_error(self):
        d = json.loads(R.page({"n": "abc", "at": "-4", "kind": "XYZ", "who": "bob", "from": "nope"}))
        self.assertEqual([x["id"] for x in d["items"]], R.reel[:8])

    def test_the_last_page_says_there_is_no_next(self):
        d = page(ep=45, at=60, n=20)
        self.assertIsNone(d["next"])


class Switch(unittest.TestCase):
    def test_a_file_turns_the_reel_off_at_once_and_back_on(self):
        self.assertTrue(R.on())
        open(os.path.join(DATA, "reels.off"), "w").close()
        try:
            self.assertFalse(R.on())
        finally:
            os.remove(os.path.join(DATA, "reels.off"))
        self.assertTrue(R.on())


class Limit(unittest.TestCase):
    def test_a_reader_is_held_after_ninety_in_five_minutes_and_others_are_not(self):
        r = reels.Reels.__new__(reels.Reels)
        import collections
        import threading
        r.lock, r.seen = threading.Lock(), collections.defaultdict(collections.deque)
        self.assertTrue(all(r.allow("1.2.3.4") for _ in range(90)))
        self.assertFalse(r.allow("1.2.3.4"))
        self.assertTrue(r.allow("5.6.7.8"))


class Nuggets(unittest.TestCase):
    """What the page relies on, for every one of the 6,423."""

    def test_every_nugget_can_be_played_and_read(self):
        bad = []
        for i, blob in R.blob.items():
            x = json.loads(blob)
            a, b = x["clip"]
            times = [t for t, _ in x["words"]]
            poster = os.path.join(SITE, "editions", f"{x['ep']:03d}", "media", x["poster"])
            if not (len(x["v"]) == 11 and 0 <= a < b and x["words"] and times == sorted(times)
                    and 0 <= times[0] and times[-1] <= b - a and os.path.exists(poster) and (x["head"] or x["k"] == "J")):
                bad.append(i)
        self.assertEqual(bad, [])


class Captions(unittest.TestCase):
    def test_fillers_and_false_starts_are_dropped(self):
        said = [(0, "So"), (10, "uh,"), (20, "the"), (30, "the"), (40, "y"), (50, "you"), (60, "know")]
        self.assertEqual([w for _, w in build.clean_said(said)], ["So", "the", "you", "know"])

    def test_the_quote_spells_what_the_transcript_misheard_at_the_transcripts_times(self):
        said = [(0, "take"), (20, "away"), (40, "his"), (60, "stiffenbox."), (120, "You"), (130, "know,")]
        out = build.align(said, "take away his tiffin box.")
        self.assertEqual([w for _, w in out], ["take", "away", "his", "tiffin", "box.", "You", "know,"])
        self.assertEqual(out[3][0], 60)
        self.assertTrue(60 < out[4][0] < 120)

    def test_names_are_put_right_only_when_sure_and_only_from_the_nuggets_own_text(self):
        # A wrong correction is worse than a mishearing: an earlier fixer, at 0.75 similarity, turned
        # "Indian history" into "India history" and "Germany" into "German" in about one rewrite in five.
        # It now corrects only close misses of names the insight itself spells, never another form of a
        # word (India/Indian, German/Germans), never a short name; "Chinme" (0.77) stays as heard.
        fixed = build.fix_names([(0, "The"), (10, "essay"), (20, "is"), (30, "Montaine."), (40, "like"), (50, "Bastia,")],
                                ["Montaigne: 'I have no more made my book'", "Frédéric Bastiat"])
        self.assertEqual([w for _, w in fixed], ["The", "essay", "is", "Montaigne.", "like", "Bastiat,"])
        kept = build.fix_names([(0, "Indian"), (10, "Germans"), (20, "Goha"), (30, "Chinme")], ["India", "German", "Guha", "Chinmay Tumbe"])
        self.assertEqual([w for _, w in kept], ["Indian", "Germans", "Goha", "Chinme"])
        self.assertEqual(build.fix_names([(0, "Montaine")], ["nothing like it"])[0][1], "Montaine")

    def test_a_laughs_line_is_its_setup_not_its_punchline(self):
        self.assertEqual(build.setup_of("Amit on hurt feelings: 'We are adults. It's not like…'"), "Amit on hurt feelings")
        self.assertEqual(build.setup_of("A quick one-two on policy. Amit: 'Never trust a joint secretary.'"), "A quick one-two on policy.")


if __name__ == "__main__":
    unittest.main()
