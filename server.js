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

  // Parse address — keep commas, ATTOM handles both formats fine
  const parts = address.split(",").map(s => s.trim());
  if (parts.length < 2) {
    return res.status(400).json({ ok: false, error: "Address must include street and city/state (e.g. 123 Main St, Denver, CO)" });
  }
  const address1    = parts[0];
  const address2    = parts.slice(1).join(", ").trim();

  const result = { ok: true, sources: {}, debug: { address1, address2 } };

  let attomId   = null;
  let latitude  = null;
  let longitude = null;

  // ── 1. Property Detail ──────────────────────────────────────────────────────
  try {
    const data = await attomGet("/property/detail", { address1, address2: address2 });
    const prop = data?.property?.[0];
    if (prop) {
      const b = prop.building || {};
      const lot = prop.lot || {};
      const sum = prop.summary || {};
      attomId   = prop.identifier?.attomId;
      latitude  = parseFloat(prop.location?.latitude);
      longitude = parseFloat(prop.location?.longitude);
      result.matchedAddress = prop.address?.oneLine;
      result.property = {
        attomId,
        beds:      b.rooms?.beds,
        baths:     b.rooms?.bathsTotal || b.rooms?.bathsFull,
        sqft:      b.size?.livingSize || b.size?.universalSize,
        yearBuilt: sum.yearBuilt,
        lotSqft:   lot.lotSize1,
        propType:  sum.propType || sum.propSubType,
        county:    prop.area?.countrysecsubd || prop.area?.countrySecSubd,
        zip:       prop.address?.postal1,
        latitude,
        longitude,
      };
      result.sources.property = "attom";
    }
  } catch(e) {
    result.sources.property = "error: " + e.message;
  }

  // ── 2. AVM — use /attomavm/detail with attomId (more reliable than address) ─
  try {
    if (!attomId) throw new Error("No attomId from property detail");
    const data = await attomGet("/attomavm/detail", { attomid: attomId });
    const avm = data?.property?.[0]?.avm;
    if (avm) {
      result.avm = {
        value:      avm.amount?.value,
        low:        avm.amount?.low,
        high:       avm.amount?.high,
        asIsValue:  avm.amount?.value,
        confidence: avm.condition?.indicator || avm.amount?.scr,
      };
      result.sources.avm = "attom";
    } else {
      result.sources.avm = "no AVM data for this property";
    }
  } catch(e) {
    result.sources.avm = "error: " + e.message;
  }

  // ── 3. Tax Assessment ───────────────────────────────────────────────────────
  try {
    const taxParams = attomId
      ? { attomid: attomId }
      : { address1, address2: address2 };
    const data = await attomGet("/assessment/detail", taxParams);
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

  // ── 4. Sold Comps — /sale/snapshot with lat/long radius ─────────────────────
  try {
    if (!latitude || !longitude) throw new Error("No lat/long from property detail — cannot do radius comp search");

    const now = new Date();
    const fmt = d => `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;

    const subjectBeds  = result.property?.beds  ? parseInt(result.property.beds)  : null;
    const subjectBaths = result.property?.baths ? parseFloat(result.property.baths) : null;
    const subjectSqft  = result.property?.sqft  ? parseInt(result.property.sqft)   : null;

    // ── Helper: convert raw ATTOM property to comp object with match metadata ──
    const toComp = (p, searchNote) => {
      const b         = p.building || {};
      const sale      = p.sale || {};
      const sqft      = b.size?.universalsize || b.size?.livingsize || 0;
      const salePrice = sale.amount?.saleamt || 0;
      const beds      = b.rooms?.beds ? parseInt(b.rooms.beds) : null;
      const baths     = b.rooms?.bathstotal || b.rooms?.bathsfull ? parseFloat(b.rooms?.bathstotal || b.rooms?.bathsfull) : null;

      // Similarity score — lower = better match
      // Components: sqft diff (weighted heaviest), bed diff, bath diff, recency
      let score = 0;
      const flags = [];

      if (subjectSqft && sqft) {
        const sqftPct = Math.abs(sqft - subjectSqft) / subjectSqft;
        score += sqftPct * 40;  // up to 40 points for sqft diff
        if (sqftPct > 0.30) flags.push(`sqft off ${Math.round(sqftPct*100)}%`);
      }
      if (subjectBeds && beds !== null) {
        const bedDiff = Math.abs(beds - subjectBeds);
        score += bedDiff * 10;  // 10 pts per bed off
        if (bedDiff > 1) flags.push(`${bedDiff} bed diff`);
      }
      if (subjectBaths && baths !== null) {
        const bathDiff = Math.abs(baths - subjectBaths);
        score += bathDiff * 5;  // 5 pts per bath off
        if (bathDiff > 1) flags.push(`${bathDiff} bath diff`);
      }
      // Recency bonus — subtract up to 5 pts for very recent sales
      const soldDate = sale.saleTransDate || "";
      const monthsAgo = soldDate ? (now - new Date(soldDate)) / (1000*60*60*24*30) : 36;
      score += Math.min(monthsAgo * 0.3, 10); // up to 10 pts for age

      return {
        address:      [p.address?.line1, p.address?.locality, p.address?.countrySubd].filter(Boolean).join(", "),
        beds:         String(beds ?? ""),
        baths:        String(baths ?? ""),
        sqft,
        salePrice,
        pricePerSqft: sqft > 0 ? Math.round(salePrice / sqft) : 0,
        soldDate:     soldDate ? soldDate.slice(0, 10) : "",
        notes:        `ATTOM verified sale${searchNote ? " · "+searchNote : ""}`,
        source:       "attom",
        matchScore:   Math.round(score * 10) / 10,
        matchFlags:   flags,  // passed to frontend for display
      };
    };

    // ── Helper: post-filter and score a raw result set ──
    // Drops comps outside ±30% sqft (if subject sqft known), then sorts by score
    const processResults = (props, searchNote) => {
      const comps = props.map(p => toComp(p, searchNote));
      let filtered = comps;
      if (subjectSqft) {
        const within30 = comps.filter(c => c.sqft === 0 || Math.abs(c.sqft - subjectSqft) / subjectSqft <= 0.30);
        if (within30.length >= 3) filtered = within30;
        // if ±30% gives fewer than 3, fall back to ±50% before giving up on sqft filter
        else {
          const within50 = comps.filter(c => c.sqft === 0 || Math.abs(c.sqft - subjectSqft) / subjectSqft <= 0.50);
          if (within50.length >= 3) filtered = within50;
          // else keep all — sqft filter would leave us with too few
        }
      }
      filtered.sort((a, b) => a.matchScore - b.matchScore);
      return filtered;
    };

    // Build bed/bath filter — exact match first, widen in fallback
    const exactBedBath = {};
    if (subjectBeds)  { exactBedBath.minbeds  = subjectBeds;  exactBedBath.maxbeds  = subjectBeds; }
    if (subjectBaths) { exactBedBath.minbaths = Math.floor(subjectBaths); exactBedBath.maxbaths = Math.ceil(subjectBaths) + 1; }

    const looseBedBath = {};
    if (subjectBeds)  { looseBedBath.minbeds  = Math.max(1, subjectBeds  - 1); looseBedBath.maxbeds  = subjectBeds  + 1; }
    if (subjectBaths) { looseBedBath.minbaths = Math.max(1, subjectBaths - 1); looseBedBath.maxbaths = subjectBaths + 1; }

    // Ladder: exact beds first, then ±1, then no filter — each with progressive radius/date
    const searches = [
      { months: 12, radius: "0.5", bedBath: exactBedBath, label: "exact beds" },
      { months: 24, radius: "1.0", bedBath: exactBedBath, label: "exact beds" },
      { months: 36, radius: "1.5", bedBath: exactBedBath, label: "exact beds" },
      { months: 24, radius: "1.0", bedBath: looseBedBath, label: "±1 bed/bath" },
      { months: 36, radius: "2.0", bedBath: looseBedBath, label: "±1 bed/bath" },
      { months: 36, radius: "2.0", bedBath: {},           label: "no bed filter" },
    ];

    let bestComps  = null;
    let usedSearch = null;

    for (const s of searches) {
      const start = new Date(now);
      start.setMonth(start.getMonth() - s.months);
      const data = await attomGet("/sale/snapshot", {
        latitude, longitude,
        radius:              s.radius,
        startSaleSearchDate: fmt(start),
        endSaleSearchDate:   fmt(now),
        pageSize:            "25",
        propertytype:        "SFR",
        ...s.bedBath,
      });
      const props = data?.property?.filter(p => p?.sale?.amount?.saleamt > 0);
      if (!props || props.length === 0) continue;

      const scored = processResults(props, s.label !== "exact beds" ? s.label : null);
      if (scored.length >= 3) {
        bestComps  = scored;
        usedSearch = s;
        break;
      }
    }

    if (bestComps && bestComps.length > 0) {
      result.comps = bestComps.slice(0, 5);
      result.subjectSqft = subjectSqft; // pass to frontend for flag rendering
      result.sources.comps = `attom (${usedSearch.months}mo / ${usedSearch.radius}mi${usedSearch.label !== "exact beds" ? " · "+usedSearch.label : ""} — ${bestComps.length} scored)`;
    } else {
      result.sources.comps = "no SFR sales found within 36 months / 2mi — using AI estimates";
    }
  } catch(e) {
    result.sources.comps = "error: " + e.message;
  }

  res.json(result);
});

// GET /api/attom/compdebug?address=... — shows exactly what sale/snapshot returns
app.get("/api/attom/compdebug", async (req, res) => {
  const address = req.query.address;
  if (!address) return res.json({ error: "Pass ?address=123 Main St, City, ST" });
  const parts = address.split(",").map(s => s.trim());
  const address1 = parts[0];
  const address2 = parts.slice(1).join(", ").trim();

  // First get lat/long
  let latitude, longitude, attomId;
  try {
    const d = await attomGet("/property/detail", { address1, address2 });
    const prop = d?.property?.[0];
    attomId   = prop?.identifier?.attomId;
    latitude  = parseFloat(prop?.location?.latitude);
    longitude = parseFloat(prop?.location?.longitude);
  } catch(e) { return res.json({ error: "Property detail failed: " + e.message }); }

  if (!latitude || !longitude) return res.json({ error: "No lat/long returned", attomId, latitude, longitude });

  const now   = new Date();
  const start = new Date(now);
  start.setMonth(start.getMonth() - 24);
  const fmt = d => `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;

  // Try without any filters first so we can see raw results
  try {
    const data = await attomGet("/sale/snapshot", {
      latitude, longitude,
      radius: "1.0",
      startSaleSearchDate: fmt(start),
      endSaleSearchDate:   fmt(now),
      pageSize: "10",
    });
    const summary = data?.property?.map(p => ({
      address: p.address?.oneLine,
      sale: p.sale,
      buildingRooms: p.building?.rooms,
      buildingSize: p.building?.size,
    }));
    res.json({ attomId, latitude, longitude, total: data?.status?.total, returned: summary?.length, properties: summary });
  } catch(e) {
    res.json({ error: e.message, attomId, latitude, longitude });
  }
});

