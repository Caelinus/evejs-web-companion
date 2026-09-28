import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccountPass, readAcrossAccounts, type AccountPassDeps } from "./accountPass.ts";

function stubDeps(refuse: ReadonlySet<string> = new Set()) {
  const signIns: string[] = [];
  const signOuts: string[] = [];
  let minted = 0;
  const deps: AccountPassDeps = {
    async signIn(accountName) {
      signIns.push(accountName);
      if (refuse.has(accountName)) throw new Error("refused");
      minted += 1;
      return `token-${accountName}-${minted}`;
    },
    async signOut(token) {
      signOuts.push(token);
    },
  };
  return { deps, signIns, signOuts };
}

test("an account is signed in once and its token reused", async () => {
  const { deps, signIns } = stubDeps();
  const pass = createAccountPass(deps);
  const first = await pass.optionsFor("alpha");
  const second = await pass.optionsFor("alpha");
  assert.deepEqual(first, { token: "token-alpha-1" });
  assert.deepEqual(second, first);
  assert.deepEqual(signIns, ["alpha"]);
});

test("two asks in the same tick share one sign-in", async () => {
  const { deps, signIns } = stubDeps();
  const pass = createAccountPass(deps);
  const [a, b] = await Promise.all([pass.optionsFor("alpha"), pass.optionsFor("alpha")]);
  assert.deepEqual(a, b);
  assert.deepEqual(signIns, ["alpha"]);
});

test("a refused sign-in is not remembered", async () => {
  const refuse = new Set(["alpha"]);
  const { deps, signIns } = stubDeps(refuse);
  const pass = createAccountPass(deps);
  await assert.rejects(pass.optionsFor("alpha"));
  refuse.delete("alpha");
  assert.deepEqual(await pass.optionsFor("alpha"), { token: "token-alpha-1" });
  assert.deepEqual(signIns, ["alpha", "alpha"]);
});

test("a forgotten account signs in afresh", async () => {
  const { deps, signIns } = stubDeps();
  const pass = createAccountPass(deps);
  await pass.optionsFor("alpha");
  pass.forget("alpha");
  assert.deepEqual(await pass.optionsFor("alpha"), { token: "token-alpha-2" });
  assert.deepEqual(signIns, ["alpha", "alpha"]);
});

test("an unknown account is refused without a sign-in", async () => {
  const { deps, signIns } = stubDeps();
  const pass = createAccountPass(deps);
  await assert.rejects(pass.optionsFor(""), /no longer knows which account/);
  assert.deepEqual(signIns, []);
});

test("release signs every minted token out and refuses later asks", async () => {
  const { deps, signOuts } = stubDeps(new Set(["broken"]));
  const pass = createAccountPass(deps);
  await pass.optionsFor("alpha");
  await pass.optionsFor("beta");
  await assert.rejects(pass.optionsFor("broken"));
  await pass.release();
  assert.deepEqual(signOuts.sort(), ["token-alpha-1", "token-beta-2"]);
  await assert.rejects(pass.optionsFor("alpha"), /closed/);
  await pass.release();
  assert.equal(signOuts.length, 2);
});

test("a read across accounts names the accounts it could not read", async () => {
  const result = await readAcrossAccounts(["alpha", "beta", "gamma"], async (name) => {
    if (name === "beta") throw new Error("down");
    return [`${name}-1`, `${name}-2`];
  });
  assert.deepEqual(result.rows, ["alpha-1", "alpha-2", "gamma-1", "gamma-2"]);
  assert.deepEqual(result.failed, ["beta"]);
});

test("accounts are read one at a time", async () => {
  let inFlight = 0;
  let peak = 0;
  await readAcrossAccounts(["a", "b", "c"], async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return [];
  });
  assert.equal(peak, 1);
});
