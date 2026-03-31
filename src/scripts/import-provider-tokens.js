require("dotenv").config({ quiet: true });

const { providerMap } = require("../lib/providers");
const { updateProviderSetting } = require("../lib/provider-settings");

function getArgValue(name) {
  const prefix = `${name}=`;
  const raw = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : "";
}

function readPayload() {
  const fromArg = getArgValue("--payload").trim();
  if (fromArg) {
    return fromArg;
  }

  try {
    const fromStdin = require("node:fs").readFileSync(0, "utf8").trim();
    return fromStdin;
  } catch {
    return "";
  }
}

function parsePayload(encoded) {
  if (!encoded) {
    throw new Error("Payload is required. Use --payload='<base64url>' or pass it via stdin.");
  }

  let parsed;
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Payload is not valid base64url JSON");
  }

  const providers = Array.isArray(parsed?.providers) ? parsed.providers : [];
  return {
    version: Number(parsed?.version) || 0,
    createdAt: parsed?.createdAt || null,
    providers,
  };
}

function main() {
  const encoded = readPayload();
  const payload = parsePayload(encoded);
  if (payload.version !== 1) {
    throw new Error(`Unsupported payload version: ${payload.version}`);
  }

  let imported = 0;
  let skipped = 0;

  for (const row of payload.providers) {
    const provider = String(row?.provider || "").trim().toLowerCase();
    if (!providerMap.has(provider)) {
      skipped += 1;
      console.warn(`[tokens:import] skipped unknown provider: ${provider || "<empty>"}`);
      continue;
    }

    const token = typeof row?.token === "string" ? row.token : "";
    const enabled = Boolean(row?.enabled);

    updateProviderSetting({
      provider,
      enabled,
      token,
      clearToken: !token,
    });
    imported += 1;
  }

  console.log(`[tokens:import] imported: ${imported}`);
  console.log(`[tokens:import] skipped: ${skipped}`);
  if (payload.createdAt) {
    console.log(`[tokens:import] payload createdAt: ${payload.createdAt}`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error("[tokens:import] failed:", message);
  process.exit(1);
}
