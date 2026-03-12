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

// ─── ATTOM Integration ────────────────────────────────────────────────────────
const ATTOM_BASE = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";

async function attomGet(path, params) {
  const ATTOM_KEY = process.env.ATTOM_API_KEY; // read live every call
  if (!ATTOM_KEY) throw new Error("ATTOM_API_KEY not set in environment");
  const url = new URL(ATTOM_BASE + path);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { "apikey": ATTOM_KEY, "Accept": "application/json" }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ATTOM ${res.status}: ${txt.slice(0,200)}`);
  }
  return res.json();
}

// POST /api/attom/lookup — master endpoint: property details + AVM + taxes + comps
app.post("/api/attom/lookup", async (req, res) => {
  const { address } = req.body;
  if (!address || address.trim().length < 5) {
    return res.status(400).json({ ok: false, error: "Address required" });
  }

  // Parse address into street + city/state for ATTOM
  // Expected formats: "123 Main St, Denver, CO" or "123 Main St, Denver, CO 80201"
  const parts = address.split(",").map(s => s.trim());
  if (parts.length < 2) {
    return res.status(400).json({ ok: false, error: "Address must include street and city/state (e.g. 123 Main St, Denver, CO)" });
  }
  const address1 = parts[0];
  const cityStateZip = parts.slice(1).join(", ");

  const result = { ok: true, sources: {} };

  // ── 1. Property Detail ──────────────────────────────────────────────────────
  try {
    const data = await attomGet("/property/detail", { address1, address2: cityStateZip });
    const prop = data?.property?.[0];
    if (prop) {
      const b = prop.building || {};
      const lot = prop.lot || {};
      const sum = prop.summary || {};
      result.property = {
        attomId:    prop.identifier?.attomId,
        beds:       b.rooms?.beds,
        baths:      b.rooms?.bathsTotal || b.rooms?.bathsFull,
        sqft:       b.size?.livingSize || b.size?.universalSize,
        yearBuilt:  sum.yearBuilt,
        lotSqft:    lot.lotSize1,
        propType:   sum.propType || sum.propSubType,
        county:     prop.area?.countrySecSubd,
        zip:        prop.address?.postal1,
        state:      prop.address?.stateFips ? undefined : prop.address?.country,
      };
      result.sources.property = "attom";
    }
  } catch(e) {
    result.sources.property = "error: " + e.message;
  }

  // ── 2. AVM (Automated Valuation Model) ─────────────────────────────────────
  try {
    const data = await attomGet("/avm/detail", { address1, address2: cityStateZip });
    const avm = data?.property?.[0]?.avm;
    if (avm) {
      result.avm = {
        value:    avm.amount?.value,
        low:      avm.amount?.low,
        high:     avm.amount?.high,
        asIsValue: avm.amount?.value,   // AVM = current market value = AS-IS
        confidence: avm.condition?.indicator,
      };
      result.sources.avm = "attom";
    }
  } catch(e) {
    result.sources.avm = "error: " + e.message;
  }

  // ── 3. Tax Assessment ───────────────────────────────────────────────────────
  try {
    const data = await attomGet("/assessment/detail", { address1, address2: cityStateZip });
    const asmt = data?.property?.[0]?.assessment;
    if (asmt) {
      result.tax = {
        annualTax:    asmt.tax?.taxAmt,
        assessedValue: asmt.assessed?.assdTtlValue,
        marketValue:  asmt.market?.mktTtlValue,
        taxYear:      asmt.tax?.taxYear,
      };
      result.sources.tax = "attom";
    }
  } catch(e) {
    result.sources.tax = "error: " + e.message;
  }

  // ── 4. Sold Comps (Sales History of nearby properties) ─────────────────────
  try {
    const data = await attomGet("/saleshistory/snapshot", {
      address1, address2: cityStateZip,
      radius: "0.25",     // quarter mile radius
      pageSize: "10",
    });
    const sales = data?.property;
    if (sales && sales.length > 0) {
      result.comps = sales
        .filter(p => p.sale?.amount?.saleAmt > 0)
        .slice(0, 5)
        .map(p => {
          const b = p.building || {};
          const sale = p.sale || {};
          const sqft = b.size?.livingSize || b.size?.universalSize || 0;
          const salePrice = sale.amount?.saleAmt || 0;
          return {
            address:      [p.address?.line1, p.address?.locality, p.address?.countrySubd].filter(Boolean).join(", "),
            beds:         String(b.rooms?.beds || ""),
            baths:        String(b.rooms?.bathsTotal || b.rooms?.bathsFull || ""),
            sqft:         sqft,
            salePrice:    salePrice,
            pricePerSqft: sqft > 0 ? Math.round(salePrice / sqft) : 0,
            soldDate:     sale.saleTransDate ? sale.saleTransDate.slice(0, 10) : "",
            notes:        `ATTOM verified sale · ${b.size?.livingSize ? b.size.livingSize + " sqft" : "sqft unknown"}`,
            source:       "attom",
          };
        });
      result.sources.comps = "attom";
    }
  } catch(e) {
    result.sources.comps = "error: " + e.message;
  }

  res.json(result);
});

// GET /api/attom/status — lets frontend check if key is configured
app.get("/api/attom/status", (req, res) => {
  // Re-read at request time so we catch keys added after startup
  const key = process.env.ATTOM_API_KEY;
  res.json({
    configured: !!key,
    keyLength: key ? key.length : 0,
    keyPrefix: key ? key.slice(0,4)+"…" : null,
  });
});

// ─── Catch-all + Server Start (must be last) ──────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`New Growth Deal Analyzer running on port ${PORT}`);
});
