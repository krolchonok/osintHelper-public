const INTELX_API_BASE = "https://free.intelx.io";
const INTELX_BUCKETS = [
  "leaks.public.wikileaks",
  "leaks.public.general",
  "dumpster",
  "documents.public.scihub",
];
const SEARCH_PAGE_LIMIT = 1000;
const MAX_RESULTS = 1000;
const MAX_CONCURRENCY = 40;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_FILE_CONCURRENCY_LIMIT = 80;

function parseBoundedEnvInt(name, defaultValue, maxValue) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 1) {
    return defaultValue;
  }
  return Math.max(1, Math.min(Math.floor(value), maxValue));
}

function getIntelxFileConcurrency() {
  return parseBoundedEnvInt("INTELX_FILE_CONCURRENCY", MAX_CONCURRENCY, MAX_FILE_CONCURRENCY_LIMIT);
}

function parseIntelxKeys(rawToken) {
  return String(rawToken || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function maskIntelxKey(apiKey) {
  if (!apiKey) {
    return "unknown";
  }
  if (apiKey.length <= 12) {
    return `${apiKey.slice(0, 4)}...`;
  }
  return `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;
}

function isRateLimitError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("http 429") ||
    message.includes("http 402") ||
    message.includes("limit exceeded") ||
    message.includes("quota exceeded") ||
    message.includes("payment required")
  );
}

function createIntelxClient(rawToken) {
  const apiKeys = parseIntelxKeys(rawToken);
  if (!apiKeys.length) {
    throw new Error("IntelX provider token is empty");
  }

  let currentKeyIndex = 0;

  function getCurrentApiKey() {
    const current = apiKeys[currentKeyIndex];
    if (!current) {
      throw new Error("No IntelX API keys available");
    }
    return current;
  }

  function switchToNextKey(expectedKey = null) {
    if (apiKeys.length <= 1) {
      return getCurrentApiKey();
    }
    if (expectedKey && getCurrentApiKey() !== expectedKey) {
      return getCurrentApiKey();
    }
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
    return getCurrentApiKey();
  }

  function getBaseHeaders(apiKey = getCurrentApiKey()) {
    return {
      accept: "*/*",
      "user-agent": "Mozilla/5.0",
      "x-key": apiKey,
      origin: "https://intelx.io",
      referer: "https://intelx.io/",
    };
  }

  async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
    const allowKeyRotation = options.allowKeyRotation !== false;
    const requestOptions = { ...options };
    delete requestOptions.allowKeyRotation;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const requestKey = requestOptions.headers?.["x-key"];

      try {
        const response = await fetch(url, { ...requestOptions, signal: controller.signal });
        clearTimeout(timer);

        if (!response.ok) {
          let detail = "";
          try {
            detail = await response.text();
          } catch {
            detail = "";
          }
          throw new Error(`HTTP ${response.status} ${response.statusText} | ${detail.slice(0, 200)}`);
        }

        return response;
      } catch (error) {
        clearTimeout(timer);
        if (allowKeyRotation && apiKeys.length > 1 && isRateLimitError(error)) {
          switchToNextKey(requestKey);
        }
        if (attempt === retries) {
          throw error;
        }
        const waitMs = 300 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    throw new Error("IntelX request failed");
  }

  async function startSearch(searchTerm) {
    const response = await fetchWithRetry(`${INTELX_API_BASE}/intelligent/search`, {
      method: "POST",
      headers: {
        ...getBaseHeaders(),
        "content-type": "application/json;charset=UTF-8",
      },
      body: JSON.stringify({
        term: searchTerm,
        buckets: INTELX_BUCKETS,
        lookuplevel: 0,
        maxresults: MAX_RESULTS,
        timeout: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
        datefrom: "",
        dateto: "",
        sort: 2,
        media: 0,
        terminate: [],
      }),
    });

    const payload = await response.json();
    if (!payload?.id) {
      throw new Error("IntelX search did not return search id");
    }
    return payload.id;
  }

  async function getOnePage(searchId) {
    const params = new URLSearchParams({
      id: String(searchId),
      limit: String(SEARCH_PAGE_LIMIT),
      statistics: "1",
      previewlines: "8",
    });
    const response = await fetchWithRetry(
      `${INTELX_API_BASE}/intelligent/search/result?${params.toString()}`,
      { headers: getBaseHeaders() },
    );
    const payload = await response.json();
    return Array.isArray(payload?.records) ? payload.records : [];
  }

  async function fetchFileText(storageid, bucket) {
    let attempts = 0;
    const maxAttempts = apiKeys.length;

    while (attempts < maxAttempts) {
      const currentKey = getCurrentApiKey();
      try {
        const params = new URLSearchParams({
          f: "0",
          storageid,
          bucket: bucket || "leaks.public.general",
          k: currentKey,
          license: "registeredfree",
        });
        const response = await fetchWithRetry(`${INTELX_API_BASE}/file/view?${params.toString()}`, {
          headers: {
            ...getBaseHeaders(currentKey),
            "x-key": currentKey,
          },
        });
        return await response.text();
      } catch (error) {
        attempts += 1;
        if (isRateLimitError(error) && attempts < maxAttempts) {
          switchToNextKey(currentKey);
          continue;
        }
        throw error;
      }
    }

    throw new Error(`IntelX limits exhausted for ${maskIntelxKey(getCurrentApiKey())}`);
  }

  async function fetchFileAndFind(searchTerm, record) {
    const storageid = String(record?.storageid || "").trim();
    const bucket = String(record?.bucket || "leaks.public.general").trim() || "leaks.public.general";
    const text = await fetchFileText(storageid, bucket);
    const loweredNeedle = searchTerm.toLowerCase();
    const fileName = getIntelxRecordFileName(record);
    return text
      .split(/\r?\n/)
      .map((line) => String(line || "").trim())
      .filter((line) => line && line.toLowerCase().includes(loweredNeedle))
      .map((line) => ({
        line,
        storageid,
        bucket,
        fileName,
      }));
  }

  async function runWithConcurrency(tasks, concurrency = MAX_CONCURRENCY, onProgress = null) {
    const results = [];
    let index = 0;
    let completed = 0;

    async function worker() {
      while (index < tasks.length) {
        const current = index;
        index += 1;
        try {
          results[current] = await tasks[current]();
        } catch (error) {
          results[current] = { error: error instanceof Error ? error.message : String(error) };
        }
        completed += 1;
        if (onProgress) {
          await onProgress(completed, tasks.length);
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
    );

    return results;
  }

  async function searchLeaks(searchTerm, options = {}) {
    const seenStorageIds = new Set();
    const jobs = [];
    const warnings = [];
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const fileConcurrency = Math.max(
      1,
      Math.min(Number(options.fileConcurrency) || getIntelxFileConcurrency(), MAX_FILE_CONCURRENCY_LIMIT),
    );

    const searchId = await startSearch(searchTerm);
    const page = await getOnePage(searchId);
    for (const record of page) {
      const storageid = String(record?.storageid || "").trim();
      if (!storageid || seenStorageIds.has(storageid)) {
        continue;
      }
      seenStorageIds.add(storageid);
      jobs.push(() => fetchFileAndFind(searchTerm, record));
    }

    if (!jobs.length) {
      return {
        hits: [],
        warnings: page.length >= SEARCH_PAGE_LIMIT
          ? ["IntelX returned a full page of results; some matches may be truncated."]
          : [],
      };
    }

    if (page.length >= SEARCH_PAGE_LIMIT) {
      warnings.push("IntelX returned a full page of results; some matches may be truncated.");
    }

    if (onProgress) {
      await onProgress(0, jobs.length);
    }

    const results = await runWithConcurrency(jobs, fileConcurrency, onProgress);
    const uniqueHits = new Map();

    for (const row of results) {
      if (!Array.isArray(row)) {
        if (row && row.error) {
          warnings.push(String(row.error));
        }
        continue;
      }
      for (const hit of row) {
        const line = String(hit?.line || "").trim();
        const storageid = String(hit?.storageid || "").trim();
        const bucket = String(hit?.bucket || "leaks.public.general").trim();
        const fileName = String(hit?.fileName || "").trim();
        if (!line) {
          continue;
        }
        const key = [storageid, bucket, line].join("|");
        if (!uniqueHits.has(key)) {
          uniqueHits.set(key, {
            line,
            storageid,
            bucket,
            fileName,
          });
        }
      }
    }

    return {
      hits: Array.from(uniqueHits.values()),
      warnings: Array.from(new Set(warnings)),
    };
  }

  return {
    apiKeyCount: apiKeys.length,
    getCurrentApiKey,
    searchLeaks,
    fetchFileText,
    fetchWithRetry,
  };
}

function getIntelxRecordFileName(record) {
  const candidates = [
    record?.name,
    record?.file?.name,
    record?.filename,
    record?.title,
    record?.caption,
    record?.systemid,
    record?.storageid,
  ];

  for (const value of candidates) {
    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

async function fetchIntelxAccountInfo(rawToken) {
  const client = createIntelxClient(rawToken);
  const results = [];

  for (const apiKey of parseIntelxKeys(rawToken)) {
    const response = await client.fetchWithRetry(`${INTELX_API_BASE}/authenticate/info`, {
      headers: {
        accept: "*/*",
        "user-agent": "Mozilla/5.0",
        "x-key": apiKey,
        origin: "https://intelx.io",
        referer: "https://intelx.io/",
      },
      allowKeyRotation: false,
    });
    const payload = await response.json();
    const fileReadInfo = payload.paths?.["/file/view"] || payload.paths?.["/file/read"] || null;
    const available = Number(fileReadInfo?.Credit || 0);
    const creditMax = Number(fileReadInfo?.CreditMax || 0);
    results.push({
      keyPreview: maskIntelxKey(apiKey),
      available,
      creditMax,
      used: Math.max(0, creditMax - available),
      raw: payload,
    });
  }

  return results;
}

module.exports = {
  createIntelxClient,
  fetchIntelxAccountInfo,
  maskIntelxKey,
  parseIntelxKeys,
};
