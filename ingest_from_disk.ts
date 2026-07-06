// ============================================================================
// ingest_from_disk.ts — load downloaded transcripts into the database
// ----------------------------------------------------------------------------
// "Ingest" = read raw material in, process it, store it ready to use. This is
// the second half of the backfill pipeline:
//
//   download_transcripts.ts   →   ./transcripts/*.json3 + *.info.json   (files)
//   ingest_from_disk.ts (HERE) →   chunk + embed + store in LanceDB
//
// It touches NO YouTube endpoints, so it can NEVER be rate-limited — safe to run
// over and over, even while a download is still going. It skips any video
// already in the DB, so re-running just picks up whatever newly landed.
//
//   npm run sermons:ingest
// ============================================================================

// Built-in file tools: readdir = list a folder, readFile = read a file.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
// Reuse the helpers from the other files — no need to rewrite them here.
import { linesFromJson3, parseTitle, type Json3 } from "./youtube.ts";
import { chunkLines } from "./chunk.ts";
import { embed } from "./embeddings.ts";
import { connect, ingestedVideoIds, SERMON_TABLE, type SermonRow } from "./db.ts";

const DIR = "./transcripts";

// The slice of an info.json file we care about.
interface Info {
  id: string;
  title: string;
  upload_date?: string;
  language?: string;
}

// "20260607" → "2026-06-07" (same as in youtube.ts; kept local for clarity).
function fmtDate(d?: string): string {
  return d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : "";
}

// Load this video's caption file. Prefer the original language; if that exact
// file isn't on disk, try en, then de, then any <id>.*.json3 we can find.
async function readCaption(files: Set<string>, id: string, lang?: string): Promise<Json3 | null> {
  // `[lang, "en", "de"].filter(Boolean)` = those three, minus any that are
  // empty/undefined (Boolean as a filter drops falsy values).
  const ordered = [lang, "en", "de"].filter(Boolean) as string[];
  const tried = new Set<string>();
  for (const l of ordered) {
    const name = `${id}.${l}.json3`;
    if (tried.has(name) || !files.has(name)) continue; // not on disk → next
    tried.add(name);
    return JSON.parse(await readFile(join(DIR, name), "utf8")) as Json3;
  }
  // Last resort: scan for ANY caption file belonging to this id.
  for (const name of files) {
    if (name.startsWith(id + ".") && name.endsWith(".json3")) {
      return JSON.parse(await readFile(join(DIR, name), "utf8")) as Json3;
    }
  }
  return null; // no caption file at all
}

// `main` = the entry point; everything runs from here.
async function main() {
  let all: string[];
  try {
    all = await readdir(DIR); // every filename in ./transcripts
  } catch {
    // The folder doesn't exist yet → tell the user what to run first, then stop.
    console.error(`No ./transcripts directory yet — run \`npm run sermons:download\` first.`);
    process.exit(1);
  }
  const files = new Set(all);                               // fast "exists?" lookups
  const infos = all.filter((f) => f.endsWith(".info.json")); // one per video
  console.log(`Found ${infos.length} downloaded video(s) on disk.`);

  const db = await connect();
  const done = await ingestedVideoIds(db); // video_ids already stored
  console.log(`Already in DB: ${done.size}. Ingesting the rest…\n`);

  // Counters so we can print a summary at the end.
  let okVideos = 0;
  let okChunks = 0;
  let skipped = 0;

  // Process each downloaded video one at a time.
  for (const file of infos) {
    const info = JSON.parse(await readFile(join(DIR, file), "utf8")) as Info;
    if (done.has(info.id)) { skipped++; continue; } // already stored → skip

    const cap = await readCaption(files, info.id, info.language);
    if (!cap) { console.log(`${info.id}  — no caption file, skipped`); continue; }

    // Captions → clean lines → ~45s chunks.
    const lines = linesFromJson3(cap);
    const chunks = chunkLines(lines);
    if (chunks.length === 0) { console.log(`${info.id}  — empty transcript, skipped`); continue; }

    const { sermonTitle, preacher } = parseTitle(info.title);
    const lang = info.language || "en";
    const date = fmtDate(info.upload_date);

    // Embed all of this video's chunks in ONE request (faster + cheaper than
    // one call per chunk). vectors[idx] lines up with chunks[idx].
    const vectors = await embed(chunks.map((c) => c.text));

    // Build one database row per chunk. `.map((c, idx) => ...)` gives us the
    // chunk `c` and its position `idx`.
    const rows: SermonRow[] = chunks.map((c, idx) => ({
      video_id: info.id,
      sermon_title: sermonTitle,
      preacher,
      language: lang,
      date,
      chunk_index: idx,
      start: c.start,
      end: c.end,
      // A YouTube link that jumps straight to this passage's start second.
      url: `https://www.youtube.com/watch?v=${info.id}&t=${c.start}s`,
      text: c.text,
      vector: vectors[idx],
    }));

    // First video ever? Create the table (its columns are inferred from these
    // rows). Otherwise just append to the existing table.
    const names = await db.tableNames();
    if (!names.includes(SERMON_TABLE)) {
      await db.createTable(SERMON_TABLE, rows);
    } else {
      const table = await db.openTable(SERMON_TABLE);
      await table.add(rows);
    }
    done.add(info.id); // remember within this run too

    okVideos++;
    okChunks += rows.length;
    console.log(`${info.id}  ✓ ${rows.length} chunks · ${preacher} · ${lang} · ${date} — ${sermonTitle}`);
  }

  console.log(`\nDone. Added ${okChunks} chunks from ${okVideos} new video(s) (skipped ${skipped} already in DB).`);
}

// Run main(); if it throws, print the error and exit with a failure code.
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
