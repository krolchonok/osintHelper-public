const express = require("express");
const { requireApiUser } = require("../lib/auth");
const { lookupCompanyByInn, isValidInn } = require("../lib/egrul");

const router = express.Router();

router.get("/lookup", requireApiUser(), async (req, res) => {
  const inn = String(req.query.inn || "").trim();
  if (!isValidInn(inn)) {
    res.status(400).json({ error: "INN must be 10 or 12 digits" });
    return;
  }

  try {
    const company = await lookupCompanyByInn(inn);
    res.json({ company: company || null });
  } catch (err) {
    console.error("[egrul] lookup error:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "EGRUL lookup failed" });
  }
});

module.exports = { egrulRouter: router };
