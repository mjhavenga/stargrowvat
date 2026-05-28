import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const tokenPath = path.join(dataDir, "xero-token.json");
const returnsPath = path.join(dataDir, "returns-history.json");
const sessionsPath = path.join(dataDir, "sessions.json");
const mappingPath = path.join(__dirname, "config", "vat-mapping.json");

const port = Number(process.env.PORT || 3000);
const xeroClientId = process.env.XERO_CLIENT_ID || "";
const xeroClientSecret = process.env.XERO_CLIENT_SECRET || "";
const redirectUri = process.env.XERO_REDIRECT_URI || `http://localhost:${port}/auth/callback`;
const sessionSecret = process.env.SESSION_SECRET || "dev-session-secret-change-me";
const appUserName = process.env.APP_USER_NAME || process.env.APP_USER_EMAIL || "";
const appUserPassword = process.env.APP_USER_PASSWORD || "";

const scopes = [
  "offline_access",
  "accounting.invoices.read",
  "accounting.contacts.read",
  "accounting.settings.read"
].join(" ");

const oauthStates = new Map();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendRedirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 10_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map(part => part.trim()).filter(Boolean).map(part => {
      const index = part.indexOf("=");
      return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    })
  );
}

function setSessionCookie(res, sessionId) {
  const value = `${sessionId}.${sign(sessionId)}`;
  res.setHeader("set-cookie", `sg_session=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax`);
}

function getSessionId(req) {
  const cookie = parseCookies(req.headers.cookie).sg_session;
  if (!cookie) return null;
  const [sessionId, signature] = cookie.split(".");
  return signature === sign(sessionId) ? sessionId : null;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(payload, null, 2));
}

function clearSessionCookie(res) {
  res.setHeader("set-cookie", "sg_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
}

async function readSessions() {
  return readJson(sessionsPath, []);
}

async function createUserSession(email) {
  const sessions = await readSessions();
  const session = {
    id: crypto.randomUUID(),
    email,
    createdAt: new Date().toISOString()
  };
  sessions.unshift(session);
  await writeJson(sessionsPath, sessions.slice(0, 100));
  return session;
}

async function getAuthenticatedUser(req) {
  const sessionId = getSessionId(req);
  if (!sessionId) return null;
  const sessions = await readSessions();
  const session = sessions.find(item => item.id === sessionId);
  return session ? { email: session.email } : null;
}

async function deleteUserSession(req) {
  const sessionId = getSessionId(req);
  if (!sessionId) return;
  const sessions = await readSessions();
  await writeJson(sessionsPath, sessions.filter(item => item.id !== sessionId));
}

function requireLoginConfig() {
  if (!appUserName || !appUserPassword) {
    const error = new Error("App login is not configured. Set APP_USER_NAME and APP_USER_PASSWORD.");
    error.status = 503;
    throw error;
  }
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function assertAuthenticated(req) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    const error = new Error("Login required.");
    error.status = 401;
    throw error;
  }
  return user;
}

async function readReturnHistory() {
  return readJson(returnsPath, []);
}

