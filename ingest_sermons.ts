// Pull sermon transcripts from the MosaikBLN channel, chunk them into
// timestamped passages, embed them, and load them into LanceDB.
//
//   npm run sermons            # pilot: ~20 newest streams not yet ingested
//   npm run sermons -- 50      # next 50 not yet ingested
//   npm run sermons -- all     # everything remaining
//
// Idempotent: videos already in the table are skipped, so re-running never
// duplicates and "pull the rest later" is just a bigger number (or `all`).

import { listStreams, fetchTranscript, type StreamRef } from "./youtube.ts";
import { chunkLines } from "./chunk.ts";
import { embed } from "./embeddings.ts";
import { connect, ingestedVideoIds, SERMON_TABLE, type SermonRow } from "./db.ts";

const DEFAULT_PILOT = 20;
const PER_VIDEO_DELAY_MS = 1200; // be polite to YouTube's caption endpoint

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How many *new* videos to ingest this run. `all` = no cap.
function parseLimit(arg?: string): number {
  if (!arg) return DEFAULT_PILOT;
  if (arg.toLowerCase() === "all") return Infinity;
  const n = Number(arg);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PILOT;
}

async function main() {
  const limit = parseLimit(process.argv[2]);
  const db = await connect();

  const done = await ingestedVideoIds(db);
  console.log(`Already ingested: ${done.size} videos.`);

  // Newest-first; drop anything we already have, then take up to `limit` new.
  const all = await listStreams();
  const todo = all.filter((s) => !done.has(s.id)).slice(0, limit === Infinity ? undefined : limit);

  if (todo.length === 0) {
    console.log("Nothing new to ingest. Done.");
    return;
  }
  console.log(`Ingesting ${todo.length} new video(s) of ${all.length} total streams.\n`);

  let okVideos = 0;
  let okChunks = 0;

  for (const [i, ref] of todo.entries()) {
    const tag = `[${i + 1}/${todo.length}] ${ref.id}`;
    if (i > 0) await sleep(PER_VIDEO_DELAY_MS);
    try {
      const t = await fetchTranscript(ref as StreamRef);
      if (!t) {
        console.log(`${tag}  — no captions, skipped (${ref.title})`);
        continue;
      }

      const chunks = chunkLines(t.lines);
      if (chunks.length === 0) {
        console.log(`${tag}  — empty transcript, skipped`);
        continue;
      }

      const vectors = await embed(chunks.map((c) => c.text));
      const rows: SermonRow[] = chunks.map((c, idx) => ({
        video_id: t.id,
        sermon_title: t.sermonTitle,
        preacher: t.preacher,
        language: t.language,
        date: t.date,
        chunk_index: idx,
        start: c.start,
        end: c.end,
        url: `https://www.youtube.com/watch?v=${t.id}&t=${c.start}s`,
        text: c.text,
        vector: vectors[idx],
      }));

      // Create the table on the first insert; append thereafter.
      const names = await db.tableNames();
      if (!names.includes(SERMON_TABLE)) {
        await db.createTable(SERMON_TABLE, rows);
      } else {
        const table = await db.openTable(SERMON_TABLE);
        await table.add(rows);
      }

      okVideos++;
      okChunks += rows.length;
      console.log(
        `${tag}  ✓ ${rows.length} chunks · ${t.preacher} · ${t.language} · ${t.date} — ${t.sermonTitle}`
      );
    } catch (err) {
      console.log(`${tag}  ! error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nDone. Added ${okChunks} chunks from ${okVideos} video(s).`);
  console.log("Run `npm run dev` (or restart it) and search at http://localhost:5173");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
