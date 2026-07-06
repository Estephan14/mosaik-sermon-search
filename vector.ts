// ─────────────────────────────────────────────────────────────────────────
// TEACHING EXAMPLE — standalone, not used by the app.
//
// The smallest possible "what is an embedding?" demo: send one sentence to
// OpenAI and print the vector it comes back as. Nothing imports this file; the
// real app lives in ingest.ts / search.ts / server.ts.
//
// Run it on its own:   node --env-file=.env vector.ts
// (The only change from the very first version: the key is read from .env
//  instead of being pasted inline.)
// ─────────────────────────────────────────────────────────────────────────

const myLanguage = "i am jonathan estephan and i am a software engineer";

async function main() {
  const responseFromOpenAI = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      input: myLanguage,
      model: "text-embedding-3-small",
    }),
  }).then((response) => response.json());

  console.log({ responseFromOpenAI: responseFromOpenAI.data[0].embedding });
}

main();