function returnSummary(record) {
  return {
    id: record.id,
    status: record.status,
    returnKind: record.returnKind,
    tenantId: record.tenantId,
    tenantName: record.tenantName,
    period: record.period,
    savedAt: record.savedAt,
    counts: record.returnData?.counts || {},
    vatTotals: record.returnData?.vat?.totals || {},
    icpTotal: record.returnData?.icp?.total || 0,
    icpDifference: record.returnData?.icp?.reconciliationDifference || 0
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function moneyCell(value) {
  return Number(value || 0).toFixed(2);
}

function tableRows(rows, columns) {
  return rows.map(row => `<tr>${columns.map(column => `<td>${escapeHtml(row[column] ?? "")}</td>`).join("")}</tr>`).join("");
}

function groupedTransactionRows(transactions) {
  const groups = new Map();
  for (const row of transactions || []) {
    const key = `${row.vatBox || "unmapped"}|${row.vatCategory || "Unmapped"}`;
    const group = groups.get(key) || {
      vatBox: row.vatBox || "unmapped",
      vatCategory: row.vatCategory || "Unmapped",
      rows: [],
      net: 0,
      tax: 0,
      gross: 0
    };
    group.rows.push(row);
    group.net += Number(row.net || 0);
    group.tax += Number(row.tax || 0);
    group.gross += Number(row.gross || 0);
    groups.set(key, group);
  }

  return [...groups.values()].map(group => `
    <tr class="group"><td colspan="14">${escapeHtml(group.vatBox)} - ${escapeHtml(group.vatCategory)}</td></tr>
    ${group.rows.map(row => `
      <tr>
        <td>${escapeHtml(row.vatBox)}</td>
        <td>${escapeHtml(row.vatCategory)}</td>
        <td>${row.isLatePosting ? "Yes" : ""}</td>
        <td>${escapeHtml(row.lateFromPeriod || "")}</td>
        <td>${row.sourceUrl ? `<a href="${escapeHtml(row.sourceUrl)}">Open in Xero</a>` : ""}</td>
        <td>${escapeHtml(row.date)}</td>
        <td>${escapeHtml(row.source)}</td>
        <td>${escapeHtml(row.contact)}</td>
        <td>${escapeHtml(row.reference)}</td>
        <td>${escapeHtml(row.account)}</td>
        <td>${escapeHtml(row.taxName)}</td>
        <td class="num">${moneyCell(row.net)}</td>
        <td class="num">${moneyCell(row.tax)}</td>
        <td class="num">${moneyCell(row.gross)}</td>
      </tr>
    `).join("")}
    <tr class="subtotal">
      <td colspan="11">Subtotal</td>
      <td class="num">${moneyCell(group.net)}</td>
      <td class="num">${moneyCell(group.tax)}</td>
      <td class="num">${moneyCell(group.gross)}</td>
    </tr>
  `).join("");
}

function buildExcelReport(returnData) {
  const period = returnData.period || {};
  const payable = returnData.vat?.payable || calculateVatPayable(returnData.vat?.rows || []);
  const vatRows = (returnData.vat?.rows || []).map(row => ({
    box: row.box,
    description: row.description,
    net: moneyCell(row.net),
    vat: moneyCell(row.vat),
    transactionCount: row.transactionCount
  }));
  const icpRows = (returnData.icp?.rows || []).map(row => ({
    customer: row.customer,
    vatNumber: row.vatNumber,
    country: row.country,
    goods: moneyCell(row.goods),
    notes: (row.notes || []).join(", ")
  }));

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; }
    table { border-collapse: collapse; margin-bottom: 28px; width: 100%; }
    th, td { border: 1px solid #cfd7e2; padding: 6px 8px; font-size: 12px; }
    th { background: #eef3f7; text-align: left; }
    .num { text-align: right; }
    .group td { background: #dff5f1; font-weight: bold; }
    .subtotal td { background: #f3f7f9; font-weight: bold; }
  </style>
</head>
<body>
  <h1>Xero Dutch VAT Template</h1>
  <p>Period: ${escapeHtml(period.fromDate)} to ${escapeHtml(period.toDate)}</p>
  <h2>VAT Boxes</h2>
  <table>
    <thead><tr><th>Box</th><th>Description</th><th>Net</th><th>VAT</th><th>Lines</th></tr></thead>
    <tbody>${tableRows(vatRows, ["box", "description", "net", "vat", "transactionCount"])}</tbody>
  </table>
  <h2>Berekening te betalen / te ontvangen</h2>
  <table>
    <tbody>
      <tr><td>BTW op binnenlandse prestaties (1a + 1b + 1c + 1d + 1e)</td><td class="num">${moneyCell(payable.domesticVat)}</td></tr>
      <tr><td>BTW verschuldigd over import (4a + 4b)</td><td class="num">${moneyCell(payable.importVat)}</td></tr>
      <tr class="subtotal"><td>Totaal verschuldigde BTW</td><td class="num">${moneyCell(payable.totalDue)}</td></tr>
      <tr><td>Af: Voorbelasting (5b)</td><td class="num">${moneyCell(payable.inputTax)}</td></tr>
      <tr class="subtotal"><td>Subtotaal (5a - 5b = 5c)</td><td class="num">${moneyCell(payable.subtotal)}</td></tr>
      <tr><td>Af: Vermindering kleineondernemersregeling (5d)</td><td class="num">${moneyCell(payable.smallBusinessRelief)}</td></tr>
      <tr class="subtotal"><td>TE BETALEN (+) / TE ONTVANGEN (-)</td><td class="num">${moneyCell(payable.payableReceivable)}</td></tr>
    </tbody>
  </table>
  <h2>Transactions by VAT Category</h2>
  <table>
    <thead>
      <tr><th>VAT box</th><th>VAT category</th><th>Late posting</th><th>Closed period</th><th>Link</th><th>Date</th><th>Source</th><th>Contact</th><th>Reference</th><th>Account</th><th>Tax rate</th><th>Net</th><th>Tax</th><th>Gross</th></tr>
    </thead>
    <tbody>${groupedTransactionRows(returnData.transactions || [])}</tbody>
  </table>
  <h2>ICP</h2>
  <table>
    <thead><tr><th>Customer</th><th>VAT number</th><th>Country</th><th>Goods</th><th>Notes</th></tr></thead>
    <tbody>${tableRows(icpRows, ["customer", "vatNumber", "country", "goods", "notes"])}</tbody>
  </table>
</body>
</html>`;
}

function sendExcel(res, filename, html) {
  res.writeHead(200, {
    "content-type": "application/vnd.ms-excel; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store"
  });
  res.end(html);
}

async function saveReturnRecord(payload) {
  if (!payload?.returnData?.vat?.rows || !payload?.returnData?.transactions) {
    const error = new Error("A fetched return preview is required before saving.");
    error.status = 400;
    throw error;
  }

  const history = await readReturnHistory();
  const record = {
    id: crypto.randomUUID(),
    savedAt: new Date().toISOString(),
    status: payload.status || "Saved as draft",
    returnKind: payload.returnKind || "VAT",
    tenantId: payload.tenantId || "",
    tenantName: payload.tenantName || payload.tenantId || "",
    period: payload.returnData.period || { fromDate: payload.fromDate, toDate: payload.toDate },
    returnData: payload.returnData
  };

  history.unshift(record);
  await writeJson(returnsPath, history);
  return record;
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function createPkceChallenge(verifier) {
  return base64Url(crypto.createHash("sha256").update(verifier).digest());
}

function requireXeroConfig() {
  if (!xeroClientId || !xeroClientSecret) {
    const error = new Error("Xero credentials are not configured.");
    error.status = 503;
    throw error;
  }
}

async function tokenRequest(params) {
  requireXeroConfig();
  const response = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "authorization": `Basic ${Buffer.from(`${xeroClientId}:${xeroClientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(params)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error_description || body.error || `Xero token request failed with ${response.status}`);
  }
  return body;
}

async function getTokenSet() {
  const tokenSet = await readJson(tokenPath, null);
  if (!tokenSet) return null;
  if (tokenSet.expires_at && Date.now() < tokenSet.expires_at - 60_000) return tokenSet;
  if (!tokenSet.refresh_token) return tokenSet;

  const refreshed = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: tokenSet.refresh_token
  });
  const next = { ...refreshed, expires_at: Date.now() + refreshed.expires_in * 1000 };
  await writeJson(tokenPath, next);
  return next;
}

async function xeroFetch(tenantId, endpoint, query = {}) {
  const tokenSet = await getTokenSet();
  if (!tokenSet?.access_token) {
    const error = new Error("Not connected to Xero.");
    error.status = 401;
    throw error;
  }
  const url = new URL(`https://api.xero.com/api.xro/2.0/${endpoint.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${tokenSet.access_token}`,
      "xero-tenant-id": tenantId,
      accept: "application/json"
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.Message || body.message || `Xero API request failed with ${response.status}`);
  }
  return body;
}

async function getTenants() {
  const tokenSet = await getTokenSet();
  if (!tokenSet?.access_token) return [];
  const response = await fetch("https://api.xero.com/connections", {
    headers: { authorization: `Bearer ${tokenSet.access_token}`, accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Could not load Xero tenants (${response.status})`);
  return response.json();
}

async function listPaged(tenantId, endpoint, rootKey, query) {
  const rows = [];
  for (let page = 1; page <= 20; page += 1) {
    const body = await xeroFetch(tenantId, endpoint, { ...query, page });
    const batch = body[rootKey] || [];
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
}

function xeroDateFilter(fromDate, toDate, field = "Date") {
  const from = fromDate.replaceAll("-", ",");
  const to = toDate.replaceAll("-", ",");
  return `${field}>=DateTime(${from})&&${field}<=DateTime(${to})`;
}

function sourceLabel(source) {
  const labels = {
    ACCREC: "Receivable Invoice",
    ACCRECCREDIT: "Receivable Credit Note",
    ACCPAY: "Payable Bill",
    ACCPAYCREDIT: "Payable Credit Note"
  };
  return labels[source.Type] || source.Type || "Xero Transaction";
}

function sourceRedirectPath(source) {
  const id = source.InvoiceID || source.CreditNoteID || "";
  if (!id) return "";
  const paths = {
    ACCREC: `/AccountsReceivable/View.aspx?InvoiceID=${id}`,
    ACCPAY: `/AccountsPayable/Edit.aspx?InvoiceID=${id}`,
    ACCRECCREDIT: `/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=${id}`,
    ACCPAYCREDIT: `/AccountsPayable/ViewCreditNote.aspx?creditNoteID=${id}`
  };
  return paths[source.Type] || "";
}

function xeroSourceUrl(source, orgShortCode) {
  const redirectPath = sourceRedirectPath(source);
  if (!redirectPath) return "";
  const url = new URL("https://go.xero.com/organisationlogin/default.aspx");
  if (orgShortCode) url.searchParams.set("shortcode", orgShortCode);
  url.searchParams.set("redirecturl", redirectPath);
  return url.toString();
}

function sourceId(source) {
  return source.InvoiceID || source.CreditNoteID || source.BankTransactionID || source.ManualJournalID || "";
}

function transactionKeyFromParts(parts) {
  return [
    parts.sourceType || "",
    parts.sourceId || "",
    parts.lineId || "",
    parts.date || "",
    parts.reference || "",
    parts.account || "",
    parts.net ?? "",
    parts.tax ?? ""
  ].join("|");
}

function transactionKey(line) {
  return line.transactionKey || transactionKeyFromParts(line);
}

function amountSign(source) {
  const signs = {
    ACCREC: 1,
    ACCRECCREDIT: -1,
    ACCPAY: -1,
    ACCPAYCREDIT: 1
  };
  return signs[source.Type] || 1;
}

function normaliseLine(source, orgShortCode = "") {
  const signValue = amountSign(source);
  const typeLabel = sourceLabel(source);
  const sourceUrl = xeroSourceUrl(source, orgShortCode);
  const documentId = sourceId(source);
  const date = source.DateString || source.Date || source.FullyPaidOnDate || "";
  const contact = source.Contact?.Name || "";
  return (source.LineItems || []).map(line => {
    const net = Number(line.LineAmount || 0) * signValue;
    const tax = Number(line.TaxAmount || 0) * signValue;
    const normalised = {
      date: String(date).slice(0, 10),
      source: typeLabel,
      sourceType: source.Type || "",
      sourceId: documentId,
      lineId: line.LineItemID || "",
      sourceUrl,
      contact,
      reference: source.InvoiceNumber || source.CreditNoteNumber || source.BankTransactionID || source.Reference || "",
      details: [contact, line.Description].filter(Boolean).join(" - "),
      account: line.AccountCode || "",
      taxType: line.TaxType || "",
      taxName: line.TaxType || "",
      net,
      tax,
      gross: net + tax
    };
    normalised.transactionKey = transactionKey(normalised);
    return normalised;
  });
}

function matchesMapping(line, box) {
  const haystack = `${line.taxName} ${line.taxType}`.toLowerCase();
  return [
    ...(box.taxRateNames || []),
    ...(box.taxRateIncludes || [])
  ].some(term => haystack.includes(String(term).toLowerCase()));
}

function findVatCategory(line, mapping) {
  const box = mapping.vatBoxes.find(item => matchesMapping(line, item));
  if (!box) {
    return {
      vatBox: "unmapped",
      vatCategory: "Unmapped",
      vatMode: "none"
    };
  }
  return {
    vatBox: box.box,
    vatCategory: box.description,
    vatMode: box.vatMode
  };
}

function roundDown(value) {
  return value < 0 ? Math.ceil(value) : Math.floor(value);
}

function calculateVat(lines, mapping) {
  const rows = mapping.vatBoxes.map(box => {
    const matched = lines.filter(line => line.vatBox === box.box);
    const net = matched.reduce((sum, line) => sum + line.net, 0);
    const xeroTax = matched.reduce((sum, line) => sum + line.tax, 0);
    let vat = xeroTax;
    if (box.vatMode === "zero") vat = 0;
    if (box.vatMode === "rate") vat = roundDown(net * Number(box.rate || 0));
    return {
      box: box.box,
      description: box.description,
      net: Number(net.toFixed(2)),
      vat: Number(vat.toFixed(2)),
      transactionCount: matched.length
    };
  });
  const vat = {
    rows,
    totals: {
      net: Number(rows.reduce((sum, row) => sum + row.net, 0).toFixed(2)),
      vat: Number(rows.reduce((sum, row) => sum + row.vat, 0).toFixed(2))
    }
  };
  vat.payable = calculateVatPayable(rows);
  return vat;
}

function sumVatRows(rows, boxes) {
  return rows
    .filter(row => boxes.includes(row.box))
    .reduce((sum, row) => sum + Number(row.vat || 0), 0);
}

function calculateVatPayable(rows) {
  const domesticVat = sumVatRows(rows, ["1a", "1b", "1d", "1d-verlegd", "1e"]);
  const importVat = sumVatRows(rows, ["4a-high", "4a-low", "4b-high", "4b-low"]);
  const totalDue = domesticVat + importVat;
  const inputTax = Math.abs(sumVatRows(rows, ["5b"]));
  const subtotal = totalDue - inputTax;
  const smallBusinessRelief = 0;
  const payableReceivable = subtotal - smallBusinessRelief;

  return {
    domesticVat: Number(domesticVat.toFixed(2)),
    importVat: Number(importVat.toFixed(2)),
    totalDue: Number(totalDue.toFixed(2)),
    inputTax: Number(inputTax.toFixed(2)),
    subtotal: Number(subtotal.toFixed(2)),
    smallBusinessRelief,
    payableReceivable: Number(payableReceivable.toFixed(2))
  };
}

function countryCodeFromContact(contact) {
  const taxNumber = contact.TaxNumber || contact.TaxNumberType || "";
  const vatPrefix = String(taxNumber).trim().slice(0, 2).toUpperCase();
  if (/^[A-Z]{2}$/.test(vatPrefix)) return vatPrefix;
  const address = (contact.Addresses || []).find(item => item.AddressType === "STREET") || contact.Addresses?.[0] || {};
  return String(address.Country || "").slice(0, 2).toUpperCase();
}

function calculateIcp(lines, contacts, mapping) {
  const contactByName = new Map(contacts.map(contact => [contact.Name, contact]));
  const icpLines = lines.filter(line => mapping.vatBoxes.some(box => box.icp && matchesMapping(line, box)));
  const grouped = new Map();
  for (const line of icpLines) {
    const current = grouped.get(line.contact) || { customer: line.contact, goods: 0, transactionCount: 0 };
    current.goods += line.gross || line.net;
    current.transactionCount += 1;
    grouped.set(line.contact, current);
  }
  const rows = [...grouped.values()].sort((a, b) => a.customer.localeCompare(b.customer));
  for (const row of rows) {
    const contact = contactByName.get(row.customer) || {};
    row.vatNumber = contact.TaxNumber || "";
    row.country = countryCodeFromContact(contact);
    row.isEu = Boolean(mapping.euCountries[row.country]);
    row.notes = [];
    if (!row.vatNumber) row.notes.push("VAT number missing in Xero");
    if (!row.isEu) row.notes.push("Country is not recognised as ICP-applicable EU");
    row.goods = Number(row.goods.toFixed(2));
  }
  const total = Number(rows.reduce((sum, row) => sum + row.goods, 0).toFixed(2));
  return { rows, total };
}

async function fetchLinesForPeriod(tenantId, fromDate, toDate, mapping, taxRateByType, orgShortCode) {
  const where = xeroDateFilter(fromDate, toDate);
  const [invoices, creditNotes] = await Promise.all([
    listPaged(tenantId, "Invoices", "Invoices", { where }),
    listPaged(tenantId, "CreditNotes", "CreditNotes", { where })
  ]);

  const lines = [
    ...invoices.flatMap(invoice => normaliseLine(invoice, orgShortCode)),
    ...creditNotes.flatMap(note => normaliseLine(note, orgShortCode))
  ].map(line => ({
    ...line,
    taxName: taxRateByType.get(line.taxType) || line.taxType
  })).map(line => ({
    ...line,
    ...findVatCategory(line, mapping)
  }));

  return {
    invoices,
    creditNotes,
    lines
  };
}

function isFinalisedReturn(record) {
  return String(record.status || "").toLowerCase().includes("finalised");
}

function periodBefore(period, fromDate) {
  return period?.fromDate && period?.toDate && String(period.toDate) < fromDate;
}

function latestFinalisedVatReturns(history, tenantId, fromDate) {
  const byPeriod = new Map();
  for (const record of history) {
    if (record.tenantId !== tenantId) continue;
    if (record.returnKind !== "VAT") continue;
    if (!isFinalisedReturn(record)) continue;
    if (!periodBefore(record.period, fromDate)) continue;
    const key = `${record.period.fromDate}|${record.period.toDate}`;
    if (!byPeriod.has(key)) byPeriod.set(key, record);
  }
  return [...byPeriod.values()];
}

async function findLatePostedLines(tenantId, fromDate, mapping, taxRateByType, orgShortCode) {
  const history = await readReturnHistory();
  const finalisedReturns = latestFinalisedVatReturns(history, tenantId, fromDate);
  const lateLines = [];

  for (const record of finalisedReturns) {
    const savedKeys = new Set((record.returnData?.transactions || []).map(transactionKey));
    const current = await fetchLinesForPeriod(
      tenantId,
      record.period.fromDate,
      record.period.toDate,
      mapping,
      taxRateByType,
      orgShortCode
    );

    for (const line of current.lines) {
      if (savedKeys.has(transactionKey(line))) continue;
      lateLines.push({
        ...line,
        isLatePosting: true,
        lateFromPeriod: `${record.period.fromDate} to ${record.period.toDate}`
      });
    }
  }

  return lateLines;
}

async function buildPreview(tenantId, fromDate, toDate) {
  const mapping = await readJson(mappingPath);
  const [contacts, taxRates, organisations] = await Promise.all([
    listPaged(tenantId, "Contacts", "Contacts", { includeArchived: false }),
    xeroFetch(tenantId, "TaxRates"),
    xeroFetch(tenantId, "Organisation")
  ]);

  const taxRateByType = new Map((taxRates.TaxRates || []).map(rate => [rate.TaxType, rate.Name]));
  const orgShortCode = organisations.Organisations?.[0]?.ShortCode || "";
  const currentPeriod = await fetchLinesForPeriod(tenantId, fromDate, toDate, mapping, taxRateByType, orgShortCode);
  const lateLines = await findLatePostedLines(tenantId, fromDate, mapping, taxRateByType, orgShortCode);
  const lines = [...currentPeriod.lines, ...lateLines];

  const vat = calculateVat(lines, mapping);
  const icp = calculateIcp(lines, contacts, mapping);
  const vat3b = vat.rows
    .filter(row => row.box === "3b-goods" || row.box === "3b-services")
    .reduce((sum, row) => sum + row.net, 0);

  return {
    period: { fromDate, toDate },
    counts: {
      invoices: currentPeriod.invoices.length,
      creditNotes: currentPeriod.creditNotes.length,
      contacts: contacts.length,
      currentLines: currentPeriod.lines.length,
      lateLines: lateLines.length,
      lines: lines.length
    },
    transactions: lines
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.reference).localeCompare(String(b.reference)))
      .map(line => ({
        date: line.date,
        source: line.source,
        sourceUrl: line.sourceUrl,
        transactionKey: line.transactionKey,
        isLatePosting: Boolean(line.isLatePosting),
        lateFromPeriod: line.lateFromPeriod || "",
        contact: line.contact,
        reference: line.reference,
        account: line.account,
        taxName: line.taxName,
        vatBox: line.vatBox,
        vatCategory: line.vatCategory,
        net: Number(line.net.toFixed(2)),
        tax: Number(line.tax.toFixed(2)),
        gross: Number(line.gross.toFixed(2))
      })),
    vat,
    icp: {
      ...icp,
      vat3b: Number(vat3b.toFixed(2)),
      reconciliationDifference: Number((icp.total - vat3b).toFixed(2))
    },
    exceptions: icp.rows.flatMap(row => row.notes.map(note => ({ customer: row.customer, note })))
  };
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") sendJson(res, 404, { error: "Not found" });
    else throw error;
  }
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = getSessionId(req) || crypto.randomUUID();
  setSessionCookie(res, sessionId);

  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/status") {
    const token = await getTokenSet();
    sendJson(res, 200, {
      configured: Boolean(xeroClientId && xeroClientSecret),
      connected: Boolean(token?.access_token),
      redirectUri
    });
    return;
  }

  if (url.pathname === "/api/me") {
    const user = await getAuthenticatedUser(req);
    sendJson(res, 200, {
      authenticated: Boolean(user),
      username: user?.email || "",
      loginConfigured: Boolean(appUserName && appUserPassword)
    });
    return;
  }

  if (url.pathname === "/auth/login" && req.method === "POST") {
    requireLoginConfig();
    const body = JSON.parse(await readBody(req) || "{}");
    const emailOk = constantTimeEqual(String(body.email || "").toLowerCase(), appUserName.toLowerCase());
    const passwordOk = constantTimeEqual(body.password || "", appUserPassword);
    if (!emailOk || !passwordOk) {
      sendJson(res, 401, { error: "Invalid email or password." });
      return;
    }
    const session = await createUserSession(appUserName);
    setSessionCookie(res, session.id);
    sendJson(res, 200, { authenticated: true, username: appUserName });
    return;
  }

  if (url.pathname === "/auth/logout") {
    await deleteUserSession(req);
    clearSessionCookie(res);
    sendRedirect(res, "/");
    return;
  }

  if (url.pathname === "/auth/xero") {
    await assertAuthenticated(req);
    requireXeroConfig();
    const verifier = base64Url(crypto.randomBytes(32));
    const state = crypto.randomUUID();
    oauthStates.set(state, { verifier, sessionId, createdAt: Date.now() });
    const authUrl = new URL("https://login.xero.com/identity/connect/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", xeroClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", scopes);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", createPkceChallenge(verifier));
    authUrl.searchParams.set("code_challenge_method", "S256");
    sendRedirect(res, authUrl.toString());
    return;
  }

  if (url.pathname === "/auth/callback") {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const stored = oauthStates.get(state);
    if (!stored || !code) {
      sendJson(res, 400, { error: "Invalid Xero callback state." });
      return;
    }
    oauthStates.delete(state);
    const tokenSet = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: stored.verifier
    });
    await writeJson(tokenPath, { ...tokenSet, expires_at: Date.now() + tokenSet.expires_in * 1000 });
    sendRedirect(res, "/?connected=1");
    return;
  }

  if (url.pathname === "/auth/disconnect-xero") {
    await assertAuthenticated(req);
    await fs.rm(tokenPath, { force: true });
    sendRedirect(res, "/");
    return;
  }

  if (url.pathname === "/api/tenants") {
    await assertAuthenticated(req);
    sendJson(res, 200, { tenants: await getTenants() });
    return;
  }

  if (url.pathname === "/api/returns" && req.method === "GET") {
    await assertAuthenticated(req);
    const history = await readReturnHistory();
    sendJson(res, 200, { returns: history.map(returnSummary) });
    return;
  }

  if (url.pathname === "/api/returns" && req.method === "POST") {
    await assertAuthenticated(req);
    const body = JSON.parse(await readBody(req) || "{}");
    const record = await saveReturnRecord(body);
    sendJson(res, 201, { return: returnSummary(record), id: record.id });
    return;
  }

  if (url.pathname.startsWith("/api/returns/") && !url.pathname.endsWith("/export") && req.method === "GET") {
    await assertAuthenticated(req);
    const id = decodeURIComponent(url.pathname.split("/").pop() || "");
    const history = await readReturnHistory();
    const record = history.find(item => item.id === id);
    if (!record) {
      sendJson(res, 404, { error: "Saved return was not found." });
      return;
    }
    sendJson(res, 200, { return: record });
    return;
  }

  if (url.pathname === "/api/export-excel" && req.method === "POST") {
    await assertAuthenticated(req);
    const body = JSON.parse(await readBody(req) || "{}");
    if (!body.returnData?.vat?.rows || !body.returnData?.transactions) {
      sendJson(res, 400, { error: "A fetched or saved return is required before export." });
      return;
    }
    const period = body.returnData.period || {};
    const filename = `stargrow-vat-${period.fromDate || "from"}-${period.toDate || "to"}.xls`;
    sendExcel(res, filename, buildExcelReport(body.returnData));
    return;
  }

  if (url.pathname.startsWith("/api/returns/") && url.pathname.endsWith("/export") && req.method === "GET") {
    await assertAuthenticated(req);
    const parts = url.pathname.split("/");
    const id = decodeURIComponent(parts[3] || "");
    const history = await readReturnHistory();
    const record = history.find(item => item.id === id);
    if (!record) {
      sendJson(res, 404, { error: "Saved return was not found." });
      return;
    }
    const period = record.period || {};
    const filename = `stargrow-vat-${period.fromDate || "from"}-${period.toDate || "to"}.xls`;
    sendExcel(res, filename, buildExcelReport(record.returnData));
    return;
  }

  if (url.pathname === "/api/preview" && req.method === "POST") {
    await assertAuthenticated(req);
    const body = JSON.parse(await readBody(req) || "{}");
    if (!body.tenantId || !body.fromDate || !body.toDate) {
      sendJson(res, 400, { error: "tenantId, fromDate and toDate are required." });
      return;
    }
    sendJson(res, 200, await buildPreview(body.tenantId, body.fromDate, body.toDate));
    return;
  }

  await serveStatic(req, res, url.pathname);
}

const server = http.createServer((req, res) => {
  router(req, res).catch(error => {
    console.error(error);
    sendJson(res, error.status || 500, { error: error.message || "Unexpected error" });
  });
});

server.listen(port, () => {
  console.log(`Stargrow VAT app listening on http://localhost:${port}`);
});
