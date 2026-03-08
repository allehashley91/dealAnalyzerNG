// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Health check — Railway pings this to confirm the app is alive
app.get("/health", (req, res) => res.status(200).send("OK"));

// Proxy to Anthropic — keeps API key server-side
app.post("/api/analyze", async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY environment variable is not set." });
    }

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

// Catch-all — serve index.html for any unmatched route
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Bind to 0.0.0.0 — required for Railway to route traffic correctly
app.listen(PORT, "0.0.0.0", () => {
  console.log(`New Growth Deal Analyzer running on port ${PORT}`);
});
