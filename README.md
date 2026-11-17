# AI Research Lab

M11 now uses an Ink terminal client with streamed report previews, approval at the prompt, and persistent research projects. See [CLI usage](docs/cli.md), [gateway configuration](docs/hkust-api.md), and [workflow](docs/milestone9.md).

## Run locally

Requires Node 24 and pnpm 11.22.0. Persistence runs on PostgreSQL through `DATABASE_URL`, or inside the API process through PGlite when `DATABASE_DRIVER=pglite` and `PGLITE_DATA_DIR=.pglite`; PGlite keeps a single connection, so one process owns the data directory at a time. Configure `apps/api/.env` with `HUMAN_ENABLED=true`, database settings, your model API key and `EMBEDDING_API_KEY` for the embedding service.

```bash
pnpm install
pnpm dev
```

In another terminal run `pnpm cli`. Enter a question to create a project; after completion, enter another message to revise it. Use `/upload path/to/notes.md` to index a document. RAG uses an external embedding service by default (Voyage); fill `EMBEDDING_API_KEY` in `.env`. Ollama remains an optional embedding provider.

The API defaults to <http://localhost:3001>. The legacy browser client can be started separately with `pnpm dev:web`.

## Verify

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

`apps/api` owns research and persistence; `apps/cli` is the main interface; `apps/web` retains the legacy browser client.

## Try a model

Copy `apps/api/.env.example` to `apps/api/.env`, then edit the model settings. Use an installed Ollama model name, or select OpenAI and set its model name and API key. No model name is hard-coded. Without `LLM_PROVIDER`, health checks still work and model requests return HTTP 503.

Restart `pnpm dev` after editing `.env`. In another terminal, run:

```bash
curl -sS -X POST http://localhost:3001/api/model/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Explain tool calling in one sentence."}'

curl -N -X POST http://localhost:3001/api/model/stream \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Explain tool calling in one sentence."}'
```

The first returns JSON with `provider`, `model` and `text`. The second sends SSE `delta` events followed by `done`, or an `error` event if streaming fails. The server validates prompts, enforces `MODEL_TIMEOUT_MS`, and does not log prompts or API keys. `ModelProvider` also exposes Zod-validated structured output for later workflows; support depends on the configured model. Switch providers by changing `.env` and restarting the API.
