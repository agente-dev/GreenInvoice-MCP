/**
 * MCP tool definitions for the Green Invoice API.
 * Consolidated resource-based tools covering all 66 API endpoints.
 *
 * DISCLAIMER: This is an unofficial, third-party integration.
 * Not affiliated with or endorsed by Green Invoice.
 *
 * API Reference: https://www.greeninvoice.co.il/api-docs/
 * Apiary spec last updated: 2026-03-11
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GreenInvoiceClient, SANDBOX_BASE } from "./client.js";

// ── Shared helpers ─────────────────────────────────────────────────────

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function parseData(raw?: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in 'data' parameter: ${raw}`);
  }
}

const resourceIdInput = z
  .string()
  .optional()
  .describe(
    "Business UUID to send as X-Resource-Id for this call. Pass it on every call when the MCP transport is stateless or starts a new process per tool call."
  );

function getBusinessId(data: Record<string, unknown> | undefined): string {
  const value = data?.businessId ?? data?.id;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      "A business UUID is required (data: {\"businessId\":\"...\"})"
    );
  }
  return value;
}

async function selectBusiness(
  client: GreenInvoiceClient,
  data: Record<string, unknown> | undefined
) {
  const businessId = getBusinessId(data);
  const previousResourceId = client.resourceId;
  client.setResourceId(businessId);

  try {
    const business = await client.get("/businesses/me");
    return {
      selectedBusinessId: client.resourceId,
      business,
    };
  } catch (error) {
    client.setResourceId(previousResourceId);
    throw error;
  }
}

// ── Reference enums (embedded in descriptions) ────────────────────────

const DOC_TYPES = `Document type codes (per GET /documents/types): 10=Price Quotation, 20=Bill/Payment Confirmation, 100=Order (sales order/order confirmation), 200=Delivery Note, 210=Return Delivery, 300=Proforma Invoice (חשבון עסקה), 305=Tax Invoice, 320=Tax Invoice+Receipt, 330=Credit Note, 400=Receipt, 405=Donation Receipt, 410=Cancel Donation, 500=Purchase Order (הזמנת רכש, issued to a supplier), 600=Deposit Receipt, 610=Deposit Withdrawal. There is no RFQ document type (price quotations are outbound only).`;

const DOC_STATUSES = `Document statuses: 0=Open, 1=Closed, 2=Manually Closed, 3=Canceling, 4=Canceled`;

const PAYMENT_TYPES = `Payment type codes: -1=Unpaid, 0=Deduction at Source, 1=Cash, 2=Check, 3=Credit Card, 4=Bank Transfer, 5=PayPal, 10=Payment App, 11=Other`;

const CURRENCIES = `Currencies: ILS, USD, EUR, GBP, JPY, CHF, CNY, AUD, CAD, and more (28 supported)`;

// ── Sandbox test-data helpers ─────────────────────────────────────────

/** Document types the API rejects without a payment array. */
const PAYMENT_REQUIRED_TYPES = new Set([320, 400, 405]);

const TEST_REMARKS =
  "TEST DATA — created in the Green Invoice sandbox by greeninvoice-mcp. Not a real financial document.";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function finiteNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`'${field}' must be a finite number`);
  }
  return parsed;
}

/**
 * Expand a minimal spec into a complete, valid document payload.
 *
 * Everything has a default so `create_test_document` works with no arguments at
 * all; every default can be overridden. Callers wanting full control over the
 * body should use the `create_document` action instead.
 */
export function buildTestDocument(data: Record<string, unknown> = {}): Record<string, unknown> {
  const type = finiteNumber(data.type ?? 305, "type");
  const price = finiteNumber(data.price ?? 100, "price");
  const quantity = finiteNumber(data.quantity ?? 1, "quantity");
  const currency = (data.currency as string) ?? "ILS";
  const date = (data.date as string) ?? today();

  const doc: Record<string, unknown> = {
    type,
    date,
    lang: (data.lang as string) ?? "en",
    currency,
    description: (data.description as string) ?? `TEST document (type ${type})`,
    remarks: (data.remarks as string) ?? TEST_REMARKS,
    client: {
      name: (data.clientName as string) ?? "MCP Sandbox Test Client",
      add: data.addClient === false ? false : true,
      ...(data.clientEmails ? { emails: data.clientEmails } : {}),
      ...(data.clientTaxId ? { taxId: data.clientTaxId } : {}),
    },
    income: [
      {
        description: (data.itemDescription as string) ?? "Test line item",
        quantity,
        price,
        currency,
        vatType: finiteNumber(data.vatType ?? 0, "vatType"),
      },
    ],
  };

  if (data.dueDate) doc.dueDate = data.dueDate;

  if (PAYMENT_REQUIRED_TYPES.has(type)) {
    // Defaults to the line subtotal. With vatType 0 the document total includes
    // VAT on top, so this leaves the document partially paid rather than closed
    // — pass paymentAmount explicitly to settle it in full.
    doc.payment = [
      {
        date,
        type: finiteNumber(data.paymentType ?? 4, "paymentType"),
        price: finiteNumber(data.paymentAmount ?? price * quantity, "paymentAmount"),
        currency,
      },
    ];
  }

  return doc;
}

