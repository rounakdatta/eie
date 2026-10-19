#!/usr/bin/env python3
"""Transcribe the episodes on CPU and label every word with who said it.

  python3 scripts/transcribe.py [N ...]   # all 128 by default; resumable, skips finished episodes
  python3 scripts/transcribe.py --relabel # redo only the speaker labels, from the cached voiceprints
  python3 scripts/transcribe.py --openings # restore greetings spoken over the intro music (see opening)

Audio comes from the show's podcast feed. Silero VAD cuts it at pauses into chunks of up to
30 s, NVIDIA Parakeet TDT 0.6B v3 (int8 ONNX, via onnx-asr; episodes 1-16 ran the 2x larger
fp32 build) transcribes them, and each word
is labelled Amit Varma, Ajay Shah or other by comparing WeSpeaker ResNet34 voiceprints
(via sherpa-onnx) with the two hosts' voices. The feed opens with a ~14 s notice the video
lacks ("You're listening to the audio version ..."), which is dropped, and its clock is offset
from the YouTube video's, so times are shifted to the video's: the offset comes from matching
the current transcript's word timings against the feed audio's loudness.

It shares a 10 GiB container with interactive work, so it stays small (int8 model, 16-bit
audio, 1 thread, run at nice 19) and exits with status 75 the moment the container's memory
nears its cap: an OOM there kills every process in it. Run it under scripts/gently.py, which
starts it again once memory recedes. `touch work/PAUSE` pauses between episodes; remove it to resume.

Needs `pip install onnx-asr onnxruntime sherpa-onnx numpy imageio-ffmpeg`. Models live in
work/models (see MODELS).
"""
import collections
import datetime
import difflib
import glob
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET

import imageio_ffmpeg
import numpy as np
import onnx_asr
import onnxruntime
import sherpa_onnx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRANSCRIPTS = os.path.join(ROOT, "data", "original", "transcripts")
METADATA = os.path.join(ROOT, "data", "original", "metadata")
WORK = os.path.join(ROOT, "work")
MODELS = os.path.join(WORK, "models")
FEED = "https://anchor.fm/s/f752ab78/podcast/rss"
ASR = "nvidia/parakeet-tdt-0.6b-v3 (int8 ONNX, onnx-asr)"
PARAKEET = "nvidia/parakeet-tdt-0.6b-v3"  # either build counts as transcribed
LABELS = "WeSpeaker ResNet34 voiceprints, adapted per episode, sticky decoding, third voice as other (sherpa-onnx)"
STICKY = "WeSpeaker ResNet34 voiceprints, adapted per episode, sticky decoding (sherpa-onnx)"  # before the third voice
SR, MAX_CHUNK = 16000, 30.0
# One thread: the VPS hypervisor throttles the whole VM (CPU steal 17% -> 50%) when this keeps two busy.
THREADS = int(os.environ.get("EIE_THREADS", 1))
MEMORY_LIMIT = int(os.environ.get("EIE_MEMORY_LIMIT", 6.5 * 2**30))  # container anon + shmem; the cap is 10 GiB
WIN, HOP = 1.5, 0.5  # voiceprint windows
STICK, SHARPNESS = 6.0, 20.0  # decoding: cost of a change of speaker (lower at a pause), 1 / temperature
OTHER_GAP = 0.22  # a stretch this far below the episode's typical host likeness is someone else, e.g. the crew
# Stretches of Episode 128 (video time) where only one host speaks, for the voiceprints.
VOICES = {"Amit Varma": [(20, 50), (150, 200), (220, 300)], "Ajay Shah": [(60, 95), (100, 140), (330, 400)]}


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(obj, path):
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(path + ".tmp", path)


