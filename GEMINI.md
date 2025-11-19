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

And now armed with all the data, we want to do all kind of cool things like: 

- All the cool stories that Ajay and Amit has told. Many of them mind-blowing how they connect them back to important ideas. These stories also often display a very unseen side of popular and unpopular historical events, giving that event an unique, warm, aha perspective.
- All the recommendations that have been shared by Amit and Ajay. It's also very important to share the background of *why* they're recommending that. Very crisp and to the point. If possible, you should also look up the internet and provide a relevant hyperlink to it (say Goodreads for books).
- The core idea and mindsets, if anything. For example, "Adam Smith's idea of free markets", or the fact that "a French economist invented the noble idea of VAT" or the fact that "Stalin was a well read person who was comfortable to sit and have elaborate discussions with philosophers".
- All the good and terrible jokes cracked. And cultural references mentioned.

Now that we have all the data, I think we can do much better than the all-around AI summarization. The goal is not to hoard a lot of information. we all are in hurry and we should give the gentle reader crisp actionable points like the above. Also, make sure to use the best possible AI model in this knowledge inference part. The quality of this operation will directly influence whether the gentle reader will derive any value out of it or not. Please don't put additional insight points unless you're told to (like not mentioned in the bullet points above). Because we don't want to overwhelm a reader, instead just provide crisp, actionable insights.

All of these things should be preferably in a JSON file, so that it can be later used to visualize on an UI. Also, you should add the release date of the episode in the JSON file.
