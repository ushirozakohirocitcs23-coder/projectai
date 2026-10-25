// VibeAI chat endpoint for Vercel. The API key lives in the GROQ_API_KEY environment variable,
// never in the website files. This function validates input, picks an available model and streams the reply.

const BASE = (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
const WANTED_MODEL = process.env.GROQ_MODEL || "auto";

const LIMITS = { maxMessages: 24, maxMessageChars: 4000, maxHistoryChars: 12000, temperature: 0.8, maxTokens: 900 };
const SYSTEM_PROMPT =
  "You are VibeAI, a friendly, smart and helpful assistant. Help with everyday questions, " +
  "study help, creative ideas, entertainment, suggestions and casual conversation. " +
  "Reply in the same language the user writes in (including Filipino/Taglish). " +
  "Be clear and well organised, and keep answers reasonably short unless the user asks for detail. " +
  "If you are not sure about something, say so instead of guessing.";

// ---- tiny best-effort rate limit per visitor (resets when the server instance restarts) ----
const hits = new Map();
const RATE = { windowMs: 60000, max: 15 };
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > RATE.max;
}

// ---- model list cache ----
let modelCache = { at: 0, ids: [] };
async function availableModels(key) {
  if (modelCache.ids.length && Date.now() - modelCache.at < 30 * 60 * 1000) return modelCache.ids;
  try {
    const r = await fetch(BASE + "/models", { headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return [];
    const j = await r.json();
    const ids = (j.data || [])
      .filter((m) => m && m.id && m.active !== false && !/whisper|tts|guard|orpheus|embed|safeguard|moderation|playai/i.test(m.id))
      .map((m) => m.id);
    if (ids.length) modelCache = { at: Date.now(), ids };
    return ids;
  } catch (e) {
    return [];
  }
}
function pickModel(wanted, ids) {
  if (!ids.length) return !wanted || wanted === "auto" ? "llama-3.1-8b-instant" : wanted;
  if (wanted && wanted !== "auto" && ids.includes(wanted)) return wanted;
  const prefer = ["llama-3.3-70b-versatile", "llama-3.1-70b-versatile", "llama-3.1-8b-instant", "llama-4", "llama", "gpt-oss-120b", "gpt-oss-20b", "gemma", "mixtral", "qwen"];
  for (const p of prefer) {
    const hit = ids.find((id) => id.toLowerCase().includes(p));
    if (hit) return hit;
  }
  return ids[0];
}

function fail(res, status, code, message) {
  if (res.headersSent) return res.end();
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ error: { code, message } }));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return fail(res, 405, "method", "Use POST.");

  const key = (process.env.GROQ_API_KEY || "").trim();
  if (!key) return fail(res, 500, "no_key", "No API key yet. In Vercel go to Settings > Environment Variables, add GROQ_API_KEY, then redeploy.");

  const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  if (limited(ip)) return fail(res, 429, "rate_limit", "Too many messages too fast. Wait a minute and try again.");

  // ---- validate input ----
  let data = req.body;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { data = null; } }
  if (!data || !Array.isArray(data.messages)) return fail(res, 400, "bad_request", "Invalid request.");

  let msgs = [];
  for (const m of data.messages) {
    if (!m || typeof m.content !== "string" || (m.role !== "user" && m.role !== "assistant")) return fail(res, 400, "bad_request", "Invalid message.");
    const text = m.content.trim();
    if (text) msgs.push({ role: m.role, content: text.slice(0, LIMITS.maxMessageChars) });
  }
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return fail(res, 400, "bad_request", "The last message must come from the user.");

  msgs = msgs.slice(-LIMITS.maxMessages);
  const kept = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    used += msgs[i].content.length;
    if (used > LIMITS.maxHistoryChars && kept.length) break;
    kept.unshift(msgs[i]);
  }
  kept.unshift({ role: "system", content: SYSTEM_PROMPT });

  const model = pickModel(WANTED_MODEL, await availableModels(key));

  // ---- call the AI and stream the answer ----
  const controller = new AbortController();
  res.on("close", () => controller.abort());   // user pressed Stop or left the page
  const timeout = setTimeout(() => controller.abort(), 55000);

  let upstream;
  try {
    upstream = await fetch(BASE + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key, Accept: "text/event-stream" },
      body: JSON.stringify({ model, messages: kept, stream: true, temperature: LIMITS.temperature, max_tokens: LIMITS.maxTokens }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    if (controller.signal.aborted && res.writableEnded) return;
    return fail(res, 502, "network", "Could not reach the AI service. Please try again. (" + (e && e.message ? e.message : "network error") + ")");
  }

  if (!upstream.ok) {
    clearTimeout(timeout);
    let msg = "Provider returned HTTP " + upstream.status;
    try { const j = await upstream.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
    if (upstream.status === 401) return fail(res, 401, "bad_key", "The API key was rejected. Check GROQ_API_KEY in Vercel. (" + msg + ")");
    if (upstream.status === 429) return fail(res, 429, "rate_limit", "Free limit reached or too many requests. Wait a little, then try again. (" + msg + ")");
    if (upstream.status === 400 || upstream.status === 404) return fail(res, 400, "model", "Provider rejected the request (model used: " + model + "): " + msg);
    return fail(res, 502, "provider", msg);
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-VibeAI-Model", model.replace(/[^A-Za-z0-9._\/:-]/g, ""));
  res.setHeader("Access-Control-Expose-Headers", "X-VibeAI-Model");

  try {
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (e) {
    // aborted by Stop, or the connection dropped mid-answer
  } finally {
    clearTimeout(timeout);
    res.end();
  }
};