def feed_audio(n):
    """Download episode n from the podcast feed and decode it to 16 kHz mono samples.

    A file in work/audio-override/NNN.* wins: the feed files Episode 7's audio under Episode 12.
    """
    override = glob.glob(os.path.join(WORK, "audio-override", f"{n:03d}.*"))
    if override:
        return decode(override[0])
    feed = os.path.join(WORK, "feed.xml")
    if not os.path.exists(feed):
        urllib.request.urlretrieve(FEED, feed)
    item = next(i for i in ET.parse(feed).getroot().iter("item") if i.findtext("title").startswith(f"Ep {n}:"))
    mp3 = os.path.join(WORK, f"audio-{n:03d}.mp3")
    urllib.request.urlretrieve(item.find("enclosure").get("url"), mp3)
    audio = decode(mp3)
    os.remove(mp3)
    return audio


def decode(path):
    """16 kHz mono samples as int16; pcm() converts the stretch in hand to float."""
    raw = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-loglevel", "error", "-i", path,
                          "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16)


def pcm(audio, a, b):
    """Seconds a to b of the audio as float32 in [-1, 1]."""
    return audio[max(0, int(a * SR)):max(0, int(b * SR))].astype(np.float32) / 32768


def container_memory():
    with open("/sys/fs/cgroup/memory.stat") as f:
        stat = dict(line.split() for line in f)
    return int(stat["anon"]) + int(stat["shmem"])


def guard_memory():
    """Exit with 75 as soon as the container's memory nears its cap, freeing ours before an OOM kills all."""
    def watch():
        while True:
            used = container_memory()
            if used > MEMORY_LIMIT:
                print(json.dumps({"yield": "memory", "container_gib": round(used / 2**30, 2)}), flush=True)
                os._exit(75)
            time.sleep(0.5)
    threading.Thread(target=watch, daemon=True).start()


def video_offset(audio, words):
    """Seconds by which the feed audio runs ahead of the video, and how many 5-minute windows agree."""
    frames = len(audio) // 1600
    loud = np.empty(frames, dtype=np.float32)
    for i in range(0, frames, 6000):  # ten minutes at a time
        block = audio[i * 1600:min(frames, i + 6000) * 1600].reshape(-1, 1600).astype(np.float32) / 32768
        loud[i:i + len(block)] = np.sqrt((block ** 2).mean(1))
    speech = (loud > np.percentile(loud, 30)).astype(float)
    mask = np.zeros(int(words[-1]["endTime"] * 10) + 2)
    for w in words:
        mask[int(w["startTime"] * 10):int(w["endTime"] * 10) + 1] = 1
    offsets = []
    for lo in range(0, len(mask) - 3000, 3000):
        m = mask[lo:lo + 3000] - mask[lo:lo + 3000].mean()
        scores = {off: float(np.dot(m, speech[lo + off:lo + off + 3000] - speech[lo + off:lo + off + 3000].mean()))
                  for off in range(-1200, 1201) if 0 <= lo + off and lo + off + 3000 <= len(speech)}
        offsets.append(max(scores, key=scores.get) / 10)
    median = float(np.median(offsets))
    return median, sum(abs(o - median) <= 0.3 for o in offsets) / len(offsets)


def speech_chunks(vad, audio):
    """Silero speech segments merged into chunks of at most MAX_CHUNK seconds, cut only at pauses."""
    vad.reset()
    segments = []
    for i in range(0, len(audio), 512 * 600):
        block = audio[i:i + 512 * 600].astype(np.float32) / 32768
        for j in range(0, len(block), 512):
            vad.accept_waveform(block[j:j + 512])
            while not vad.empty():
                segments.append((vad.front.start / SR, (vad.front.start + len(vad.front.samples)) / SR))
                vad.pop()
    vad.flush()
    while not vad.empty():
        segments.append((vad.front.start / SR, (vad.front.start + len(vad.front.samples)) / SR))
        vad.pop()
    chunks = []
    for a, b in segments:
        if chunks and b - chunks[-1][0] <= MAX_CHUNK:
            chunks[-1][1] = b
        else:
            chunks.append([a, b])
    return chunks


