const express = require("express");
const { requireApiUser } = require("../lib/auth");
const { lookupCompanyByInn, isValidInn } = require("../lib/egrul");
const { lookupCompanyDomains } = require("../lib/inn-domain-sources");
const { buildOrgNameVariants } = require("../lib/org-name-variants");

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

router.get("/domains", requireApiUser(), async (req, res) => {
  const inn = String(req.query.inn || "").trim();
  if (!isValidInn(inn)) {
    res.status(400).json({ error: "INN must be 10 or 12 digits" });
    return;
  }

  try {
    const company = await lookupCompanyByInn(inn);
    if (!company || !company.fullName) {
      res.json({
        company: null,
        domains: [],
        domainDetails: [],
        matchedOrg: null,
        triedOrgs: [],
        sources: {},
        hasNetlasKey: false,
      });
      return;
    }

    const lookup = await lookupCompanyDomains(company);
    res.json({
      company,
      domains: lookup.domains,
      domainDetails: lookup.domainDetails,
      matchedOrg: lookup.matchedOrg,
      triedOrgs: lookup.searchVariants,
      searchVariants: buildOrgNameVariants(company),
      sources: lookup.sources,
      hasNetlasKey: lookup.hasNetlasKey,
    });
  } catch (err) {
    console.error("[egrul] domains error:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "INN domain lookup failed" });
  }
});

module.exports = { egrulRouter: router };
