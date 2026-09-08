// Manual additions to Env for Worker secrets (set via `wrangler secret put`).
// These are not bindings, so `wrangler types` doesn't generate them automatically.
interface Env {
  FAL_KEY: string;
  RUNWARE_KEY: string;
  REPLICATE_KEY: string;
  MONGO_URL: string;
  UPSTASH_URL: string;
  UPSTASH_TOKEN: string;
  WAVESPEED_KEY: string;
}
