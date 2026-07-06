// ============================================================================
// youtube.ts — everything that talks to YouTube
// ----------------------------------------------------------------------------
// We don't scrape YouTube ourselves; we drive a battle-tested tool called
// `yt-dlp` (run as `python -m yt_dlp`). From it we get:
//   - the channel's list of streams (ids + titles)
//   - per video: its metadata (title, date, language) and a URL to the
//     auto-generated captions in "json3" format (clean text + timestamps).
//
// NOTE: this file does direct caption fetching (used by the original pilot).
// The big 443 backfill instead uses download_transcripts.ts, which lets yt-dlp
// download the caption files (gentler on YouTube's rate limits). Both reuse the
// small helpers here (parseTitle, linesFromJson3).
// ============================================================================

// `child_process` lets our program run another program (here, python/yt-dlp).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// execFile normally reports completion via a callback; promisify wraps it so we
// can use the nicer `await` style instead.
const execFileAsync = promisify(execFile);

const CHANNEL = "https://www.youtube.com/@MosaikBLN/streams";
// We call `python -m yt_dlp` rather than a `yt-dlp.exe` so it works wherever
// yt-dlp was pip-installed, without needing it on the system PATH.
const YT = { cmd: "python", base: ["-m", "yt_dlp", "--no-warnings"] };

