// Global leaderboard for the Counting Outs Drill "Time Attack" mode.
// Storage: Upstash Redis (sorted set) over its REST API — no npm deps required.
//
// Required environment variables (set in Vercel project settings):
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//
// GET  /api/leaderboard            -> { scores: [{ name, correct, attempted, ts }, ...] }  (top 20)
// POST /api/leaderboard  { name, correct, attempted, durationSec } -> { ok, scores }
//
// NOTE: scores are computed client-side, so this board is inherently spoofable.
// Basic guards below (sanity caps, light rate limit) deter casual abuse only.

const ZKEY = 'outs:leaderboard';
const TOP_N = 20;
const KEEP_N = 200;          // trim the set to the best N runs
const MAX_CORRECT = 90;      // generous ceiling for a 3-minute run (~2s each)
const DURATION = 180;        // seconds — must match the front-end challenge length

async function redis(command) {
  // The Upstash marketplace integration may expose either UPSTASH_* or KV_* names.
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('leaderboard backend not configured');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function parseMember(m) {
  try { const o = JSON.parse(m); return o && typeof o.name === 'string' ? o : null; }
  catch { return null; }
}

async function topScores() {
  // highest scores first, with their numeric score
  const flat = await redis(['ZRANGE', ZKEY, '0', String(TOP_N - 1), 'REV', 'WITHSCORES']);
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    const o = parseMember(flat[i]);
    if (o) out.push({ name: o.name, correct: o.correct, attempted: o.attempted, ts: o.ts });
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ scores: await topScores() });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};

      // ---- validate ----
      let name = String(body.name ?? 'Anon').replace(/[<>\n\r\t]/g, '').trim().slice(0, 16) || 'Anon';
      const correct = Number(body.correct);
      const attempted = Number(body.attempted);
      const durationSec = Number(body.durationSec);

      if (!Number.isInteger(correct) || !Number.isInteger(attempted))
        return res.status(400).json({ error: 'invalid score' });
      if (correct < 0 || attempted < 0 || correct > attempted)
        return res.status(400).json({ error: 'invalid score' });
      if (correct > MAX_CORRECT)
        return res.status(400).json({ error: 'score exceeds plausible maximum' });
      if (durationSec && Math.abs(durationSec - DURATION) > 5)
        return res.status(400).json({ error: 'invalid run duration' });

      // ---- light per-IP rate limit: max ~1 submit / 3s ----
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const rlKey = `outs:rl:${ip}`;
      const n = await redis(['INCR', rlKey]);
      if (n === 1) await redis(['EXPIRE', rlKey, '3']);
      else if (n > 1) return res.status(429).json({ error: 'too many submissions — slow down' });

      // ---- store ----
      const member = JSON.stringify({ name, correct, attempted, ts: Date.now() });
      await redis(['ZADD', ZKEY, String(correct), member]);
      // keep only the best KEEP_N runs (drop the lowest)
      await redis(['ZREMRANGEBYRANK', ZKEY, '0', String(-KEEP_N - 1)]);

      return res.status(200).json({ ok: true, scores: await topScores() });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'server error' });
  }
};
