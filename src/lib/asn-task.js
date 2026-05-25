const { Resolver } = require("node:dns/promises");
const { getDbState } = require("../db");
const { clampProgress, nowIso } = require("./utils");
const { fetch2ipAsnInfo, fetch2ipProvider, parse2ipKeys, create2ipKeyRotator } = require("./2ip");
const { getProviderRuntimeSettings } = require("./provider-settings");

function reverseIpv4(ip) {
  return ip.split(".").reverse().join(".") + ".origin.asn.cymru.com";
}

function expandIpv6(ip) {
  const halves = ip.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const fill = Math.max(0, 8 - left.length - right.length);
  const middle = Array(fill).fill("0000");
  return [...left, ...middle, ...right].map((g) => g.padStart(4, "0")).join(":");
}

function reverseIpv6(ip) {
  const expanded = expandIpv6(ip);
  const nibbles = expanded.replace(/:/g, "").split("").reverse().join(".");
  return nibbles + ".origin6.asn.cymru.com";
}

async function lookupIpAsn(ip, resolver) {
  try {
    const query = ip.includes(":") ? reverseIpv6(ip) : reverseIpv4(ip);
    const records = await resolver.resolveTxt(query);
    if (!records?.length) return null;
    const txt = records[0].join("");
    const parts = txt.split("|").map((s) => s.trim());
    const asnNum = parseInt(parts[0], 10);
    return Number.isFinite(asnNum) && asnNum > 0
      ? { asnNum, cidr: parts[1] || "", country: parts[2] || "", rir: parts[3] || "" }
      : null;
  } catch {
    return null;
  }
}

async function lookupAsnName(asnNum, resolver) {
  try {
    const records = await resolver.resolveTxt(`AS${asnNum}.asn.cymru.com`);
    if (!records?.length) return "";
    const txt = records[0].join("");
    const parts = txt.split("|").map((s) => s.trim());
    return parts[5] || parts[4] || "";
  } catch {
    return "";
  }
}

