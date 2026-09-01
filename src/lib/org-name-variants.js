const LEGAL_PREFIX_RE =
  /^(?:ООО|ОАО|ЗАО|ПАО|АО|ИП|ГУП|МУП|ФГУП|НАО|ПК|КФХ|PUBLICHNOE AKTSIONERNOE OBSHCHESTVO|AKTSIONERNOE OBSHCHESTVO|LIMITED LIABILITY COMPANY|LLC)\s+/i;

const CYRILLIC_TO_LATIN = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

function normalizeOrgName(raw) {
  return String(raw || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function transliterateToLatin(raw) {
  let out = "";
  for (const ch of String(raw || "")) {
    const lower = ch.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(CYRILLIC_TO_LATIN, lower)) {
      out += CYRILLIC_TO_LATIN[lower];
      continue;
    }
    out += ch;
  }
  return normalizeOrgName(out);
}

function stripLegalPrefix(raw) {
  let value = normalizeOrgName(raw);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = value.replace(LEGAL_PREFIX_RE, "").trim();
    if (!next || next === value) {
      break;
    }
    value = next;
  }
  return value;
}

function extractQuotedNames(raw) {
  const names = [];
  const text = String(raw || "");
  for (const match of text.matchAll(/["«]([^"»]+)["»]/g)) {
    const quoted = normalizeOrgName(match[1]);
    if (quoted) {
      names.push(quoted);
    }
  }
  return names;
}

function buildOrgNameVariants(company) {
  const variants = new Set();
  const seeds = [
    company?.fullName,
    company?.shortName,
    ...extractQuotedNames(company?.fullName),
    ...extractQuotedNames(company?.shortName),
  ];

  const add = (raw) => {
    const value = normalizeOrgName(raw);
    if (value.length >= 3) {
      variants.add(value);
    }
  };

  for (const seed of seeds) {
    add(seed);
    add(stripLegalPrefix(seed));
  }

  for (const value of [...variants]) {
    if (/[А-Яа-яЁё]/.test(value)) {
      add(transliterateToLatin(value));
      add(transliterateToLatin(stripLegalPrefix(value)));
    }
  }

  for (const value of [...variants]) {
    if (/^[A-Za-z0-9 .,&'"-]+$/.test(value)) {
      add(value.toUpperCase());
      add(
        value
          .replace(/[^A-Za-z0-9]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .toUpperCase(),
      );
      add(value.replace(/[^A-Za-z0-9]+/g, "").toUpperCase());
    }
  }

  return [...variants];
}

function buildOrgNameVariantsFromText(raw) {
  return buildOrgNameVariants({ fullName: raw, shortName: raw });
}

module.exports = {
  buildOrgNameVariants,
  buildOrgNameVariantsFromText,
  transliterateToLatin,
};
