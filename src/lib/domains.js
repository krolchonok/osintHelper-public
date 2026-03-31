const DOMAIN_RE = /^(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function isValidDomain(value) {
  return DOMAIN_RE.test(value);
}

function parseDomainInput(raw) {
  const parts = String(raw || "")
    .split(/[\n,;]+/g)
    .map((item) => normalizeDomain(item))
    .filter(Boolean);

  return Array.from(new Set(parts)).filter(isValidDomain);
}

module.exports = {
  normalizeDomain,
  isValidDomain,
  parseDomainInput,
};
