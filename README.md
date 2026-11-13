# AI Relay Gateway

A personal, self-healing API gateway for **Claude Code**, **Codex**, and OpenAI / Anthropic SDK clients. It manages multiple AI relay providers (official APIs, `new-api`, `one-api`, and third-party relays) with **many API keys per provider**:

- **Automatic Key Rotation**: When a key runs out of quota/balance (`402` or out-of-balance body message), becomes invalid (`401`), or hits a rate limit (`429`), the gateway immediately updates its state and retries with the next healthy key on the same provider.
- **Ordered Provider Failover Chains**: When all keys of a provider are exhausted or the relay itself returns `5xx` / times out, the gateway fails over to the next provider in your route chain.
- **SSE Stream First-Event Peek**: Some relays return `HTTP 200` with `text/event-stream` and send an error inside the first SSE event (`event: error` or `data: {"error": ...}`). The gateway peeks the first SSE event before committing headers to the client so it can still transparently fail over.
- **100% Free on Cloudflare**: Runs on a single Cloudflare Worker with D1, Workers Static Assets, and Cron Triggers.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/khushveer007/ai-relay-gateway)

---

## Features

| Area | Details |
| --- | --- |
| **Wire Formats** | Transparent passthrough for `anthropic` (`/v1/messages`), `openai-chat` (`/v1/chat/completions`), and `openai-responses` (`/v1/responses`), plus merged `GET /v1/models`. |
| **Model Mapping & Allow-list** | Per-provider model rewriting (exact or glob, e.g. `claude-3-7-sonnet-*` → `claude-3-7-sonnet-20250219`) and optional strict allow-list against `/v1/models`. |
| **Named Routes** | Route requests by Gateway Key binding → Model glob pattern → `default` route. Each route defines an ordered provider failover chain. |
| **Key Selection** | **Sequential** (drain key #1 before using key #2) or **Round-Robin** per provider. |
| **Smart Error Classifier** | Built-in rules for OpenAI, Anthropic, and `new-api`/`one-api` error bodies (English & Chinese), plus custom per-provider regex & status rules with a dry-run tester. |
| **Auto Recovery Cron** | Runs every 15 minutes to clear expired rate-limit cooldowns, re-check exhausted keys via balance endpoint or 1-token test request, and refresh balances. |
| **Security** | Upstream API keys encrypted at rest with **AES-256-GCM** (`ENCRYPTION_KEY`). Client `sk-gw-…` keys stored as **SHA-256** hashes. Admin dashboard protected by `ADMIN_PASSWORD` + HMAC-signed `HttpOnly; SameSite=Strict` cookies. |

---

## Quick Start

### Option 1: One-Command Interactive CLI Setup

```bash
npm install
npm run setup
```

`npm run setup` will:
1. Verify your Cloudflare login (`wrangler whoami` / `wrangler login`).
2. Create the `ai-gateway` D1 database and write its `database_id` into `wrangler.jsonc`.
3. Apply the SQL schema migrations (`migrations/0001_init.sql`).
4. Prompt for `ADMIN_PASSWORD` and generate cryptographic secrets for `ENCRYPTION_KEY` and `SESSION_SECRET`.
5. Build the dashboard UI and deploy the Worker to `https://ai-gateway.<your-subdomain>.workers.dev`.

### Option 2: Local Development

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Then open `http://localhost:8787` to sign into the dashboard with the `ADMIN_PASSWORD` in `.dev.vars`.

---

## Connecting Clients

After signing into the dashboard, add at least one provider & API key, then create a gateway key (`sk-gw-…`) in **Gateway Keys**.

### Claude Code

Add to your shell profile (`~/.bashrc` / `~/.zshrc`):

```bash
export ANTHROPIC_BASE_URL="https://ai-gateway.<your-subdomain>.workers.dev"
export ANTHROPIC_AUTH_TOKEN="sk-gw-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Or in `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://ai-gateway.<your-subdomain>.workers.dev",
    "ANTHROPIC_AUTH_TOKEN": "sk-gw-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

### OpenAI Codex CLI

Add to `~/.codex/config.toml`:

```toml
model_provider = "gateway"

[model_providers.gateway]
name = "AI Relay Gateway"
base_url = "https://ai-gateway.<your-subdomain>.workers.dev/v1"
env_key = "GATEWAY_KEY"
wire_api = "responses"
```

And export your key:

```bash
export GATEWAY_KEY="sk-gw-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

---

## How Error Classification & Failover Work

Every failed upstream attempt (or `200` response containing an error JSON/SSE event) is evaluated against your **Error Rules** (per-provider rules run first, then global rules, ordered by `priority`):

| Action | Key Effect | Routing Behavior |
| --- | --- | --- |
| `EXHAUSTED` | Marks key `exhausted` and schedules re-check in `recheck_hours` | Immediately tries **next key** of the same provider (or next provider if none left) |
| `INVALID_KEY` | Marks key `invalid` | Immediately tries **next key** of the same provider |
| `RATE_LIMITED` | Sets `cooldown_until` (`Retry-After` header or rule `cooldown_s`) | Immediately tries **next key** of the same provider |
| `UPSTREAM_ERROR` | Key is **not** penalized | Skips remaining keys on this relay and switches to the **next provider** in the route chain |
| `CLIENT_ERROR` | Key is **not** penalized | Returns the upstream `4xx` error directly to the client without retrying |

---

## Testing

```bash
npm run typecheck
npm test
```
