const https = require("node:https");

const TOKEN = process.env.NETLAS_API_KEY;
const DOMAIN = process.argv[2] || "energobank.ru";
const MAX_PAGES = 50;
const PAGE_SIZE = 20;
const PREFIXES = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
      timeout: 15000,
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function fetchQuery(query, found) {
  let totalCount = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PAGE_SIZE;
    const url = `https://app.netlas.io/api/domains/?q=${encodeURIComponent(query)}&start=${start}&fields=domain&source_type=include`;
    const { status, body } = await get(url);

    if (status !== 200) {
      if (page > 0 && found.size > 0) {
        console.log(`  [cap] status=${status} на start=${start} — Netlas срезал, нужен alpha split`);
        return true;
      }
      console.error(`  [err] status=${status} query="${query}"`);
      return false;
    }

    let data;
    try { data = JSON.parse(body); } catch { break; }

    if (page === 0 && typeof data?.count === "number") {
      totalCount = data.count;
      console.log(`  [info] API count=${totalCount}`);
    }

    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const d = item?.data?.domain || item?.domain;
      if (d && d.endsWith(`.${DOMAIN}`)) found.add(d);
    }
    if (items.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) return true;
  }
  return totalCount !== null && totalCount > found.size;
}

async function main() {
  console.log(`\nТестируем Netlas на домене: ${DOMAIN}\n`);

  const found = new Set();
  const hitLimit = await fetchQuery(`domain:*.${DOMAIN}`, found);
  console.log(`[base] собрали=${found.size}, needAlpha=${hitLimit}\n`);

  if (hitLimit) {
    console.log("[info] Запускаем алфавитное разбиение...\n");
    for (const prefix of PREFIXES) {
      const before = found.size;
      await fetchQuery(`domain:${prefix}*.${DOMAIN}`, found);
      const added = found.size - before;
      if (added > 0) console.log(`[${prefix}*]  +${added} (total: ${found.size})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  } else {
    console.log("[info] Алфавитное разбиение не нужно");
  }

  console.log(`\nИтого уникальных субдоменов: ${found.size}`);
  const sorted = [...found].sort();
  const named = sorted.filter(d => !/^host-\d+\./.test(d));
  const hosts = sorted.filter(d => /^host-\d+\./.test(d));
  if (named.length) { console.log("\nИменованные:"); named.forEach(d => console.log(" ", d)); }
  if (hosts.length) { console.log(`\nhost-N (${hosts.length} шт): ${hosts[0]} ... ${hosts[hosts.length-1]}`); }
}

main().catch(console.error);
