// Download every MosaikBLN stream's metadata + ORIGINAL-language caption to
// ./transcripts, the rate-limit-careful way. The caption (timedtext) endpoint
// is the throttled one, so we minimise hits to it:
//   - Phase A: fetch info.json only (metadata endpoint — not throttled) to learn
//     each video's original language. No caption requests here.
//   - Phase B: fetch exactly ONE caption per video (its original language),
//     grouped by language so yt-dlp can batch. Half the caption load of pulling
//     both en+de.
// yt-dlp (not raw fetch) does the network work: real client, your cookies,
// pacing, and exponential 429 backoff. Fully resumable — re-run to mop up.
//
//   npm run sermons:download          # all missing
//   npm run sermons:download -- 30    # cap this run to 30 missing videos
//
// Then `npm run sermons:ingest` to embed + load what landed.

import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listStreams } from "./youtube.ts";
import { connect, ingestedVideoIds } from "./db.ts";

const DIR = "./transcripts";
const SKIP = join(DIR, "_skip.txt"); // ids we've given up on (upcoming/private/removed)

function infoFile(id: string) { return join(DIR, `${id}.info.json`); }
function subFile(id: string, lang: string) { return join(DIR, `${id}.${lang}.json3`); }

// Load the skip-list (one video id per line). Delete _skip.txt to re-attempt them
// later (e.g. once an upcoming live event has actually aired).
async function loadSkip(): Promise<Set<string>> {
  try {
    return new Set((await readFile(SKIP, "utf8")).split(/\s+/).filter(Boolean));
  } catch {
    return new Set();
  }
}

// Read the bits of a downloaded info.json we care about: the original language,
// and whether the video has ANY caption track at all. `hasCaptions` lets us tell
// "no captions exist" (nothing to get, ever) apart from "throttled right now".
// Returns null if the info.json isn't on disk yet.
async function readInfo(id: string): Promise<{ language: string; hasCaptions: boolean } | null> {
  try {
    const j = JSON.parse(await readFile(infoFile(id), "utf8")) as {
      language?: string;
      automatic_captions?: Record<string, unknown>;
      subtitles?: Record<string, unknown>;
    };
    const auto = j.automatic_captions ? Object.keys(j.automatic_captions).length : 0;
    const manual = j.subtitles ? Object.keys(j.subtitles).length : 0;
    return { language: j.language || "en", hasCaptions: auto + manual > 0 };
  } catch {
    return null;
  }
}

// "Complete" = there is nothing left for us to download for this video. True if:
//   - it's already in the DB, OR
//   - we already have its original-language caption file on disk, OR
//   - its metadata says it has NO captions at all (un-gettable — skip forever).
// (If info.json isn't downloaded yet, it's NOT complete — Phase A will fetch it.)
async function isComplete(id: string, dbIds: Set<string>, skip: Set<string>): Promise<boolean> {
  if (dbIds.has(id)) return true;
  if (skip.has(id)) return true;      // we've permanently given up on this one
  const info = await readInfo(id);
  if (!info) return false;            // no metadata yet → still need to fetch it
  if (!info.hasCaptions) return true; // genuinely captionless → give up on it
  return existsSync(subFile(id, info.language)); // do we have the caption file?
}

function runYtDlp(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("python", ["-m", "yt_dlp", ...args], { stdio: "inherit" });
    p.on("close", (code) => resolve(code ?? 0));
  });
}

const auth = () => (existsSync("cookies.txt") ? ["--cookies", "cookies.txt"] : []);
const PACE = ["--retries", "12", "--retry-sleep", "exp=15:600", "--extractor-retries", "4"];

async function main() {
  const cap = Number(process.argv[2]);
  await mkdir(DIR, { recursive: true });

  console.log("Listing channel streams…");
  const streams = await listStreams();
  console.log(`Channel has ${streams.length} streams.`);

  const dbIds = await ingestedVideoIds(await connect());
  const skip = await loadSkip();
  const missing: string[] = [];
  for (const s of streams) if (!(await isComplete(s.id, dbIds, skip))) missing.push(s.id);

  const batch = Number.isFinite(cap) && cap > 0 ? missing.slice(0, cap) : missing;
  console.log(`${missing.length} missing; fetching ${batch.length} this run.`);
  if (batch.length === 0) { console.log("Nothing to download."); return; }

  // ---- Phase A: metadata for any batch id lacking info.json (no captions) ----
  const needInfo = batch.filter((id) => !existsSync(infoFile(id)));
  if (needInfo.length) {
    console.log(`Phase A: fetching metadata for ${needInfo.length} video(s)…`);
    const todo = join(DIR, "_todo_info.txt");
    await writeFile(todo, needInfo.map((id) => `https://www.youtube.com/watch?v=${id}`).join("\n"));
    await runYtDlp([
      "-i", "--no-warnings", "--skip-download", "--write-info-json", "--no-overwrites",
      ...auth(), "--sleep-requests", "1", ...PACE,
      "-o", join(DIR, "%(id)s.%(ext)s"), "--batch-file", todo,
    ]);

    // Metadata isn't rate-limited, so if info.json STILL didn't appear, the
    // video is genuinely unavailable (upcoming live event, private, removed).
    // Record it so future runs stop retrying it and the backfill can complete.
    const dead = needInfo.filter((id) => !existsSync(infoFile(id)));
    if (dead.length) {
      for (const id of dead) skip.add(id);
      await writeFile(SKIP, [...skip].join("\n"));
      console.log(`Skipping ${dead.length} unavailable video(s) (upcoming/private/removed).`);
    }
  }

  // ---- Phase B: one original-language caption per video, grouped by language --
  // A `Map` is like an object/dictionary: keys → values. Here: language → list
  // of video ids that still need that language's caption.
  const byLang = new Map<string, string[]>();
  for (const id of batch) {
    const info = await readInfo(id);
    if (!info || !info.hasCaptions) continue;          // no metadata / no captions
    if (existsSync(subFile(id, info.language))) continue; // already have it
    (byLang.get(info.language) ?? byLang.set(info.language, []).get(info.language)!).push(id);
  }

  for (const [lang, ids] of byLang) {
    console.log(`Phase B: fetching ${ids.length} ${lang} caption(s)…`);
    const todo = join(DIR, `_todo_sub_${lang}.txt`);
    await writeFile(todo, ids.map((id) => `https://www.youtube.com/watch?v=${id}`).join("\n"));
    await runYtDlp([
      "-i", "--no-warnings", "--skip-download", "--ignore-no-formats-error",
      "--write-auto-subs", "--sub-langs", lang, "--sub-format", "json3", "--no-overwrites",
      ...auth(), "--sleep-requests", "1", "--sleep-subtitles", "3", ...PACE,
      "-o", join(DIR, "%(id)s.%(ext)s"), "--batch-file", todo,
    ]);
  }

  // Re-tally after this run so the drainer can see how much (if anything) is left.
  let complete = 0;
  for (const s of streams) if (await isComplete(s.id, dbIds, skip)) complete++;
  const remaining = streams.length - complete;
  console.log(`\nComplete (DB / disk / no-captions): ${complete}/${streams.length}. Remaining to fetch: ${remaining}.`);
  console.log("Next: `npm run sermons:ingest` to embed + load what's downloaded.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
