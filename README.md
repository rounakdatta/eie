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
