# TokenTrim

Offline-first PWA that compresses long LLM prompts in the browser with LLMLingua-2.
No server, no API keys. Requires Node 20.19+ (or 22.12+) to build.

## Run locally

```sh
npm install
npm run dev        # http://localhost:5173
```

Test the offline behaviour against a production build (the service worker is not active in `npm run dev`):

```sh
npm run build
npm run preview    # open the printed URL, tap "Initialize / Download Offline Model"
```

Once the status pill says "Offline ready", switch to Airplane Mode and reload. Everything still works.

## Deploy to GitHub Pages

```sh
git init && git add . && git commit -m "TokenTrim"
git branch -M main
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

Then in the repo: **Settings > Pages > Build and deployment > Source: GitHub Actions**.
Every push to `main` runs `.github/workflows/deploy.yml` and publishes `dist/`.

## Notes

- The model is read from `MODEL_ID` in `src/worker/compressor.worker.ts` and cached in Cache Storage as `transformers-cache`.
- Single-threaded WASM is used on purpose, so no COOP/COEP headers are needed.
- On iPhone, use Share > Add to Home Screen so Safari does not evict the cached model after 7 days of inactivity.
