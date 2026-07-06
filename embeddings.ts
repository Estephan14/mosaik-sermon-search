// ============================================================================
// embeddings.ts — turning text into numbers ("embeddings")
// ----------------------------------------------------------------------------
// THE BIG IDEA: a computer can't compare meanings, only numbers. An "embedding"
// is a list of ~1536 numbers (a "vector") that represents the *meaning* of a
// piece of text. Texts with similar meaning get similar lists of numbers. So
// "overcoming fear" and "trusting God when scared" end up close together, even
// though they share no words. We ask OpenAI's model to produce these numbers.
//
// This file's whole job: take text -> give back its list of numbers.
// ============================================================================

// `export const` = a fixed value other files are allowed to import and use.
// (const = it never changes, like a label glued onto a value.)
export const EMBED_MODEL = "text-embedding-3-small"; // which OpenAI model we use
export const EMBED_DIM = 1536; // how many numbers each embedding has

// A small helper that reads the secret API key from the environment.
// Returns a string (the `: string` after the () says "this gives back a string").
function apiKey(): string {
  // process.env = the bag of environment variables the program started with.
  // `npm run ...` loads them from the .env file via `--env-file=.env`.
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    // `throw` = stop everything and report an error. Better a clear message now
    // than a confusing crash later when we try to call OpenAI without a key.
    throw new Error(
      "OPENAI_API_KEY is not set. Run with `node --env-file=.env ...` (npm scripts already do this)."
    );
  }
  return key;
}

// Turn one string, OR a whole list of strings, into embeddings.
// `async` = this function does slow work (talking to the internet) and hands
// back a "Promise" — an IOU for a value that arrives later. Code that calls it
// uses `await` to wait for the IOU to be paid.
// `Promise<number[][]>` = "eventually gives back a list of lists of numbers"
// (one list of numbers per input string).
export async function embed(input: string | string[]): Promise<number[][]> {
  // If we were given a single string, wrap it in a list so the rest of the code
  // only ever deals with a list. `? :` is shorthand for if/else.
  const inputs = Array.isArray(input) ? input : [input];

  // `fetch` = make an HTTP request (ask another computer on the internet for
  // something). `await` = pause here until the reply comes back.
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",                 // POST = "here's some data, do something with it"
    headers: {
      "Content-Type": "application/json",      // we're sending JSON text
      Authorization: `Bearer ${apiKey()}`,     // prove who we are with the key
    },
    // The body is our request turned into JSON text (a universal text format
    // for data). JSON.stringify = "object -> text".
    body: JSON.stringify({ input: inputs, model: EMBED_MODEL }),
  });

  // res.ok is false for error replies (e.g. 401 bad key, 429 too many requests).
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings failed (${res.status}): ${body}`);
  }

  // Parse the JSON reply text back into an object we can read. The `as {...}`
  // just tells TypeScript what shape to expect (a list under `data`).
  const json = (await res.json()) as { data: { embedding: number[] }[] };

  // `.map(...)` = make a new list by transforming each item. Here: from each
  // result object `d`, pull out just its `.embedding` list of numbers.
  return json.data.map((d) => d.embedding);
}

// Convenience wrapper for the very common "I just have one string" case.
export async function embedOne(text: string): Promise<number[]> {
  // embed() always returns a list-of-lists; `const [vec] = ...` grabs the first
  // (and only) inner list out of it. That trick is called "destructuring".
  const [vec] = await embed(text);
  return vec;
}
