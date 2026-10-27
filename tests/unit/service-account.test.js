import { test } from "node:test";
import assert from "node:assert/strict";
import { parseServiceAccount } from "../../server/firebase.js";

// Dummy key material: shape only, not a real key.
const PEM = "-----BEGIN PRIVATE KEY-----\nTESTONLYKEYMATERIAL\n-----END PRIVATE KEY-----\n";
const ACCOUNT = { type: "service_account", project_id: "one-stop-72ee5", client_email: "svc@one-stop-72ee5.iam.gserviceaccount.com", private_key: PEM };
const json = JSON.stringify(ACCOUNT);
const b64 = Buffer.from(json).toString("base64");

test("service account accepts raw JSON, base64, quotes and whitespace", () => {
  for (const input of [json, ` \n${json}\n `, b64, `"${b64}"`, `'${json}'`, JSON.stringify(ACCOUNT, null, 2)]) {
    const account = parseServiceAccount(input);
    assert.equal(account.project_id, "one-stop-72ee5");
    assert.equal(account.private_key, PEM);
  }
});

test("service account repairs doubly escaped private-key newlines", () => {
  const doubled = json.replace(/\\n/g, "\\\\n");
  assert.equal(parseServiceAccount(doubled).private_key, PEM);
});

test("service account errors name the problem without echoing the value", () => {
  const cases = [
    ["svc-name@one-stop-72ee5.iam.gserviceaccount.com", /email address, not the key/],
    ["C:\\keys\\one-stop-72ee5-abc.json", /looks like a file path/],
    ["{", /first line of a multi-line value/],
    [Buffer.from("not json at all").toString("base64"), /does not decode to JSON/],
    ["%%% not base64 %%%", /neither JSON nor base64/],
    [JSON.stringify({ type: "authorized_user", client_secret: "TESTSECRET" }), /not a service-account key/],
    [JSON.stringify({ ...ACCOUNT, private_key: "TESTSECRET" }), /not a PEM private key/]
  ];
  for (const [input, expected] of cases) {
    assert.throws(() => parseServiceAccount(input), error => {
      assert.match(error.message, expected);
      for (const fragment of ["svc-name", "abc.json", "TESTSECRET", "TESTONLYKEYMATERIAL"]) assert.ok(!error.message.includes(fragment), `message leaks ${fragment}`);
      return true;
    });
  }
});
