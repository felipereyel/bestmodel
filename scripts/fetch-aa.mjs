#!/usr/bin/env node
/**
 * Pull the LLM leaderboard from the Artificial Analysis Data API (free tier)
 * and write a trimmed, stable snapshot to data/models.json. If the model data
 * is unchanged from the previous snapshot nothing is written, so the cron only
 * produces a commit when something actually moved.
 *
 * The free endpoint is paginated (200 per page) and already carries cost per
 * Intelligence Index task, so a single pass gives us everything. It does not
 * expose AA's blended price (Pro only); that is the plain 3:1 input:output
 * blend, so it is computed here from the per-token prices, which matched AA's
 * published figure to 3 dp across the whole legacy snapshot.
 *
 * Parameter counts and the open-weights flag are not in the free API. They
 * are scraped from AA's public pages: the release catalogue for the
 * open-weights list, and per-model detail pages for the metadata itself (see
 * the scrape section below). This is best effort; if the scrape fails the
 * run degrades to API-only data.
 *
 * Also maintains data/changelog.json: per-run diff of models added, removed,
 * or re-scored / re-priced.
 *
 * Docs: https://artificialanalysis.ai/data-api/docs  (spec: /api/v2/openapi)
 * Free tier is 100 requests per 24h; a run uses one request per page.
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
const ENDPOINT = "https://artificialanalysis.ai/api/v2/language/models/free";
const MAX_PAGES = 50;
const CHANGELOG_MAX = 90;

const apiKey = process.env.AA_API_KEY;
if (!apiKey) {
  console.error("AA_API_KEY is not set. Get a free key at https://artificialanalysis.ai/ and export it (or add it as a GitHub Actions secret).");
  process.exit(1);
}

const positive = (v) => (v != null && v > 0 ? v : null); // AA reports 0 when a speed benchmark has not run
const round = (v, dp = 2) => (v == null || Number.isNaN(+v) ? null : Math.round(+v * 10 ** dp) / 10 ** dp);

const headers = { "x-api-key": apiKey, accept: "application/json" };

/** Walk every page of the free endpoint. Returns the raw model objects plus the index version. */
async function fetchAllModels() {
  const data = [];
  let indexVersion = null;
  for (let page = 1, more = true; more; page++) {
    const res = await fetch(`${ENDPOINT}?page=${page}`, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`AA API ${res.status} ${res.statusText} on page ${page}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    if (!Array.isArray(json.data)) throw new Error("Unexpected response shape: no data[]");
    data.push(...json.data);
    indexVersion ??= json.intelligence_index_version ?? null;
    more = json.pagination?.has_more === true && page < MAX_PAGES;
  }
  return { data, indexVersion };
}

function normalise(raw, meta) {
  const ev = raw.evaluations ?? {};
  const pr = raw.pricing ?? {};
  const perf = raw.performance ?? {};
  const m = meta ?? {};
  const input = positive(round(pr.price_1m_input_tokens, 3));
  const output = positive(round(pr.price_1m_output_tokens, 3));
  // AA's 3:1 input:output blend (Pro-only field), computed from the unrounded prices so ties round the same way AA's did.
  const blended = input != null && output != null ? positive(round((3 * pr.price_1m_input_tokens + pr.price_1m_output_tokens) / 4, 3)) : null;
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    creator: raw.model_creator?.name ?? "Unknown",
    index: round(ev.artificial_analysis_intelligence_index, 1),
    coding: round(ev.artificial_analysis_coding_index, 1),
    math: round(ev.artificial_analysis_math_index, 1),
    blended,
    input,
    output,
    task: round(positive(raw.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost), 4),
    tps: positive(round(perf.median_output_tokens_per_second, 0)),
    ttft: positive(round(perf.median_time_to_first_token_seconds, 2)),
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

// AA no longer embeds the full model dataset in every page payload. A detail
// page's RSC payload carries an `initialModels` array (~30 records: the page's
// model, its effort variants and a rotating featured set), and
// /models/releases carries a `releases` array with the full catalogue,
// including the open-weights flag per release. Both are embedded as escaped
// JSON in the flight data. Strategy: parse the releases catalogue to learn
// which slugs are open-weights, fetch the detail page of each open-weights
// model in the snapshot (variant slugs redirect to the release page), and
// collect per-model metadata keyed by the model uuid, which matches the
// Data API ids.

function extractJsonArray(text, startIdx) {
  let i = text.indexOf("[", startIdx);
  if (i === -1) return null;
  let depth = 0, j = i;
  while (j < text.length) {
    const c = text[j];
    if (c === '"') {
      j++;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === '"') break;
        j++;
      }
    } else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return text.slice(i, j + 1);
    }
    j++;
  }
  return null;
}

// The balanced scan may overrun into sibling flight data, so on "trailing
// data" errors trim to the position JSON parsing reports as the end of the
// first value.
function tryParseJson(cand) {
  try { return JSON.parse(cand); } catch (err) {
    const m = /after JSON at position (\d+)/.exec(err.message);
    if (m) { try { return JSON.parse(cand.slice(0, +m[1])); } catch {} }
  }
  return null;
}

function parseEmbeddedArray(html, key) {
  const needle = `\\"${key}\\":[`;
  let idx = html.indexOf(needle);
  while (idx !== -1) {
    const raw = extractJsonArray(html, idx + needle.length - 1);
    if (raw) {
      const v = tryParseJson(raw) ?? tryParseJson(raw.replaceAll('\\"', '"'));
      if (Array.isArray(v)) return v;
    }
    idx = html.indexOf(needle, idx + 1);
  }
  return null;
}

function recordsToMeta(records) {
  const recs = new Map();
  for (const r of records ?? []) {
    if (typeof r?.id !== "string" || !/^[0-9a-f-]{36}$/.test(r.id) || recs.has(r.id)) continue;
    recs.set(r.id, {
      params: r.parameters ?? null,
      activeParams: r.inferenceParametersActiveBillions ?? null,
      openWeights: r.isOpenWeights ?? null,
      sizeClass: r.sizeClass ?? null,
      contextTokens: r.contextWindowTokens ?? null,
      license: r.licenseName ?? null,
    });
  }
  return recs;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

async function pool(items, n, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      results[k] = await fn(items[k]).catch(() => null);
    }
  }));
  return results;
}

async function fetchModelMeta(data) {
  let releases;
  try {
    releases = parseEmbeddedArray(await fetchText("https://artificialanalysis.ai/models/releases"), "releases");
  } catch (err) {
    console.warn(`WARN: could not fetch release catalogue (${err.message}); continuing without parameter metadata.`);
    return new Map();
  }
  const openSlugs = new Set((releases ?? []).filter((r) => r?.slug && r.isOpenWeights === true).map((r) => r.slug));
  if (!openSlugs.size) {
    console.warn("WARN: release catalogue parsed but no open-weights releases found; continuing without parameter metadata.");
    return new Map();
  }

  // Which detail pages to fetch: one per open-weights release represented in
  // the snapshot. Variant slugs (effort / reasoning suffixes) redirect to the
  // release page, so strip trailing segments until the slug is a known
  // open-weights release.
  const pages = new Set();
  for (const raw of data) {
    if (raw.evaluations?.artificial_analysis_intelligence_index == null) continue;
    let slug = raw.slug;
    for (let i = 0; i < 4 && !openSlugs.has(slug); i++) {
      const cut = slug.lastIndexOf("-");
      if (cut === -1) break;
      slug = slug.slice(0, cut);
    }
    if (openSlugs.has(slug)) pages.add(slug);
  }

  const metas = new Map();
  let fetched = 0;
  const slugs = [...pages];
  await pool(slugs, 8, async (slug) => {
    const records = parseEmbeddedArray(await fetchText(`https://artificialanalysis.ai/models/${slug}`), "initialModels");
    fetched++;
    for (const [id, meta] of recordsToMeta(records)) if (!metas.has(id)) metas.set(id, meta);
  });
  console.log(`Parameter metadata: ${metas.size} models from ${fetched}/${slugs.length} detail pages.`);
  return metas;
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
    if (p.task != null && m.task != null && p.task !== m.task) fields.push({ field: "cost/task", from: p.task, to: m.task });
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
  const { data, indexVersion } = await fetchAllModels();

  const meta = await fetchModelMeta(data);

  // Keep models with a score and either a hosted price or open weights + a parameter
  // count. The latter gives self-hosters a target even when no provider lists a price.
  const models = data
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
    intelligence_index_version: indexVersion,
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
