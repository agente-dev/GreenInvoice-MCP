import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { GreenInvoiceClient } from "../src/client.ts";

const originalFetch = globalThis.fetch;
const originalAuthMode = process.env.GREENINVOICE_AUTH_MODE;
const originalTokenUrl = process.env.GREENINVOICE_TOKEN_URL;

beforeEach(() => {
  delete process.env.GREENINVOICE_TOKEN_URL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAuthMode === undefined) delete process.env.GREENINVOICE_AUTH_MODE;
  else process.env.GREENINVOICE_AUTH_MODE = originalAuthMode;
  if (originalTokenUrl === undefined) delete process.env.GREENINVOICE_TOKEN_URL;
  else process.env.GREENINVOICE_TOKEN_URL = originalTokenUrl;
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureResourceResponse(url, init = {}) {
  return jsonResponse({
    url,
    authorization: new Headers(init.headers).get("Authorization"),
  });
}

test("OAuth uses the production IdP contract and bearer token for resource calls", async () => {
  process.env.GREENINVOICE_AUTH_MODE = "oauth";
  delete process.env.GREENINVOICE_TOKEN_URL;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method, body: init.body });
    if (url === "https://api.morning.co/idp/v1/oauth/token") {
      return jsonResponse({
        accessToken: "oauth-contract-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    return captureResourceResponse(url, init);
  };

  const client = new GreenInvoiceClient("contract-id", "contract-secret");
  const result = await client.get("/businesses/me");

  assert.equal(requests[0].url, "https://api.morning.co/idp/v1/oauth/token");
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(JSON.parse(requests[0].body), {
    client_id: "contract-id",
    client_secret: "contract-secret",
    grant_type: "client_credentials",
  });
  assert.deepEqual(result, {
    url: "https://api.greeninvoice.co.il/api/v1/businesses/me",
    authorization: "Bearer oauth-contract-token",
  });
});

test("auto mode falls back once to legacy and keeps the winning strategy sticky", async () => {
  process.env.GREENINVOICE_AUTH_MODE = "auto";
  delete process.env.GREENINVOICE_TOKEN_URL;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method, body: init.body });
    if (url === "https://api.morning.co/idp/v1/oauth/token") {
      return jsonResponse({ error: "not provisioned" }, 401);
    }
    if (url.endsWith("/account/token")) return jsonResponse({ token: "legacy-token" });
    return captureResourceResponse(url, init);
  };

  const client = new GreenInvoiceClient("contract-id", "contract-secret");
  const first = await client.get("/businesses/me");
  const second = await client.get("/businesses/me");

  assert.equal(calls.filter((call) => call.url.endsWith("/idp/v1/oauth/token")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/account/token")).length, 1);
  assert.equal(first.authorization, "Bearer legacy-token");
  assert.equal(second.authorization, "Bearer legacy-token");
});

test("auto mode falls back to legacy when the IdP request has a network error", async () => {
  process.env.GREENINVOICE_AUTH_MODE = "auto";
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://api.morning.co/idp/v1/oauth/token") {
      throw new Error("fixture IdP network failure");
    }
    if (url.endsWith("/account/token")) {
      return jsonResponse({ token: "legacy-after-network-error" });
    }
    return captureResourceResponse(url, init);
  };

  const client = new GreenInvoiceClient("contract-id", "contract-secret");
  const result = await client.get("/businesses/me");

  assert.deepEqual(calls.slice(0, 2), [
    "https://api.morning.co/idp/v1/oauth/token",
    "https://api.greeninvoice.co.il/api/v1/account/token",
  ]);
  assert.equal(result.authorization, "Bearer legacy-after-network-error");
});

test("oauth mode does not call the legacy endpoint when the IdP rejects credentials", async () => {
  process.env.GREENINVOICE_AUTH_MODE = "oauth";
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    return jsonResponse({ error: "rejected" }, 401);
  };

  const client = new GreenInvoiceClient("contract-id", "contract-secret");
  await assert.rejects(client.get("/businesses/me"), /OAuth auth failed \(401\)/);
  assert.deepEqual(calls, ["https://api.morning.co/idp/v1/oauth/token"]);
});

test("legacy mode uses only the existing account token endpoint", async () => {
  process.env.GREENINVOICE_AUTH_MODE = "legacy";
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/account/token")) {
      return jsonResponse({ token: "explicit-legacy-token" });
    }
    return captureResourceResponse(url, init);
  };

  const client = new GreenInvoiceClient("contract-id", "contract-secret");
  const result = await client.get("/businesses/me");

  assert.deepEqual(calls, [
    "https://api.greeninvoice.co.il/api/v1/account/token",
    "https://api.greeninvoice.co.il/api/v1/businesses/me",
  ]);
  assert.equal(result.authorization, "Bearer explicit-legacy-token");
});

test("OAuth cache refreshes inside the existing five-minute safety margin", async () => {
  process.env.GREENINVOICE_AUTH_MODE = "oauth";
  let issued = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/idp/v1/oauth/token")) {
      issued += 1;
      return jsonResponse({
        accessToken: `token-${issued}`,
        expiresAt: Math.floor(Date.now() / 1000) + (issued === 1 ? 240 : 3600),
      });
    }
    return captureResourceResponse(url, init);
  };

  const client = new GreenInvoiceClient("contract-id", "contract-secret");
  await client.get("/businesses/me");
  await client.get("/businesses/me");
  assert.equal(issued, 2);
});

test("sandbox client infers the separate sandbox IdP and keeps its resource base", async () => {
  process.env.GREENINVOICE_AUTH_MODE = "oauth";
  delete process.env.GREENINVOICE_TOKEN_URL;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://api.sandbox.morning.dev/idp/v1/oauth/token") {
      return jsonResponse({
        accessToken: "sandbox-oauth-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    return captureResourceResponse(url, init);
  };

  const client = new GreenInvoiceClient("sandbox-id", "sandbox-secret", true);
  const result = await client.get("/businesses/me");

  assert.equal(calls[0], "https://api.sandbox.morning.dev/idp/v1/oauth/token");
  assert.equal(result.url, "https://sandbox.d.greeninvoice.co.il/api/v1/businesses/me");
  assert.equal(result.authorization, "Bearer sandbox-oauth-token");
});

test("GREENINVOICE_TOKEN_URL overrides inferred IdP endpoint", async () => {
  process.env.GREENINVOICE_AUTH_MODE = "oauth";
  process.env.GREENINVOICE_TOKEN_URL = "https://idp.example.test/custom-token";
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === process.env.GREENINVOICE_TOKEN_URL) {
      return jsonResponse({
        accessToken: "override-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    return captureResourceResponse(url, init);
  };

  const client = new GreenInvoiceClient("contract-id", "contract-secret");
  await client.get("/businesses/me");
  assert.equal(calls[0], "https://idp.example.test/custom-token");
});

test("a resource 401 invalidates OAuth cache and retries once with a fresh token", async () => {
  process.env.GREENINVOICE_AUTH_MODE = "oauth";
  let issued = 0;
  let resourceCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/idp/v1/oauth/token")) {
      issued += 1;
      return jsonResponse({
        accessToken: `token-${issued}`,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    resourceCalls += 1;
    if (resourceCalls === 1) return jsonResponse({ error: "expired" }, 401);
    return captureResourceResponse(url, init);
  };

  const client = new GreenInvoiceClient("contract-id", "contract-secret");
  const result = await client.get("/businesses/me");

  assert.equal(issued, 2);
  assert.equal(resourceCalls, 2);
  assert.equal(result.authorization, "Bearer token-2");
});
