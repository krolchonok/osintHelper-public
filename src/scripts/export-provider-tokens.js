require("dotenv").config({ quiet: true });

const { getProviderRuntimeSettings } = require("../lib/provider-settings");

function main() {
  const rows = getProviderRuntimeSettings()
    .filter((item) => item && typeof item.provider === "string")
    .filter((item) => item.token || item.enabled === false)
    .map((item) => ({
      provider: item.provider,
      enabled: Boolean(item.enabled),
      token: item.token || "",
    }));

  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    providers: rows,
  };

  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const command = `npm run tokens:import -- --payload='${encoded}'`;

  console.log("[tokens:export] providers:", rows.length);
  console.log("[tokens:export] import command:");
  console.log(command);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error("[tokens:export] failed:", message);
  process.exit(1);
}