def transcribe(asr, audio, chunks):
    """Words with start, end and confidence, on the feed's clock."""
    words = []
    for a, b in chunks:
        start = max(0.0, a - 0.15)
        r = asr.recognize(pcm(audio, start, b + 0.15), sample_rate=SR)
        chunk = []
        for token, t, logprob in zip(r.tokens, r.timestamps, r.logprobs):
            if not chunk or token.startswith(" "):  # a leading space starts a word; pieces and punctuation join it
                chunk.append({"text": "", "start": start + t, "logprobs": []})
            chunk[-1]["text"] += token
            chunk[-1]["logprobs"].append(logprob)
        for i, w in enumerate(chunk):
            nxt = chunk[i + 1]["start"] if i + 1 < len(chunk) else min(w["start"] + 0.5, b + 0.15)
            words.append({"word": w["text"].strip(), "startTime": round(w["start"], 2),
                          "endTime": round(max(w["start"] + 0.08, min(nxt, w["start"] + 1.5)), 2),
                          "confidence": round(float(np.exp(np.mean(w["logprobs"]))), 4)})
    return [w for w in words if w["word"]]


def preroll_end(words):
    """The feed opens with a notice the video lacks ("You're listening to the audio version ...
    subscribe to us on YouTube also"); return the feed time where it ends, or 0 if absent."""
    plain = [re.sub(r"[^a-z]", "", w["word"].lower()) for w in words if w["startTime"] < 40]
    for i in range(len(plain) - 4):
        if plain[i:i + 5] == ["subscribe", "to", "us", "on", "youtube"]:
            k = i + 5 if i + 5 < len(plain) and plain[i + 5] == "also" else i + 4
            return words[k]["endTime"]
    return 0.0


def label(extractor, voices, audio, words, cache):
    """Amit Varma, Ajay Shah or other for every word, from 1.5 s voiceprint windows over the speech.

    Each episode's own two voices are found by k-means seeded with the reference voiceprints,
    because recording setups changed over the show's run; the seed keeps the names attached.
    """
    names, refs = list(voices), np.array(list(voices.values()))
    regions = []
    for w in words:
        if regions and w["startTime"] - regions[-1][1] < 0.3:
            regions[-1][1] = max(regions[-1][1], w["endTime"])
        else:
            regions.append([w["startTime"], w["endTime"]])
    windows = []
    for a, b in regions:
        if b - a <= WIN:
            windows.append(((a + b - WIN) / 2, (a + b + WIN) / 2))
            continue
        t = a
        while t + WIN < b:
            windows.append((t, t + WIN))
            t += HOP
        windows.append((b - WIN, b))
    windows = np.round(np.array(windows, dtype=np.float32), 2)
    try:  # the cached windows were cut from this episode's speech, maybe from a few more words: use them as they are
        saved = np.load(cache)
        cached = saved["windows"].astype(np.float32)
        assert cached[:, 0].min() <= words[0]["startTime"] + 2 and cached[:, 1].max() >= words[-1]["endTime"] - 2
        windows, embeddings = cached, saved["embeddings"].astype(np.float32)
    except Exception:  # missing, or cut short by a memory exit
        assert audio is not None, "no cached embeddings, and no audio to compute them"
        embeddings = np.array([embed(extractor, audio, a, b) for a, b in windows])
        np.savez_compressed(cache + ".tmp.npz", windows=windows, embeddings=embeddings.astype(np.float16))
        os.replace(cache + ".tmp.npz", cache)
    centroids = refs
    for _ in range(5):
        nearest = (embeddings @ centroids.T).argmax(1)
        centroids = np.array([embeddings[nearest == k].mean(0) if (nearest == k).sum() >= 20 else refs[k]
                              for k in range(len(names))])
        centroids /= np.linalg.norm(centroids, axis=1, keepdims=True)
    sims = embeddings @ centroids.T
    pauses = np.r_[False, windows[1:, 0] > windows[:-1, 1]]
    path = decode_speakers(sims, pauses, float(np.median(sims.max(1))) - OTHER_GAP)
    centers = windows.mean(axis=1)
    states = names + ["other"]
    labels, best = [], []
    for w in words:
        i = int(np.argmin(np.abs(centers - (w["startTime"] + w["endTime"]) / 2)))
        labels.append(states[path[i]])
        best.append(float(sims[i].max()))
    # How close each episode voice stays to its reference: a swap would show as own < other.
    drift = {name: round(float(centroids[k] @ refs[k]), 3) for k, name in enumerate(names)}
    swapped = any(centroids[k] @ refs[k] < centroids[k] @ refs[1 - k] for k in range(len(names)))
    return labels, float(np.mean(best)), drift, swapped


