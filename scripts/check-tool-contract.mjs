#!/usr/bin/env node
/**
 * Verify the published stdio contract, including the stateless per-call
 * resourceId argument required by clients that spawn one MCP process per call.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: {
    ...process.env,
    GREENINVOICE_API_ID: "contract-test-id",
    GREENINVOICE_API_SECRET: "contract-test-secret",
  },
  stderr: "pipe",
});
const client = new Client(
  { name: "greeninvoice-contract-check", version: "1.0.0" },
  { capabilities: {} }
);

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${label}`);
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const scopedTools = [
    "account",
    "business",
    "document",
    "client",
    "supplier",
    "item",
    "expense",
    "payment",
    "webhook",
    "partner",
    "sandbox",
  ];

  for (const name of scopedTools) {
    const properties = byName.get(name)?.inputSchema?.properties;
    check(
      `${name} exposes a per-call resourceId`,
      Boolean(properties && Object.hasOwn(properties, "resourceId"))
    );
  }

  check("legacy partner tool remains discoverable", byName.has("partner"));
  check(
    "reference_data does not claim a business scope",
    !Object.hasOwn(byName.get("reference_data")?.inputSchema?.properties ?? {}, "resourceId")
  );
} finally {
  await client.close().catch(() => undefined);
}

console.log(
  failures === 0
    ? "\nAll MCP tool-contract checks passed."
    : `\n${failures} MCP tool-contract check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
