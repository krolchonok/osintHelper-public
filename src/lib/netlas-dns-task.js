const { getDbState } = require("../db");
const { nowIso } = require("./utils");

async function netlasDiscoveryProxy(nodeType, nodeValue, fieldId) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "vary": "web",
    "Origin": "https://app.netlas.io",
    "Referer": "https://app.netlas.io/"
  };

  const countRes = await fetch("https://app.netlas.io/api/discovery/node_count/", {
    method: "POST",
    headers,
    body: JSON.stringify({
      node_type: nodeType,
      node_value: nodeValue,
      search_field_id: fieldId
    })
  });

  if (!countRes.ok) return null;
  const countId = countRes.headers.get("x-count-id");
  if (!countId) return null;

  const resultRes = await fetch("https://app.netlas.io/api/discovery/node_result/", {
    method: "POST",
    headers: { ...headers, "X-Count-Id": countId },
    body: JSON.stringify({
      node_type: nodeType,
      node_value: nodeValue,
      search_field_id: fieldId
    })
  });

  if (!resultRes.ok) return null;
  return await resultRes.json();
}

async function executeNetlasDnsTask(projectId, onProgress) {
  const { db } = getDbState();
  const subdomains = db.prepare("SELECT id, host FROM subdomains WHERE project_id = ?").all(projectId);
  
  if (subdomains.length === 0) {
    await onProgress(100, "No subdomains to scan");
    return { processed: 0 };
  }

  const fieldIds = [32, 31, 30, 29]; // TXT, MX, NS, A
  const typeMap = { 32: "TXT", 31: "MX", 30: "NS", 29: "A" };

  let processed = 0;
  for (const sub of subdomains) {
    processed++;
    const progress = Math.round((processed / subdomains.length) * 100);
    await onProgress(progress, `Scanning ${sub.host} (${processed}/${subdomains.length})`, processed, subdomains.length);

    for (const fieldId of fieldIds) {
      try {
        const data = await netlasDiscoveryProxy("domain", sub.host, fieldId);
        if (data && data.aggregations) {
          const type = typeMap[fieldId];
          const values = data.aggregations
            .filter(item => item.node_type === (fieldId === 29 ? "ip" : (fieldId === 32 ? "dns_txt" : "domain")))
            .map(item => item.node_value);

          for (const val of values) {
            db.prepare(`
              INSERT INTO dns_records (id, project_id, subdomain_id, record_type, value, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(project_id, subdomain_id, record_type, value) DO UPDATE SET created_at = excluded.created_at
            `).run(
              require("./utils").createId(),
              projectId,
              sub.id,
              type,
              val,
              nowIso()
            );
          }
        }
      } catch (err) {
        console.error(`[netlas-dns-task] error for ${sub.host} field ${fieldId}:`, err);
      }
      // Small delay to be polite
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return { processed };
}

module.exports = { executeNetlasDnsTask };
