// ============================================================================
// export_index.mjs — bake the LanceDB store into a tiny serverless index.
// ----------------------------------------------------------------------------
// OpenAI's text-embedding-3 vectors are Matryoshka embeddings: the first N
// dimensions are themselves a valid (coarser) embedding. So we can truncate
// the stored 1536-dim vectors to 512, renormalize, and quantize to int8 —
// shrinking the searchable index from ~230 MB to ~20 MB with little quality
// loss. Small enough to live INSIDE a serverless function and brute-force
// search in memory. Run: node export_index.mjs   → writes serverless/index-data/
// ============================================================================

import { connect } from "@lancedb/lancedb";
import { mkdirSync, writeFileSync } from "node:fs";

const DIMS = 768;
const OUT = "./serverless/index-data";

const db = await connect("./data");
const table = await db.openTable("sermons");
const rows = await table.query().toArray();
console.log("rows:", rows.length);

mkdirSync(OUT, { recursive: true });

const vectors = new Int8Array(rows.length * DIMS);
const scales = new Float32Array(rows.length);
const meta = [];
const preacherVideos = new Map();

rows.forEach((r, i) => {
  // Truncate to the first DIMS dimensions and L2-renormalize (Matryoshka).
  const v = Array.from(r.vector).slice(0, DIMS);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  // Per-vector int8 quantization: scale so the largest component uses the
  // full int8 range; keep the scale so dot products can be un-quantized.
  let maxAbs = 0;
  for (const x of v) maxAbs = Math.max(maxAbs, Math.abs(x / norm));
  const scale = maxAbs / 127 || 1;
  scales[i] = scale;
  for (let d = 0; d < DIMS; d++) vectors[i * DIMS + d] = Math.round(v[d] / norm / scale);

  meta.push({
    video_id: r.video_id,
    sermon_title: r.sermon_title,
    preacher: r.preacher,
    language: r.language,
    date: r.date,
    start: r.start,
    url: r.url,
    text: r.text,
  });

  if (!preacherVideos.has(r.preacher)) preacherVideos.set(r.preacher, new Set());
  preacherVideos.get(r.preacher).add(r.video_id);
});

writeFileSync(`${OUT}/vectors.bin`, Buffer.from(vectors.buffer));
writeFileSync(`${OUT}/scales.bin`, Buffer.from(scales.buffer));
writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta));
writeFileSync(
  `${OUT}/../public/preachers.json`,
  JSON.stringify({
    preachers: [...preacherVideos.entries()]
      .map(([preacher, set]) => ({ preacher, count: set.size }))
      .sort((a, b) => b.count - a.count),
  })
);

console.log("vectors.bin:", (vectors.byteLength / 1e6).toFixed(1), "MB");
console.log("meta.json:", (JSON.stringify(meta).length / 1e6).toFixed(1), "MB");
console.log("done → " + OUT);
