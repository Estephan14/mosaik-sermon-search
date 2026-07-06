// ============================================================================
// db.ts — where the vectors live (LanceDB)
// ----------------------------------------------------------------------------
// LanceDB is an "embedded vector database". Two terms:
//   - "database" = organised storage you can search.
//   - "embedded" = it runs *inside* our program, no separate server to start.
// Think "SQLite for vectors": it's literally just a folder on disk (./data).
// We put rows in (each row = some text + its embedding numbers), and later ask
// "which rows are closest to THIS vector?".
// ============================================================================

// `import * as lancedb` = bring in the whole LanceDB toolkit under the name
// `lancedb` so we can call lancedb.connect(), etc.
import * as lancedb from "@lancedb/lancedb";

export const DB_DIR = "./data";          // the folder the database lives in
export const TABLE_NAME = "docs";        // the little demo corpus table
export const SERMON_TABLE = "sermons";   // the real sermon-transcripts table

// An `interface` describes the SHAPE of an object — what fields it must have and
// each field's type. It's a blueprint, not data. (Like a class with no behaviour.)
// This is one row of the small demo table.
export interface Row {
  id: number;
  text: string;
  category: string;
  vector: number[]; // the embedding — a list of numbers
}

// One row of the sermons table = a single ~45s passage of one sermon, plus the
// metadata we want to show (preacher, language, date) and a link back to YouTube.
export interface SermonRow {
  video_id: string;
  sermon_title: string;
  preacher: string;
  language: string; // "en" | "de" | ...
  date: string;     // YYYY-MM-DD
  chunk_index: number;
  start: number;    // seconds into the video
  end: number;      // seconds
  url: string;      // youtube deep link to `start`
  text: string;
  vector: number[];
}

// Open (or create) the database folder and hand back a handle to it.
// Every other file calls this first.
export async function connect() {
  return lancedb.connect(DB_DIR);
}

// `Awaited<ReturnType<typeof connect>>` is a mouthful that just means
// "the thing connect() gives back" — i.e. a database handle. We pass it in so
// callers reuse one connection.
//
// Open the demo table, or throw a friendly error if it hasn't been built yet.
export async function openTable(db: Awaited<ReturnType<typeof connect>>) {
  const names = await db.tableNames();          // what tables exist?
  if (!names.includes(TABLE_NAME)) {
    throw new Error(
      `Table "${TABLE_NAME}" does not exist yet. Run \`npm run ingest\` first.`
    );
  }
  return db.openTable(TABLE_NAME);
}

// Same thing for the sermons table.
export async function openSermonTable(db: Awaited<ReturnType<typeof connect>>) {
  const names = await db.tableNames();
  if (!names.includes(SERMON_TABLE)) {
    throw new Error(
      `Table "${SERMON_TABLE}" does not exist yet. Run \`npm run sermons\` first.`
    );
  }
  return db.openTable(SERMON_TABLE);
}

// Return the set of video_ids we've ALREADY stored. This is what makes re-runs
// "idempotent" (a fancy word meaning: running it again changes nothing new —
// we skip videos we already have instead of duplicating them).
//
// A `Set` is a bag of unique values with a super-fast "is X in here?" check —
// perfect for "have we done this video already?".
export async function ingestedVideoIds(
  db: Awaited<ReturnType<typeof connect>>
): Promise<Set<string>> {
  const names = await db.tableNames();
  if (!names.includes(SERMON_TABLE)) return new Set(); // nothing stored yet
  const table = await db.openTable(SERMON_TABLE);
  // Ask the DB for just the video_id column of every row (not the big vectors).
  const rows = await table.query().select(["video_id"]).toArray();
  // Turn that list of rows into a Set of the id strings.
  return new Set(rows.map((r) => r.video_id as string));
}
