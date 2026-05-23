import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const tokenPath = path.join(dataDir, "xero-token.json");
const mappingPath = path.join(__dirname, "config", "vat-mapping.json");

const port = Number(process.env.PORT || 3000);
const xeroClientId = process.env.XERO_CLIENT_ID || "";
const xeroClientSecret = process.env.XERO_CLIENT_SECRET || "";
const redirectUri = process.env.XERO_REDIRECT_URI || `http://localhost:${port}/auth/callback`;
const sessionSecret = process.env.SESSION_SECRET || "dev-session-secret-change-me";

const scopes = [
  "offline_access",
  "accounting.transactions.read",
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
      if (body.length > 1_000_000) {
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

function amountSign(sourceType) {
  return sourceType.includes("Credit Note") ? -1 : 1;
}

function normaliseLine(source, sourceType) {
  const signValue = amountSign(sourceType);
  const date = source.DateString || source.Date || source.FullyPaidOnDate || "";
  const contact = source.Contact?.Name || "";
  return (source.LineItems || []).map(line => {
    const net = Number(line.LineAmount || 0) * signValue;
    const tax = Number(line.TaxAmount || 0) * signValue;
    return {
      date: String(date).slice(0, 10),
      source: sourceType,
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
  });
}

function matchesMapping(line, box) {
  const haystack = `${line.taxName} ${line.taxType}`.toLowerCase();
  return [
    ...(box.taxRateNames || []),
    ...(box.taxRateIncludes || [])
  ].some(term => haystack.includes(String(term).toLowerCase()));
}

function roundDown(value) {
  return value < 0 ? Math.ceil(value) : Math.floor(value);
}

function calculateVat(lines, mapping) {
  const rows = mapping.vatBoxes.map(box => {
    const matched = lines.filter(line => matchesMapping(line, box));
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
  return {
    rows,
    totals: {
      net: Number(rows.reduce((sum, row) => sum + row.net, 0).toFixed(2)),
      vat: Number(rows.reduce((sum, row) => sum + row.vat, 0).toFixed(2))
    }
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

async function buildPreview(tenantId, fromDate, toDate) {
  const mapping = await readJson(mappingPath);
  const where = xeroDateFilter(fromDate, toDate);
  const [invoices, creditNotes, contacts, taxRates] = await Promise.all([
    listPaged(tenantId, "Invoices", "Invoices", { where }),
    listPaged(tenantId, "CreditNotes", "CreditNotes", { where }),
    listPaged(tenantId, "Contacts", "Contacts", { includeArchived: false }),
    xeroFetch(tenantId, "TaxRates")
  ]);

  const taxRateByType = new Map((taxRates.TaxRates || []).map(rate => [rate.TaxType, rate.Name]));
  const lines = [
    ...invoices.flatMap(invoice => normaliseLine(invoice, "Receivable Invoice")),
    ...creditNotes.flatMap(note => normaliseLine(note, "Receivable Credit Note"))
  ].map(line => ({
    ...line,
    taxName: taxRateByType.get(line.taxType) || line.taxType
  }));

  const vat = calculateVat(lines, mapping);
  const icp = calculateIcp(lines, contacts, mapping);
  const vat3b = vat.rows
    .filter(row => row.box === "3b-goods" || row.box === "3b-services")
    .reduce((sum, row) => sum + row.net, 0);

  return {
    period: { fromDate, toDate },
    counts: {
      invoices: invoices.length,
      creditNotes: creditNotes.length,
      contacts: contacts.length,
      lines: lines.length
    },
    vat,
    icp: {
      ...icp,
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

  if (url.pathname === "/auth/xero") {
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

  if (url.pathname === "/auth/logout") {
    await fs.rm(tokenPath, { force: true });
    sendRedirect(res, "/");
    return;
  }

  if (url.pathname === "/api/tenants") {
    sendJson(res, 200, { tenants: await getTenants() });
    return;
  }

  if (url.pathname === "/api/preview" && req.method === "POST") {
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
