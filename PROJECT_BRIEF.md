# PROJECT BRIEF — Inference Benchmarker

> Claude: build this project in parts, using the toolbox I gave you (TOOLS.md). For each part,
> choose the right tool from that toolbox to meet the outcome.
>
> Build protocol — follow exactly:
> 1. Build one PART at a time, in order. Don't skip ahead.
> 2. At the start of a part, tell me which tool you'll use and why (1 line), and whether any
>    secret/binding still needs to be set.
> 3. Write the code, deploy, and tell me exactly what URL to open and what I should see.
> 4. Then STOP and wait for me to type "next".
> 5. If a key/bucket isn't ready, stop and give me the exact command to run.

What we're building: one Cloudflare Worker that takes one prompt, sends it to several AI vendors at
once, measures latency and cost for each, stores results, shows a comparison dashboard. Two modes:
image and text. A price/performance test harness.

Principles: secrets never in code; one prompt held constant; cheapest models; deploy+verify each part.

PART 1 — A live skeleton
  Outcome: a deployed Worker whose homepage returns JSON { name, time } at a public URL.
  Done when: I open the URL and see the JSON.

PART 2 — Measure one inference
  Outcome: /bench sends a fixed prompt to a no-external-key AI model, measures ms, returns latency_ms
  + output. Add /bench?mode=image that generates an image, stores the file durably, returns URL+latency.
  Done when: /bench shows a latency number; /bench?mode=image returns an image URL that opens.

PART 3 — Never lose a run
  Outcome: every /bench call saved to a database (timestamp, mode, vendor, model, latency, price).
  Add /runs listing the last 20 as a table.
  Done when: runs accumulate in /runs.

PART 4 — Compare real vendors (image)
  Outcome: /bench?mode=image sends the same prompt to all four image-capable vendors in parallel,
  times each, records each price, saves one row per vendor.
  Done when: one call returns 4 vendors with latency+price; /runs gets 4 rows.

PART 5 — Production storage + text mode
  Outcome (a): clean structured rows -> queryable SQL store; full raw responses -> document store.
  Outcome (b): /bench?mode=text — same prompt to text vendors, measuring latency, tokens/sec, $/1M tokens.
  Done when: a run leaves a clean row in SQL AND a raw doc in the document store.

PART 6 — Speed + dashboard
  Outcome (a): a fast key/value layer — cache identical prompt 60s, total-runs counter, fastest leaderboard.
  Outcome (b): rebuild / into a clean dashboard: last-20 table + counter + leaderboard.
  Done when: same prompt twice is much faster the 2nd time; dashboard shows all three.

PART 7 — Harden + report
  Outcome: one vendor failing must not break the others; no secrets in code; final deploy; then from the
  stored data tell me cheapest/fastest/best-value for image and text, and draft REPORT.md.
  Done when: the tool survives a vendor error and REPORT.md gives a clear recommendation.