/** Document types the `seed` action creates, one of each. */
export const SEED_TYPES = [10, 300, 305, 320, 400];

// ════════════════════════════════════════════════════════════════════════

export function registerTools(
  server: McpServer,
  client: GreenInvoiceClient,
  sandboxClient: GreenInvoiceClient | null = null
) {

  // ── 1. ACCOUNT ───────────────────────────────────────────────────────

  server.tool(
    "account",
    `Get account information.
Actions: "get" = current business info (GET /businesses/me) — sufficient for "who am I" / connection verification.
Note: there is no public-API "settings" action; /account/me is web-session only (403 for API keys) and /account/settings does not exist (404).`,
    {
      action: z.enum(["get"]).describe("Action to perform"),
      resourceId: resourceIdInput,
    },
    async ({ resourceId }) => {
      return json(await client.get("/businesses/me", resourceId));
    }
  );

  // ── 2. BUSINESS ──────────────────────────────────────────────────────

  server.tool(
    "business",
    `Manage businesses. Actions:
"list" = list all businesses available to the authenticated user, including invited businesses visible to a representative (GET /businesses)
"select" = select a business for subsequent calls without changing the authorization token (data: {"businessId":"..."}). Sends the UUID as X-Resource-Id and verifies it with GET /businesses/me.
"get_selection" = return the currently selected X-Resource-Id business context
"clear_selection" = return to the API key's default business context
"resourceId" (top-level tool argument) = use a business UUID for this call. This is the reliable option for stateless clients; pass it again on every subsequent tool call.
"get" = get current business (GET /businesses/me) or by id (data: {"id":"..."})
"update" = update business (data: JSON of fields to update)
"get_numbering" = get document numbering (GET /businesses/numbering)
"set_numbering" = set initial numbering (data: {"10":1,"305":50001,...})
"get_footer" = get document footer text
"get_types" = get business types (data: {"lang":"he"} optional)
"upload_file" = upload logo/signature/doc (data: {"type":"logo","file":"base64..."})
"delete_file" = delete a file (data: {"type":"logo"})`,
    {
      action: z.enum(["list", "select", "get_selection", "clear_selection", "get", "update", "get_numbering", "set_numbering", "get_footer", "get_types", "upload_file", "delete_file"])
        .describe("Action to perform"),
      data: z.string().optional().describe("JSON string of request parameters (see action descriptions)"),
      resourceId: resourceIdInput,
    },
    async ({ action, data: raw, resourceId }) => {
      const data = parseData(raw) as Record<string, unknown> | undefined;
      switch (action) {
        case "list":
          return json(await client.get("/businesses", resourceId));
        case "select":
          return json(await selectBusiness(client, data));
        case "get_selection":
          return json({ selectedBusinessId: client.resourceId });
        case "clear_selection": {
          const previousBusinessId = client.resourceId;
          client.setResourceId(null);
          return json({
            selectedBusinessId: null,
            previousBusinessId,
          });
        }
        case "get": {
          const id = data?.id as string | undefined;
          return json(await client.get(id ? `/businesses/${id}` : "/businesses/me", resourceId));
        }
        case "update":
          return json(await client.put("/businesses", data, resourceId));
        case "get_numbering":
          return json(await client.get("/businesses/numbering", resourceId));
        case "set_numbering":
          return json(await client.put("/businesses/numbering", data, resourceId));
        case "get_footer":
          return json(await client.get("/businesses/footer", resourceId));
        case "get_types": {
          const lang = data?.lang ? `?lang=${data.lang}` : "";
          return json(await client.get(`/businesses/types${lang}`, resourceId));
        }
        case "upload_file":
          return json(await client.post("/businesses/file", data, resourceId));
        case "delete_file":
          return json(await client.request("DELETE", "/businesses/file", data, resourceId));
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }
  );

  // ── 3. DOCUMENT ──────────────────────────────────────────────────────

  server.tool(
    "document",
    `Manage documents (invoices, receipts, quotes, etc.). ${DOC_TYPES}. ${DOC_STATUSES}. ${PAYMENT_TYPES}. ${CURRENCIES}.

Actions:
"search" = search documents (data: {page, pageSize, type:[], status:[], fromDate, toDate, sort, clientId, clientName, description, number, paymentTypes:[], download})
"get" = get by ID (data: {"id":"..."})
"create" = create document (works for ALL types above, incl. 100=Order and 500=Purchase Order). IMPORTANT field names: 'income' (not 'items'), 'payment' (not 'payments'), 'remarks' (not 'notes'), 'lang' (not 'language'), 'emails' (array). Types 320,400,405 REQUIRE payment array. Set client.add=true to auto-create client. For type 500 the 'client' object holds the SUPPLIER being ordered from (document recipient); manage supplier records themselves with the 'supplier' tool. Data: {type, client:{id,name,emails,taxId,address,city,zip,country,phone,add,self}, income:[{catalogNum,description,quantity,price,currency,vatType,itemId}], payment:[{date,type,price,currency,bankName,bankBranch,bankAccount,chequeNum}], currency,lang,description,remarks,footer,emailContent,signed,rounding,attachment,date,dueDate,discount:{amount,type},maxPayments,linkedDocumentIds,linkedPaymentId}
"update" = update document (data: {"id":"...", ...fields})
"close" = close document (data: {"id":"..."})
"open" = reopen document (data: {"id":"..."})
"send" = send via email (data: {"id":"...", "email":"optional-override"})
"download_links" = get PDF download links (data: {"id":"..."})
"add_payment" = add payment to document (data: {"id":"...", type, price, currency, date, bankName, bankBranch, bankAccount, chequeNum})
"preview" = preview as base64 PDF (data: same shape as create)
"get_linked" = get linked documents (data: {"id":"..."})
"get_info" = get document info for a type (data: {"type":305})
"get_types" = list document types (data: {"lang":"he"} optional)
"get_statuses" = list document statuses (data: {"lang":"he"} optional)
"search_payments" = search payments within documents (data: {page, pageSize, type:[], paymentTypes:[], fromDate, toDate, paymentId, sort})`,
    {
      action: z.enum(["search", "get", "create", "update", "close", "open", "send", "download_links", "add_payment", "preview", "get_linked", "get_info", "get_types", "get_statuses", "search_payments"])
        .describe("Action to perform"),
      data: z.string().optional().describe("JSON string of request parameters"),
      resourceId: resourceIdInput,
    },
    async ({ action, data: raw, resourceId }) => {
      const data = parseData(raw) as Record<string, unknown> | undefined;
      const id = data?.id as string | undefined;
      switch (action) {
        case "search":
          return json(await client.post("/documents/search", data, resourceId));
        case "get":
          return json(await client.get(`/documents/${id}`, resourceId));
        case "create": {
          const body = { ...data };
          delete body.id;
          return json(await client.post("/documents", body, resourceId));
        }
        case "update": {
          const body = { ...data };
          delete body.id;
          return json(await client.put(`/documents/${id}`, body, resourceId));
        }
        case "close":
          return json(await client.post(`/documents/${id}/close`, undefined, resourceId));
        case "open":
          return json(await client.post(`/documents/${id}/open`, undefined, resourceId));
        case "send": {
          const body: Record<string, unknown> = {};
          if (data?.email) body.email = data.email;
          return json(await client.post(`/documents/${id}/send`, body, resourceId));
        }
        case "download_links":
          return json(await client.get(`/documents/${id}/download/links`, resourceId));
        case "add_payment": {
          const body = { ...data };
          delete body.id;
          return json(await client.post(`/documents/${id}/payment`, body, resourceId));
        }
        case "preview":
          return json(await client.post("/documents/preview", data, resourceId));
        case "get_linked":
          return json(await client.get(`/documents/${id}/linked`, resourceId));
        case "get_info": {
          const type = data?.type;
          return json(await client.get(`/documents/info?type=${type}`, resourceId));
        }
        case "get_types": {
          const lang = data?.lang ? `?lang=${data.lang}` : "";
          return json(await client.get(`/documents/types${lang}`, resourceId));
        }
        case "get_statuses": {
          const lang = data?.lang ? `?lang=${data.lang}` : "";
          return json(await client.get(`/documents/statuses${lang}`, resourceId));
        }
        case "search_payments":
          return json(await client.post("/documents/payments/search", data, resourceId));
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }
  );

  // ── 4. CLIENT ────────────────────────────────────────────────────────

  server.tool(
    "client",
    `Manage clients. Actions:
"search" = search clients (data: {page, pageSize, name, email, taxId, active, contactPerson, labels:[], sort, sortType})
"get" = get by ID (data: {"id":"..."})
"create" = create client (data: {name, emails:[], taxId, phone, mobile, fax, city, zip, address, country, category, subCategory, accountingKey, paymentTerms, bankName, bankBranch, bankAccount, active, department, contactPerson, remarks, labels:[]})
"update" = update client (data: {"id":"...", ...fields})
"delete" = delete client (NOTE: only inactive clients can be deleted) (data: {"id":"..."})
"associate_docs" = associate existing documents to a client (data: {"id":"...", "ids":["docId1","docId2"]})
"merge" = merge clients (one must be inactive; inactive one is deleted) (data: {"id":"...", "mergeId":"..."})
"update_balance" = update/reset client balance (data: {"id":"...", "balance":0})`,
    {
      action: z.enum(["search", "get", "create", "update", "delete", "associate_docs", "merge", "update_balance"])
        .describe("Action to perform"),
      data: z.string().optional().describe("JSON string of request parameters"),
      resourceId: resourceIdInput,
    },
    async ({ action, data: raw, resourceId }) => {
      const data = parseData(raw) as Record<string, unknown> | undefined;
      const id = data?.id as string | undefined;
      switch (action) {
        case "search":
          return json(await client.post("/clients/search", data, resourceId));
        case "get":
          return json(await client.get(`/clients/${id}`, resourceId));
        case "create": {
          const body = { ...data };
          delete body.id;
          return json(await client.post("/clients", body, resourceId));
        }
        case "update": {
          const body = { ...data };
          delete body.id;
          return json(await client.put(`/clients/${id}`, body, resourceId));
        }
        case "delete":
          return json(await client.delete(`/clients/${id}`, resourceId));
        case "associate_docs": {
          const ids = data?.ids;
          return json(await client.post(`/clients/${id}/assoc`, { ids }, resourceId));
        }
        case "merge": {
          const mergeId = data?.mergeId;
          return json(await client.post(`/clients/${id}/merge`, { mergeId }, resourceId));
        }
        case "update_balance": {
          const balance = data?.balance;
          return json(await client.post(`/clients/${id}/balance`, { balance }, resourceId));
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }
  );

  // ── 5. SUPPLIER ──────────────────────────────────────────────────────

  server.tool(
    "supplier",
    `Manage suppliers (used for expenses). Actions:
"search" = search suppliers (data: {page, pageSize, name, email, active, contactPerson, labels:[]})
"get" = get by ID (data: {"id":"..."})
"create" = create supplier (data: {name, emails:[], taxId, phone, mobile, fax, city, zip, address, country, department, accountingKey, paymentTerms, bankName, bankBranch, bankAccount, active, contactPerson, remarks, labels:[]})
"update" = update supplier (data: {"id":"...", ...fields})
"delete" = delete supplier (NOTE: only inactive suppliers can be deleted) (data: {"id":"..."})
"merge" = merge suppliers (one must be inactive) (data: {"id":"...", "mergeId":"..."})`,
    {
      action: z.enum(["search", "get", "create", "update", "delete", "merge"])
        .describe("Action to perform"),
      data: z.string().optional().describe("JSON string of request parameters"),
      resourceId: resourceIdInput,
    },
    async ({ action, data: raw, resourceId }) => {
      const data = parseData(raw) as Record<string, unknown> | undefined;
      const id = data?.id as string | undefined;
      switch (action) {
        case "search":
          return json(await client.post("/suppliers/search", data, resourceId));
        case "get":
          return json(await client.get(`/suppliers/${id}`, resourceId));
        case "create": {
          const body = { ...data };
          delete body.id;
          return json(await client.post("/suppliers", body, resourceId));
        }
        case "update": {
          const body = { ...data };
          delete body.id;
          return json(await client.put(`/suppliers/${id}`, body, resourceId));
        }
        case "delete":
          return json(await client.delete(`/suppliers/${id}`, resourceId));
        case "merge": {
          const mergeId = data?.mergeId;
          return json(await client.post(`/suppliers/${id}/merge`, { mergeId }, resourceId));
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }
  );

  // ── 6. ITEM ──────────────────────────────────────────────────────────

  server.tool(
    "item",
    `Manage catalog items (products/services). Actions:
"search" = search items (data: {page, pageSize, name, description, currency, active})
"get" = get by ID (data: {"id":"..."})
"create" = create item (data: {name, description, price, currency, vatType (0=default,1=included,2=exempt), sku, active})
"update" = update item (data: {"id":"...", ...fields})
"delete" = delete item (data: {"id":"..."})`,
    {
      action: z.enum(["search", "get", "create", "update", "delete"])
        .describe("Action to perform"),
      data: z.string().optional().describe("JSON string of request parameters"),
      resourceId: resourceIdInput,
    },
    async ({ action, data: raw, resourceId }) => {
      const data = parseData(raw) as Record<string, unknown> | undefined;
      const id = data?.id as string | undefined;
      switch (action) {
        case "search":
          return json(await client.post("/items/search", data, resourceId));
        case "get":
          return json(await client.get(`/items/${id}`, resourceId));
        case "create": {
          const body = { ...data };
          delete body.id;
          return json(await client.post("/items", body, resourceId));
        }
        case "update": {
          const body = { ...data };
          delete body.id;
          return json(await client.put(`/items/${id}`, body, resourceId));
        }
        case "delete":
          return json(await client.delete(`/items/${id}`, resourceId));
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }
  );

  // ── 7. EXPENSE ───────────────────────────────────────────────────────

  server.tool(
    "expense",
    `Manage expenses (outcome tracking). ${PAYMENT_TYPES}.
Expense statuses: 10=Open, 20=Reported.
Expense documentType uses the same document-type codes as documents (NOT a 10/20/30/40 enum): e.g. 305=Tax Invoice, 320=Tax Invoice+Receipt (חשבונית מס קבלה), 400=Receipt, 300=Proforma. Verified 2026-07-24: passing 30 fails with 3308 "invalid expense document type"; 320 works.
IMPORTANT create requirements (verified 2026-07-24): reportingDate is required (else 3308->3310 "invalid reporting month"); accountingClassification is required (else 3312 "please fill in expense type details") — get valid ids/keys via get_classifications.

Actions:
"search" = search expenses (data: {page, pageSize, fromDate, toDate, dueDate, description, supplierId, supplierName, number, paid, reported, sort, minAmount, maxAmount, accountingClassificationId})
"get" = get by ID (data: {"id":"..."})
"create" = create expense (data: {paymentType, currency, currencyRate, vat, amount, date, dueDate, reportingDate, documentType, number, description, remarks, supplier:{id,name,...}, accountingClassification:{id,key,code,title,...}, active, addRecipient, addAccountingClassification})
"update" = update expense (data: {"id":"...", ...fields}). NOTE: cannot update once reported (status=20)
"delete" = delete expense (data: {"id":"..."})
"open" = reopen expense (data: {"id":"..."})
"close" = close/report expense (data: {"id":"..."})
"get_statuses" = list expense statuses
"get_classifications" = get accounting classifications map
"search_drafts" = search expense drafts (data: {page, pageSize, fromDate, toDate, description, supplierId, supplierName})`,
    {
      action: z.enum(["search", "get", "create", "update", "delete", "open", "close", "get_statuses", "get_classifications", "search_drafts"])
        .describe("Action to perform"),
      data: z.string().optional().describe("JSON string of request parameters"),
      resourceId: resourceIdInput,
    },
    async ({ action, data: raw, resourceId }) => {
      const data = parseData(raw) as Record<string, unknown> | undefined;
      const id = data?.id as string | undefined;
      switch (action) {
        case "search":
          return json(await client.post("/expenses/search", data, resourceId));
        case "get":
          return json(await client.get(`/expenses/${id}`, resourceId));
        case "create": {
          const body = { ...data };
          delete body.id;
          return json(await client.post("/expenses", body, resourceId));
        }
        case "update": {
          const body = { ...data };
          delete body.id;
          return json(await client.put(`/expenses/${id}`, body, resourceId));
        }
        case "delete":
          return json(await client.delete(`/expenses/${id}`, resourceId));
        case "open":
          return json(await client.post(`/expenses/${id}/open`, undefined, resourceId));
        case "close":
          return json(await client.post(`/expenses/${id}/close`, undefined, resourceId));
        case "get_statuses":
          return json(await client.get("/expenses/statuses", resourceId));
        case "get_classifications":
          return json(await client.get("/accounting/classifications/map", resourceId));
        case "search_drafts":
          return json(await client.post("/expenses/drafts/search", data, resourceId));
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }
  );

  // ── 8. PAYMENT ───────────────────────────────────────────────────────

  server.tool(
    "payment",
    `Manage payments and payment links. ${PAYMENT_TYPES}.

Actions:
"get_form" = get payment form URL for online payment (data: {type, description, lang, currency, vatType, amount, maxPayments, pluginId, group, client:{...}, income:[...], remarks, successUrl, failureUrl, notifyUrl, custom})
"search_tokens" = search saved credit card tokens (data: {paymentNumber, cardHolder, externalKey})
"charge_token" = charge a saved credit card token (data: {"id":"tokenId", type, description, lang, currency, vatType, amount, maxPayments, income:[...], remarks, notifyUrl})
"create_link" = create payment link (data: {client:{...}, income:[...], currency, lang, remarks})
"get_link" = get payment link details (data: {"id":"..."})
"get_link_status" = check payment link status (data: {"id":"..."})`,
    {
      action: z.enum(["get_form", "search_tokens", "charge_token", "create_link", "get_link", "get_link_status"])
        .describe("Action to perform"),
      data: z.string().optional().describe("JSON string of request parameters"),
      resourceId: resourceIdInput,
    },
    async ({ action, data: raw, resourceId }) => {
      const data = parseData(raw) as Record<string, unknown> | undefined;
      const id = data?.id as string | undefined;
      switch (action) {
        case "get_form":
          return json(await client.post("/payments/form", data, resourceId));
        case "search_tokens":
          return json(await client.post("/payments/tokens/search", data, resourceId));
        case "charge_token": {
          const body = { ...data };
          delete body.id;
          return json(await client.post(`/payments/tokens/${id}/charge`, body, resourceId));
        }
        case "create_link":
          return json(await client.post("/payment/links", data, resourceId));
        case "get_link":
          return json(await client.get(`/payment/links/${id}`, resourceId));
        case "get_link_status":
          return json(await client.get(`/payment/links/${id}/status`, resourceId));
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }
  );

  // ── 9. WEBHOOK ───────────────────────────────────────────────────────

  server.tool(
    "webhook",
    `Manage webhook subscriptions. Available events: document.created, document.updated, document.sent, document.paid, document.overdue, payment.received, payment.failed, payment.refunded, client.created, client.updated, client.deleted.

Actions:
"create" = create webhook (data: {"url":"https://...", "events":["document.created",...]})
"get" = get webhook by ID (data: {"id":"..."})
"delete" = delete webhook (data: {"id":"..."})`,
    {
      action: z.enum(["create", "get", "delete"]).describe("Action to perform"),
      data: z.string().optional().describe("JSON string of request parameters"),
      resourceId: resourceIdInput,
    },
    async ({ action, data: raw, resourceId }) => {
      const data = parseData(raw) as Record<string, unknown> | undefined;
      const id = data?.id as string | undefined;
      switch (action) {
        case "create":
          return json(await client.post("/webhooks", data, resourceId));
        case "get":
          return json(await client.get(`/webhooks/${id}`, resourceId));
        case "delete":
          return json(await client.delete(`/webhooks/${id}`, resourceId));
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }
  );

  // ── 10. REFERENCE DATA ───────────────────────────────────────────────

  server.tool(
    "reference_data",
    `Lookup reference data (no authentication required, served from cache.greeninvoice.co.il).

Actions:
"occupations" = get business categories/subcategories (data: {"locale":"he_IL"})
"countries" = get supported countries (data: {"locale":"he_IL"} or {"locale":"en_US"})
"cities" = get supported cities (data: {"locale":"he_IL", "country":"IL"})
"currencies" = get exchange rates (data: {"base":"ILS"})`,
    {
      action: z.enum(["occupations", "countries", "cities", "currencies"]).describe("Action to perform"),
      data: z.string().optional().describe("JSON string of request parameters"),
    },
    async ({ action, data: raw }) => {
      const data = parseData(raw) as Record<string, unknown> | undefined;
      const CACHE_BASE = "https://cache.greeninvoice.co.il";
      let url: string;
      switch (action) {
        case "occupations":
          url = `${CACHE_BASE}/businesses/v1/occupations?locale=${data?.locale || "he_IL"}`;
          break;
        case "countries":
          url = `${CACHE_BASE}/geo-location/v1/countries?locale=${data?.locale || "he_IL"}`;
          break;
        case "cities":
          url = `${CACHE_BASE}/geo-location/v1/cities?locale=${data?.locale || "he_IL"}&country=${data?.country || "IL"}`;
          break;
        case "currencies":
          url = `${CACHE_BASE}/currency-exchange/v1/latest?base=${data?.base || "ILS"}`;
          break;
        default:
          throw new Error(`Unknown action: ${action}`);
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Reference data error (${res.status}): ${await res.text()}`);
      return json(await res.json());
    }
  );

  // ── 11. PARTNER (BACKWARD-COMPATIBILITY SHIM) ───────────────────────

  server.tool(
    "partner",
    `Deprecated compatibility surface for older GreenInvoice MCP clients.

Morning's public Partners API does not accept the normal business Bearer token: it uses separate partner Basic authentication. Its list response exposes masked identifiers/email addresses, not client API tokens, and an approved client's one-time API key is delivered to the partner callback URL for storage.

Actions:
"list" = safely list businesses already available to this business token via GET /businesses. Use the "business" tool for new integrations.
"connect", "find", "disconnect" = return a migration explanation; these legacy actions cannot be performed correctly with business API credentials.`,
    {
      action: z.enum(["list", "connect", "find", "disconnect"]).describe("Legacy action to perform"),
      data: z.string().optional().describe("Legacy JSON request parameters"),
      resourceId: resourceIdInput,
    },
    async ({ action, resourceId }) => {
      if (action === "list") {
        return json({
          deprecated: true,
          migration: "Use business action=list, then pass the returned business UUID as resourceId on every scoped tool call.",
          businesses: await client.get("/businesses", resourceId),
        });
      }

      return json({
        deprecated: true,
        supported: false,
        action,
        migration:
          "The public Partners API requires separate Basic partner credentials and callback-delivered client keys; normal Green Invoice business API credentials cannot safely perform this action. Use Morning's partner onboarding flow, or use business action=list for already-authorized businesses.",
      });
    }
  );

  // ── 12. SANDBOX ──────────────────────────────────────────────────────

  server.tool(
    "sandbox",
    `Create and inspect TEST documents in the Green Invoice sandbox (${SANDBOX_BASE}). Use this instead of the 'document' tool whenever the goal is to try something out, demo a flow, or validate a payload shape — nothing here touches the real books.

This tool is hard-bound to the sandbox base URL and cannot reach production, no matter what is passed to it. The other ten tools remain on whichever environment the server was started against.

Requires its OWN credentials: the sandbox is a separate environment with separate accounts, and production API keys are rejected there with 401. Set GREENINVOICE_SANDBOX_API_ID and GREENINVOICE_SANDBOX_API_SECRET from a sandbox account created at https://app.sandbox.d.greeninvoice.co.il/. Run action "status" first to check.

${DOC_TYPES}. ${PAYMENT_TYPES}. ${CURRENCIES}.

Actions:
"status" = report whether sandbox credentials are configured, and if so verify them against the sandbox (GET /businesses/me). Safe, read-only, no arguments. Note /account/me answers 403 for API-key auth, so it is probed best-effort only and a failure there is reported as accountNote, not as a credential problem.
"list_businesses" = list all sandbox businesses available to the authenticated user, including invited client businesses (GET /businesses)
"select_business" = select a sandbox client business for subsequent sandbox calls while keeping the same token (data: {"businessId":"..."}). Sends X-Resource-Id and verifies it with GET /businesses/me.
"clear_business" = clear the selected sandbox business and return to the API key's default context
"resourceId" (top-level tool argument) = use a sandbox business UUID for this call. Stateless clients must pass it again on every call.
"create_test_document" = create a document from a minimal spec, filling in every required field. All arguments optional (data: {type (default 305), price (default 100), quantity (default 1), currency (default ILS), lang (default en), date (default today), dueDate, description, remarks, itemDescription, vatType, clientName (default "MCP Sandbox Test Client"), clientEmails:[], clientTaxId, addClient (default true — auto-creates the client), paymentType (default 4=Bank Transfer), paymentAmount}). Types 320/400/405 get a payment array automatically; its default is the line subtotal, which with vatType 0 leaves the document partially paid — pass paymentAmount to settle in full.
"seed" = create one test document of each of types ${SEED_TYPES.join(", ")} in a single call, for populating an empty sandbox (data: {price, currency, clientName} — all optional, applied to every document). Returns a per-type result list including any failures.
"create_document" = create a document from a full explicit payload, same shape as the 'document' tool's create action (data: {type, client:{...}, income:[...], payment:[...], ...}). No defaults are filled in.
"preview_document" = render a payload as a base64 PDF WITHOUT creating anything (data: same shape as create_document). The cheapest way to check a payload is well-formed.
"get_document" = get a sandbox document by ID (data: {"id":"..."})
"search_documents" = search sandbox documents (data: {page, pageSize, type:[], status:[], fromDate, toDate, sort})
"download_links" = get PDF download links for a sandbox document (data: {"id":"..."})
"create_test_client" = create a test client (data: {name, emails:[], taxId, phone, address, city, ...} — all optional, name defaults to a timestamped test name)
"search_clients" = search sandbox clients (data: {page, pageSize, name, email, active})
"request" = escape hatch for any other sandbox endpoint (data: {"method":"POST","path":"/items/search","body":{...}}). Reaches all 66 endpoints without duplicating the whole tool surface.

Note: there is deliberately no "send" action — sandbox document emails would still be delivered to real inboxes. Use "download_links" or "preview_document" to inspect output instead.`,
    {
      action: z.enum(["status", "list_businesses", "select_business", "clear_business", "create_test_document", "seed", "create_document", "preview_document", "get_document", "search_documents", "download_links", "create_test_client", "search_clients", "request"])
        .describe("Action to perform"),
      data: z.string().optional().describe("JSON string of request parameters (see action descriptions)"),
      resourceId: resourceIdInput,
    },
    async ({ action, data: raw, resourceId }) => {
      const data = parseData(raw) as Record<string, unknown> | undefined;

      if (!sandboxClient) {
        const message =
          "Sandbox is not configured. The Green Invoice sandbox is a separate environment " +
          "with its own accounts — production API keys are rejected there with HTTP 401 " +
          "(verified 2026-07-25). To enable this tool:\n" +
          "  1. Create a sandbox account at https://app.sandbox.d.greeninvoice.co.il/\n" +
          "  2. In that account, generate an API key (My Account > Developer Tools > API Keys)\n" +
          "  3. Set GREENINVOICE_SANDBOX_API_ID and GREENINVOICE_SANDBOX_API_SECRET on this MCP server\n" +
          "Alternatively, set GREENINVOICE_SANDBOX=true to point the entire server (all tools) " +
          "at the sandbox using GREENINVOICE_API_ID/SECRET.";
        if (action === "status") {
          return json({ configured: false, baseUrl: SANDBOX_BASE, message });
        }
        throw new Error(message);
      }

      const sb = sandboxClient;
      const id = data?.id as string | undefined;

      switch (action) {
        case "status": {
          const result: Record<string, unknown> = {
            configured: true,
            baseUrl: sb.base,
            sharedWithMainClient: sb === client,
            selectedBusinessId: resourceId ?? sb.resourceId,
          };
          // /businesses/me is the liveness probe: it is the endpoint an API key
          // is always scoped for.
          try {
            result.business = await sb.get("/businesses/me", resourceId);
            result.reachable = true;
          } catch (err) {
            result.reachable = false;
            result.error = err instanceof Error ? err.message : String(err);
          }
          // /account/me is best-effort only — it answers 403 for API-key auth on
          // at least some plans (verified against production 2026-07-25), so a
          // failure here says nothing about whether credentials are good.
          try {
            result.account = await sb.get("/account/me", resourceId);
          } catch (err) {
            result.accountNote = `GET /account/me unavailable (${
              err instanceof Error ? err.message : String(err)
            }) — not a credential problem; this endpoint is commonly forbidden for API keys.`;
          }
          return json(result);
        }

        case "list_businesses":
          return json(await sb.get("/businesses", resourceId));

        case "select_business":
          return json(await selectBusiness(sb, data));

        case "clear_business": {
          const previousBusinessId = sb.resourceId;
          sb.setResourceId(null);
          return json({
            selectedBusinessId: null,
            previousBusinessId,
          });
        }

        case "create_test_document": {
          const body = buildTestDocument(data ?? {});
          return json({ sent: body, response: await sb.post("/documents", body, resourceId) });
        }

        case "seed": {
          const results: Array<Record<string, unknown>> = [];
          for (const type of SEED_TYPES) {
            const body = buildTestDocument({ ...data, type });
            try {
              results.push({ type, ok: true, response: await sb.post("/documents", body, resourceId) });
            } catch (err) {
              results.push({
                type,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                sent: body,
              });
            }
          }
          return json({ baseUrl: sb.base, created: results.filter((r) => r.ok).length, results });
        }

        case "create_document": {
          const body = { ...data };
          delete body.id;
          return json(await sb.post("/documents", body, resourceId));
        }

        case "preview_document": {
          const body = { ...data };
          delete body.id;
          return json(await sb.post("/documents/preview", body, resourceId));
        }

        case "get_document":
          return json(await sb.get(`/documents/${id}`, resourceId));

        case "search_documents":
          return json(await sb.post("/documents/search", data ?? {}, resourceId));

        case "download_links":
          return json(await sb.get(`/documents/${id}/download/links`, resourceId));

        case "create_test_client": {
          const body = {
            name: `MCP Sandbox Test Client ${today()}`,
            active: true,
            remarks: TEST_REMARKS,
            ...data,
          };
          delete (body as Record<string, unknown>).id;
          return json(await sb.post("/clients", body, resourceId));
        }

        case "search_clients":
          return json(await sb.post("/clients/search", data ?? {}, resourceId));

        case "request": {
          const method = String(data?.method ?? "GET").toUpperCase();
          const path = data?.path as string | undefined;
          if (!path) throw new Error("'path' is required for the request action, e.g. \"/items/search\"");
          if (!path.startsWith("/")) throw new Error(`'path' must start with '/': ${path}`);
          return json(await sb.request(method, path, data?.body, resourceId));
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }
  );
}
