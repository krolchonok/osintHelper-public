const net = require("node:net");

function extractRdapEntityName(entity) {
  const card = Array.isArray(entity?.vcardArray) ? entity.vcardArray : [];
  const fields = Array.isArray(card[1]) ? card[1] : [];
  for (const row of fields) {
    if (!Array.isArray(row) || row.length < 4) {
      continue;
    }
    if (String(row[0]).toLowerCase() === "fn") {
      return String(row[3] || "").trim();
    }
  }
  return "";
}

async function fetchDomainWhois(domain) {
  function queryWhoisServer(server, query, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: server, port: 43 });
      let settled = false;
      let chunks = "";

      const finish = (error, value) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (error) {
          reject(error);
          return;
        }
        resolve(value);
      };

      socket.setEncoding("utf8");
      socket.setTimeout(timeoutMs);

      socket.on("connect", () => {
        socket.write(`${query}\r\n`);
      });
      socket.on("data", (data) => {
        chunks += String(data || "");
      });
      socket.on("end", () => finish(null, chunks));
      socket.on("timeout", () => finish(new Error("WHOIS timeout")));
      socket.on("error", (error) => finish(error));
    });
  }

  function parseWhoisByKey(text, keys) {
    const lines = String(text || "").split(/\r?\n/);
    for (const key of keys) {
      const lowerKey = String(key).toLowerCase();
      const line = lines.find((row) => String(row).toLowerCase().startsWith(`${lowerKey}:`));
      if (!line) {
        continue;
      }
      const value = line.slice(line.indexOf(":") + 1).trim();
      if (value) {
        return value;
      }
    }
    return null;
  }

  function parseWhoisList(text, keys) {
    const lines = String(text || "").split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      const normalized = String(line || "").trim();
      if (!normalized || normalized.startsWith("%") || normalized.startsWith("#")) {
        continue;
      }
      const idx = normalized.indexOf(":");
      if (idx <= 0) {
        continue;
      }
      const key = normalized.slice(0, idx).trim().toLowerCase();
      const value = normalized.slice(idx + 1).trim();
      if (!value) {
        continue;
      }
      if (keys.includes(key)) {
        out.push(value.toLowerCase());
      }
    }
    return Array.from(new Set(out));
  }

  async function requestRdap(endpoint) {
    const response = await fetch(endpoint, { method: "GET" });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error("WHOIS response is not valid JSON");
    }
  }

  function normalizeRdapBase(base) {
    const value = String(base || "").trim();
    if (!value) {
      return "";
    }
    return value.endsWith("/") ? value : `${value}/`;
  }

  const endpoints = [];
  endpoints.push(`https://rdap.org/domain/${encodeURIComponent(domain)}`);

  try {
    const bootstrap = await fetch("https://data.iana.org/rdap/dns.json", { method: "GET" });
    if (bootstrap.ok) {
      const data = await bootstrap.json();
      const services = Array.isArray(data?.services) ? data.services : [];
      const domainParts = String(domain).toLowerCase().split(".");
      const tld = domainParts.length > 1 ? domainParts[domainParts.length - 1] : "";
      const match = services.find((entry) => {
        const tlds = Array.isArray(entry?.[0]) ? entry[0].map((item) => String(item).toLowerCase()) : [];
        return tlds.includes(tld);
      });

      const urls = Array.isArray(match?.[1]) ? match[1] : [];
      for (const base of urls) {
        const normalized = normalizeRdapBase(base);
        if (!normalized) {
          continue;
        }
        endpoints.push(`${normalized}domain/${encodeURIComponent(domain)}`);
      }
    }
  } catch {
    // Ignore bootstrap failure and keep rdap.org fallback only.
  }

  let data = null;
  let lastStatus = null;
  let usedEndpoint = endpoints[0];
  for (const endpoint of Array.from(new Set(endpoints))) {
    try {
      data = await requestRdap(endpoint);
      usedEndpoint = endpoint;
      break;
    } catch (error) {
      if (typeof error?.status === "number") {
        lastStatus = error.status;
      }
      usedEndpoint = endpoint;
    }
  }

  if (!data) {
    const tld = String(domain).toLowerCase().split(".").pop();
    if (!tld) {
      throw new Error("WHOIS/RDAP not found for this domain");
    }

    let ianaText = "";
    try {
      ianaText = await queryWhoisServer("whois.iana.org", tld);
    } catch {
      ianaText = "";
    }

    const whoisServer =
      parseWhoisByKey(ianaText, ["whois"]) ||
      parseWhoisByKey(ianaText, ["refer"]) ||
      null;

    if (!whoisServer) {
      if (lastStatus === 404) {
        throw new Error("WHOIS/RDAP not found for this domain");
      }
      throw new Error(`WHOIS request failed (${lastStatus || "unknown error"})`);
    }

    let whoisText = "";
    try {
      whoisText = await queryWhoisServer(whoisServer, domain);
    } catch {
      whoisText = "";
    }

    if (!whoisText.trim()) {
      throw new Error("WHOIS/RDAP not found for this domain");
    }

    const registrar = parseWhoisByKey(whoisText, ["registrar", "registrar name", "org"]);
    const inn = parseWhoisByKey(whoisText, ["inn", "taxpayer-id", "tin"]);
    const createdAt = parseWhoisByKey(whoisText, ["creation date", "created", "created on", "created-date"]);
    const updatedAt = parseWhoisByKey(whoisText, ["updated date", "last updated on", "changed", "changed-date"]);
    const expiresAt = parseWhoisByKey(whoisText, ["registry expiry date", "expiration date", "paid-till", "expires", "expiry date"]);
    const statusRaw = parseWhoisList(whoisText, ["status", "state", "domain status"]);
    const nameservers = parseWhoisList(whoisText, ["name server", "nserver", "nameserver", "ns"]);

    return {
      domain,
      registrar: registrar || null,
      inn: inn || null,
      registrant: parseWhoisByKey(whoisText, ["person", "org", "registrant", "registrant organization"]) || null,
      registrarWhois: whoisServer || null,
      country: parseWhoisByKey(whoisText, ["country", "registrant country"]) || null,
      emails: parseWhoisList(whoisText, ["e-mail", "email", "admin email", "registrant email"]),
      dnssec: parseWhoisByKey(whoisText, ["dnssec"]) || null,
      status: statusRaw,
      nameservers,
      createdAt: createdAt || null,
      updatedAt: updatedAt || null,
      expiresAt: expiresAt || null,
      rdapUrl: `whois://${whoisServer}`,
      source: `whois://${whoisServer}`,
    };
  }

  const statuses = Array.isArray(data?.status) ? data.status.map((item) => String(item)) : [];
  const nameservers = Array.isArray(data?.nameservers)
    ? data.nameservers
        .map((item) => String(item?.ldhName || item?.unicodeName || "").toLowerCase().trim())
        .filter(Boolean)
    : [];

  const events = Array.isArray(data?.events) ? data.events : [];
  const findEventDate = (key) => {
    const event = events.find((row) => String(row?.eventAction || "").toLowerCase() === key);
    return event?.eventDate || null;
  };

  const entities = Array.isArray(data?.entities) ? data.entities : [];
  const registrarEntity = entities.find((entity) =>
    Array.isArray(entity?.roles) &&
    entity.roles.map((role) => String(role).toLowerCase()).includes("registrar"),
  );
  const registrar = extractRdapEntityName(registrarEntity);

  return {
    domain,
    registrar: registrar || null,
    inn: null,
    registrant: null,
    registrarWhois: null,
    country: null,
    emails: [],
    dnssec: null,
    status: statuses,
    nameservers,
    createdAt: findEventDate("registration"),
    updatedAt: findEventDate("last changed"),
    expiresAt: findEventDate("expiration"),
    rdapUrl: usedEndpoint,
    source: usedEndpoint,
  };
}

module.exports = {
  fetchDomainWhois,
};
