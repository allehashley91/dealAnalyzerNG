// server.js
// Run: node server.js
// Requires: npm install express cors node-fetch dotenv

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

// Use native fetch (Node 18+) or node-fetch
const fetch = globalThis.fetch || require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve the frontend HTML file
app.use(express.static(path.join(__dirname, "public")));

// Proxy route — keeps API key server-side, never exposed to browser
app.post("/api/analyze", async (req, res) => {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
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
    console.error("API error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`New Growth Deal Analyzer running at http://localhost:${PORT}`);
});
