# Inference Benchmarker

A price/performance test harness for AI inference vendors. Sends one fixed prompt to
multiple vendors in parallel, measures latency and cost for each, stores every run, and
shows a comparison dashboard. Three modes: **text**, **image**, **video**.

Built on Cloudflare Workers. Live at
[inference-benchmarker.tukrim.workers.dev](https://inference-benchmarker.tukrim.workers.dev).

---

## Why this exists

If you're deciding which AI vendor to build a feature on, the questions that matter are
"how long will the user wait?" and "what will this cost us at our volume?" — not "does it
work." This project answers those questions with **real measured numbers**, not vendor
marketing.

The headline finding: a single 6-second video costs roughly **120×** an image and
**21,000×** a text call, on the vendors tested. Full analysis in [REPORT.md](REPORT.md).

---

## Vendors compared

| Vendor | Modes | Notes |
|---|---|---|
| **Workers AI** | text, image | Cloudflare-native, no external key, free tier |
| **fal.ai** | image, video | Fastest reliable image vendor (~3.1s) |
| **Runware** | image | Cheapest measured ($0.0027/image), only vendor with live per-call pricing |
| **Replicate** | text, image | Text works well; image model exceeded a 60s wait window every attempt |
| **WaveSpeed** | image | Added late; works, currently disabled in the active vendor list |

---

## Architecture

```
                        ┌─────────────────────────────┐
   one fixed prompt ───▶│  Cloudflare Worker (/bench)  │
                        └──────────────┬──────────────┘
                                       │  calls all vendors in parallel
                                       │  (Promise.allSettled — one failing
                                       │   never breaks the others)
                        ┌──────────────┼──────────────┐
                        ▼              ▼              ▼
                   Workers AI      fal.ai        Runware ...
                        │              │              │
                        └──────────────┼──────────────┘
                                       │  each result saved to:
                        ┌──────────────┼──────────────┬─────────────┐
                        ▼              ▼              ▼             ▼
                   Neon (Postgres)  MongoDB Atlas   Upstash Redis   R2
                   clean SQL rows   full raw JSON   cache/counter/  generated
                   via Hyperdrive   ("black box")   leaderboard     image files
```

**Why three storage types, not one** — each answers a question the others can't:

- **Neon (Postgres)** via Cloudflare Hyperdrive — clean, queryable rows: "what is the average latency per vendor"
- **MongoDB Atlas** — the complete, unmodified vendor response for every call: "what exactly did fal.ai send back on run #47"
- **Upstash Redis** — hot/tiny/instant: a 60-second response cache, a total-runs counter, a fastest-vendor leaderboard

---

## Endpoints

| Path | What it does |
|---|---|
| `/` | Dashboard — total runs, fastest-vendor leaderboard, unit-economics table, last 20 runs |
| `/bench` | Text benchmark — Workers AI + Replicate in parallel |
| `/bench?mode=image` | Image benchmark — Workers AI + fal.ai + Runware + Replicate in parallel |
| `/bench?mode=video` | Video benchmark — fal.ai (6s clip; slower and pricier, run on demand) |
| `/runs` | Last 20 runs as a table |
| `/analysis` | Aggregate stats as JSON (success/failure counts, avg latency, avg price per vendor/mode) |

---

## CI/CD pipeline

Three branches, three Jenkins pipelines, promoting code left-to-right:

```
  dev  ──────────▶  staging  ──────────▶  main
   │                   │                    │
   ▼                   ▼                    ▼
 install deps       install deps         install deps
 type-check         type-check           type-check
 (no deploy)        deploy to            deploy to
                    inference-           inference-
                    benchmarker-         benchmarker
                    staging              (production)
```

- **`dev`** — a fast, cheap sanity gate. Installs dependencies and type-checks the code
  (`tsc --noEmit`). Nothing deploys. Broken code stops here.
- **`staging`** — same checks, then deploys to a **separate** Worker
  (`inference-benchmarker-staging.tukrim.workers.dev`) so changes can be seen running live
  without touching production.
- **`main`** — same checks, then the real production deploy.

One [`Jenkinsfile`](Jenkinsfile) lives on all three branches. Each deploy stage is guarded
with `when { branch '...' }`, so a stage only activates on its matching branch. Cloudflare
deploys authenticate with a scoped API token stored in Jenkins' credential store, never in
the code.

---

## Running locally

```bash
npm install
npx wrangler login          # one-time, opens a browser
npx wrangler dev            # local dev server
npx wrangler deploy         # deploy to production
npx wrangler deploy --env staging   # deploy to staging
```

**Secrets** (set with `npx wrangler secret put NAME`, never committed):
`FAL_KEY`, `RUNWARE_KEY`, `REPLICATE_KEY`, `WAVESPEED_KEY`, `MONGO_URL`, `UPSTASH_URL`,
`UPSTASH_TOKEN`. The Neon connection string lives inside the Hyperdrive config, not as a
secret.

---

## Project origin

Built in 7 incremental parts (see [PROJECT_BRIEF.md](PROJECT_BRIEF.md) /
[TOOLS.md](TOOLS.md)), each deployed and verified before moving on. The build hit and
resolved several real problems — Hyperdrive query caching hiding fresh writes, MongoDB's
SRV connection format not working on Workers, a replica-set primary/secondary write
conflict, a vendor model that never completed within the wait window. Each was diagnosed
with evidence and either fixed or documented honestly in [REPORT.md](REPORT.md).
