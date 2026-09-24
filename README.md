# Best value LLM

Live: https://felipereyel.github.io/bestmodel/

A single static page with two views backed by [Artificial Analysis](https://artificialanalysis.ai/) data:

- **API value** — every model plotted as Intelligence Index against blended API price, with the **value frontier** (models where nothing cheaper is also smarter) highlighted.
- **Self-host** — every open-weights model plotted as Intelligence Index against total parameter count, with the **self-host frontier** (the best model you can run at each size) and a lookup table of the best model per memory band for people running local models.

A GitHub Actions cron refreshes the data daily, commits when something changed, and redeploys to GitHub Pages.

Inspired by [vps.sonnylab.com/model-value-2026-07](https://vps.sonnylab.com/model-value-2026-07.html), but data-driven instead of hand-maintained.

## Layout

| Path | What it is |
|---|---|
| `index.html` | The page. Vanilla HTML/SVG/JS, no build step. Loads `data/models.json` at runtime. Two tabs: API value and self-host. |
| `data/models.json` | Trimmed snapshot of the AA `/data/llms/models` response, joined with parameter metadata. Ships with a hand-entered seed so the page renders before the first fetch. |
| `data/changelog.json` | Per-run diff (added / removed / re-scored / re-priced / re-sized), newest first, capped at 90 entries. Rendered in the "What changed" card. |
| `scripts/fetch-aa.mjs` | Fetches the API, scrapes parameter counts from the AA model page, normalises, diffs against the previous snapshot, writes both files. Writes nothing if the data is identical. |
| `.github/workflows/update-and-deploy.yml` | Daily cron + manual trigger + push to `main`. Fetch, commit if changed, deploy `dist/` to GitHub Pages. |
| `scripts/build.sh` | Copies the page and data into `dist/`, which is uploaded as the Pages artifact. |

## Data sources

The free AA data API (`/api/v2/data/llms/models`) exposes scores, pricing and speed but **not** parameter counts. Total parameters, active parameters, the open-weights flag, context window and licence are read from the React Server Components payload embedded in any AA model detail page (the payload carries the full model dataset). `scripts/fetch-aa.mjs` tries a few candidate model slugs so a rename does not break the run, and degrades gracefully to no parameter metadata if the scrape fails.

Models with a score and either a hosted price **or** open weights + a known parameter count are kept. That second group is what the self-host tab needs: many open-weights models have no hosted API price, but a self-hoster still cares about them.

## Setup

1. Get a free API key: sign up at https://artificialanalysis.ai/, open the Insights Platform, create an API key (1,000 requests/day, attribution required).
2. Create the GitHub repo and push:
   ```sh
   git init -b main && git add -A && git commit -m "Initial site"
   gh repo create bestmodel --public --source=. --push
   ```
3. Add the key as a repository secret named `AA_API_KEY`:
   ```sh
   gh secret set AA_API_KEY
   ```
4. Enable GitHub Pages with **Source: GitHub Actions** (Settings → Pages), so the workflow can publish:
   ```sh
   gh api -X POST repos/:owner/:repo/pages -f build_type=workflow
   ```
5. Run the workflow once by hand so the seed data is replaced and the first deploy happens:
   ```sh
   gh workflow run update-and-deploy.yml
   ```

The cron runs at 06:17 UTC daily. Scheduled runs on a repo with no activity for 60 days get paused by GitHub; a manual run re-enables them.

## Local

```sh
export AA_API_KEY=...      # or copy .env.example to .env and source it
npm run fetch              # writes data/models.json + data/changelog.json
npm run serve              # http://localhost:8080
```

The page fetches JSON, so open it over HTTP rather than as a `file://` URL.

## Notes

- The API value frontier is computed client-side for whichever metric is selected (Intelligence, Coding, Math), over the full model set, so filtering by maker shows where that maker's models sit against everyone.
- The self-host frontier is computed the same way but sorted by total parameters instead of price.
- Blended price is AA's 3:1 input:output blend. Cached-input, batch and fast-mode pricing are ignored.
- Memory bands assume ~4-bit quantisation at roughly 0.55 GB per billion parameters, plus headroom. Actual memory also depends on context and KV cache.
- Data attribution: Artificial Analysis, https://artificialanalysis.ai/. Required by their API terms.
