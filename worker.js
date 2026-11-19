// Strom der Toten leaderboard API (Cloudflare Worker + D1).
// Static files are served by Workers static assets; only /api/* reaches this code.
//
//   POST /api/run          -> { token }                 start a run (call when the player deploys)
//   POST /api/score        { token, name, rounds, kills, shots, objectives (0-7), egg, map, mode } -> { ok, id, rank }
//   GET  /api/leaderboard  ?mode=std|chaos|all&limit=50 -> { scores: [...] }
//   DELETE /api/score/:id  header X-Admin-Key           remove a bad entry (needs ADMIN_KEY secret)
//
// Ranking: rounds (desc) > kills (desc) > bullets fired (asc, fewer = cleaner) > oldest first.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runs (
     token TEXT PRIMARY KEY,
     ip TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     used INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS scores (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     rounds INTEGER NOT NULL,
     kills INTEGER NOT NULL,
     shots INTEGER NOT NULL,
     objectives INTEGER NOT NULL DEFAULT 0,
     egg INTEGER NOT NULL DEFAULT 0,
     map TEXT NOT NULL,
     mode TEXT NOT NULL,
     duration INTEGER NOT NULL,
     ip TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS scores_rank ON scores (mode, rounds DESC, kills DESC, shots ASC, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS runs_ip ON runs (ip, started_at)`,
];

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  // Columns added after launch: add them to existing databases.
  const cols = (await db.prepare("PRAGMA table_info(scores)").all()).results.map((c) => c.name);
  for (const [name, def] of [["objectives", "INTEGER NOT NULL DEFAULT 0"], ["egg", "INTEGER NOT NULL DEFAULT 0"]]) {
    if (!cols.includes(name)) await db.prepare(`ALTER TABLE scores ADD COLUMN ${name} ${def}`).run();
  }
  schemaReady = true;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function ipHash(request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("strom:" + ip));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const now = () => Math.floor(Date.now() / 1000);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

// Most zombies a run could plausibly have killed by the given round (generous on purpose).
function killCap(rounds) {
  let total = 50;
  for (let n = 1; n <= rounds; n++) total += Math.round(6 + n * 3 + n * n * 0.08) + 8;
  return total;
}

function cleanName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
  return name.length >= 1 ? name : null;
}

async function startRun(request, env) {
  const ip = await ipHash(request);
  const t = now();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE ip = ? AND started_at > ?")
    .bind(ip, t - 600)
    .first();
  if (recent && recent.n >= 40) return json({ error: "Slow down a little." }, 429);
  const token = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO runs (token, ip, started_at) VALUES (?, ?, ?)").bind(token, ip, t),
    env.DB.prepare("DELETE FROM runs WHERE started_at < ? AND used = 0").bind(t - 86400 * 2),
  ]);
  return json({ token });
}

async function submitScore(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request." }, 400);
  }
  const name = cleanName(body.name);
  const rounds = int(body.rounds), kills = int(body.kills), shots = int(body.shots);
  const objectives = int(body.objectives) ?? 0;
  const egg = body.egg === true || body.egg === 1 ? 1 : 0;
  if (objectives > 7 || (egg && objectives !== 7)) return json({ error: "Bad objectives." }, 400);
  const mode = body.mode === "chaos" ? "chaos" : "std";
  const map = typeof body.map === "string" ? body.map.slice(0, 24) : "Eisenhof";
  if (!name) return json({ error: "Enter a name (1–16 characters)." }, 400);
  if (rounds === null || kills === null || shots === null || rounds < 1 || rounds > 1000)
    return json({ error: "Bad stats." }, 400);
  if (typeof body.token !== "string") return json({ error: "Missing run token." }, 400);

  const run = await env.DB.prepare("SELECT started_at, used FROM runs WHERE token = ?").bind(body.token).first();
  if (!run) return json({ error: "Unknown run." }, 400);
  if (run.used) return json({ error: "This run was already posted." }, 409);

  const t = now();
  const duration = t - run.started_at;
  // Light sanity checks. They stop casual fakes, not a determined cheater.
  if (duration < (rounds - 1) * 4) return json({ error: "That run was too fast to be real." }, 400);
  if (duration > 60 * 60 * 12) return json({ error: "Run expired." }, 400);
  if (kills > killCap(rounds)) return json({ error: "Too many kills for that round." }, 400);

  const ip = await ipHash(request);
  const claim = await env.DB.prepare("UPDATE runs SET used = 1 WHERE token = ? AND used = 0").bind(body.token).run();
  if (!claim.meta || claim.meta.changes !== 1) return json({ error: "This run was already posted." }, 409);

  const ins = await env.DB.prepare(
    "INSERT INTO scores (name, rounds, kills, shots, objectives, egg, map, mode, duration, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(name, rounds, kills, shots, objectives, egg, map, mode, duration, ip, t)
    .run();
  const id = ins.meta.last_row_id;

  const better = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM scores WHERE mode = ?1 AND (
       rounds > ?2 OR (rounds = ?2 AND kills > ?3) OR (rounds = ?2 AND kills = ?3 AND shots < ?4)
       OR (rounds = ?2 AND kills = ?3 AND shots = ?4 AND id < ?5))`
  )
    .bind(mode, rounds, kills, shots, id)
    .first();
  return json({ ok: true, id, rank: (better ? better.n : 0) + 1 });
}

async function leaderboard(url, env) {
  const modeQ = url.searchParams.get("mode") || "std";
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
  const where = modeQ === "all" ? "" : "WHERE mode = ?1";
  const stmt = env.DB.prepare(
    `SELECT id, name, rounds, kills, shots, objectives, egg, map, mode, created_at FROM scores ${where}
     ORDER BY rounds DESC, kills DESC, shots ASC, created_at ASC LIMIT ${limit}`
  );
  const res = await (modeQ === "all" ? stmt : stmt.bind(modeQ === "chaos" ? "chaos" : "std")).all();
  return json({ scores: res.results || [] });
}

async function deleteScore(request, env, id) {
  if (!env.ADMIN_KEY || request.headers.get("x-admin-key") !== env.ADMIN_KEY) return json({ error: "Nope." }, 403);
  await env.DB.prepare("DELETE FROM scores WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      await ensureSchema(env.DB);
      const m = request.method;
      if (url.pathname === "/api/run" && m === "POST") return await startRun(request, env);
      if (url.pathname === "/api/score" && m === "POST") return await submitScore(request, env);
      if (url.pathname === "/api/leaderboard" && m === "GET") return await leaderboard(url, env);
      const del = url.pathname.match(/^\/api\/score\/(\d+)$/);
      if (del && m === "DELETE") return await deleteScore(request, env, Number(del[1]));
      return json({ error: "Not found." }, 404);
    } catch (err) {
      return json({ error: "Server error.", detail: String(err && err.message) }, 500);
    }
  },
};
