// ============================================================================
// chunk.ts — cutting a long transcript into bite-sized passages
// ----------------------------------------------------------------------------
// A sermon is ~44 minutes = thousands of words. If we embedded the whole thing
// as ONE vector, search could only say "this sermon is relevant" — not WHERE.
// So we slice the transcript into ~45-second "chunks". Each chunk becomes its
// own vector, so a search can point you at the exact moment.
//
// json3 caption lines are already short (a few words each), so we just glue
// consecutive lines together until ~45 seconds have passed, then start a new
// chunk. No clever overlap needed.
// ============================================================================

// `import type` = we only need the SHAPE TranscriptLine (for type-checking),
// not any running code from that file.
import type { TranscriptLine } from "./youtube.ts";

// The shape of one finished chunk.
export interface Chunk {
  start: number; // seconds — when the first line in this window was spoken
  end: number;   // seconds — when the last line in this window was spoken
  text: string;  // all the lines in the window glued into one passage
}

// `windowSec = 45` = a "default": if the caller doesn't say, use 45 seconds.
export function chunkLines(lines: TranscriptLine[], windowSec = 45): Chunk[] {
  const chunks: Chunk[] = []; // the finished chunks we'll return
  let buf: TranscriptLine[] = []; // "buffer": lines collected for the CURRENT chunk

  // `flush` = take whatever is sitting in the buffer, turn it into one chunk,
  // push it onto the results, and empty the buffer. (Defined as a small inline
  // function so we can call it from two places below.)
  const flush = () => {
    if (buf.length === 0) return; // nothing collected → nothing to do
    chunks.push({
      start: buf[0].start,                  // first line's time
      end: buf[buf.length - 1].start,       // last line's time
      // Join all the line texts with spaces, then squash any double spaces and
      // trim the ends. (\s+ means "one or more whitespace characters".)
      text: buf.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim(),
    });
    buf = []; // start fresh for the next window
  };

  // Walk through every line in order.
  for (const line of lines) {
    // If this line is 45s+ past where the current window started, the window is
    // "full" — flush it and begin a new one with this line.
    if (buf.length > 0 && line.start - buf[0].start >= windowSec) flush();
    buf.push(line);
  }
  flush(); // don't forget the final, partially-filled window

  // `.filter(...)` keeps only items that pass a test — here, drop empty chunks.
  return chunks.filter((c) => c.text.length > 0);
}
