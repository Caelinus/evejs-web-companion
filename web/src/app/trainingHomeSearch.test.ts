import test from "node:test";
import assert from "node:assert/strict";
import { searchTrainingHomes } from "./api.ts";

test("Training Home search retains accessible structure identity beside NPC stations", async () => {
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "http://test");
    assert.equal(url.pathname, "/api/pilot-training/homes");
    assert.equal(url.searchParams.get("q"), "Nonni");
    assert.equal(url.searchParams.get("characterID"), "42");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    return Response.json({ ok: true, capped: false, structureWarning: null, matches: [
      { id: 60001519, kind: "station", name: "Nonni V", solarSystemID: 30001401, solarSystemName: "Nonni" },
      { id: 1000000000001, kind: "structure", name: "Example Astrahus", solarSystemID: 30001401, solarSystemName: "Nonni" },
      { id: 30001401, kind: "system", name: "Nonni", solarSystemID: 30001401, solarSystemName: "Nonni" },
    ] });
  };
  const result = await searchTrainingHomes("Nonni", { token: "test-token", fetch: fetcher }, 42);
  assert.deepEqual(result.matches.map(({ kind, id }) => ({ kind, id })), [
    { kind: "station", id: 60001519 },
    { kind: "structure", id: 1000000000001 },
  ]);
});
