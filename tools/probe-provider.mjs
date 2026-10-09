#!/usr/bin/env node
/**
 * Standalone launcher for the model-route probe.
 *
 * The implementation lives in `paseo-plugin/lib/probe-provider.mjs` so the
 * published `paseo-dsh` CLI and this repo script share one copy. Prefer
 * `npx paseo-dsh probe ...` (no clone needed); this exists for a checkout.
 *
 * Usage:
 *   node tools/probe-provider.mjs \
 *     --base-url https://gateway.example/v1 \
 *     --api-key-env MY_API_KEY \
 *     --model deepseek-v4-flash
 */
import { runProbe } from "../paseo-plugin/lib/probe-provider.mjs";

await runProbe(process.argv.slice(2), "node tools/probe-provider.mjs");
