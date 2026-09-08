import { Client } from "pg";
import { MongoClient } from "mongodb";

const BENCH_PROMPT = "Explain what a CPU cache is in exactly two sentences.";
const TEXT_MODEL = "@cf/meta/llama-3.2-1b-instruct";
const IMAGE_PROMPT = "A mountain sunset over a calm lake, digital art";
const IMAGE_MODEL = "@cf/stabilityai/stable-diffusion-xl-base-1.0";

// Replicate's disclosed per-token pricing for this model (confirmed via public pricing pages,
// not returned live by their API), used to compute $/1M tokens from actual token counts.
const REPLICATE_TEXT_MODEL = "meta/meta-llama-3-8b-instruct";
const REPLICATE_TEXT_PRICE_PER_1M_INPUT = 0.05;
const REPLICATE_TEXT_PRICE_PER_1M_OUTPUT = 0.25;

// Rate card: published per-call prices for vendors whose API response doesn't disclose a
// live price. Used ONLY as a fallback — a live price from the vendor's own response always
// wins. Every number here is sourced from the vendor's public pricing page, not estimated.
const RATE_CARD_PER_IMAGE_USD: Record<string, number> = {
  "fal.ai": 0.003, // fal.ai fast-sdxl, published rate
  wavespeed: 0.005, // WaveSpeed z-image/turbo, published rate
};
// Workers AI bills in "Neurons" ($0.011 per 1,000 Neurons past the 10k/day free allocation).
// Its API response already includes the real neuron count per call — convert that directly
// rather than using a flat per-image guess.
const WORKERS_AI_USD_PER_1000_NEURONS = 0.011;

const VIDEO_PROMPT = "A paper airplane gliding gently over a calm ocean at sunset";
const VIDEO_MODEL = "xai/grok-imagine-video/text-to-video";
const VIDEO_DURATION_SECONDS = 6; // this model's minimum billable duration
const VIDEO_PRICE_PER_SECOND_USD = 0.06; // fal.ai published rate for this model, 720p

const RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  mode TEXT NOT NULL,
  vendor TEXT NOT NULL,
  model TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  price_usd DOUBLE PRECISION
);
`;

interface VendorImageResult {
  vendor: string;
  model: string;
  latency_ms: number;
  price_usd: number | null;
  url: string | null;
  error: string | null;
  raw: unknown;
}

interface VendorTextResult {
  vendor: string;
  model: string;
  latency_ms: number;
  price_usd: number | null;
  tokens_per_sec: number | null;
  output: string | null;
  error: string | null;
  raw: unknown;
}

async function withPg<T>(env: Env, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function saveRun(
  env: Env,
  row: { mode: string; vendor: string; model: string; latency_ms: number; price_usd: number | null }
) {
  await withPg(env, async (client) => {
    // TODO(perf): move this one-time table creation out of the hot path once confirmed working.
    await client.query(RUNS_SCHEMA);
    await client.query(
      `INSERT INTO runs (mode, vendor, model, latency_ms, price_usd) VALUES ($1, $2, $3, $4, $5)`,
      [row.mode, row.vendor, row.model, row.latency_ms, row.price_usd]
    );
  });
}

// Workers' subrequest limit forces directConnection=true (no full topology discovery),
// but that means we're pinned to exactly one host — and only the replica set's current
// PRIMARY accepts writes. So: parse the multi-host standard connection string once, and
// try each host in turn until one accepts the write. Self-heals if Atlas fails over primaries.
function mongoHostUrls(mongoUrl: string): string[] {
  const m = mongoUrl.match(/^mongodb:\/\/([^@]+)@([^/]+)\/(.*)$/);
  if (!m) throw new Error("MONGO_URL is not in standard mongodb:// multi-host format");
  const [, userpass, hosts, paramsRaw] = m;
  const params = paramsRaw.replace(/[?&]replicaSet=[^&]+/, "").replace(/^&/, "");
  const sep = params.includes("?") ? "&" : "?";
  return hosts.split(",").map((host) => `mongodb://${userpass}@${host}/${params}${sep}directConnection=true`);
}

