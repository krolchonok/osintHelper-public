const TIMEOUT_MS = 10000;
const TWOIP_IO_BASE = "https://2ip.io";

function parse2ipKeys(rawToken) {
  return String(rawToken || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function create2ipKeyRotator(keys) {
  let index = 0;
  const list = keys.length ? keys : [""];
  return {
    current: () => list[index],
    rotate: () => { index = (index + 1) % list.length; },
    count: list.length,
  };
}

async function fetch2ip(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; osintHelper/1.0)",
        Accept: "text/html,application/xhtml+xml",
        ...headers,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok && !(res.status === 503 && text.includes("atob("))) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function buildUrl(base, params, token) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

async function fetchWithRotation(rotator, buildFn) {
  let attempts = rotator.count;
  while (attempts-- > 0) {
    try {
      return await fetch2ip(buildFn(rotator.current()));
    } catch (err) {
      if (err.status === 429 || err.status === 403) {
        rotator.rotate();
        continue;
      }
      throw err;
    }
  }
  throw new Error("2ip: все ключи исчерпаны");
}

async function fetch2ipGeo(ip, rotator) {
  return fetchWithRotation(rotator, (token) =>
    buildUrl("https://api.2ip.me/geo.json", { ip }, token),
  );
}

async function fetch2ipProvider(ip, rotator) {
  return fetchWithRotation(rotator, (token) =>
    buildUrl("https://api.2ip.me/provider.json", { ip }, token),
  );
}

async function fetch2ipHosting(site, rotator) {
  return fetchWithRotation(rotator, (token) =>
    buildUrl("https://api.2ip.me/hosting.json", { site }, token),
  );
}

async function fetch2ipMac(mac, rotator) {
  return fetchWithRotation(rotator, (token) =>
    buildUrl("https://api.2ip.ua/mac.json", { mac }, token),
  );
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parse2ipChallengeCookies(html) {
  const match = String(html || "").match(/atob\("([^"]+)"\)/);
  if (!match) return "";

  let decoded = "";
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return "";
  }

  const answer = decoded.match(/const\s+answer\s*=\s*"([^"]+)"/)?.[1] || "";
  const salt = decoded.match(/const\s+salt\s*=\s*"([^"]+)"/)?.[1] || "";
  if (!answer || !salt) return "";
  return `2ip_js_challenge_salt=${encodeURIComponent(salt)}; 2ip_js_challenge=${encodeURIComponent(answer)}`;
}

function parseAsnTableValue(html, label) {
  const escapedLabel = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<th>\\s*${escapedLabel}:\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, "i");
  const match = String(html || "").match(pattern);
  return match ? decodeHtml(match[1]) : "";
}

function parseAsnTableHref(html, label) {
  const escapedLabel = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<th>\\s*${escapedLabel}:\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, "i");
  const cellMatch = String(html || "").match(pattern);
  if (!cellMatch) return "";

  const href = cellMatch[1].match(/<a[^>]+href=["']([^"']+)["']/i)?.[1] || "";
  return decodeHtml(href);
}

function parse2ipAsnInfo(html, asnNum) {
  const titleMatch = String(html || "").match(/<h3[^>]*>\s*([\s\S]*?)\s*<\/h3>/i);
  return {
    asn: `AS${asnNum}`,
    ownerName: titleMatch ? decodeHtml(titleMatch[1]) : "",
    ownerUrl: parseAsnTableHref(html, "Homepage") || parseAsnTableValue(html, "Homepage"),
    ownerCountry: parseAsnTableValue(html, "Country"),
    ownerCity: parseAsnTableValue(html, "City"),
    sourceUrl: `${TWOIP_IO_BASE}/as/${asnNum}/`,
  };
}

async function fetch2ipAsnInfo(asnNum) {
  const normalized = String(asnNum || "").replace(/^AS/i, "").trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("2ip ASN number is invalid");
  }

  const url = `${TWOIP_IO_BASE}/as/${encodeURIComponent(normalized)}/`;
  let html = await fetchText(url);
  const cookies = parse2ipChallengeCookies(html);
  if (cookies) {
    html = await fetchText(url, { Cookie: cookies });
  }
  return parse2ipAsnInfo(html, normalized);
}

async function fetch2ipAll(domain, ip, rawToken) {
  const keys = parse2ipKeys(rawToken);
  const rotator = create2ipKeyRotator(keys);

  const results = await Promise.allSettled([
    fetch2ipGeo(ip || domain, rotator),
    fetch2ipProvider(ip || domain, rotator),
    fetch2ipHosting(domain, rotator),
  ]);

  return {
    geo: results[0].status === "fulfilled" ? results[0].value : null,
    provider: results[1].status === "fulfilled" ? results[1].value : null,
    hosting: results[2].status === "fulfilled" ? results[2].value : null,
    errors: results
      .map((r, i) => r.status === "rejected" ? { index: i, error: r.reason?.message } : null)
      .filter(Boolean),
  };
}

module.exports = {
  fetch2ipAll,
  fetch2ipAsnInfo,
  fetch2ipMac,
  fetch2ipProvider,
  parse2ipKeys,
  create2ipKeyRotator,
};
