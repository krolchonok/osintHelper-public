const TIMEOUT_MS = 10000;

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

module.exports = { fetch2ipAll, fetch2ipMac, parse2ipKeys };
