# strom-der-toten-site

Garrett's site. Static files served by Cloudflare Workers (static assets).

- `index.html` → `/`
- `games.html` → `/games`
- `strom-der-toten.html` → `/strom-der-toten` (the game, exported from the Claude artifact)

Every push to `main` redeploys via Cloudflare Workers Builds.
To update the game, replace `strom-der-toten.html` with the new build.