def decode_speakers(sims, pauses, other):
    """Most likely speaker per window (Viterbi) among the two hosts and "someone else", who scores a
    flat `other` likeness. A change of speaker costs STICK, a third of that at a pause, so a few
    seconds of contrary evidence are needed to switch and one odd window can't flip a sentence."""
    ll = np.c_[sims, np.full(len(sims), other)] * SHARPNESS
    ll = ll - np.logaddexp.reduce(ll, axis=1, keepdims=True)
    states = ll.shape[1]
    change = 1 - np.eye(states)
    score, back = ll[0].copy(), np.zeros(ll.shape, dtype=np.int8)
    for i in range(1, len(ll)):
        candidates = score[None, :] - STICK * (0.3 if pauses[i] else 1.0) * change  # [to, from]
        back[i] = candidates.argmax(1)
        score = candidates.max(1) + ll[i]
    path = np.zeros(len(ll), dtype=np.int8)
    path[-1] = score.argmax()
    for i in range(len(ll) - 1, 0, -1):
        path[i - 1] = back[i][path[i]]
    return path


def embed(extractor, audio, a, b):
    stream = extractor.create_stream()
    stream.accept_waveform(SR, pcm(audio, a, b))
    stream.input_finished()
    e = np.array(extractor.compute(stream))
    return e / np.linalg.norm(e)


def similarity(old_words, new_words, duration, old_joiner):
    """Mean word-level similarity of old and new text over 20 one-minute samples."""
    norm = lambda ws, joiner: re.sub(r"[^a-z0-9' ]+", " ", joiner.join(w["word"] for w in ws).lower()).split()
    ratios = []
    for t in np.linspace(60, max(61, duration - 120), 20):
        o = norm([w for w in old_words if t <= w["startTime"] < t + 60], old_joiner)
        n = norm([w for w in new_words if t <= w["startTime"] < t + 60], " ")
        if o and n:
            ratios.append(difflib.SequenceMatcher(None, o, n, autojunk=False).ratio())
    return round(float(np.mean(ratios)), 3)


def agreement(old, new_words, labels):
    """Share of the old transcript's words whose diarizer label maps to the new speaker."""
    starts = np.array([w["startTime"] for w in new_words])
    pairs = []
    for seg in old["segments"]:
        for w in seg.get("words", []):
            i = int(np.clip(np.searchsorted(starts, (w["startTime"] + w["endTime"]) / 2) - 1, 0, len(starts) - 1))
            pairs.append((seg["speaker"], labels[i]))
    counts = collections.Counter(pairs)
    olds = {o for o, _ in pairs}
    if len(olds) < 2:
        return None
    best = {o: max((n for p, n in counts if p == o), key=lambda n: counts[(o, n)]) for o in olds}
    return round(sum(c for (o, n), c in counts.items() if best[o] == n) / len(pairs), 4)


def fluidaudio(n, current):
    """The Mac's FluidAudio transcript of episode n, kept in work/fluidaudio for alignment and comparison."""
    path = os.path.join(WORK, "fluidaudio", f"{n:03d}.json")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        assert "asr" not in current["metadata"], f"no FluidAudio copy of episode {n}"
        write_json(current, path)
    return load_json(path)


def segments_of(words, labels):
    segments = []
    for w, spk in zip(words, labels):
        if not segments or segments[-1]["speaker"] != spk:
            segments.append({"speaker": spk, "words": []})
        segments[-1]["words"].append(w)
    return [{"speaker": s["speaker"], "startTime": s["words"][0]["startTime"], "endTime": s["words"][-1]["endTime"],
             "text": " ".join(w["word"] for w in s["words"]), "words": s["words"]} for s in segments]


