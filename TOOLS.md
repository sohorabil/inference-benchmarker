# PROJECT TOOLBOX — read this first, then wait for the brief

> Claude: this file is the "sync". Read it fully and remember it. It tells you the whole
> toolbox available for this project and which need each tool serves. After you've read it,
> DO NOT start building. Say "toolbox loaded — paste the project brief when ready" and wait.
> When the brief arrives, map each outcome to the right tool below.

Project: Inference Benchmarker — send the same prompt to several AI vendors, measure how fast
and how expensive each is, store results, show a comparison. Runtime: Cloudflare Workers (wrangler).

Hard rules (every part):
- Secrets never in code. Every key is a Worker secret: `wrangler secret put NAME` (local: .dev.vars).
- One prompt, held constant across vendors.
- Build incrementally: one part at a time; deploy; verify; wait for "next".
- Cheapest/smallest model per vendor.

The toolbox — need -> tool:
| Need (outcome)                         | Tool                 | Secret / binding            |
| host + run + deploy                    | Cloudflare Workers   | wrangler login              |
| inference, no external key             | Workers AI           | binding AI                  |
| store generated image files           | Cloudflare R2        | binding IMAGES (bench-images)|
| simple early results store (SQL)       | Cloudflare D1        | binding DB (bench-db)       |
| vendor: fast image/video               | fal.ai               | secret FAL_KEY              |
| vendor: cheapest image                 | Runware              | secret RUNWARE_KEY          |
| vendor: text + image, big catalog      | Replicate            | secret REPLICATE_KEY        |
| clean queryable results (Postgres)     | Neon                 | secret DATABASE_URL         |
| raw schema-free vendor responses       | MongoDB Atlas        | MONGO_URL, MONGO_KEY        |
| cache + counters + leaderboard         | Upstash Redis        | UPSTASH_URL, UPSTASH_TOKEN  |
| a VM (understand VM-hosted vendors)    | DigitalOcean         | manual, not in code         |

Pick by shape when two stores fit: structured+queried -> Neon (or D1 early); messy raw blob -> Mongo;
hot/tiny/instant (counter, cache, ranking) -> Upstash Redis.
