// ============================================================================
// server.ts — the tiny web server behind the search page
// ----------------------------------------------------------------------------
// A "server" here = a program that waits for browser requests and answers them.
// This one answers exactly two kinds of request:
//   GET  /        → send back the search web page (index.html)
//   POST /search  → run a search and send back the results as JSON
// Run it with `npm run dev`, then open http://localhost:5173 in a browser.
// It needs NO extra libraries — Node.js has a built-in HTTP server.
// ============================================================================

// These `node:...` imports are built-in Node tools (file reading, HTTP, paths).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { searchSermons, listPreachers } from "./search.ts";
import { listStreams, fetchTranscript } from "./youtube.ts";
import { chunkLines } from "./chunk.ts";
import { embed } from "./embeddings.ts";
import { connect, ingestedVideoIds, SERMON_TABLE, type SermonRow } from "./db.ts";

// Figure out the folder THIS file lives in, so we can find index.html next to
// it no matter where the program was started from.
const __dirname = dirname(fileURLToPath(import.meta.url));
// Use the PORT env var if given, otherwise 5173. (|| = "or, if that's empty".)
const PORT = Number(process.env.PORT) || 5173;

// --- background sync -------------------------------------------------------
// These two variables remember whether a sync is already running and when the
// last one finished. `let` = a value that CAN change (unlike `const`).
let syncRunning = false;
let lastSyncAt = 0;
const SYNC_COOLDOWN_MS = 30 * 60 * 1000; // don't sync more than once per 30 min

// Check the 10 newest sermons on the YouTube channel. Any that aren't in
// LanceDB yet get downloaded, chunked, embedded, and stored — all in the
// background, without blocking whoever loaded the page.
async function syncLatest() {
  const now = Date.now();
  if (syncRunning || now - lastSyncAt < SYNC_COOLDOWN_MS) return;
  syncRunning = true;
  lastSyncAt = now;
  try {
    const streams = await listStreams(10); // newest 10, fastest to check
    const db = await connect();
    const done = await ingestedVideoIds(db);
    const fresh = streams.filter((s) => !done.has(s.id));
    if (fresh.length === 0) { console.log("[sync] up to date"); return; }
    console.log(`[sync] ${fresh.length} new sermon(s) found — ingesting…`);

    for (const stream of fresh) {
      try {
        const transcript = await fetchTranscript(stream);
        if (!transcript) { console.log(`[sync] ${stream.id} — no captions, skipped`); continue; }

        const chunks = chunkLines(transcript.lines);
        if (chunks.length === 0) continue;

        const vectors = await embed(chunks.map((c) => c.text));
        const rows: SermonRow[] = chunks.map((c, idx) => ({
          video_id: transcript.id,
          sermon_title: transcript.sermonTitle,
          preacher: transcript.preacher,
          language: transcript.language,
          date: transcript.date,
          chunk_index: idx,
          start: c.start,
          end: c.end,
          url: `https://www.youtube.com/watch?v=${transcript.id}&t=${c.start}s`,
          text: c.text,
          vector: vectors[idx],
        }));

        const names = await db.tableNames();
        if (!names.includes(SERMON_TABLE)) {
          await db.createTable(SERMON_TABLE, rows);
        } else {
          const table = await db.openTable(SERMON_TABLE);
          await table.add(rows);
        }
        console.log(`[sync] ✓ ${transcript.sermonTitle} — ${transcript.preacher}`);
      } catch (err) {
        console.error(`[sync] ${stream.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("[sync] error:", err instanceof Error ? err.message : err);
  } finally {
    syncRunning = false;
  }
}

// createServer takes a function that runs FOR EVERY incoming request.
// req = what the browser asked for; res = the reply we build up and send.
const server = createServer(async (req, res) => {
  try {
    // --- the search API ---------------------------------------------------
    // Did the browser POST to /search? Then it's a search request.
    if (req.method === "POST" && req.url === "/search") {
      const body = await readBody(req);                 // read the sent text
      // Parse the JSON body. `|| "{}"` guards against an empty body.
      const { query, limit, language, preacher } = JSON.parse(body || "{}");
      if (!query || typeof query !== "string") {
        // 400 = "Bad Request": the caller didn't give us a usable query.
        return json(res, 400, { error: "Provide a non-empty 'query' string." });
      }
      const hits = await searchSermons(query, {
        limit: limit ?? 8,                    // ?? = "use 8 if limit is missing"
        language: language || undefined,
        preacher: preacher || undefined,
      });
      return json(res, 200, { query, hits }); // 200 = "OK", here are the results
    }

    // --- the preachers list (for the filter dropdown) ---------------------
    if (req.method === "GET" && req.url === "/preachers") {
      return json(res, 200, { preachers: await listPreachers() });
    }

    // --- the UI -----------------------------------------------------------
    // A plain GET for "/" → send the HTML page, then sync in the background.
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      // syncLatest() is NOT awaited — the page loads immediately and the sync
      // runs behind it. Any new sermons show up in subsequent searches.
      syncLatest();
      const html = await readFile(join(__dirname, "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    // Anything else → 404 "Not Found".
    res.writeHead(404).end("Not found");
  } catch (err) {
    // If anything above blew up, don't crash the server — reply 500 + the message.
    console.error(err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

// Start listening. The callback runs once, when the server is ready.
server.listen(PORT, () => {
  console.log(`Vector search UI on http://localhost:${PORT}`);
});

// Read the full body of a request. The body arrives in pieces ("chunks"), so we
// glue them together and resolve the Promise once the browser signals "end".
function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));   // a piece arrived → append it
    req.on("end", () => resolve(data));   // all done → hand back the full text
    req.on("error", reject);              // something broke → fail the Promise
  });
}

// Small helper: send an object back as a JSON reply with a status code.
function json(res: import("node:http").ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}
