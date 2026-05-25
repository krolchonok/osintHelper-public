const express = require("express");
const { requireApiUser } = require("../lib/auth");

const router = express.Router();

async function netlasDiscoveryProxy(nodeType, nodeValue, fieldId) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "vary": "web",
    "Origin": "https://app.netlas.io",
    "Referer": "https://app.netlas.io/"
  };

  // Step 1: Get node_count and X-Count-Id
  const countRes = await fetch("https://app.netlas.io/api/discovery/node_count/", {
    method: "POST",
    headers,
    body: JSON.stringify({
      node_type: nodeType,
      node_value: nodeValue,
      search_field_id: fieldId
    })
  });

  if (!countRes.ok) {
    throw new Error(`Netlas node_count failed with status ${countRes.status}`);
  }

  const countId = countRes.headers.get("x-count-id");
  if (!countId) {
    throw new Error("Netlas failed to return x-count-id");
  }

  // Step 2: Get actual results using node_result and x-count-id
  const resultRes = await fetch("https://app.netlas.io/api/discovery/node_result/", {
    method: "POST",
    headers: {
      ...headers,
      "X-Count-Id": countId
    },
    body: JSON.stringify({
      node_type: nodeType,
      node_value: nodeValue,
      search_field_id: fieldId
    })
  });

  if (!resultRes.ok) {
    throw new Error(`Netlas node_result failed with status ${resultRes.status}`);
  }

  return await resultRes.json();
}

router.get("/org-domains", requireApiUser(), async (req, res) => {
  const org = req.query.org;
  if (!org) {
    return res.status(400).json({ error: "Missing 'org' parameter" });
  }

  try {
    // search_field_id 80 is \"Domain with same organization (Domain WHOIS)\"
    // node_type \"organization\"
    const data = await netlasDiscoveryProxy(\"organization\", org, 80);
    
    // Extract domains from aggregations
    const domains = (data.aggregations || [])
      .filter(item => item.node_type === \"domain\")
      .map(item => item.node_value);

    res.json({ domains });
  } catch (err) {
    console.error(\"[netlas-proxy] error:\", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { netlasRouter: router };
