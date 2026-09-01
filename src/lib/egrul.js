const SEARCH_URL = "https://egrul.nalog.ru/";
const RESULT_URL = "https://egrul.nalog.ru/search-result/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 1200;
const POLL_MAX_ATTEMPTS = 8;

function isValidInn(raw) {
  return /^\d{10}$|^\d{12}$/.test(String(raw || "").trim());
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function startEgrulSearch(inn) {
  const response = await fetchWithTimeout(SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: `query=${encodeURIComponent(inn)}&region=&PreventChromeAutocomplete=`,
  });

  if (!response.ok) {
    throw new Error(`EGRUL search request failed (HTTP ${response.status})`);
  }

  const data = await response.json();
  if (data?.captchaRequired) {
    throw new Error("EGRUL requires captcha, try again later");
  }

  const token = String(data?.t || "").trim();
  if (!token) {
    throw new Error("EGRUL did not return a search token");
  }

  return token;
}

async function pollEgrulResult(token) {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(`${RESULT_URL}${encodeURIComponent(token)}`, {
      headers: { "User-Agent": USER_AGENT },
    });

    if (response.status === 200) {
      const data = await response.json();
      if (Array.isArray(data?.rows)) {
        return data.rows;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error("EGRUL search timed out");
}

// ЕГРЮЛ/ЕГРИП search: resolves an INN to the registered legal entity name.
// This is the first step of "reverse whois by INN" — WHOIS/reverse-whois
// sources index by organization name, not by tax id, so callers must resolve
// the name here before querying Netlas org-domains (see routes/netlas.js).
async function lookupCompanyByInn(rawInn) {
  const inn = String(rawInn || "").trim();
  if (!isValidInn(inn)) {
    throw new Error("INN must be 10 or 12 digits");
  }

  const token = await startEgrulSearch(inn);
  const rows = await pollEgrulResult(token);
  const match = rows.find((row) => String(row?.i || "").trim() === inn) || rows[0] || null;

  if (!match) {
    return null;
  }

  return {
    inn: match.i || inn,
    ogrn: match.o || null,
    kpp: match.p || null,
    fullName: match.n || null,
    shortName: match.c || null,
    manager: match.g || null,
    region: match.rn || null,
    kind: match.k || null,
    registeredAt: match.r || null,
  };
}

module.exports = {
  lookupCompanyByInn,
  isValidInn,
};
