// One-off cleanup: collapse duplicate preacher spellings already in the DB
// (e.g. "David Schnitter" and "Dave Schnitter (Audio Only!)" → "Dave Schnitter").
// Future ingests are already normalized in parseTitle; this fixes existing rows.
//
//   npm run normalize:preachers

import { connect, openSermonTable } from "./db.ts";
import { normalizePreacher } from "./youtube.ts";

async function main() {
  const db = await connect();
  const table = await openSermonTable(db);

  // Find every distinct preacher currently stored.
  const rows = await table.query().select(["preacher"]).toArray();
  const distinct = new Set(rows.map((r) => r.preacher as string));

  let changed = 0;
  for (const raw of distinct) {
    const norm = normalizePreacher(raw);
    if (norm === raw) continue; // already clean
    // Rewrite every row with this raw name to the normalized one.
    await table.update({
      where: `preacher = '${raw.replace(/'/g, "''")}'`,
      values: { preacher: norm },
    });
    console.log(`"${raw}" → "${norm}"`);
    changed++;
  }

  console.log(changed ? `\nNormalized ${changed} preacher name(s).` : "Nothing to normalize.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