async function withMongoWrite<T>(env: Env, fn: (collection: ReturnType<ReturnType<MongoClient["db"]>["collection"]>) => Promise<T>): Promise<T> {
  const hostUrls = mongoHostUrls(env.MONGO_URL);
  let lastError: unknown;
  for (const url of hostUrls) {
    const client = new MongoClient(url, { maxPoolSize: 1, minPoolSize: 0, serverSelectionTimeoutMS: 5000 });
    try {
      await client.connect();
      const collection = client.db("inference_benchmarker").collection("raw_runs");
      return await fn(collection);
    } catch (e) {
      lastError = e; // likely "not primary" — try the next host
    } finally {
      await client.close();
    }
  }
  throw lastError ?? new Error("No Mongo host accepted the write");
}

// Raw, schema-free vendor responses — the "black box recorder".
// Unlike `runs` (clean SQL rows), this keeps the *entire* response so nothing is lost
// even if we didn't think to extract a field into the SQL schema.
async function saveRawDoc(
  env: Env,
  doc: { mode: string; vendor: string; model: string; latency_ms: number; raw: unknown; error: string | null }
) {
  await withMongoWrite(env, (collection) => collection.insertOne({ ...doc, created_at: new Date().toISOString() }));
}

// --- Upstash Redis (REST API — plain HTTPS, no driver/connection issues like Mongo had) ---
const CACHE_TTL_SECONDS = 60;

