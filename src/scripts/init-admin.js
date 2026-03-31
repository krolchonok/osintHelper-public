require("dotenv").config({ quiet: true });

const { openDatabase } = require("../db");
const { config } = require("../lib/config");
const { initAdminBootstrap } = require("../lib/bootstrap");

async function main() {
  openDatabase(config.sqlitePath);
  await initAdminBootstrap();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[auth:init-admin] failed: ${message}`);
  process.exit(1);
});
