const express = require("express");
const { requireApiUser } = require("../lib/auth");

const router = express.Router();

// Returns flat array of all aggregation entries from the Netlas discovery response
async function netlasDiscoveryProxy(nodeType, nodeValue) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "vary": "web",
    "Origin": "https://app.netlas.io",
    "Referer": "https://app.netlas.io/"
  };

  // node_count returns the full result directly as an array of { aggregations: [...] }
  const countRes = await fetch("https://app.netlas.io/api/discovery/node_count/", {
    method: "POST",
    headers,
    body: JSON.stringify({
      node_type: nodeType,
      node_value: nodeValue
    })
  });

  if (!countRes.ok) {
    throw new Error(`Netlas node_count failed with status ${countRes.status}`);
  }

  const data = await countRes.json();

  // Response is an array of groups, each with its own aggregations array — flatten them all
  const groups = Array.isArray(data) ? data : [data];
  const allAggregations = groups.flatMap(group => Array.isArray(group.aggregations) ? group.aggregations : []);

  return allAggregations;
}

router.get("/org-domains", requireApiUser(), async (req, res) => {
  const org = req.query.org;
  if (!org) {
    return res.status(400).json({ error: "Missing 'org' parameter" });
  }

  try {
    // search_field_id 80 is "Domain with same organization (Domain WHOIS)"
    const aggregations = await netlasDiscoveryProxy("organization", org);

    // Find the domain aggregation entry (search_field_id 80) and extract preview domains
    const domainEntry = aggregations.find(item => item.search_field_id === 80);
    const domains = Array.isArray(domainEntry?.preview) ? domainEntry.preview : [];

    res.json({ domains });
  } catch (err) {
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
    // Fetch all aggregations for the domain in one request
    const aggregations = await netlasDiscoveryProxy("domain", domain);

    // search_field_id mappings:
    // 32: TXT, 31: MX, 30: NS, 29: A
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
