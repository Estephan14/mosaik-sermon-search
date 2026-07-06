// ============================================================================
//  /api/search — the sermon search, serverless edition.
// ----------------------------------------------------------------------------
//  The original app searches a 230 MB LanceDB store on disk. This variant
//  serves the SAME corpus from a ~50 MB baked-in index: vectors truncated to
//  768 Matryoshka dimensions, L2-renormalized, int8-quantized (export_index.mjs
//  in the repo root builds it). 31k vectors × 768 dims brute-forced in memory
//  is a few tens of milliseconds — no database, no filesystem beyond the
//  bundle, fits a Vercel function.
//
//  Response shape is identical to the original server.ts, so the same
//  index.html works against either.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIMS = 768;
const MODEL = "text-embedding-3-small";

// Loaded ONCE per warm instance, straight out of the function bundle.
// (Careful with Buffer views: respect byteOffset or the data reads garbage.)
const DIR = join(process.cwd(), "index-data");
const vbuf = readFileSync(join(DIR, "vectors.bin"));
const sbuf = readFileSync(join(DIR, "scales.bin"));
const vecs = new Int8Array(vbuf.buffer, vbuf.byteOffset, vbuf.length);
const scales = new Float32Array(sbuf.buffer, sbuf.byteOffset, sbuf.length / 4);
const meta = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf8"));

// Light per-IP throttle so strangers can't spend the OpenAI key.
const ipHits = new Map();
function throttled(ip) {
  const now = Date.now();
  const rec = ipHits.get(ip);
  if (!rec || now - rec.start > 60000) {
    ipHits.set(ip, { start: now, n: 1 });
    if (ipHits.size > 5000) ipHits.clear();
    return false;
  }
  rec.n += 1;
  return rec.n > 10; // ten searches a minute is plenty for a human.
}

async function embed(inputs) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, input: inputs, dimensions: DIMS }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

// Overlapping ~18-word windows for "why it matched" highlighting — identical
// to the original search.ts (auto-captions have no punctuation to split on).
function splitPhrases(text, size = 18, stride = 9) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= size) return [text];
  const out = [];
  for (let i = 0; i < words.length; i += stride) {
    out.push(words.slice(i, i + size).join(" "));
    if (i + size >= words.length) break;
  }
  return out;
}

function cosineFloat(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  if (throttled(ip)) return res.status(429).json({ error: "Easy — a few seconds between searches." });

  try {
    const { query, limit, language, preacher } = req.body || {};
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Provide a non-empty 'query' string." });
    }
    const k = Math.min(Math.max(Number(limit) || 8, 1), 20);

    // 1. Query → vector (same model family the corpus was embedded with).
    const [q] = await embed([query.slice(0, 500)]);

    // 2. Brute-force cosine over the whole corpus (doc vectors are unit length,
    //    so the un-quantized dot product IS the cosine similarity). We keep a
    //    generous shortlist, then dedupe: the store has some double-ingested
    //    rows, and neighbouring chunks of one sermon can crowd out variety —
    //    so at most two moments per video make the final list.
    const SHORTLIST = k * 6;
    const top = []; // small sorted list of {score, i}
    for (let i = 0; i < meta.length; i++) {
      const m = meta[i];
      if (language && m.language !== language) continue;
      if (preacher && m.preacher !== preacher) continue;
      let dot = 0;
      const off = i * DIMS;
      for (let d = 0; d < DIMS; d++) dot += q[d] * vecs[off + d];
      const score = dot * scales[i];
      if (top.length < SHORTLIST) {
        top.push({ score, i });
        top.sort((a, b) => b.score - a.score);
      } else if (score > top[SHORTLIST - 1].score) {
        top[SHORTLIST - 1] = { score, i };
        top.sort((a, b) => b.score - a.score);
      }
    }

    const seen = new Set(); // exact duplicates (video_id + start)
    const perVideo = new Map(); // variety: max 2 moments from any one sermon
    const picked = [];
    for (const { score, i } of top) {
      const m = meta[i];
      const key = `${m.video_id}:${m.start}`;
      if (seen.has(key)) continue;
      if ((perVideo.get(m.video_id) || 0) >= 2) continue;
      seen.add(key);
      perVideo.set(m.video_id, (perVideo.get(m.video_id) || 0) + 1);
      picked.push({ score, i });
      if (picked.length >= k) break;
    }

    const hits = picked.map(({ score, i }, rank) => ({
      rank: rank + 1,
      ...meta[i],
      highlight: "",
      distance: 1 - score,
      similarity: score,
    }));

    // 3. "Why it matched": embed every phrase-window of every hit in one batch,
    //    keep each hit's closest window. Same trick as the original.
    const perHit = hits.map((h) => splitPhrases(h.text));
    const flat = [];
    const owner = [];
    perHit.forEach((phrases, hi) => phrases.forEach((p) => { flat.push(p); owner.push(hi); }));
    if (flat.length) {
      try {
        const vecsF = await embed(flat);
        const best = hits.map(() => ({ score: -Infinity, text: "" }));
        vecsF.forEach((v, idx) => {
          const hi = owner[idx];
          const s = cosineFloat(q, v);
          if (s > best[hi].score) best[hi] = { score: s, text: flat[idx] };
        });
        hits.forEach((h, hi) => (h.highlight = best[hi].text));
      } catch {} // highlighting is a garnish — never fail the search over it.
    }

    res.status(200).json({ query, hits });
  } catch (error) {
    console.error("search error:", error.message);
    res.status(500).json({ error: "Search hiccuped — try again in a moment." });
  }
}
