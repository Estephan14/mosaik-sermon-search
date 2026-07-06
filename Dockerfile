# Runnable container for the sermon-search app.
# It bundles the code AND the prebuilt LanceDB vector store (./data), so the
# running container is fully self-contained — it only needs an OpenAI key at
# runtime (to embed incoming search queries).

FROM node:24-slim

WORKDIR /app

# Install production dependencies first so this layer caches across code changes.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy the app source + the vector database folder (./data).
# (node_modules, transcripts, cookies, .env, etc. are excluded via .dockerignore.)
COPY . .

# Most hosts inject the port to listen on via $PORT; default to 8080 locally.
ENV PORT=8080
EXPOSE 8080

# IMPORTANT: OPENAI_API_KEY is provided at RUNTIME by the host (never baked in).
# Node 24 runs the TypeScript directly.
CMD ["node", "server.ts"]
