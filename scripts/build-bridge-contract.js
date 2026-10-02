"use strict";

// One checked contract shared by the two repositories. Each repository can
// verify the half it owns without requiring the sibling checkout; when both
// are present this generator updates identical manifests in one operation.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WEB_ROOT = path.resolve(__dirname, "..");
const EVEJS_ROOT = path.resolve(process.env.EVEJS_REPO || path.join(WEB_ROOT, "..", "eve.js"));
const GATEWAY_SOURCE = path.join(
  EVEJS_ROOT,
  "server",
  "src",
  "_secondary",
  "express",
  "evejsWebGatewayRuntime.js",
);
const WEB_POLICY_SOURCE = path.join(WEB_ROOT, "src", "bridgeCallPolicy.js");
const FILE_NAME = "evejs-web-bridge-contract.json";

function digest(values) {
  return crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function sortedUnique(values, label) {
  const sorted = [...values].map(String).sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new Error(`${label} contains a duplicate pair.`);
  }
  return sorted;
}

function buildContract() {
  if (!fs.existsSync(GATEWAY_SOURCE)) {
    throw new Error(`EveJS gateway source was not found at ${GATEWAY_SOURCE}`);
  }
  const gateway = require(GATEWAY_SOURCE);
  const policy = require(WEB_POLICY_SOURCE);
  const allowedPairs = sortedUnique(
    gateway.WEB_CALL_ALLOWLIST.map((pair) => `${pair.service}.${pair.method}`),
    "gateway allowlist",
  );
  const writePairs = sortedUnique(policy.BRIDGE_WRITE_PAIR_KEYS, "BFF write policy");
  // The BFF's defensive write denylist also includes methods the gateway
  // currently refuses. Keep the two inventories independent: adding a deny
  // classification must never require expanding the game's allowlist.
  return {
    schemaVersion: 1,
    sources: {
      gatewayAllowlist: "eve.js/server/src/_secondary/express/evejsWebGatewayRuntime.js#WEB_CALL_ALLOWLIST",
      bffWritePolicy: "evejs-web-poc/src/bridgeCallPolicy.js#BRIDGE_WRITE_PAIR_KEYS",
    },
    gatewayAllowlist: {
      count: allowedPairs.length,
      sha256: digest(allowedPairs),
      pairs: allowedPairs,
    },
    bffWritePolicy: {
      count: writePairs.length,
      sha256: digest(writePairs),
      pairs: writePairs,
    },
    boundary: {
      genericBridgeAllowsWrites: false,
      browserSessionFields: [...policy.SAFE_BROWSER_SESSION_FIELDS],
    },
  };
}

function writeJson(filePath, contract) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
}

function main(argv = process.argv.slice(2)) {
  const contract = buildContract();
  if (argv.includes("--write")) {
    const webPath = path.join(WEB_ROOT, "contracts", FILE_NAME);
    const evePath = path.join(EVEJS_ROOT, "server", "contracts", FILE_NAME);
    writeJson(webPath, contract);
    writeJson(evePath, contract);
    console.log(`Wrote ${webPath}`);
    console.log(`Wrote ${evePath}`);
    return;
  }
  process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = { buildContract, digest, sortedUnique };
