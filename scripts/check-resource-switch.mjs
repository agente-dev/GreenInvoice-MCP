#!/usr/bin/env node
/**
 * Offline verification for CPA business switching.
 *
 * Morning's representative UI keeps one authorization token and changes the
 * selected client business with X-Resource-Id. This check proves that the
 * client propagates that header, can change it between calls, can clear it,
 * and does not request a new token merely because the business changed.
 */

import { GreenInvoiceClient } from "../dist/client.js";

const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
const originalFetch = globalThis.fetch;
const originalAuthMode = process.env.GREENINVOICE_AUTH_MODE;
const originalTokenUrl = process.env.GREENINVOICE_TOKEN_URL;
process.env.GREENINVOICE_AUTH_MODE = "oauth";
delete process.env.GREENINVOICE_TOKEN_URL;
const requests = [];
let authCalls = 0;

globalThis.fetch = async (url, options = {}) => {
  const requestUrl = String(url);
  const headers = new Headers(options.headers);
  requests.push({
    url: requestUrl,
    authorization: headers.get("Authorization"),
    resourceId: headers.get("X-Resource-Id"),
  });

  if (requestUrl.endsWith("/idp/v1/oauth/token")) {
    authCalls++;
    return new Response(JSON.stringify({
      accessToken: "sandbox-test-token",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (requestUrl.endsWith("/account/token")) {
    authCalls++;
    return new Response(JSON.stringify({ token: "legacy-test-token" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ items: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

let failures = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

try {
  const client = new GreenInvoiceClient("test-id", "test-secret", true);

  client.setResourceId(BUSINESS_A);
  await client.post("/documents/search", { page: 1 });

  // Stateless MCP transports cannot rely on a prior `select` call. The
  // resource must be carried by this request without changing the saved
  // selection on a long-lived client.
  await client.post("/documents/search", { page: 1 }, BUSINESS_B);

  await client.post("/documents/search", { page: 1 });

  client.setResourceId(null);
  await client.post("/documents/search", { page: 1 });

  const apiRequests = requests.filter(
    (request) =>
      !request.url.endsWith("/account/token") &&
      !request.url.endsWith("/idp/v1/oauth/token")
  );

  check("one token is reused across business switches", authCalls === 1);
  check(
    "first request carries business A",
    apiRequests[0]?.resourceId === BUSINESS_A,
    String(apiRequests[0]?.resourceId)
  );
  check(
    "explicit per-call override carries business B",
    apiRequests[1]?.resourceId === BUSINESS_B,
    String(apiRequests[1]?.resourceId)
  );
  check(
    "per-call override does not mutate saved selection",
    apiRequests[2]?.resourceId === BUSINESS_A,
    String(apiRequests[2]?.resourceId)
  );
  check(
    "cleared context omits X-Resource-Id",
    apiRequests[3]?.resourceId === null,
    String(apiRequests[3]?.resourceId)
  );
  check(
    "authorization remains unchanged",
    apiRequests.every(
      (request) => request.authorization === "Bearer sandbox-test-token"
    )
  );
  check(
    "selected resource getter reflects clear",
    client.resourceId === null
  );

  let invalidRejected = false;
  try {
    client.setResourceId("not-a-business-uuid");
  } catch {
    invalidRejected = true;
  }
  check("invalid business IDs are rejected", invalidRejected);
} finally {
  globalThis.fetch = originalFetch;
  if (originalAuthMode === undefined) delete process.env.GREENINVOICE_AUTH_MODE;
  else process.env.GREENINVOICE_AUTH_MODE = originalAuthMode;
  if (originalTokenUrl === undefined) delete process.env.GREENINVOICE_TOKEN_URL;
  else process.env.GREENINVOICE_TOKEN_URL = originalTokenUrl;
}

console.log(
  failures === 0
    ? "\nAll resource-switch checks passed."
    : `\n${failures} resource-switch check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