def opening(asr, audio, words, old_words, offset):
    """Words spoken over the intro music, before the first word VAD found: Silero doesn't hear
    speech under music, so a greeting can go missing ("Welcome, gentle reader, to this episode of").
    Whatever FluidAudio heard in the 10 s before the first word, after its last pause, is transcribed
    again and kept if it reads the same. Words on the feed clock in and out; old_words on the video's."""
    first = words[0]["startTime"] - offset
    heard = [w for w in old_words if first - 10 <= w["startTime"] < first - 0.3]
    for i in range(len(heard) - 1, 0, -1):
        if heard[i]["startTime"] - heard[i - 1]["endTime"] >= 1.0:
            heard = heard[i:]
            break
    plain = lambda text: re.sub(r"[^a-z ]+", "", text.lower()).split()
    said = plain("".join(w["word"] for w in heard))  # FluidAudio's pieces carry their own spaces
    if len(said) < 2:
        return []
    found = [dict(w, endTime=min(w["endTime"], words[0]["startTime"]))
             for w in transcribe(asr, audio, [(heard[0]["startTime"] - 0.3 + offset, words[0]["startTime"])])
             if w["startTime"] < words[0]["startTime"] - 0.05]
    if difflib.SequenceMatcher(None, said, plain(" ".join(w["word"] for w in found)), autojunk=False).ratio() < 0.6:
        return []
    return found


def load_asr():
    so = onnxruntime.SessionOptions()
    so.intra_op_num_threads, so.inter_op_num_threads = THREADS, 1
    return onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", path=os.path.join(MODELS, "parakeet-v3-int8"),
                               quantization="int8", sess_options=so).with_timestamps()


