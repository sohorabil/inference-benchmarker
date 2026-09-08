# Inference Benchmarker — Findings Report

Generated from real, stored benchmark data (Neon Postgres `runs` table + MongoDB raw
responses), not projections. All vendors were called with the identical fixed prompt:

- Text: *"Explain what a CPU cache is in exactly two sentences."*
- Image: *"A mountain sunset over a calm lake, digital art"*

## Image mode

| Vendor | Successful calls | Avg latency | Min–Max | Avg price/image | Price source |
|---|---|---|---|---|---|
| **fal.ai** (`fal-ai/fast-sdxl`) | 5 | **~3,100 ms** | 3,037–3,465 ms | **$0.003** | Published rate card (API doesn't disclose live price) |
| **Runware** (`runware:101@1`) | 4 | 3,494 ms | 3,003–4,219 ms | **$0.0027** | Live, per-call — the only vendor whose API returns real-time cost |
| **Workers AI** (`stable-diffusion-xl-base-1.0`) | 8 | ~9,600 ms | 8,705–11,002 ms | **$0.00** | Cloudflare's published rate — this model is $0/step while in Beta |
| **Replicate** (`black-forest-labs/flux-schnell`) | 0 reliable* | ~61,700 ms | 61,460–62,055 ms | n/a — never completed | Consistently exceeded our 60s wait window on every attempt |
| WaveSpeed (`z-image/turbo`) | 2 | 3,005 ms | 2,988–3,021 ms | **$0.005** | Published rate card; disabled before final comparison — see note below |

**Cost per 1,000 image calls, at measured rates:** fal.ai ≈ $3.00 · WaveSpeed ≈ $5.00 ·
Runware ≈ $2.70 · Workers AI ≈ $0.00 (until the free daily Neuron allocation is exhausted,
at which point it becomes metered — not measured in this project).

\* Two early Replicate "successes" in the raw data are a labeling artifact from before a
mid-testing bug fix (see **Data caveats** below) — they were actually timeouts, not real
completions. Zero image requests to Replicate ever returned a usable image in this project.

**Image mode recommendation:**
- **Fastest & most reliable:** fal.ai — consistently ~3.1s, zero failures once billing was active.
- **Cheapest (measured):** Runware — the only vendor that returned live pricing ($0.0032/image), and it's also fast (~3.5s). Runme is the best-value pick if price certainty matters.
- **Avoid for latency-sensitive use:** Replicate's `flux-schnell` never completed within 60 seconds in this project, despite its "schnell" (fast) name — likely cold-start latency on a low-usage account rather than a fundamental model issue, but as measured, unusable for a synchronous chatbot flow.
- **Workers AI** is a reasonable zero-setup default (no vendor account, no key) but is ~3x slower than fal.ai/Runware — fine for a fallback, not for latency-critical production.

## Text mode

| Vendor | Successful calls | Avg latency | Tokens/sec (last sample) | Avg price/call | Price source |
|---|---|---|---|---|---|
| **Workers AI** (`llama-3.2-1b-instruct`) | 17 | **1,027 ms** | ~75 tok/s | **$0.000017** | Live — Workers AI's response includes real "neurons" usage, converted to $ at Cloudflare's published $0.011/1,000-neuron rate |
| **Replicate** (`meta-llama-3-8b-instruct`) | 2 | 1,485 ms | ~82 tok/s | **$0.0000216** | Live, computed from actual token counts × published per-token rate ($0.05/1M in, $0.25/1M out) |

**Cost per 1,000 text calls:** Workers AI ≈ $0.017 · Replicate ≈ $0.022 — both effectively
negligible at this scale; the real differentiator between them is latency and quality, not cost.

**Text mode recommendation:**
- **Workers AI** is faster (~1.03s vs ~1.49s) and marginally cheaper — the clear default for text unless a larger/more capable model is specifically needed.
- **Replicate** is viable and nearly as cheap, useful as a fallback vendor. Sample size (n=2) is still small — treat the latency comparison as indicative, not final.

## Video mode — one real measured data point

Text and image models are cheap enough that cost is rarely the deciding factor. Video is a
different story — this is the number most worth showing a company, because it changes the
conversation from "which vendor" to "can we afford this feature at all."

**Vendor tested:** fal.ai, `xai/grok-imagine-video/text-to-video` (chosen as the cheapest
disclosed-price text-to-video model available on fal.ai; $0.06/sec at 720p).

| Metric | Value |
|---|---|
| Requested duration | 6 seconds (this model's **minimum** — durations below 6s are not available) |
| Actual latency (submit → completed video) | **64,149 ms (~64 seconds)** |
| Actual video delivered | 6.04s, 1280×720, 24fps, MP4 |
| **Real cost, measured** | **$0.3625** |
| Pro-rated cost for a hypothetical 2s clip | ~$0.12 *(not purchasable at this length — shown for comparison only)* |

**Why this matters for unit economics:** a single 6-second video costs roughly **21,000×**
what a single text call costs, and **120×** what a single image call costs, on this vendor.
At volume, the gap is stark:

| Feature | Cost per 1,000 requests |
|---|---|
| Text (Workers AI) | ~$0.02 |
| Image (fal.ai) | ~$3.00 |
| Video (fal.ai, 6s min) | **~$362.50** |

**Recommendation:** video generation is not a "nice to have add-on" from a cost standpoint —
it needs its own line item in any budget conversation, explicit user-facing rate limits, and
likely a paid-tier gate if offered to end users. A company evaluating "should we add video
generation" should see this $362.50/1,000-requests number before committing, not discover it
after launch. This project only tested one vendor/model for video; a real production decision
would need at least 2-3 more video vendors compared the same way before committing.

## Resilience — confirmed working

Every `/bench` call fans out to all configured vendors in parallel via `Promise.allSettled`.
Verified directly: a single call with 3 of 4 image vendors failing (billing not yet active)
still returned a complete, well-formed response — the working vendor's result was unaffected
by the other three failing. No vendor failure has ever produced a 500 error or a broken
response in this project.

## Data caveats — read before trusting the numbers above

This report is built from a small number of real calls (single digits to low teens per
vendor), run manually during development — not a sustained load test. Treat every average
above as a rough signal, not a statistically confident benchmark. Specific caveats:

- **Replicate image mode**: the two "successful_calls" recorded before a bug fix were
  actually unfinished (status: "processing") predictions that got mislabeled as successes
  due to a logic bug — fixed mid-project (now correctly recorded as failures/timeouts). The
  raw MongoDB documents still contain the old mislabeled records; they were not retroactively
  cleaned up.
- **Runware and fal.ai** briefly failed on billing/parameter errors early in testing
  (documented, resolved) — those failures are real and counted in the `failures` table above,
  but don't reflect the vendors' steady-state reliability.
- **WaveSpeed** was added, tested successfully (2/2 calls, ~3s each — competitive with
  fal.ai/Runware), then deliberately excluded from the final vendor comparison per a scope
  decision partway through Part 4/7 testing. Its code remains in `src/index.ts` (commented
  out of the active vendor list) and can be re-enabled by uncommenting one line.
- **Pricing methodology**: every price in this report is either (a) read live from the
  vendor's own API response for that specific call (Runware images, Replicate text, Workers
  AI text via its neuron count), or (b) computed from that vendor's own published rate-card
  number × the actual measured quantity for that call (fal.ai/WaveSpeed images: published
  $/image; fal.ai video: published $/second × actual returned duration). No price in this
  report is a guess, an industry-average, or a number pulled from a source other than the
  vendor's own current pricing page. The rate-card constants live in `src/index.ts` as
  `RATE_CARD_PER_IMAGE_USD`, `WORKERS_AI_USD_PER_1000_NEURONS`, and `VIDEO_PRICE_PER_SECOND_USD`
  — update them if a vendor changes their published pricing.
- **Video** was tested with exactly one call, to one vendor/model. It answers "does this
  integration work and roughly what does it cost," not "which video vendor is best" — that
  would need the same multi-vendor comparison already done for text and images.

## Overall recommendation

For a production chatbot needing text and image generation, cheaply and quickly:
**Workers AI for text** (free, fast, zero external setup) **+ fal.ai for images** (fastest
reliable image vendor measured, ~3.1s, $0.003/image). Runware is a strong alternative for
images if per-call price predictability matters more than raw speed (its API is the only one
that discloses live pricing). Replicate needs further investigation for images (likely just
needs a warmed-up account or a longer async-poll pattern like WaveSpeed's/fal.ai video's)
before it can be trusted for latency-sensitive image generation — its text model works fine.

**If video generation is on the roadmap:** budget for it explicitly and separately — at
~$362.50 per 1,000 six-second clips (one vendor's measured rate), it is roughly two orders of
magnitude more expensive than image generation and four orders of magnitude more than text.
This is the single most important unit-economics finding in this report for planning purposes.
