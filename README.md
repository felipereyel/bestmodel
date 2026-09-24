# Best value LLM

Live: https://bestvaluemodel.terrydjony.workers.dev/ (Cloudflare) · https://terryds.github.io/bestvaluemodel/ (GitHub Pages mirror)

A single static page that plots every model on the [Artificial Analysis](https://artificialanalysis.ai/) Intelligence Index against its blended API price and highlights the **value frontier** (models where nothing cheaper is also smarter). A GitHub Actions cron refreshes the data daily and redeploys to GitHub Pages only when something actually changed.

Inspired by [vps.sonnylab.com/model-value-2026-07](https://vps.sonnylab.com/model-value-2026-07.html), but data-driven instead of hand-maintained.

## Layout

| Path | What it is |
|---|---|
| `index.html` | The page. Vanilla HTML/SVG/JS, no build step. Loads `data/models.json` at runtime. |
| `data/models.json` | Trimmed snapshot of the AA `/data/llms/models` response. Ships with a hand-entered seed so the page renders before the first fetch. |
| `data/changelog.json` | Per-run diff (added / removed / re-scored / re-priced), newest first, capped at 90 entries. Rendered in the "What changed" card. |
| `scripts/fetch-aa.mjs` | Fetches the API, normalises, diffs against the previous snapshot, writes both files. Writes nothing if the data is identical. |
| `.github/workflows/update-and-deploy.yml` | Daily cron + manual trigger + push to `main`. Fetch, commit if changed, deploy to GitHub Pages and Cloudflare. |
| `wrangler.jsonc`, `scripts/build.sh`, `_headers` | Cloudflare Workers static-assets config. `build.sh` copies the page, data and headers into `dist/`, which wrangler uploads. |

## Setup

1. Get a free API key: sign up at https://artificialanalysis.ai/, open the Insights Platform, create an API key (1,000 requests/day, attribution required).
2. Create the GitHub repo and push:
   ```sh
   git init -b main && git add -A && git commit -m "Initial site"
   gh repo create bestvaluemodel --public --source=. --push
   ```
3. Add the key as a repository secret named `AA_API_KEY`:
   ```sh
   gh secret set AA_API_KEY
   ```
4. Enable Pages with source **GitHub Actions** (Settings → Pages). The workflow also tries to enable it itself via `configure-pages`.
5. Run the workflow once by hand so the seed data is replaced:
   ```sh
   gh workflow run update-and-deploy.yml
   ```

6. Cloudflare (optional, already live from a local `npm run deploy`): create an API token with the **Edit Cloudflare Workers** template at https://dash.cloudflare.com/profile/api-tokens and store it as the `CLOUDFLARE_API_TOKEN` secret. Without it the Cloudflare job is skipped and only GitHub Pages updates.
   ```sh
   gh secret set CLOUDFLARE_API_TOKEN
   ```

The cron runs at 06:17 UTC daily. Scheduled runs on a repo with no activity for 60 days get paused by GitHub; a manual run re-enables them.

## Local

```sh
export AA_API_KEY=...      # or copy .env.example to .env and source it
npm run fetch              # writes data/models.json + data/changelog.json
npm run serve              # http://localhost:8080
npm run deploy             # build dist/ and push it to Cloudflare (needs `npx wrangler login` once)
```

The page fetches JSON, so open it over HTTP rather than as a `file://` URL.

## Notes

- The frontier is computed client-side for whichever metric is selected (Intelligence, Coding, Math), over the full model set, so filtering by maker shows where that maker's models sit against everyone.
- Blended price is AA's 3:1 input:output blend. Cached-input, batch and fast-mode pricing are ignored.
- Data attribution: Artificial Analysis, https://artificialanalysis.ai/. Required by their API terms.
