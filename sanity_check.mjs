// Does the 512-dim int8 index agree with the full 1536-dim LanceDB search?
// Compares top-5 result sets for a few realistic queries.
import { readFileSync } from "node:fs";
import { searchSermons } from "./search.ts";

const DIMS = 768;
const vecs = new Int8Array(readFileSync("./serverless/index-data/vectors.bin").buffer);
const scales = new Float32Array(readFileSync("./serverless/index-data/scales.bin").buffer);
const meta = JSON.parse(readFileSync("./serverless/index-data/meta.json", "utf8"));

async function embedQuery(q) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: q, dimensions: DIMS }),
  });
  return (await res.json()).data[0].embedding;
}

function topK(q, k) {
  const scored = [];
  for (let i = 0; i < meta.length; i++) {
    let dot = 0;
    const off = i * DIMS;
    for (let d = 0; d < DIMS; d++) dot += q[d] * vecs[off + d];
    scored.push([dot * scales[i], i]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, k).map(([score, i]) => ({ key: meta[i].video_id + ":" + meta[i].start, score }));
}

const QUERIES = [
  "dealing with anxiety and trusting God",
  "how to forgive someone who hurt you",
  "what is baptism and why does it matter",
];

for (const q of QUERIES) {
  const [mini, full] = await Promise.all([
    embedQuery(q).then((v) => topK(v, 5)),
    searchSermons(q, { limit: 5 }),
  ]);
  const fullKeys = new Set(full.map((h) => h.video_id + ":" + h.start));
  const overlap = mini.filter((m) => fullKeys.has(m.key)).length;
  console.log(`"${q}" → top-5 overlap: ${overlap}/5`);
}
