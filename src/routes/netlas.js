const express = require("express");
const { requireApiUser } = require("../lib/auth");
const { findOrgDomainsByText, getNetlasApiKeys } = require("../lib/netlas-org-domains");

const router = express.Router();

function buildNetlasHeaders(apiKey) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    vary: "web",
    Origin: "https://app.netlas.io",
    Referer: "https://app.netlas.io/",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function netlasDiscoveryProxy(nodeType, nodeValue) {
  const apiKey = getNetlasApiKeys()[0] || null;
  const countRes = await fetch("https://app.netlas.io/api/discovery/node_count/", {
    method: "POST",
    headers: buildNetlasHeaders(apiKey),
    body: JSON.stringify({
      node_type: nodeType,
      node_value: nodeValue,
    }),
  });

  if (!countRes.ok) {
    throw new Error(`Netlas node_count failed with status ${countRes.status}`);
  }

  const data = await countRes.json();
  const groups = Array.isArray(data) ? data : [data];
  return groups.flatMap((group) => (Array.isArray(group.aggregations) ? group.aggregations : []));
}

router.get("/org-domains", requireApiUser(), async (req, res) => {
  const org = String(req.query.org || "").trim();
  if (!org) {
    res.status(400).json({ error: "Missing 'org' parameter" });
    return;
  }

  try {
    const lookup = await findOrgDomainsByText(org);
    res.json({
      domains: lookup.domains,
      matchedOrg: lookup.matchedOrg,
      triedOrgs: lookup.triedOrgs,
      hasNetlasKey: lookup.hasNetlasKey,
    });
  } catch (err) {
    if (err && err.code === "NETLAS_RATE_LIMIT") {
      res.status(429).json({
        error: "Netlas daily request limit exceeded. Add NETLAS_API_KEY in Settings or try again tomorrow.",
      });
      return;
    }
    console.error("[netlas-proxy] org-domains error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/domain-dns-records", requireApiUser(), async (req, res) => {
  const domain = req.query.domain;
  if (!domain) {
    return res.status(400).json({ error: "Missing 'domain' parameter" });
  }

  try {
    const aggregations = await netlasDiscoveryProxy("domain", domain);
    const fieldMap = { 32: "TXT", 31: "MX", 30: "NS", 29: "A" };
    const results = { TXT: [], MX: [], NS: [], A: [] };

    for (const entry of aggregations) {
      const key = fieldMap[entry.search_field_id];
      if (key && Array.isArray(entry.preview)) {
        results[key] = entry.preview;
      }
    }

    res.json({ domain, records: results });
  } catch (err) {
    console.error("[netlas-proxy] dns error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { netlasRouter: router };
