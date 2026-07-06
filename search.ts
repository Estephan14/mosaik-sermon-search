// ============================================================================
// search.ts — the actual "search by meaning"
// ----------------------------------------------------------------------------
// The whole point of the project lives here:
//   1. Turn the user's question into a vector (embedOne).
//   2. Ask LanceDB for the stored passages whose vectors are CLOSEST to it.
//   3. For each result, find the single SENTENCE that best matches the question
//      ("why it matched"), so the UI can highlight it.
//   4. Hand it all back, ranked best-first, with metadata.
// "Closest" = most similar in meaning. That's why typing "overcoming fear"
// finds a passage about anxiety even with no matching words.
// ============================================================================

import { embed, embedOne } from "./embeddings.ts";
import { connect, openSermonTable } from "./db.ts";

// The shape of one search result we send back to the web page.
export interface SermonHit {
  rank: number;        // 1 = best match, 2 = next, ...
  video_id: string;
  sermon_title: string;
  preacher: string;
  language: string;
  date: string;
  start: number;       // seconds into the video
  url: string;         // youtube deep link to `start`
  text: string;
  highlight: string;   // the one sentence in `text` that best matches the query
  distance: number;    // cosine distance: 0 = identical meaning, bigger = less alike
  similarity: number;  // 1 - distance, a friendlier 0..1 "how close" score
}

export interface SearchOptions {
  limit?: number;     // how many results to return
  language?: string;  // only search "en" or "de", if set
  preacher?: string;  // only this preacher, if set
}

// Escape single quotes so a value we drop into a SQL filter can't break it.
function sqlQuote(s: string): string {
  return s.replace(/'/g, "''");
}

// Break a passage into short overlapping phrases for highlighting. We'd love to
// split on sentences, but YouTube auto-captions have NO punctuation, so instead
// we slide a ~18-word window across the words (stepping 9 at a time, so windows
// overlap and a good phrase never falls between two of them). Each window is an
// exact substring of `text`, which lets the UI highlight it cleanly.
function splitPhrases(text: string, size = 18, stride = 9): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < words.length; i += stride) {
    out.push(words.slice(i, i + size).join(" "));
    if (i + size >= words.length) break; // last window reached the end
  }
  return out;
}

// Cosine similarity between two vectors = how aligned their directions are.
// 1 = same direction (same meaning), 0 = unrelated. (dot product / sizes.)
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export async function searchSermons(query: string, opts: SearchOptions = {}): Promise<SermonHit[]> {
  const { limit = 8, language, preacher } = opts;

  // STEP 1: the user's text → a vector, using the SAME model the passages used.
  const queryVector = await embedOne(query);

  // STEP 2: open the table and build the nearest-neighbour search.
  const db = await connect();
  const table = await openSermonTable(db);
  let q = table.search(queryVector).distanceType("cosine");

  // Optional filters narrow the DB BEFORE ranking (e.g. only German, only Dave).
  const filters: string[] = [];
  if (language) filters.push(`language = '${sqlQuote(language)}'`);
  if (preacher) filters.push(`preacher = '${sqlQuote(preacher)}'`);
  if (filters.length) q = q.where(filters.join(" AND "));

  const raw = await q.limit(limit).toArray();

  // Reshape each raw DB row into our tidy SermonHit (highlight filled in below).
  const hits: SermonHit[] = raw.map((r, i) => ({
    rank: i + 1,
    video_id: r.video_id,
    sermon_title: r.sermon_title,
    preacher: r.preacher,
    language: r.language,
    date: r.date,
    start: r.start,
    url: r.url,
    text: r.text,
    highlight: "",
    distance: r._distance,
    similarity: 1 - r._distance,
  }));

  // STEP 3: "why it matched". Embed every phrase-window of every result in ONE
  // batch, then for each result keep the window closest in meaning to the query.
  const perHit = hits.map((h) => splitPhrases(h.text));
  const flat: string[] = [];          // all sentences, flattened
  const owner: number[] = [];         // which hit each flat sentence belongs to
  perHit.forEach((sents, hi) => sents.forEach((s) => { flat.push(s); owner.push(hi); }));

  if (flat.length) {
    const vecs = await embed(flat);
    const best = hits.map(() => ({ score: -Infinity, text: "" }));
    vecs.forEach((v, k) => {
      const hi = owner[k];
      const score = cosine(queryVector, v);
      if (score > best[hi].score) best[hi] = { score, text: flat[k] };
    });
    hits.forEach((h, hi) => { h.highlight = best[hi].text; });
  }

  return hits;
}

// List every preacher with how many SERMONS (distinct videos) they have, most
// first. Powers the "filter by preacher" dropdown. We count distinct video_ids,
// NOT rows — each sermon is many chunk-rows, so counting rows would be wildly
// inflated (and confusing).
export async function listPreachers(): Promise<{ preacher: string; count: number }[]> {
  const db = await connect();
  const table = await openSermonTable(db);
  const rows = await table.query().select(["preacher", "video_id"]).toArray();
  // For each preacher, collect the unique set of video_ids they appear in.
  const vids = new Map<string, Set<string>>();
  for (const r of rows) {
    const p = r.preacher as string;
    if (!vids.has(p)) vids.set(p, new Set());
    vids.get(p)!.add(r.video_id as string);
  }
  // count = how many distinct sermons (videos), sorted most-first.
  return [...vids.entries()]
    .map(([preacher, set]) => ({ preacher, count: set.size }))
    .sort((a, b) => b.count - a.count);
}
