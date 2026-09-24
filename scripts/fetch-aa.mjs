#!/usr/bin/env node
/**
 * Pull the LLM leaderboard from the Artificial Analysis free API and write
 * a trimmed, stable snapshot to data/models.json. If the model data is
 * unchanged from the previous snapshot nothing is written, so a daily cron
 * only produces a commit when something actually moved.
 *
 * Also maintains data/changelog.json: per-run diff of models added, removed,
 * or re-scored / re-priced.
 *
 * Attribution required by AA terms: https://artificialanalysis.ai/
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const MODELS_PATH = path.join(DATA_DIR, "models.json");
const CHANGELOG_PATH = path.join(DATA_DIR, "changelog.json");
const ENDPOINT = "https://artificialanalysis.ai/api/v2/data/llms/models";
const CHANGELOG_MAX = 90;

const apiKey = process.env.AA_API_KEY;
if (!apiKey) {
  console.error("AA_API_KEY is not set. Get a free key at https://artificialanalysis.ai/ and export it (or add it as a GitHub Actions secret).");
  process.exit(1);
}

const positive = (v) => (v != null && v > 0 ? v : null); // AA reports 0 when a speed benchmark has not run
const round = (v, dp = 2) => (v == null || Number.isNaN(+v) ? null : Math.round(+v * 10 ** dp) / 10 ** dp);

function normalise(raw) {
  const ev = raw.evaluations ?? {};
  const pr = raw.pricing ?? {};
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    creator: raw.model_creator?.name ?? "Unknown",
    creator_slug: raw.model_creator?.slug ?? null,
    index: round(ev.artificial_analysis_intelligence_index, 1),
    coding: round(ev.artificial_analysis_coding_index, 1),
    math: round(ev.artificial_analysis_math_index, 1),
    blended: round(pr.price_1m_blended_3_to_1, 3),
    input: round(pr.price_1m_input_tokens, 3),
    output: round(pr.price_1m_output_tokens, 3),
    tps: positive(round(raw.median_output_tokens_per_second, 0)),
    ttft: positive(round(raw.median_time_to_first_token_seconds, 2)),
    url: raw.slug ? `https://artificialanalysis.ai/models/${raw.slug}` : null,
  };
}

async function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
}

function diff(prevModels, nextModels) {
  const byId = (arr) => new Map(arr.map((m) => [m.id, m]));
  const prev = byId(prevModels), next = byId(nextModels);
  const added = [], removed = [], changed = [];
  for (const [id, m] of next) {
    const p = prev.get(id);
    if (!p) { added.push({ name: m.name, creator: m.creator, index: m.index, blended: m.blended }); continue; }
    const fields = [];
    if (p.index !== m.index) fields.push({ field: "index", from: p.index, to: m.index });
    if (p.blended !== m.blended) fields.push({ field: "blended", from: p.blended, to: m.blended });
    if (p.input !== m.input) fields.push({ field: "input", from: p.input, to: m.input });
    if (p.output !== m.output) fields.push({ field: "output", from: p.output, to: m.output });
    if (fields.length) changed.push({ name: m.name, creator: m.creator, fields });
  }
  for (const [id, p] of prev) if (!next.has(id)) removed.push({ name: p.name, creator: p.creator, index: p.index, blended: p.blended });
  return { added, removed, changed };
}

const stableKey = (models) => JSON.stringify(models.map((m) => {
  const { url, ...rest } = m; // url derives from slug
  return rest;
}));

async function main() {
  const res = await fetch(ENDPOINT, { headers: { "x-api-key": apiKey, accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AA API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!Array.isArray(json.data)) throw new Error("Unexpected response shape: no data[]");

  const models = json.data
    .map(normalise)
    .filter((m) => m.index != null && m.blended != null && m.blended > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (models.length < 10) throw new Error(`Only ${models.length} usable models returned; refusing to overwrite snapshot.`);

  const prev = await readJson(MODELS_PATH, null);
  const prevModels = prev?.models ?? [];
  const isSeed = prev?.source === "seed";

  if (prev && !isSeed && stableKey(prevModels) === stableKey(models)) {
    console.log(`No change: ${models.length} models identical to snapshot from ${prev.fetched_at}.`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const snapshot = {
    fetched_at: new Date().toISOString(),
    source: "artificialanalysis.ai",
    endpoint: ENDPOINT,
    prompt_options: json.prompt_options ?? null,
    attribution: "Data from Artificial Analysis (https://artificialanalysis.ai/). Attribution required.",
    count: models.length,
    models,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(MODELS_PATH, JSON.stringify(snapshot, null, 2) + "\n");

  if (prev && !isSeed) {
    const d = diff(prevModels, models);
    if (d.added.length || d.removed.length || d.changed.length) {
      const log = await readJson(CHANGELOG_PATH, []);
      log.unshift({ date: today, ...d });
      await writeFile(CHANGELOG_PATH, JSON.stringify(log.slice(0, CHANGELOG_MAX), null, 2) + "\n");
    }
    console.log(`Updated: ${models.length} models. +${d.added.length} / -${d.removed.length} / ~${d.changed.length} changed.`);
  } else {
    if (!existsSync(CHANGELOG_PATH)) await writeFile(CHANGELOG_PATH, "[]\n");
    console.log(`Wrote first real snapshot: ${models.length} models.`);
  }
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
