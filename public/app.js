const tenantSelect = document.querySelector("#tenantSelect");
const connectLink = document.querySelector("#connectLink");
const message = document.querySelector("#message");
const fromDate = document.querySelector("#fromDate");
const toDate = document.querySelector("#toDate");
const previewButton = document.querySelector("#previewButton");

const invoiceCount = document.querySelector("#invoiceCount");
const creditNoteCount = document.querySelector("#creditNoteCount");
const lineCount = document.querySelector("#lineCount");
const icpDiff = document.querySelector("#icpDiff");
const vatRows = document.querySelector("#vatRows");
const icpRows = document.querySelector("#icpRows");
const exceptions = document.querySelector("#exceptions");

function money(value) {
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function setMessage(text, isError = false) {
  message.textContent = text || "";
  message.style.color = isError ? "#9b1c1c" : "#176b5d";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function setDefaultDates() {
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3);
  const start = new Date(now.getFullYear(), quarter * 3, 1);
  const end = new Date(now.getFullYear(), quarter * 3 + 3, 0);
  fromDate.value = start.toISOString().slice(0, 10);
  toDate.value = end.toISOString().slice(0, 10);
}

function renderPreview(data) {
  invoiceCount.textContent = data.counts.invoices;
  creditNoteCount.textContent = data.counts.creditNotes;
  lineCount.textContent = data.counts.lines;
  icpDiff.textContent = money(data.icp.reconciliationDifference);

  vatRows.innerHTML = data.vat.rows.map(row => `
    <tr>
      <td>${row.box}</td>
      <td>${row.description}</td>
      <td class="num">${money(row.net)}</td>
      <td class="num">${money(row.vat)}</td>
      <td class="num">${row.transactionCount}</td>
    </tr>
  `).join("");

  icpRows.innerHTML = data.icp.rows.map(row => `
    <tr>
      <td>${row.customer}</td>
      <td>${row.vatNumber || "-"}</td>
      <td>${row.country || "-"}</td>
      <td class="num">${money(row.goods)}</td>
      <td>${row.notes.join(", ") || "-"}</td>
    </tr>
  `).join("");

  exceptions.innerHTML = data.exceptions.length
    ? data.exceptions.map(item => `<li><strong>${item.customer}</strong>: ${item.note}</li>`).join("")
    : "<li>No ICP exceptions detected.</li>";
}

async function loadStatus() {
  const status = await api("/api/status");
  connectLink.textContent = status.connected ? "Reconnect Xero" : "Connect Xero";
  if (!status.configured) {
    setMessage("Set XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_REDIRECT_URI before connecting to Xero.", true);
    return;
  }
  if (!status.connected) {
    setMessage("Connect Xero to load organisations.");
    return;
  }
  const { tenants } = await api("/api/tenants");
  tenantSelect.innerHTML = tenants.map(tenant => `
    <option value="${tenant.tenantId}">${tenant.tenantName || tenant.tenantId}</option>
  `).join("");
  setMessage(tenants.length ? "Connected. Choose a period and fetch the return." : "Connected, but no Xero organisations were returned.", !tenants.length);
}

previewButton.addEventListener("click", async () => {
  try {
    setMessage("Fetching Xero data...");
    const data = await api("/api/preview", {
      method: "POST",
      body: JSON.stringify({
        tenantId: tenantSelect.value,
        fromDate: fromDate.value,
        toDate: toDate.value
      })
    });
    renderPreview(data);
    setMessage("Return preview updated.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

setDefaultDates();
loadStatus().catch(error => setMessage(error.message, true));
