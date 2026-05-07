# Gemini Instructions

These are instructions provided to the Gemini CLI for processing audio files from the Everything is Everything YouTube channel. It's a very informative podcast and our project is valuable knowledge extraction.

## Project Configuration

- **YouTube Channel:** `https://www.youtube.com/@amitvarma`
- **FluidAudio Directory:** `~/personal/FluidAudio`
- **yt-dlp Cookies:** `~/Downloads/cookies.txt`
- Frequency of episode drops: Every Friday

## Processing Workflow

- The diarized transcripts of all the episodes must be there in this repo. If not, you should double check and make sure to backfill them.
- The `yt-dlp` command is used to download the audio in `.wav` format.
- The `diarize-transcribe` command from FluidAudio is used to transcribe the audio files.

## File Management

- A `.gitignore` file is in place to prevent audio files (`.wav`, `.webm`, `.mp3`) and the `data/media` directory from being committed to the repository.
- The number of audio files on disk should be limited to a maximum of 20 to conserve disk space.
- All audio and transcript files should be named using `snake_case`. The format should be `[title_in_snake_case]_episode_[number]_[everything_is_everything]`.

# Audio Processing Commands

This document lists the foundational commands used for processing audio from the YouTube channel `https://www.youtube.com/@amitvarma`.

## Download Audio (using yt-dlp)

To download audio from the channel, specifying a range of videos and using a cookies file for authentication:

```bash
yt-dlp -x --audio-format wav -o "/path/to/your/data/directory/%(title)s.%(ext)s" --playlist-items <start>-<end> --cookies /path/to/your/cookies.txt "https://www.youtube.com/@amitvarma"
```

## Transcribe and Diarize (using FluidAudio)

To process an audio file for transcription and speaker diarization:

```bash
swift run diarize-transcribe "/path/to/your/audio/file.wav" --output "/path/to/your/transcripts/directory/file.json"
```

## Once transcribed and diarized files are ready

And now armed with all the data (both the transcript and the descriptions - make sure to keep this point in mind), we want to do all kind of cool things like: 

- All the cool stories that Ajay and Amit has told. Many of them mind-blowing how they connect them back to important ideas. These stories also often display a very unseen side of popular and unpopular historical events, giving that event an unique, warm, aha perspective.
- All the recommendations that have been shared by Amit and Ajay. It's also very important to share the background of *why* they're recommending that. Very crisp and to the point.
- The core idea and mindsets, if anything. For example, "Adam Smith's idea of free markets", or the fact that "a French economist invented the noble idea of VAT" or the fact that "Stalin was a well read person who was comfortable to sit and have elaborate discussions with philosophers".
- All the good and terrible jokes cracked. And cultural references mentioned. Please don't capture small kidding around, instead be mature enough to capture the real jokes and witty moments. We are dealing with quality here.

Now that we have all the data, I think we can do much better than the all-around AI summarization. The goal is not to hoard a lot of information. we all are in hurry and we should give the gentle reader crisp actionable points like the above. Also, make sure to use the best possible AI model in this knowledge inference part. The quality of this operation will directly influence whether the gentle reader will derive any value out of it or not. Please don't put additional insight points unless you're told to (like not mentioned in the bullet points above). Because we don't want to overwhelm a reader, instead just provide crisp, actionable insights.

All of these things should be preferably in a JSON file, so that it can be later used to visualize on an UI. Also, you should add the release date of the episode in the JSON file.

## Insight Extraction Strategy (the psychology of how you choose which insight would be valuable and which not)

**Target Reader:** A super curious mid-20s person whose goal is to learn and connect dots. They want intellectual nourishment and "aha" moments.

**The Key Test:** "Would a curious 20-something find this valuable for learning and connecting dots?"

### Stories
**What to capture:**
- Stories that teach something or reveal an interesting perspective
- Personal anecdotes if they connect to broader ideas
- "Share-worthy" moments - things you'd tell a friend over coffee
- Don't have to be mind-blowing, but should be warming and insightful

**Examples:** Billy Joel story (luck in success), snake encounter (instinct vs knowledge), USSR collapse (social conformity)

### Recommendations
**What to capture:**
- ALL explicit recommendations: books, essays, albums, films
- The "WHY" is crucial - helps reader decide if it's for them
- Make sure to include clearly who the recommender is. **Crucial:** Just the recommender's name (e.g., "Amit Varma", "Ajay Shah"). Do **NOT** add parenthetical context like "(referenced)" or "(guest)".
- I had initally asked your to look up book URLs, but actually ignore that. No need to bring in URLs by searching for them. If the podcast hosts have specified something interesting URL, then feel free to include that as you find interesting and insightful, but no need to look up book cover images and book URLs and all of that.

**Be generous:** If they mention a book with enthusiasm or context, it's likely a recommendation.

### Core Ideas
**What to capture:**
- Major intellectual concepts that help connect dots
- Frameworks for understanding the world (like "Four Quadrants of Conformism")
- Big ideas worth remembering and applying
- Not every point discussed, but substantial concepts

**Examples:** "Hardware vs Software," "Preference Falsification," "People as Brains Not Stomachs"

### Jokes & Cultural References
**What to capture:**
- Genuinely witty moments (not casual banter)
- Cultural touchpoints that add flavor and context
- Things that make you smile or think "nice reference"
- References to other thinkers, books, historical moments

**Balance:** Not too strict (missing good flavor) but not too loose (capturing filler).

### Overall Philosophy
**Think like a curator, not a transcriber.** Be generous but discerning. Each insight should pass the test: "Would this help someone learn something valuable or make an interesting connection?"

Not everything needs to be profound - warmth, humor, and relatability matter too. But avoid capturing noise just for completeness. And remember, you should prioritize quality over quantity. It doesn't matter whether you pick 2 insights or 20, they should be high quality.
