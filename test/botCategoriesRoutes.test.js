"use strict";

// The bot library's CATEGORY routes, over the real store on a temp directory.
// The store's own rules are covered by src/botScriptStore.test.js; these pin
// the wiring: that "/api/botscripts/category" is not swallowed by the
// ":scriptID" route, that a save can file a bot, that store refusals come back
// as their HTTP statuses, and that deleting a category keeps its bots.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");

process.env.EVEJS_WEB_POC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-botcat-"));

const webAuth = require("../src/webAuth");
const { createApp } = require("../src/server");
const { createBotScriptStore } = require("../src/botScriptStore");

// Obviously synthetic account, not real EVE data.
const PILOT = { username: "category-test-pilot", accountID: 4001, role: "0", banned: false };

const activeServers = new Set();

async function startTestServer() {
  const app = createApp({
    eveStore: {
      async getAccount(username) {
        return String(username) === PILOT.username ? { ...PILOT } : null;
      },
      async listCharactersForAccount() {
        return [];
      },
      async getCharacterForAccount() {
        return null;
      },
    },
    webAuth,
    botScriptStore: createBotScriptStore({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-botcat-store-")),
    }),
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await request(baseUrl, "/api/login", {
    method: "POST",
    body: { username: PILOT.username, password: "x" },
  });
  return { baseUrl, token: login.payload.sessionToken };
}

test.after(() => {
  for (const server of activeServers) {
    server.close();
  }
});

async function request(baseUrl, routePath, { method = "GET", token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

const doc = (name) => ({ format: "evejs-bot-script", version: 1, name, program: [] });

test("categories: create, file on save, move, rename, reorder, delete keeps the bots", async () => {
  const { baseUrl, token } = await startTestServer();
  const post = (routePath, body) => request(baseUrl, routePath, { method: "POST", token, body });

  const mining = (await post("/api/botcategories", { name: "Mining" })).payload.categoryID;
  const ratting = (await post("/api/botcategories", { name: "Ratting" })).payload.categoryID;
  assert.ok(mining && ratting);

  const a = (await post("/api/botscripts", { doc: doc("A"), categoryID: mining })).payload.scriptID;
  const b = (await post("/api/botscripts", { doc: doc("B") })).payload.scriptID;

  const moved = await post("/api/botscripts/category", { scriptIDs: [b], categoryID: mining });
  assert.equal(moved.response.status, 200);
  assert.equal(moved.payload.moved, 1);

  // A save that names a category re-files the bot; one that does not keeps it.
  await post(`/api/botscripts/${a}`, { doc: doc("A"), baseRev: 1, categoryID: ratting });
  await post(`/api/botscripts/${b}`, { doc: doc("B"), baseRev: 1 });

  let scripts = (await request(baseUrl, "/api/botscripts", { token })).payload.scripts;
  const byID = (id) => scripts.find((row) => row.scriptID === id);
  assert.equal(byID(a).categoryID, ratting);
  assert.equal(byID(b).categoryID, mining);

  await post(`/api/botcategories/${mining}`, { name: "Ore", index: 1 });
  const categories = (await request(baseUrl, "/api/botcategories", { token })).payload.categories;
  assert.deepEqual(categories.map((row) => row.name), ["Ratting", "Ore"]);

  const removed = await post(`/api/botcategories/${mining}/delete`, {});
  assert.equal(removed.payload.uncategorized, 1);
  scripts = (await request(baseUrl, "/api/botscripts", { token })).payload.scripts;
  assert.equal(scripts.length, 2, "deleting a category deletes no bot");
  assert.equal(byID(b).categoryID, null);
});

test("category refusals come back with their HTTP statuses", async () => {
  const { baseUrl, token } = await startTestServer();
  const post = (routePath, body) => request(baseUrl, routePath, { method: "POST", token, body });

  await post("/api/botcategories", { name: "Mining" });
  assert.equal((await post("/api/botcategories", { name: "mining" })).response.status, 409);
  assert.equal((await post("/api/botcategories", { name: " " })).response.status, 400);
  assert.equal((await post("/api/botcategories/nope/delete", {})).response.status, 404);
  assert.equal((await post("/api/botscripts", { doc: doc("x"), categoryID: "nope" })).response.status, 404);
});

test("category routes require a sign-in", async () => {
  const { baseUrl } = await startTestServer();
  assert.equal((await request(baseUrl, "/api/botcategories")).response.status, 401);
});
