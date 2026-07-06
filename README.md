# Sermon Search — semantic search over 850+ sermons

Ask a question in plain English and get back the exact moments sermons answered
it — preacher, date, the passage itself, and a YouTube link that jumps to the
precise second.

Built for [Mosaik Berlin](https://www.mosaikberlin.com/)'s public sermon
library as a hands-on study of **AI-native search**: embeddings, chunking,
vector databases, and retrieval — the machinery under every RAG system, built
from parts instead of a framework.

## Example

> **Query:** *"dealing with anxiety and trusting God"*
>
> **#1 — "Don't worry, be happy" · Dave Schnitter · 2026-02-16 · [watch @ 11:27](https://www.youtube.com/watch?v=fDrsaBxhjuY&t=687s)**
> *"…anxiety is the overall emotion in Berlin. We know how to numb it well by
> just escaping it… Jesus has these words to say: 'Don't let your hearts be
> troubled.' He's not minimizing the trouble. He's meeting us in the midst of
> it…"* — similarity 0.63

Nothing in that sermon contains the words "dealing with anxiety" — the match is
semantic, not keyword.

## How it works

```
YouTube channel ──▶ download_transcripts.ts     (auto-subtitles → clean text)
                        │
                        ▼
                    chunk.ts                    (overlapping ~90s windows,
                        │                        sentence-aligned)
                        ▼
                    embeddings.ts               (OpenAI text-embedding-3-small)
                        │
                        ▼
                    LanceDB (./data)            (on-disk vector store, ~230 MB,
                        │                        committed — clone & run)
                        ▼
                    server.ts + index.html      (query → embed → k-NN search →
                                                 highlighted passages, deep links)
```

- **Chunking**: transcripts are split into overlapping windows aligned to
  sentence boundaries, each carrying its video timestamp — so a hit maps back
  to a *moment*, not just a video.
- **Vector store**: [LanceDB](https://lancedb.com/), embedded and file-based —
  no database server, the whole index is a folder. It's committed to this repo
  on purpose: `git clone` gives you a working search engine, not a build task.
- **Metadata pipeline**: preacher names are normalized across years of
  inconsistent video descriptions (`normalize_preachers.ts`).
- **Cost**: a search = one embedding call (fractions of a cent). The corpus
  embedding was a one-time job.

## Run it

```bash
npm install
echo "OPENAI_API_KEY=sk-..." > .env
npm run dev          # → http://localhost:8080
```

Or search from the terminal:

```bash
npm run search "why does suffering exist"
```

Or with Docker (what production runs):

```bash
docker build -t sermon-search .
docker run --rm -p 8080:8080 -e OPENAI_API_KEY=sk-... sermon-search
```

## Refresh the corpus

```bash
npm run sermons:download   # pull new transcripts from the channel
npm run sermons:ingest     # chunk + embed + upsert into ./data
```

Raw transcripts are not committed (they're regenerable and not mine to
republish); the derived vector index is.

## Deploying

See [DEPLOY.md](DEPLOY.md) — it's a small Node server with a native module and
a real filesystem, so it wants a container host (Render/Fly/Railway/VPS), not a
serverless function.

---

Built by [Jonathan Estephan](https://jonathanestephan.com). Sermon content
belongs to Mosaik Berlin; this tool only makes their public library searchable.