// Run yt-dlp with the given arguments and parse its JSON output.
// `<T>` is a "generic": the caller says what shape the JSON will be, and this
// returns that type. (Like a function that's polymorphic over the result type.)
async function ytJson<T>(args: string[]): Promise<T> {
  // yt-dlp's JSON can be huge, so allow a big output buffer (64 MB).
  const { stdout } = await execFileAsync(YT.cmd, [...YT.base, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

// One entry in the channel's stream list.
export interface StreamRef {
  id: string;
  title: string;
}

// Get the channel's streams, newest first. `--flat-playlist` = "just ids and
// titles, don't open each video" → one fast request. `limit` caps the count.
export async function listStreams(limit?: number): Promise<StreamRef[]> {
  const args = ["--flat-playlist", "-J"]; // -J = "dump everything as one JSON"
  if (limit) args.push("--playlist-end", String(limit));
  args.push(CHANNEL);
  const data = await ytJson<{ entries: StreamRef[] }>(args);
  // `data.entries ?? []` = use entries, or an empty list if it's missing.
  return (data.entries ?? []).map((e) => ({ id: e.id, title: e.title }));
}

// Known name spellings that mean the same preacher.
const PREACHER_ALIASES: Record<string, string> = {
  "David Schnitter": "Dave Schnitter",
};

// Tidy a raw preacher name so the same person isn't split into many entries:
//   - drop a trailing "(...)" note, e.g. "Dave Schnitter (Audio Only!)" → "Dave Schnitter"
//   - apply known aliases, e.g. "David Schnitter" → "Dave Schnitter"
export function normalizePreacher(name: string): string {
  const stripped = name.trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
  return PREACHER_ALIASES[stripped] || stripped || "Unknown";
}

// The channel titles look like "Making room for a miracle | Dave Schnitter".
// Split on the LAST "|" so the preacher is whatever follows it. (lastIndexOf
// finds the final "|"; -1 means there wasn't one.)
export function parseTitle(title: string): { sermonTitle: string; preacher: string } {
  const i = title.lastIndexOf("|");
  if (i === -1) return { sermonTitle: title.trim(), preacher: "Unknown" };
  return {
    sermonTitle: title.slice(0, i).trim(),                 // text before the "|"
    preacher: normalizePreacher(title.slice(i + 1)) || "Unknown", // cleaned name after it
  };
}

// One spoken line of a transcript: when it was said, and what was said.
export interface TranscriptLine {
  start: number; // seconds
  text: string;
}

// The fully-assembled transcript for one video.
export interface VideoTranscript {
  id: string;
  sermonTitle: string;
  preacher: string;
  language: string;
  date: string; // YYYY-MM-DD
  lines: TranscriptLine[];
}

// --- shapes of the JSON yt-dlp gives us (only the bits we actually read) ---
interface CaptionFormat {
  ext: string; // "json3", "vtt", ...
  url: string;
}

interface InfoJson {
  id: string;
  title: string;
  upload_date?: string; // "YYYYMMDD"
  language?: string;
  // `Record<string, CaptionFormat[]>` = an object keyed by language code, each
  // pointing to a list of available caption formats. e.g. { en: [...], de: [...] }
  automatic_captions?: Record<string, CaptionFormat[]>;
  subtitles?: Record<string, CaptionFormat[]>;
}

// The caption file itself: a list of timed "events", each with text "segs".
export interface Json3 {
  events?: { tStartMs?: number; segs?: { utf8?: string }[] }[];
}

// Convert a parsed json3 caption track into clean TranscriptLines.
export function linesFromJson3(json: Json3): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const ev of json.events ?? []) {
    // Each event's words live in `segs`; stitch their text together and tidy
    // whitespace. Skip blank events (json3 has lots of empty padding ones).
    const text = (ev.segs ?? []).map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    // tStartMs is milliseconds; /1000 → seconds, rounded to a whole number.
    lines.push({ start: Math.round((ev.tStartMs ?? 0) / 1000), text });
  }
  return lines;
}

// "20260607" → "2026-06-07". Returns "" if the date looks wrong.
function formatDate(yyyymmdd?: string): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return "";
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// Decide which caption track to download. We prefer the video's ORIGINAL
// language (the real speech-to-text), then fall back to en/de, then anything.
// Manually-made subtitles beat auto ones when both exist.
// Returns null if there are no json3 captions at all.
function pickCaption(info: InfoJson): { lang: string; url: string } | null {
  const tracks = { ...(info.automatic_captions ?? {}) };
  const manual = info.subtitles ?? {};
  // The order we try languages in. `...Object.keys(x)` spreads all the keys
  // (language codes) of an object into this list.
  const candidates = [info.language, "en", "de", ...Object.keys(manual), ...Object.keys(tracks)];

  for (const lang of candidates) {
    if (!lang) continue;
    const fmts = manual[lang] ?? tracks[lang]; // manual first, else auto
    const json3 = fmts?.find((f) => f.ext === "json3"); // we want the json3 one
    if (json3) return { lang, url: json3.url };
  }
  return null;
}

// A tiny "wait" helper: returns a Promise that resolves after `ms` milliseconds.
// Used to pause between retries below.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// YouTube's caption endpoint ("timedtext") rate-limits hard and answers with a
// 429 ("Too Many Requests"). This retries a few times with growing waits
// (1.5s, 4s, 9s, 20s) so a brief throttle doesn't look like "no captions".
// If it still fails, it THROWS — so the caller leaves that video for next time
// instead of recording it as done.
async function fetchCaptionJson(url: string): Promise<Json3> {
  const delays = [1500, 4000, 9000, 20000];
  // An infinite loop we break out of by returning or throwing.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const text = await res.text();
      try {
        return JSON.parse(text) as Json3; // success
      } catch {
        // Sometimes a throttle sneaks back as a 200 with an HTML "Sorry" page,
        // which isn't valid JSON. Treat that like a retryable failure.
        if (attempt >= delays.length) throw new Error("caption body was not JSON (throttled?)");
      }
    } else if (res.status !== 429 && res.status < 500) {
      // A "real" client error (not 429, not a server 5xx) won't fix itself.
      throw new Error(`caption fetch failed: HTTP ${res.status}`);
    }
    // Out of retries?
    if (attempt >= delays.length) throw new Error(`caption fetch throttled (last HTTP ${res.status})`);
    await sleep(delays[attempt]); // wait, then loop to try again
  }
}

// Put it all together for ONE video: metadata + transcript lines.
// Returns null if the video simply has no captions.
// Throws on a rate-limit failure (so the caller can retry it later).
export async function fetchTranscript(ref: StreamRef): Promise<VideoTranscript | null> {
  // Ask yt-dlp for this single video's full info as JSON.
  const info = await ytJson<InfoJson>([
    "--skip-download", // we never want the video/audio, just the data
    "-J",
    `https://www.youtube.com/watch?v=${ref.id}`,
  ]);

  const cap = pickCaption(info);
  if (!cap) return null; // genuinely no captions

  const json = await fetchCaptionJson(cap.url); // download + parse the captions

  const lines = linesFromJson3(json);
  if (lines.length === 0) return null;

  const { sermonTitle, preacher } = parseTitle(info.title);
  return {
    id: info.id,
    sermonTitle,
    preacher,
    language: cap.lang,
    date: formatDate(info.upload_date),
    lines,
  };
}
