const { Resolver } = require("node:dns/promises");
const { getDbState } = require("../db");
const { getProjectScopeDomains } = require("./project-domains");
const { clampProgress, createId, nowIso } = require("./utils");

const FAST_RESOLVERS = ["8.8.8.8"];
const EXTENDED_RESOLVERS = ["8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1"];
const timeoutMs = 5000;

function getResolversForScope(scanScope) {
  if (scanScope === "core") {
    return FAST_RESOLVERS;
  }
  return EXTENDED_RESOLVERS;
}

async function withTimeout(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS query timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function collectForHost(host, resolverIp) {
  const resolver = new Resolver();
  resolver.setServers([resolverIp]);

  const records = [];
  const ipsForReverse = [];

  try {
    const a = await withTimeout(resolver.resolve4(host, { ttl: true }));
    for (const item of a) {
      ipsForReverse.push(item.address);
      records.push({ resolver: resolverIp, recordType: "A", value: item.address, dataJson: JSON.stringify(item) });
    }
  } catch {}

  try {
    const aaaa = await withTimeout(resolver.resolve6(host, { ttl: true }));
    for (const item of aaaa) {
      ipsForReverse.push(item.address);
      records.push({ resolver: resolverIp, recordType: "AAAA", value: item.address, dataJson: JSON.stringify(item) });
    }
  } catch {}

  try {
    const cname = await withTimeout(resolver.resolveCname(host));
    for (const value of cname) {
      records.push({ resolver: resolverIp, recordType: "CNAME", value });
    }
  } catch {}

  try {
    const mx = await withTimeout(resolver.resolveMx(host));
    for (const value of mx) {
      records.push({
        resolver: resolverIp,
        recordType: "MX",
        value: `${value.priority} ${value.exchange}`,
        dataJson: JSON.stringify(value),
      });
    }
  } catch {}

  try {
    const ns = await withTimeout(resolver.resolveNs(host));
    for (const value of ns) {
      records.push({ resolver: resolverIp, recordType: "NS", value });
    }
  } catch {}

  try {
    const txt = await withTimeout(resolver.resolveTxt(host));
    for (const value of txt) {
      records.push({ resolver: resolverIp, recordType: "TXT", value: value.join(""), dataJson: JSON.stringify(value) });
    }
  } catch {}

  try {
    const soa = await withTimeout(resolver.resolveSoa(host));
    records.push({
      resolver: resolverIp,
      recordType: "SOA",
      value: `${soa.nsname} ${soa.hostmaster}`,
      dataJson: JSON.stringify(soa),
    });
  } catch {}

  try {
    const caa = await withTimeout(resolver.resolveCaa(host));
    for (const value of caa) {
      records.push({
        resolver: resolverIp,
        recordType: "CAA",
        value: `${value.critical ? "1" : "0"} ${value.issue || value.issuewild || value.iodef || ""}`,
        dataJson: JSON.stringify(value),
      });
    }
  } catch {}

  try {
    const srv = await withTimeout(resolver.resolveSrv(host));
    for (const value of srv) {
      records.push({
        resolver: resolverIp,
        recordType: "SRV",
        value: `${value.priority} ${value.weight} ${value.port} ${value.name}`,
        dataJson: JSON.stringify(value),
      });
    }
  } catch {}

  for (const ip of ipsForReverse) {
    try {
      const ptrValues = await withTimeout(resolver.reverse(ip));
      for (const value of ptrValues) {
        records.push({ resolver: resolverIp, recordType: "PTR", value: `${ip} -> ${value}` });
      }
    } catch {}
  }

  return records;
}

async function emit(onProgress, progress, stage, processed, total) {
  if (!onProgress) {
    return;
  }

  await onProgress({
    progress: clampProgress(progress),
    stage,
    processed,
    total,
  });
}

function upsertSubdomain(projectId, host, isRoot) {
  const { db } = getDbState();
  const now = nowIso();
  return db
    .prepare(`
      INSERT INTO subdomains (id, project_id, host, is_root, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, host)
      DO UPDATE SET
        is_root = excluded.is_root,
        updated_at = excluded.updated_at
      RETURNING id
    `)
    .get(createId(), projectId, host, isRoot ? 1 : 0, now, now);
}

async function executeDnsResolve(projectId, onProgress, scanScope = "core", options = null) {
  const { db } = getDbState();
  const resolvers = getResolversForScope(scanScope);

  await emit(onProgress, 5, "Loading hosts");

  const project = db
    .prepare("SELECT id, domain FROM projects WHERE id = ?")
    .get(projectId);

  if (!project) {
    throw new Error("Project not found");
  }

  const rootDomains = getProjectScopeDomains(project.id, project.domain);
  if (!rootDomains.length) {
    throw new Error("Add at least one domain to the project before running DNS resolve");
  }

  const subdomains = db
    .prepare("SELECT id, host FROM subdomains WHERE project_id = ?")
    .all(projectId);
  const requestedIds = Array.isArray(options?.subdomainIds)
    ? Array.from(new Set(options.subdomainIds.map((item) => String(item || "").trim()).filter(Boolean)))
    : [];

  let hostEntries = [];
  if (requestedIds.length > 0) {
    const selected = subdomains.filter((item) => requestedIds.includes(String(item.id)));
    hostEntries = selected.map((item) => ({ host: item.host, subdomainId: item.id }));
    if (!hostEntries.length) {
      throw new Error("No selected subdomains found");
    }
    await emit(onProgress, 12, "Cleaning DNS records for selected hosts");
    const placeholders = requestedIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM dns_records WHERE project_id = ? AND subdomain_id IN (${placeholders})`).run(projectId, ...requestedIds);
  } else {
    const hostMap = new Map(subdomains.map((item) => [item.host, item.id]));
    for (const domain of rootDomains) {
      const root = upsertSubdomain(projectId, domain, true);
      hostMap.set(domain, root.id);
    }
    hostEntries = Array.from(hostMap.entries()).map(([host, subdomainId]) => ({ host, subdomainId }));
    await emit(onProgress, 12, "Cleaning previous DNS records");
    db.prepare("DELETE FROM dns_records WHERE project_id = ?").run(projectId);
  }

  const insertRecordStmt = db.prepare(`
    INSERT INTO dns_records (id, project_id, subdomain_id, resolver, record_type, value, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertManyTx = db.transaction((records, hostEntry) => {
    const now = nowIso();
    for (const record of records) {
      insertRecordStmt.run(
        createId(),
        projectId,
        hostEntry.subdomainId,
        record.resolver,
        record.recordType,
        record.value,
        record.dataJson || null,
        now,
      );
    }
  });

  let inserted = 0;
  const totalSteps = Math.max(hostEntries.length * resolvers.length, 1);
  let processedSteps = 0;

  for (const hostEntry of hostEntries) {
    for (const resolverIp of resolvers) {
      await emit(
        onProgress,
        Math.round(15 + (processedSteps / totalSteps) * 80),
        `Resolving ${hostEntry.host} via ${resolverIp}`,
        processedSteps,
        totalSteps,
      );

      const foundRecords = await collectForHost(hostEntry.host, resolverIp);
      if (foundRecords.length) {
        insertManyTx(foundRecords, hostEntry);
        inserted += foundRecords.length;
      }

      processedSteps += 1;

      await emit(
        onProgress,
        Math.round(15 + (processedSteps / totalSteps) * 80),
        `Resolved ${processedSteps}/${totalSteps} resolver checks`,
        processedSteps,
        totalSteps,
      );
    }
  }

  await emit(onProgress, 98, "DNS resolve completed", processedSteps, totalSteps);
  return { hosts: hostEntries.length, records: inserted };
}

module.exports = {
  executeDnsResolve,
};