def openings(episodes):
    """Restore the openings of finished transcripts (see opening). The restored words go to the host
    FluidAudio heard there: the first word's speaker if FluidAudio has one voice across both, else the other."""
    asr = None
    for n in episodes:
        path = os.path.join(TRANSCRIPTS, f"{n:03d}.json")
        current = load_json(path)
        if not current["metadata"].get("speakerLabels", "").startswith(LABELS):
            continue
        words = [w for s in current["segments"] for w in s["words"]]
        labels = [s["speaker"] for s in current["segments"] for _ in s["words"]]
        old = fluidaudio(n, current)
        old_words = [w for s in old["segments"] for w in s.get("words", [])]
        offset = current["metadata"]["feedOffsetSeconds"]
        first = words[0]["startTime"]
        if len([w for w in old_words if first - 10 <= w["startTime"] < first - 0.3]) < 3:
            continue  # FluidAudio heard nothing before the first word either
        asr = asr or load_asr()
        feed = [dict(words[0], startTime=first + offset, endTime=words[0]["endTime"] + offset)]
        found = [dict(w, startTime=round(w["startTime"] - offset, 2), endTime=round(w["endTime"] - offset, 2))
                 for w in opening(asr, feed_audio(n), feed, old_words, offset)]
        qc = {"episode": n, "restored": " ".join(w["word"] for w in found)}
        if found:
            voice = lambda t: next((s["speaker"] for s in old["segments"] if s["startTime"] <= t <= s["endTime"]), None)
            hosts = [h for h in VOICES if h != labels[0]]
            here, there = voice(found[0]["startTime"]), voice(first)
            same = here is None or there is None or here == there or labels[0] not in VOICES
            qc["speaker"] = labels[0] if same else hosts[0]
            current["segments"] = segments_of(found + words, [qc["speaker"]] * len(found) + labels)
            write_json(current, path)
        with open(os.path.join(WORK, "openings-qc.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(qc, ensure_ascii=False) + "\n")
        print(json.dumps(qc, ensure_ascii=False), flush=True)


def relabel(episodes):
    """New speaker labels for finished transcripts, from the cached voiceprints: no audio needed.

    Labels from the sticky decoder keep their host decisions (adjudicated ones included) and only gain
    the third voice. Insights extracted from labels that barely changed (under 3% of words) are kept
    and marked current; the rest are left for extract.py to redo.
    """
    voices = load_json(os.path.join(WORK, "voices.json"))
    for n in episodes:
        path = os.path.join(TRANSCRIPTS, f"{n:03d}.json")
        current = load_json(path)
        meta = current["metadata"]
        if not meta.get("asr", "").startswith(PARAKEET) or meta.get("speakerLabels", "").startswith(LABELS):
            continue
        if not os.path.exists(os.path.join(WORK, "embeddings", f"{n:03d}.npz")):
            print(json.dumps({"episode": n, "skipped": "no cached voiceprints; the main run relabels it from audio"}))
            continue
        offset = meta["feedOffsetSeconds"]
        words = [w for seg in current["segments"] for w in seg["words"]]
        before = [seg["speaker"] for seg in current["segments"] for _ in seg["words"]]
        feed = [dict(w, startTime=w["startTime"] + offset, endTime=w["endTime"] + offset) for w in words]
        fresh, voice_match, drift, swapped = label(None, voices, None, feed,
                                                   os.path.join(WORK, "embeddings", f"{n:03d}.npz"))
        old_labels = meta["speakerLabels"]
        if old_labels.startswith(STICKY):  # keep the hosts as decided, adjudication included; add the third voice
            labels = ["other" if b == "other" else a for a, b in zip(before, fresh)]
            new_labels = LABELS + old_labels[len(STICKY):]
        else:
            labels, new_labels = fresh, LABELS
        changed = sum(a != b for a, b in zip(before, labels)) / len(words)
        segments = segments_of(words, labels)
        write_json({"metadata": {**meta, "speakerLabels": new_labels,
                                 "speakers": sorted({s["speaker"] for s in segments})}, "segments": segments}, path)
        insights_path = os.path.join(ROOT, "data", "generated", "insights", f"{n:03d}.json")
        insights = load_json(insights_path)
        keep = (insights.get("source", {}).get("speakers") == old_labels and changed < 0.03
                and (old_labels.startswith(STICKY) or not old_labels.endswith("settled by Claude")))
        if keep:
            insights["source"]["speakers"] = new_labels
            write_json(insights, insights_path)
        qc = {"episode": n, "relabelled": True, "words_changed": round(changed, 4),
              "turns_before": 1 + sum(a != b for a, b in zip(before, before[1:])), "turns_after": len(segments),
              "voice_match": round(voice_match, 3), "voice_drift": drift, "voices_swapped": swapped,
              "old_label_agreement": agreement(load_json(os.path.join(WORK, "fluidaudio", f"{n:03d}.json")), words, labels),
              "insights": "kept" if keep else "to redo"}
        with open(os.path.join(WORK, "relabel-qc.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(qc) + "\n")
        print(json.dumps(qc), flush=True)


def main(episodes):
    guard_memory()
    so = onnxruntime.SessionOptions()
    so.intra_op_num_threads, so.inter_op_num_threads = THREADS, 1
    asr = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", path=os.path.join(MODELS, "parakeet-v3-int8"),
                              quantization="int8", sess_options=so).with_timestamps()
    vad_config = sherpa_onnx.VadModelConfig()
    vad_config.silero_vad.model = os.path.join(MODELS, "silero_vad.onnx")
    vad_config.silero_vad.threshold, vad_config.silero_vad.min_silence_duration = 0.5, 0.3
    vad_config.silero_vad.min_speech_duration, vad_config.silero_vad.max_speech_duration = 0.25, MAX_CHUNK
    vad_config.sample_rate = SR
    vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=120)
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=os.path.join(MODELS, "wespeaker_en_voxceleb_resnet34_LM.onnx"), num_threads=THREADS))

    voices_path = os.path.join(WORK, "voices.json")
    if not os.path.exists(voices_path):
        audio = feed_audio(128)
        offset, _ = video_offset(audio, [w for s in load_json(os.path.join(TRANSCRIPTS, "128.json"))["segments"]
                                         for w in s["words"]])
        voices = {}
        for name, spans in VOICES.items():
            m = np.mean([embed(extractor, audio, a + offset, b + offset) for a, b in spans], axis=0)
            voices[name] = (m / np.linalg.norm(m)).tolist()
        write_json(voices, voices_path)
    voices = load_json(voices_path)

    os.makedirs(os.path.join(WORK, "embeddings"), exist_ok=True)
    for n in episodes:
        path = os.path.join(TRANSCRIPTS, f"{n:03d}.json")
        current = load_json(path)
        transcribed = current["metadata"].get("asr", "").startswith(PARAKEET)
        if transcribed and current["metadata"].get("speakerLabels", "").startswith(LABELS):  # incl. adjudicated
            continue
        while os.path.exists(os.path.join(WORK, "PAUSE")):
            time.sleep(60)
        began = time.time()
        old = fluidaudio(n, current)
        old_words = [w for s in old["segments"] for w in s.get("words", [])]
        duration = load_json(os.path.join(METADATA, f"{n:03d}.json"))["duration_seconds"]
        audio = feed_audio(n)
        offset, agree = video_offset(audio, old_words)
        if transcribed:  # only the speaker labels are redone
            notice = None
            words = [dict(w, startTime=round(w["startTime"] + current["metadata"]["feedOffsetSeconds"], 2),
                          endTime=round(w["endTime"] + current["metadata"]["feedOffsetSeconds"], 2))
                     for seg in current["segments"] for w in seg["words"]]
            offset = current["metadata"]["feedOffsetSeconds"]
        else:
            words = transcribe(asr, audio, speech_chunks(vad, audio))
            notice = preroll_end(words)
            words = [w for w in words if w["startTime"] >= notice]
        labels, voice_match, drift, swapped = label(extractor, voices, audio, words,
                                                    os.path.join(WORK, "embeddings", f"{n:03d}.npz"))
        kept = [(dict(w, startTime=round(w["startTime"] - offset, 2), endTime=round(w["endTime"] - offset, 2)), s)
                for w, s in zip(words, labels) if 0 <= w["startTime"] - offset <= duration + 1]  # drop feed preroll/outro
        words, labels = [w for w, _ in kept], [s for _, s in kept]
        segments = segments_of(words, labels)
        talk = {}
        for s in segments:
            talk[s["speaker"]] = talk.get(s["speaker"], 0) + s["endTime"] - s["startTime"]
        qc = {"episode": n, "minutes": round(duration / 60, 1), "words": len(words), "turns": len(segments),
              "offset": offset, "offset_agreement": round(agree, 2), "voice_match": round(voice_match, 3),
              "voice_drift": drift, "voices_swapped": swapped,
              "notice_dropped": None if notice is None else notice > 0,
              "first_word": words[0]["startTime"], "old_first_word": old_words[0]["startTime"],
              "talk_share": {k: round(v / sum(talk.values()), 3) for k, v in sorted(talk.items())},
              # FluidAudio's "words" are sub-word tokens that carry their own spaces
              "old_text_similarity": similarity(old_words, words, duration, ""),
              "old_label_agreement": agreement(old, words, labels),
              "processing_minutes": round((time.time() - began) / 60, 1)}
        write_json({"metadata": {"source": "YouTube audio" if glob.glob(os.path.join(WORK, "audio-override", f"{n:03d}.*"))
                                 else "podcast feed audio, re-timed to the YouTube video",
                                 "feedOffsetSeconds": offset, "durationSeconds": duration,
                                 "asr": current["metadata"]["asr"] if transcribed else ASR,
                                 "vad": "silero-vad", "speakerLabels": LABELS,
                                 "speakers": sorted(talk), "created": datetime.date.today().isoformat()},
                    "segments": segments}, path)
        with open(os.path.join(WORK, "transcribe-qc.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(qc) + "\n")
        print(json.dumps(qc), flush=True)


if __name__ == "__main__":
    numbers = [int(a) for a in sys.argv[1:] if not a.startswith("--")] or range(1, 129)
    relabel(numbers) if "--relabel" in sys.argv else openings(numbers) if "--openings" in sys.argv else main(numbers)