// GET /api/attom/debug?address=... — returns raw ATTOM responses for troubleshooting
app.get("/api/attom/debug", async (req, res) => {
  const address = req.query.address;
  if (!address) return res.json({ error: "Pass ?address=123 Main St, City, ST" });
  const parts = address.split(",").map(s => s.trim());
  const address1 = parts[0];
  // Try both formats so we can see which one works
  const address2WithComma    = parts.slice(1).join(", ").trim();
  const address2WithoutComma = parts.slice(1).join(" ").trim();
  const out = { address1, address2WithComma, address2WithoutComma, results: {} };
  // Try with comma
  try {
    const d = await attomGet("/property/detail", { address1, address2: address2WithComma });
    out.results.withComma = { attomId: d?.property?.[0]?.identifier?.attomId, lat: d?.property?.[0]?.location?.latitude, lng: d?.property?.[0]?.location?.longitude, matched: d?.property?.[0]?.address?.oneLine, status: d?.status?.msg };
  } catch(e) { out.results.withComma = { error: e.message }; }
  // Try without comma
  try {
    const d = await attomGet("/property/detail", { address1, address2: address2WithoutComma });
    out.results.withoutComma = { attomId: d?.property?.[0]?.identifier?.attomId, lat: d?.property?.[0]?.location?.latitude, lng: d?.property?.[0]?.location?.longitude, matched: d?.property?.[0]?.address?.oneLine, status: d?.status?.msg };
  } catch(e) { out.results.withoutComma = { error: e.message }; }
  res.json(out);
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
