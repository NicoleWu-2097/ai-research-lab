# AI Research Lab

Milestone 9 adds a bounded research loop with Critic-driven follow-up retrieval and quoted evidence. See [Milestone 9](docs/milestone9.md) for the workflow, [Milestone 8](docs/milestone8.md) for A2A setup, [Milestone 7](docs/milestone7.md) for review behavior, [Milestone 6](docs/milestone6.md) for retrieval, [Milestone 5](docs/milestone5.md) for database and embedding setup, and [the architecture](docs/architecture.md) for the planned system.

## Run locally

Requires Node 24 and pnpm 11.22.0. From the repository root:

```bash
pnpm install
pnpm dev
```

Open <http://localhost:5173>. The page should say **API online**. The API health endpoint is <http://localhost:3001/api/health> and returns `{"status":"ok","service":"api"}`. Stop both processes with Ctrl+C.

Ports can be changed with `PORT` for the API and `API_DEV_PROXY_TARGET` for the Vite proxy. Examples are in each app's `.env.example`; for the API, export `PORT` in the shell before `pnpm dev`.

## Verify

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

`apps/api` owns HTTP behavior, model configuration and adapters. `apps/web` owns the status page and development proxy. No database is required yet.

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
