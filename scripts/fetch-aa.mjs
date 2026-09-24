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
// AA embeds its full per-model metadata (parameter counts, open-weights flag, context,
// licence) in the React Server Components payload of any model detail page. We scrape
// one page to get parameter counts, which the free data API does not expose. A few
// candidate slugs are tried so a model rename or removal does not break the run.
const META_PAGES = [
  "https://artificialanalysis.ai/models/qwen3-8-27b",
  "https://artificialanalysis.ai/models/deepseek-v4-1-flash",
  "https://artificialanalysis.ai/models/glm-5-3",
  "https://artificialanalysis.ai/models/kimi-k3",
];
const CHANGELOG_MAX = 90;

const apiKey = process.env.AA_API_KEY;
if (!apiKey) {
  console.error("AA_API_KEY is not set. Get a free key at https://artificialanalysis.ai/ and export it (or add it as a GitHub Actions secret).");
  process.exit(1);
}

const positive = (v) => (v != null && v > 0 ? v : null); // AA reports 0 when a speed benchmark has not run
const round = (v, dp = 2) => (v == null || Number.isNaN(+v) ? null : Math.round(+v * 10 ** dp) / 10 ** dp);

function normalise(raw, meta) {
  const ev = raw.evaluations ?? {};
  const pr = raw.pricing ?? {};
  const m = meta ?? {};
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    creator: raw.model_creator?.name ?? "Unknown",
    creator_slug: raw.model_creator?.slug ?? null,
    index: round(ev.artificial_analysis_intelligence_index, 1),
    coding: round(ev.artificial_analysis_coding_index, 1),
    math: round(ev.artificial_analysis_math_index, 1),
    blended: positive(round(pr.price_1m_blended_3_to_1, 3)),
    input: positive(round(pr.price_1m_input_tokens, 3)),
    output: positive(round(pr.price_1m_output_tokens, 3)),
    tps: positive(round(raw.median_output_tokens_per_second, 0)),
    ttft: positive(round(raw.median_time_to_first_token_seconds, 2)),
    // Self-hosting metadata (scraped from the AA model page RSC payload).
    params: round(m.params, 3),                 // total parameters, billions
    active_params: round(m.activeParams, 3),    // parameters run per forward pass, billions (MoE); null for dense
    open_weights: m.openWeights ?? null,
    size_class: m.sizeClass ?? null,
    context: m.contextTokens ?? null,
    license: m.license ?? null,
    url: raw.slug ? `https://artificialanalysis.ai/models/${raw.slug}` : null,
  };
}

/* ---------- parameter metadata scrape (best effort) ---------- */
const Q = '"';
const BS = "\\";

// Pull `{id -> {params, activeParams, openWeights, sizeClass, contextTokens, license}}`
// out of an AA model page's escaped React Server Components payload.
function extractModelMeta(html) {
  const idRe = new RegExp(`${BS}${BS}${Q}id${BS}${BS}${Q}:${BS}${BS}${Q}([0-9a-f-]{36})${BS}${BS}${Q}`, "g");
  const ids = [...html.matchAll(idRe)].map((x) => ({ id: x[1], i: x.index }));
  const grab = (idx, key) => {
    const pat = `${BS}${BS}${Q}${key}${BS}${BS}${Q}:(?:${BS}${BS}${Q}([^${BS}${BS}${Q}]*)${BS}${BS}${Q}|([0-9.]+)|(true|false|null))`;
    const match = html.slice(idx, idx + 4000).match(new RegExp(pat));
    if (!match) return undefined;
    if (match[1] !== undefined) return match[1];
    if (match[3] === "null") return null;
    if (match[3] === "true") return true;
    if (match[3] === "false") return false;
    return match[2] !== undefined ? +match[2] : undefined;
  };
  const pRe = new RegExp(`${BS}${BS}${Q}parameters${BS}${BS}${Q}:([0-9.]+|null)`, "g");
  const recs = new Map();
  let m;
  while ((m = pRe.exec(html))) {
    let cand = null;
    for (const x of ids) { if (x.i < m.index) cand = x; else break; }
    if (!cand || recs.has(cand.id)) continue;
    recs.set(cand.id, {
      params: m[1] === "null" ? null : +m[1],
      activeParams: grab(cand.i, "inferenceParametersActiveBillions"),
      openWeights: grab(cand.i, "isOpenWeights"),
      sizeClass: grab(cand.i, "sizeClass"),
      contextTokens: grab(cand.i, "contextWindowTokens"),
      license: grab(cand.i, "licenseName"),
    });
  }
  return recs;
}

async function fetchModelMeta() {
  let lastErr = "no candidate pages";
  for (const url of META_PAGES) {
    try {
      const res = await fetch(url, { headers: { accept: "text/html" } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const meta = extractModelMeta(await res.text());
      if (meta.size < 50) throw new Error(`only ${meta.size} records parsed`);
      console.log(`Parameter metadata: ${meta.size} models (${[...meta.values()].filter((x) => x.openWeights).length} open weights) from ${url}.`);
      return meta;
    } catch (err) {
      lastErr = err.message;
    }
  }
  console.warn(`WARN: could not fetch parameter metadata (${lastErr}); continuing without it.`);
  return new Map();
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
    if (p.params !== m.params) fields.push({ field: "params", from: p.params, to: m.params });
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

  const meta = await fetchModelMeta();

  // Keep models with a score and either a hosted price or open weights + a parameter
  // count. The latter gives self-hosters a target even when no provider lists a price.
  const models = json.data
    .map((raw) => normalise(raw, meta.get(raw.id)))
    .filter((m) => m.index != null && ((m.blended != null && m.blended > 0) || (m.open_weights === true && m.params != null)))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (models.length < 10) throw new Error(`Only ${models.length} usable models returned; refusing to overwrite snapshot.`);

  const prev = await readJson(MODELS_PATH, null);
  const prevModels = prev?.models ?? [];
  const isSeed = prev?.source === "seed";

  // Guard against a transient metadata-scrape failure shrinking the snapshot: if the
  // previous snapshot had open-weights rows and this run has none, keep the old data.
  if (!isSeed && meta.size === 0 && prevModels.some((m) => m.open_weights === true)) {
    console.warn("Refusing to overwrite: parameter metadata was unavailable and would drop open-weights models.");
    return;
  }

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
    open_weights_count: models.filter((m) => m.open_weights === true).length,
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
