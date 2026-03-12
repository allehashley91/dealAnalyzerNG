// server.js
require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const { Pool } = require("pg");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── PostgreSQL ────────────────────────────────────────────────────────────────
let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  pool.query(`
    CREATE TABLE IF NOT EXISTS deals (
      id             BIGSERIAL PRIMARY KEY,
      saved_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      address        TEXT,
      verdict        TEXT,
      arv            NUMERIC,
      purchase_price NUMERIC,
      net_profit     NUMERIC,
      profit_pct     NUMERIC,
      snapshot       JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deals_saved_at_idx ON deals (saved_at DESC);
  `)
  .then(() => console.log("✅ PostgreSQL connected — deals table ready"))
  .catch(e => console.error("❌ PostgreSQL init error:", e.message));
} else {
  console.warn("⚠️  DATABASE_URL not set — history will not persist between sessions");
}

// ─── History Routes ────────────────────────────────────────────────────────────

app.get("/api/history", async (req, res) => {
  if (!pool) return res.json({ ok: false, error: "No database connected", deals: [] });
  try {
    const result = await pool.query(
      "SELECT id, saved_at, address, verdict, arv, purchase_price, net_profit, profit_pct, snapshot FROM deals ORDER BY saved_at DESC LIMIT 200"
    );
    res.json({ ok: true, deals: result.rows });
  } catch (e) {
    console.error("GET /api/history error:", e.message);
    res.status(500).json({ ok: false, error: e.message, deals: [] });
  }
});

app.post("/api/history/save", async (req, res) => {
  if (!pool) return res.status(503).json({ ok: false, error: "No database connected" });
  const { snapshot } = req.body;
  if (!snapshot) return res.status(400).json({ ok: false, error: "Missing snapshot" });
  try {
    const result = await pool.query(
      `INSERT INTO deals (address, verdict, arv, purchase_price, net_profit, profit_pct, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, saved_at`,
      [
        snapshot.address || "Unnamed",
        snapshot.verdict || "",
        snapshot.arv || 0,
        snapshot.purchasePrice || 0,
        snapshot.netProfit || 0,
        snapshot.profitPct || 0,
        JSON.stringify(snapshot),
      ]
    );
    res.json({ ok: true, id: result.rows[0].id, saved_at: result.rows[0].saved_at });
  } catch (e) {
    console.error("POST /api/history/save error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete("/api/history/:id", async (req, res) => {
  if (!pool) return res.status(503).json({ ok: false, error: "No database connected" });
  try {
    await pool.query("DELETE FROM deals WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/history error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Existing Routes ───────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.status(200).send("OK"));

app.get("/api/health", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: "ANTHROPIC_API_KEY is not set." });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "Hi" }] }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ ok: false, error: data?.error?.message || JSON.stringify(data) });
    res.json({ ok: true, db: !!pool });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY environment variable is not set." });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    res.json(data);
  } catch (e) {
    console.error("API proxy error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`New Growth Deal Analyzer running on port ${PORT}`);
});