async function redisCommand(env: Env, ...args: (string | number)[]): Promise<any> {
  const path = args.map((a) => encodeURIComponent(String(a))).join("/");
  const res = await fetch(`${env.UPSTASH_URL}/${path}`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Upstash HTTP ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return data.result;
}

async function getCachedBenchResult(env: Env, cacheKey: string): Promise<unknown | null> {
  const cached = await redisCommand(env, "GET", cacheKey);
  return cached ? JSON.parse(cached) : null;
}

async function setCachedBenchResult(env: Env, cacheKey: string, value: unknown): Promise<void> {
  await redisCommand(env, "SET", cacheKey, JSON.stringify(value), "EX", CACHE_TTL_SECONDS);
}

async function incrementRunsCounter(env: Env): Promise<void> {
  await redisCommand(env, "INCR", "runs:total");
}

async function getRunsCounter(env: Env): Promise<number> {
  const value = await redisCommand(env, "GET", "runs:total");
  return value ? Number(value) : 0;
}

async function updateLeaderboard(env: Env, vendor: string, latency_ms: number): Promise<void> {
  await redisCommand(env, "ZADD", "leaderboard", latency_ms, vendor);
}

async function getLeaderboard(env: Env): Promise<{ vendor: string; latency_ms: number }[]> {
  // ZRANGE ... WITHSCORES, ascending (fastest first)
  const raw: string[] = (await redisCommand(env, "ZRANGE", "leaderboard", "0", "-1", "WITHSCORES")) ?? [];
  const entries: { vendor: string; latency_ms: number }[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    entries.push({ vendor: raw[i], latency_ms: Number(raw[i + 1]) });
  }
  return entries;
}

// --- Workers AI (existing) ---
async function runWorkersAiImage(env: Env): Promise<VendorImageResult> {
  const model = IMAGE_MODEL;
  const start = Date.now();
  try {
    const imageBytes = await env.AI.run(model, { prompt: IMAGE_PROMPT, num_steps: 20 });
    const latency_ms = Date.now() - start;
    const key = `bench-${Date.now()}-workersai.png`;
    await env.IMAGES.put(key, imageBytes as unknown as ReadableStream);
    // This model returns raw image bytes (no usage/neurons metadata) — unlike the text model,
    // there's no live cost to read. Per Cloudflare's own pricing page, this model is currently
    // listed at $0.00/step while in Beta — using that published rate, not an estimate.
    return { vendor: "workers-ai", model, latency_ms, price_usd: 0, url: `/images/${key}`, error: null, raw: { note: "binary image, not stored raw" } };
  } catch (e: any) {
    return { vendor: "workers-ai", model, latency_ms: Date.now() - start, price_usd: null, url: null, error: String(e?.message ?? e), raw: null };
  }
}

// --- fal.ai ---
async function runFal(env: Env): Promise<VendorImageResult> {
  const model = "fal-ai/fast-sdxl";
  const start = Date.now();
  try {
    const res = await fetch(`https://fal.run/${model}`, {
      method: "POST",
      headers: { Authorization: `Key ${env.FAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: IMAGE_PROMPT }),
    });
    const latency_ms = Date.now() - start;
    const data: any = await res.json();
    if (!res.ok) throw new Error(`fal.ai HTTP ${res.status}: ${JSON.stringify(data)}`);
    const url = data?.images?.[0]?.url ?? null;
    // fal.ai's response doesn't disclose a live price — fall back to the published rate.
    const price_usd = data?.cost ?? RATE_CARD_PER_IMAGE_USD["fal.ai"] ?? null;
    return { vendor: "fal.ai", model, latency_ms, price_usd, url, error: null, raw: data };
  } catch (e: any) {
    return { vendor: "fal.ai", model, latency_ms: Date.now() - start, price_usd: null, url: null, error: String(e?.message ?? e), raw: null };
  }
}

// --- Runware ---
async function runRunware(env: Env): Promise<VendorImageResult> {
  const model = "runware:101@1";
  const start = Date.now();
  try {
    const res = await fetch("https://api.runware.ai/v1", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RUNWARE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          taskType: "imageInference",
          taskUUID: crypto.randomUUID(),
          model,
          positivePrompt: IMAGE_PROMPT,
          width: 1024,
          height: 1024,
          numberResults: 1,
          includeCost: true,
        },
      ]),
    });
    const latency_ms = Date.now() - start;
    const data: any = await res.json();
    if (!res.ok) throw new Error(`Runware HTTP ${res.status}: ${JSON.stringify(data)}`);
    const item = data?.data?.[0] ?? data?.[0] ?? null;
    return {
      vendor: "runware",
      model,
      latency_ms,
      price_usd: item?.cost ?? null,
      url: item?.imageURL ?? null,
      error: null,
      raw: data,
    };
  } catch (e: any) {
    return { vendor: "runware", model, latency_ms: Date.now() - start, price_usd: null, url: null, error: String(e?.message ?? e), raw: null };
  }
}

// --- Replicate ---
async function runReplicate(env: Env): Promise<VendorImageResult> {
  const model = "black-forest-labs/flux-schnell";
  const start = Date.now();
  try {
    const res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.REPLICATE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({ input: { prompt: IMAGE_PROMPT } }),
    });
    const latency_ms = Date.now() - start;
    const data: any = await res.json();
    if (!res.ok) throw new Error(`Replicate HTTP ${res.status}: ${JSON.stringify(data)}`);
    // `Prefer: wait` holds the connection ~60s max — if the model is still running past that,
    // Replicate returns the pending prediction rather than an error. Treat that as a real,
    // reportable outcome (this vendor exceeded our timeout), not a silent success.
    if (data?.status !== "succeeded") {
      throw new Error(`Replicate did not complete within the wait window (status: ${data?.status})`);
    }
    const output = data?.output;
    const url = Array.isArray(output) ? output[0] : output ?? null;
    return { vendor: "replicate", model, latency_ms, price_usd: null, url, error: null, raw: data };
  } catch (e: any) {
    return { vendor: "replicate", model, latency_ms: Date.now() - start, price_usd: null, url: null, error: String(e?.message ?? e), raw: null };
  }
}

// --- WaveSpeed ---
// Async submit-then-poll API (unlike the sync vendors above): submit a task, then poll for
// its result. Latency here is the full end-to-end wait — what a real client would experience.
const WAVESPEED_POLL_TIMEOUT_MS = 30_000;
const WAVESPEED_POLL_INTERVAL_MS = 1_000;

async function runWaveSpeed(env: Env): Promise<VendorImageResult> {
  const model = "wavespeed-ai/z-image/turbo";
  const start = Date.now();
  try {
    const submitRes = await fetch(`https://api.wavespeed.ai/api/v3/${model}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WAVESPEED_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: IMAGE_PROMPT, size: "1024*1024" }),
    });
    const submitData: any = await submitRes.json();
    if (!submitRes.ok) throw new Error(`WaveSpeed submit HTTP ${submitRes.status}: ${JSON.stringify(submitData)}`);
    const taskId = submitData?.data?.id ?? submitData?.id;
    if (!taskId) throw new Error(`WaveSpeed submit did not return a task id: ${JSON.stringify(submitData)}`);

    let resultData: any = null;
    while (Date.now() - start < WAVESPEED_POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, WAVESPEED_POLL_INTERVAL_MS));
      const pollRes = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${taskId}/result`, {
        headers: { Authorization: `Bearer ${env.WAVESPEED_KEY}` },
      });
      const pollData: any = await pollRes.json();
      if (!pollRes.ok) throw new Error(`WaveSpeed poll HTTP ${pollRes.status}: ${JSON.stringify(pollData)}`);
      const status = pollData?.data?.status ?? pollData?.status;
      if (status === "completed") {
        resultData = pollData;
        break;
      }
      if (status === "failed") {
        throw new Error(`WaveSpeed task failed: ${JSON.stringify(pollData)}`);
      }
      // otherwise still "processing" / "pending" — keep polling
    }
    if (!resultData) throw new Error(`WaveSpeed task did not complete within ${WAVESPEED_POLL_TIMEOUT_MS}ms`);

    const latency_ms = Date.now() - start;
    const outputs = resultData?.data?.outputs ?? resultData?.outputs;
    const url = Array.isArray(outputs) ? outputs[0] : (outputs ?? null);
    // WaveSpeed's response doesn't disclose a live price — fall back to the published rate.
    const price_usd = resultData?.data?.cost ?? RATE_CARD_PER_IMAGE_USD["wavespeed"] ?? null;
    return { vendor: "wavespeed", model, latency_ms, price_usd, url, error: null, raw: resultData };
  } catch (e: any) {
    return {
      vendor: "wavespeed",
      model,
      latency_ms: Date.now() - start,
      price_usd: null,
      url: null,
      error: String(e?.message ?? e),
      raw: null,
    };
  }
}

// --- fal.ai (video) ---
// Queue-based API (submit -> poll -> result), same as WaveSpeed above — video generation
// takes longer than fal.ai's sync image endpoint allows. Called on-demand for cost/latency
// reporting, not part of the regular /bench fan-out — video is a different unit-economics
// question (this model's minimum billable duration is 6s, not comparable to a single image call).
const VIDEO_POLL_TIMEOUT_MS = 120_000;
const VIDEO_POLL_INTERVAL_MS = 3_000;

async function runFalVideo(env: Env): Promise<VendorImageResult> {
  const model = VIDEO_MODEL;
  const start = Date.now();
  try {
    const submitRes = await fetch(`https://queue.fal.run/${model}`, {
      method: "POST",
      headers: { Authorization: `Key ${env.FAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: VIDEO_PROMPT, duration: VIDEO_DURATION_SECONDS, resolution: "720p" }),
    });
    const submitData: any = await submitRes.json();
    if (!submitRes.ok) throw new Error(`fal.ai video submit HTTP ${submitRes.status}: ${JSON.stringify(submitData)}`);
    const statusUrl = submitData?.status_url;
    const responseUrl = submitData?.response_url;
    if (!statusUrl || !responseUrl) throw new Error(`fal.ai video submit missing status/response URL: ${JSON.stringify(submitData)}`);

    let completed = false;
    while (Date.now() - start < VIDEO_POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
      const statusRes = await fetch(statusUrl, { headers: { Authorization: `Key ${env.FAL_KEY}` } });
      const statusData: any = await statusRes.json();
      if (statusData?.status === "COMPLETED") {
        completed = true;
        break;
      }
      if (statusData?.status === "ERROR") throw new Error(`fal.ai video task errored: ${JSON.stringify(statusData)}`);
    }
    if (!completed) throw new Error(`fal.ai video did not complete within ${VIDEO_POLL_TIMEOUT_MS}ms`);

    const resultRes = await fetch(responseUrl, { headers: { Authorization: `Key ${env.FAL_KEY}` } });
    const resultData: any = await resultRes.json();
    const latency_ms = Date.now() - start;
    const url = resultData?.video?.url ?? null;

    // No live price in the response — compute from published per-second rate * actual duration.
    const actualDuration = resultData?.video?.duration ?? VIDEO_DURATION_SECONDS;
    const price_usd = actualDuration * VIDEO_PRICE_PER_SECOND_USD;

    return { vendor: "fal.ai", model, latency_ms, price_usd, url, error: null, raw: resultData };
  } catch (e: any) {
    return { vendor: "fal.ai", model, latency_ms: Date.now() - start, price_usd: null, url: null, error: String(e?.message ?? e), raw: null };
  }
}

// --- Replicate (text) ---
async function runReplicateText(env: Env): Promise<VendorTextResult> {
  const model = REPLICATE_TEXT_MODEL;
  const start = Date.now();
  try {
    const res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.REPLICATE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({ input: { prompt: BENCH_PROMPT } }),
    });
    const latency_ms = Date.now() - start;
    const data: any = await res.json();
    if (!res.ok) throw new Error(`Replicate HTTP ${res.status}: ${JSON.stringify(data)}`);

    const output = Array.isArray(data?.output) ? data.output.join("") : (data?.output ?? null);

    // Token counts, if the model reports them (not guaranteed) — never fabricate a number if absent.
    const inputTokens: number | null = data?.metrics?.input_token_count ?? null;
    const outputTokens: number | null = data?.metrics?.output_token_count ?? null;
    const predictSeconds: number | null = data?.metrics?.predict_time ?? null;

    const tokens_per_sec =
      outputTokens != null && predictSeconds ? Math.round((outputTokens / predictSeconds) * 100) / 100 : null;
    const price_usd =
      inputTokens != null && outputTokens != null
        ? (inputTokens / 1_000_000) * REPLICATE_TEXT_PRICE_PER_1M_INPUT +
          (outputTokens / 1_000_000) * REPLICATE_TEXT_PRICE_PER_1M_OUTPUT
        : null;

    return { vendor: "replicate", model, latency_ms, price_usd, tokens_per_sec, output, error: null, raw: data };
  } catch (e: any) {
    return {
      vendor: "replicate",
      model,
      latency_ms: Date.now() - start,
      price_usd: null,
      tokens_per_sec: null,
      output: null,
      error: String(e?.message ?? e),
      raw: null,
    };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight — needed for the standalone cost-calculator artifact (different origin)
    // to fetch /analysis. Browsers send this OPTIONS request before the real GET.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (url.pathname === "/") {
      const [runsResult, totalRuns, leaderboard, unitEconomics] = await Promise.all([
        withPg(env, async (client) => {
          await client.query(RUNS_SCHEMA);
          const { rows } = await client.query(`SELECT * FROM runs ORDER BY id DESC LIMIT 20`);
          return rows;
        }).catch(() => []),
        getRunsCounter(env).catch(() => 0),
        getLeaderboard(env).catch(() => []),
        withPg(env, async (client) => {
          const { rows } = await client.query(`
            SELECT mode, vendor,
                   COUNT(*) AS calls,
                   ROUND(AVG(latency_ms)) AS avg_latency_ms,
                   AVG(price_usd) AS avg_price_usd
            FROM runs
            WHERE price_usd IS NOT NULL
            GROUP BY mode, vendor
            ORDER BY mode, avg_price_usd
          `);
          return rows;
        }).catch(() => []),
      ]);

      const runsRows = runsResult
        .map(
          (r: any) =>
            `<tr><td>${r.id}</td><td>${r.created_at}</td><td>${r.mode}</td><td>${r.vendor}</td><td>${r.model}</td><td>${r.latency_ms}</td><td>${r.price_usd != null ? "$" + Number(r.price_usd).toFixed(6) : "-"}</td></tr>`
        )
        .join("");

      const leaderboardRows = leaderboard
        .map((e, i) => `<tr><td>${i + 1}</td><td>${e.vendor}</td><td>${e.latency_ms} ms</td></tr>`)
        .join("");

      const economicsRows = unitEconomics
        .map(
          (r: any) =>
            `<tr><td>${r.mode}</td><td>${r.vendor}</td><td>${r.calls}</td><td>${r.avg_latency_ms} ms</td><td>$${Number(r.avg_price_usd).toFixed(6)}</td><td>$${(Number(r.avg_price_usd) * 1000).toFixed(2)}</td></tr>`
        )
        .join("");

      const html = `<!doctype html>
<html>
<head>
  <title>Inference Benchmarker</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; }
    h1 { margin-bottom: 0.25rem; }
    .counter { font-size: 1.5rem; margin: 1rem 0; }
    table { border-collapse: collapse; margin-bottom: 2rem; }
    th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
    th { background: #f4f4f4; }
    section { margin-bottom: 2.5rem; }
  </style>
</head>
<body>
  <h1>Inference Benchmarker</h1>
  <p><a href="/bench">/bench</a> &middot; <a href="/bench?mode=image">/bench?mode=image</a> &middot; <a href="/runs">/runs</a></p>

  <div class="counter">Total runs: <strong>${totalRuns}</strong></div>

  <section>
    <h2>Unit economics — cost per call, per vendor</h2>
    <p style="color:#666; max-width:60ch;">Computed from real stored calls: a vendor's own live price when its API discloses one, otherwise a published rate-card fallback. Never estimated or fabricated.</p>
    <table>
      <tr><th>Mode</th><th>Vendor</th><th>Calls</th><th>Avg latency</th><th>Avg $/call</th><th>$/1,000 calls</th></tr>
      ${economicsRows || "<tr><td colspan=6>No priced runs yet.</td></tr>"}
    </table>
  </section>

  <section>
    <h2>Fastest vendors (leaderboard)</h2>
    <table>
      <tr><th>#</th><th>Vendor</th><th>Latency</th></tr>
      ${leaderboardRows || "<tr><td colspan=3>No data yet — call /bench first.</td></tr>"}
    </table>
  </section>

  <section>
    <h2>Last 20 runs</h2>
    <table>
      <tr><th>ID</th><th>Created</th><th>Mode</th><th>Vendor</th><th>Model</th><th>Latency (ms)</th><th>Price ($)</th></tr>
      ${runsRows || "<tr><td colspan=7>No runs yet.</td></tr>"}
    </table>
  </section>
</body>
</html>`;

      return new Response(html, { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/bench") {
      const mode = url.searchParams.get("mode");
      // /bench must always run a fresh benchmark — never let Cloudflare's edge cache
      // serve a stale response here (our own Redis cache below is a deliberate, separate thing).
      const noStoreHeaders = { "Cache-Control": "no-store" };

      if (mode === "video") {
        // Not part of the regular fan-out: video generation is slower and pricier per call
        // than image/text, so it's only run when explicitly requested.
        const result = await runFalVideo(env);
        await Promise.allSettled([
          saveRun(env, { mode: "video", vendor: result.vendor, model: result.model, latency_ms: result.latency_ms, price_usd: result.price_usd }),
          saveRawDoc(env, { mode: "video", vendor: result.vendor, model: result.model, latency_ms: result.latency_ms, raw: result.raw, error: result.error }),
        ]);
        return Response.json(
          { mode: "video", duration_seconds: VIDEO_DURATION_SECONDS, result },
          { headers: noStoreHeaders }
        );
      }

      if (mode === "image") {
        const results = await Promise.allSettled([
          runWorkersAiImage(env),
          runFal(env),
          runRunware(env),
          runReplicate(env),
          // runWaveSpeed(env), // disabled for now — working, kept for a possible future re-enable
        ]);

        const vendorResults: VendorImageResult[] = results.map((r) =>
          r.status === "fulfilled"
            ? r.value
            : { vendor: "unknown", model: "unknown", latency_ms: 0, price_usd: null, url: null, error: String(r.reason), raw: null }
        );

        // Save one row per vendor, in parallel, don't let a save failure block the response.
        // Both stores get written independently — Neon for clean SQL rows, Mongo for the full raw response.
        const saveOutcomes = await Promise.allSettled([
          ...vendorResults.flatMap((r) => [
            saveRun(env, { mode: "image", vendor: r.vendor, model: r.model, latency_ms: r.latency_ms, price_usd: r.price_usd }),
            saveRawDoc(env, { mode: "image", vendor: r.vendor, model: r.model, latency_ms: r.latency_ms, raw: r.raw, error: r.error }),
          ]),
          incrementRunsCounter(env),
          ...vendorResults.filter((r) => !r.error).map((r) => updateLeaderboard(env, r.vendor, r.latency_ms)),
        ]);
        for (const r of saveOutcomes) {
          if (r.status === "rejected") console.error("save failed:", r.reason);
        }

        return Response.json({ mode: "image", results: vendorResults }, { headers: noStoreHeaders });
      }

      // default: text mode — Workers AI + Replicate, in parallel, same resilience pattern as image mode.
      // The prompt is always identical (BENCH_PROMPT is a constant), so a single fixed cache key is correct.
      const TEXT_CACHE_KEY = "bench:text:cache";
      const cached = await getCachedBenchResult(env, TEXT_CACHE_KEY).catch(() => null);
      if (cached) {
        return Response.json({ mode: "text", cached: true, results: cached }, { headers: noStoreHeaders });
      }

      async function runWorkersAiText(): Promise<VendorTextResult> {
        const start = Date.now();
        try {
          const result: any = await env.AI.run(TEXT_MODEL, { messages: [{ role: "user", content: BENCH_PROMPT }] });
          const latency_ms = Date.now() - start;
          const completionTokens = result?.usage?.completion_tokens ?? null;
          const tokens_per_sec =
            completionTokens != null ? Math.round((completionTokens / (latency_ms / 1000)) * 100) / 100 : null;
          // Workers AI's own response includes a real "neurons" usage figure — convert that
          // to dollars using Cloudflare's published $/1000-neurons rate, rather than leaving blank.
          // (Calls within the free daily 10k-neuron allocation are genuinely $0 — this is the
          // marginal rate, useful for projecting cost at volume beyond the free tier.)
          const neurons = result?.usage?.neurons ?? null;
          const price_usd = neurons != null ? (neurons / 1000) * WORKERS_AI_USD_PER_1000_NEURONS : null;
          return {
            vendor: "workers-ai",
            model: TEXT_MODEL,
            latency_ms,
            price_usd,
            tokens_per_sec,
            output: result?.response ?? null,
            error: null,
            raw: result,
          };
        } catch (e: any) {
          return {
            vendor: "workers-ai",
            model: TEXT_MODEL,
            latency_ms: Date.now() - start,
            price_usd: null,
            tokens_per_sec: null,
            output: null,
            error: String(e?.message ?? e),
            raw: null,
          };
        }
      }

      const textResults = await Promise.allSettled([runWorkersAiText(), runReplicateText(env)]);
      const vendorTextResults: VendorTextResult[] = textResults.map((r) =>
        r.status === "fulfilled"
          ? r.value
          : {
              vendor: "unknown",
              model: "unknown",
              latency_ms: 0,
              price_usd: null,
              tokens_per_sec: null,
              output: null,
              error: String(r.reason),
              raw: null,
            }
      );

      const saveOutcomes2 = await Promise.allSettled([
        ...vendorTextResults.flatMap((r) => [
          saveRun(env, { mode: "text", vendor: r.vendor, model: r.model, latency_ms: r.latency_ms, price_usd: r.price_usd }),
          saveRawDoc(env, { mode: "text", vendor: r.vendor, model: r.model, latency_ms: r.latency_ms, raw: r.raw, error: r.error }),
        ]),
        incrementRunsCounter(env),
        ...vendorTextResults.filter((r) => !r.error).map((r) => updateLeaderboard(env, r.vendor, r.latency_ms)),
        setCachedBenchResult(env, TEXT_CACHE_KEY, vendorTextResults),
      ]);
      for (const r of saveOutcomes2) {
        if (r.status === "rejected") console.error("save failed:", r.reason);
      }

      return Response.json({ mode: "text", cached: false, results: vendorTextResults }, { headers: noStoreHeaders });
    }

    if (url.pathname === "/runs") {
      const results = await withPg(env, async (client) => {
        await client.query(RUNS_SCHEMA);
        const { rows } = await client.query(`SELECT * FROM runs ORDER BY id DESC LIMIT 20`);
        return rows;
      });
      const rows = results
        .map((r: any) => `<tr><td>${r.id}</td><td>${r.created_at}</td><td>${r.mode}</td><td>${r.vendor}</td><td>${r.model}</td><td>${r.latency_ms}</td><td>${r.price_usd ?? "-"}</td></tr>`)
        .join("");
      const html = `<!doctype html><html><head><title>Runs</title></head><body><h1>Last 20 runs</h1><table border="1" cellpadding="6"><tr><th>ID</th><th>Created</th><th>Mode</th><th>Vendor</th><th>Model</th><th>Latency (ms)</th><th>Price ($)</th></tr>${rows}</table></body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/analysis") {
      // Neon has latency/price for every attempt; Mongo's raw docs are the only place that
      // records whether each attempt actually succeeded. Join the two so failed (billing-rejected)
      // calls don't get mistaken for "fast" successful ones.
      const successOnlyStats = await withMongoWrite(env, async (collection) => {
        return collection
          .aggregate([
            { $match: { error: null } },
            {
              $group: {
                _id: { mode: "$mode", vendor: "$vendor" },
                successful_calls: { $sum: 1 },
                avg_latency_ms: { $avg: "$latency_ms" },
                min_latency_ms: { $min: "$latency_ms" },
                max_latency_ms: { $max: "$latency_ms" },
              },
            },
            { $sort: { "_id.mode": 1, avg_latency_ms: 1 } },
          ])
          .toArray();
      });

      const failureCounts = await withMongoWrite(env, async (collection) => {
        return collection
          .aggregate([
            { $match: { error: { $ne: null } } },
            { $group: { _id: { mode: "$mode", vendor: "$vendor" }, failed_calls: { $sum: 1 } } },
          ])
          .toArray();
      });

      const priceStats = await withPg(env, async (client) => {
        await client.query(RUNS_SCHEMA);
        const { rows } = await client.query(
          `SELECT mode, vendor, AVG(price_usd) AS avg_price_usd, COUNT(price_usd) AS priced_calls
           FROM runs WHERE price_usd IS NOT NULL GROUP BY mode, vendor`
        );
        return rows;
      });

      // CORS-open: this is read-only, non-sensitive aggregate data, fetched live by the
      // standalone cost-calculator artifact (a different origin).
      return Response.json(
        { successes: successOnlyStats, failures: failureCounts, prices: priceStats },
        { headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    if (url.pathname.startsWith("/images/")) {
      const key = url.pathname.replace("/images/", "");
      const object = await env.IMAGES.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      return new Response(object.body, { headers });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
