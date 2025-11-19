# Gemini Instructions

This file documents the instructions provided to the Gemini CLI for processing audio files from the Everything is Everything YouTube channel.

## Project Configuration

- **YouTube Channel:** `https://www.youtube.com/@amitvarma`
- **FluidAudio Directory:** `~/personal/FluidAudio`
- **yt-dlp Cookies:** `~/Downloads/cookies.txt`

## Processing Workflow

- The episodes should be processed in reverse chronological order, starting from episode 85.
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
