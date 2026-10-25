// Tells the page whether the server is set up. Never reveals the key.
module.exports = (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({
    configured: !!(process.env.GROQ_API_KEY || "").trim(),
    provider: "Groq",
    model: process.env.GROQ_MODEL || "auto",
  }));
};
