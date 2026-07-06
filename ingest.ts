// One-shot script: turn every fixture into a vector and load it into LanceDB.
// Run with `npm run ingest`. Safe to re-run — it drops and rebuilds the table.

import { DOCS } from "./fixtures.ts";
import { embed } from "./embeddings.ts";
import { connect, TABLE_NAME, type Row } from "./db.ts";

async function main() {
  console.log(`Embedding ${DOCS.length} documents with OpenAI...`);
  const vectors = await embed(DOCS.map((d) => d.text));

  const rows: Row[] = DOCS.map((d, i) => ({
    id: d.id,
    text: d.text,
    category: d.category,
    vector: vectors[i],
  }));

  const db = await connect();

  // Drop an existing table so re-running gives a clean rebuild.
  const names = await db.tableNames();
  if (names.includes(TABLE_NAME)) {
    await db.dropTable(TABLE_NAME);
  }

  await db.createTable(TABLE_NAME, rows);
  console.log(`Ingested ${rows.length} rows into table "${TABLE_NAME}" (./data).`);
  console.log("Now run `npm run dev` and open http://localhost:5173");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
