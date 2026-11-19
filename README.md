# strom-der-toten-site

Garrett's site + the Strom der Toten leaderboard, on Cloudflare Workers.

| File | URL |
|---|---|
| `index.html` | `/` |
| `games.html` | `/games` |
| `strom-der-toten.html` | `/strom-der-toten` (the game) |
| `leaderboard.html` | `/leaderboard` |
| `worker.js` | `/api/*` leaderboard API (D1 database `strom-leaderboard`) |

Every push to `main` redeploys via Cloudflare Workers Builds.

Leaderboard ranking: round reached, then kills, then fewer bullets fired.
To remove a bad entry: set an `ADMIN_KEY` secret on the Worker, then
`curl -X DELETE https://<site>/api/score/<id> -H "x-admin-key: <key>"`.
