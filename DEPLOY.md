# Deploying the sermon-search app

This app is a small Node HTTP server backed by an **on-disk LanceDB vector store**
(`./data`, ~223 MB). Because it reads a real filesystem and uses a native module,
it deploys cleanly as a **Docker container** on any host that keeps a disk
(Render, Railway, Fly.io, a VPS) — *not* as a serverless function.

The only secret it needs at runtime is `OPENAI_API_KEY` (used to embed each search
query). The vector store is baked into the image, so there's no database to host.

## Run it locally with Docker

```bash
cd vector-stuff
docker build -t sermon-search .
docker run --rm -p 8080:8080 -e OPENAI_API_KEY=sk-... sermon-search
# open http://localhost:8080
```

## Deploy to Render (easiest)

1. Push this folder to a GitHub repo.
2. Render → **New → Web Service** → pick the repo.
3. Render auto-detects the `Dockerfile`. Set:
   - **Instance type**: any with ≥512 MB RAM.
   - **Environment variable**: `OPENAI_API_KEY = sk-...`
4. Deploy. Render gives you a public `https://…onrender.com` URL.

(No port config needed — Render injects `$PORT` and the server already reads it.)

## Deploy to Fly.io

```bash
cd vector-stuff
fly launch --no-deploy          # detects the Dockerfile, creates fly.toml
fly secrets set OPENAI_API_KEY=sk-...
fly deploy
```

## Deploy to Railway

1. `railway init` (or use the dashboard) and point it at this folder.
2. It builds the `Dockerfile` automatically.
3. Add the `OPENAI_API_KEY` variable in the Railway dashboard.
4. Deploy; Railway provides the public URL.

## Updating the corpus on a deployed instance

The vector store is part of the image, so to publish newly-added sermons you:
1. Locally run `npm run refresh` (downloads new transcripts + ingests them into `./data`).
2. Rebuild and redeploy the image (`docker build … && deploy`).

That keeps the live site a fast, read-only search box while all the
rate-limit-sensitive downloading happens on your machine.

## A note on cost & safety

- Each search makes a few small OpenAI embedding calls (query + result sentences)
  — fractions of a cent. There's no per-result cost beyond that.
- If you expose this publicly, consider putting it behind basic auth or a rate
  limit so the OpenAI key isn't used by strangers.