async function mapWithConcurrency(items, fn, limit = 8) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function executeAsnTask(projectId, onProgress) {
  const { db } = getDbState();

  const emit = async (progress, stage, processed = 0, total = 0) => {
    if (onProgress) await onProgress({ progress: clampProgress(progress), stage, processed, total });
  };

  await emit(5, "Загрузка IP-адресов");

  const rows = db.prepare(`
    SELECT DISTINCT d.value AS ip, s.host
    FROM dns_records d
    JOIN subdomains s ON s.id = d.subdomain_id
    WHERE d.project_id = ?
      AND d.record_type IN ('A', 'AAAA')
    ORDER BY d.value
  `).all(projectId);

  // ip → Set of hostnames
  const ipHostMap = new Map();
  for (const row of rows) {
    if (!ipHostMap.has(row.ip)) ipHostMap.set(row.ip, new Set());
    if (row.host) ipHostMap.get(row.ip).add(row.host);
  }

  const ips = Array.from(new Set(rows.map((r) => r.ip).filter(Boolean)));
  if (!ips.length) {
    throw new Error("Нет зарезолвленных IP. Сначала запустите DNS-резолв.");
  }

  await emit(10, `Найдено ${ips.length} уникальных IP`, 0, ips.length);

  const resolver = new Resolver();
  resolver.setServers(["8.8.8.8"]);

  const ipResults = await mapWithConcurrency(ips, async (ip, i) => {
    const result = await lookupIpAsn(ip, resolver);
    await emit(
      10 + Math.floor(((i + 1) / ips.length) * 60),
      `ASN lookup: ${ip}`,
      i + 1,
      ips.length,
    );
    return { ip, ...(result || {}) };
  }, 8);

  // group IPs by ASN number
  const asnMap = new Map();
  const noAsnIps = [];

  for (const item of ipResults) {
    if (!item.asnNum) {
      noAsnIps.push(item.ip);
      continue;
    }
    if (!asnMap.has(item.asnNum)) {
      asnMap.set(item.asnNum, {
        asnNum: item.asnNum,
        country: item.country || "",
        rir: item.rir || "",
        ips: [],
        cidrs: new Set(),
        hosts: new Set(),
      });
    }
    const entry = asnMap.get(item.asnNum);
    entry.ips.push(item.ip);
    if (item.cidr) entry.cidrs.add(item.cidr);
    for (const host of (ipHostMap.get(item.ip) || [])) entry.hosts.add(host);
  }

  await emit(72, "Запрос названий ASN-организаций");

  const asnNums = Array.from(asnMap.keys());
  const nameResults = await mapWithConcurrency(asnNums, async (asnNum, i) => {
    const name = await lookupAsnName(asnNum, resolver);
    await emit(
      72 + Math.floor(((i + 1) / asnNums.length) * 20),
      `AS${asnNum} → ${name || "?"}`,
      i + 1,
      asnNums.length,
    );
    return { asnNum, name };
  }, 5);

  for (const { asnNum, name } of nameResults) {
    if (asnMap.has(asnNum)) asnMap.get(asnNum).org = name;
  }

  await emit(92, "Запрос URL компаний-владельцев (2ip)");
  const asnEntriesForOwner = Array.from(asnMap.values());
  await mapWithConcurrency(asnEntriesForOwner, async (entry, i) => {
    try {
      const data = await fetch2ipAsnInfo(entry.asnNum);
      entry.ownerUrl = data?.ownerUrl || "";
      entry.ownerSourceUrl = data?.sourceUrl || "";
    } catch {
      entry.ownerUrl = "";
      entry.ownerSourceUrl = "";
    }
    await emit(
      92 + Math.floor(((i + 1) / asnEntriesForOwner.length) * 1),
      `2ip ASN: AS${entry.asnNum}`,
      i + 1,
      asnEntriesForOwner.length,
    );
  }, 2);

  const providerSettings = getProviderRuntimeSettings();
  const twoIpSetting = providerSettings.find((s) => s.provider === "2ip" && s.enabled && s.token);
  if (twoIpSetting) {
    await emit(93, "Запрос сайтов провайдеров (2ip)");
    const rotator = create2ipKeyRotator(parse2ipKeys(twoIpSetting.token));
    const asnEntries = Array.from(asnMap.values());
    await mapWithConcurrency(asnEntries, async (entry, i) => {
      const ip = entry.ips[0];
      if (!ip) return;
      try {
        const data = await fetch2ipProvider(ip, rotator);
        entry.site = data?.site || "";
      } catch {
        entry.site = "";
      }
      await emit(
        93 + Math.floor(((i + 1) / asnEntries.length) * 4),
        `2ip provider: AS${entry.asnNum}`,
        i + 1,
        asnEntries.length,
      );
    }, 3);
  }

  await emit(97, "Сохранение результатов");

  const asns = Array.from(asnMap.values())
    .map((entry) => ({
      asn: `AS${entry.asnNum}`,
      asnNum: entry.asnNum,
      org: entry.org || "",
      site: entry.site || "",
      ownerUrl: entry.ownerUrl || "",
      ownerSourceUrl: entry.ownerSourceUrl || "",
      country: entry.country,
      rir: entry.rir,
      ips: [...entry.ips].sort(),
      cidrs: [...entry.cidrs].sort(),
      hosts: [...entry.hosts].sort(),
    }))
    .sort((a, b) => b.ips.length - a.ips.length);

  const data = {
    asns,
    totalIps: ips.length,
    resolvedAsns: asns.length,
    noAsnIps,
    lookedUpAt: nowIso(),
  };

  const now = nowIso();
  db.prepare(`
    INSERT INTO project_asn (project_id, data_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id)
    DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
  `).run(projectId, JSON.stringify(data), now, now);

  await emit(99, "ASN задача завершена");
  return { ok: true, asns: asns.length, ips: ips.length };
}

module.exports = { executeAsnTask };
