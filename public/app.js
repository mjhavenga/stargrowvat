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
const connectionBadge = document.querySelector("#connectionBadge");
const checkCount = document.querySelector("#checkCount");
const returnStatus = document.querySelector("#returnStatus");
const periodLabel = document.querySelector("#periodLabel");
const refreshButton = document.querySelector("#refreshButton");
const vatNetTotal = document.querySelector("#vatNetTotal");
const vatVatTotal = document.querySelector("#vatVatTotal");

function money(value) {
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function dateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function setMessage(text, isError = false) {
  message.textContent = text || "";
  message.classList.toggle("error", isError);
}

function setConnectionBadge(text, state = "neutral") {
  connectionBadge.textContent = text;
  connectionBadge.className = `statusBadge ${state}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
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
  fromDate.value = dateInputValue(start);
  toDate.value = dateInputValue(end);
  updatePeriodLabel();
}

function updatePeriodLabel() {
  periodLabel.textContent = `${fromDate.value || "-"} to ${toDate.value || "-"}`;
}

function renderPreview(data) {
  invoiceCount.textContent = data.counts.invoices;
  creditNoteCount.textContent = data.counts.creditNotes;
  lineCount.textContent = data.counts.lines;
  icpDiff.textContent = money(data.icp.reconciliationDifference);
  vatNetTotal.textContent = money(data.vat.totals.net);
  vatVatTotal.textContent = money(data.vat.totals.vat);
  returnStatus.textContent = data.exceptions.length ? "Needs review" : "Reconciled";

  vatRows.innerHTML = data.vat.rows.map(row => `
    <tr>
      <td>${escapeHtml(row.box)}</td>
      <td>${escapeHtml(row.description)}</td>
      <td class="num">${money(row.net)}</td>
      <td class="num">${money(row.vat)}</td>
      <td class="num">${row.transactionCount}</td>
    </tr>
  `).join("");

  icpRows.innerHTML = data.icp.rows.map(row => `
    <tr>
      <td>${escapeHtml(row.customer)}</td>
      <td>${escapeHtml(row.vatNumber || "-")}</td>
      <td>${escapeHtml(row.country || "-")}</td>
      <td class="num">${money(row.goods)}</td>
      <td>${escapeHtml(row.notes.join(", ") || "-")}</td>
    </tr>
  `).join("");

  exceptions.innerHTML = data.exceptions.length
    ? data.exceptions.map(item => `<li><strong>${escapeHtml(item.customer)}</strong>: ${escapeHtml(item.note)}</li>`).join("")
    : "<li class=\"emptyCheck\">No ICP exceptions detected.</li>";
  checkCount.textContent = `${data.exceptions.length} open`;
}

async function loadStatus() {
  const status = await api("/api/status");
  connectLink.textContent = status.connected ? "Reconnect Xero" : "Connect Xero";
  if (!status.configured) {
    setConnectionBadge("Not configured", "error");
    tenantSelect.innerHTML = "<option>Add Xero credentials</option>";
    setMessage("Set XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_REDIRECT_URI before connecting to Xero.", true);
    return;
  }
  if (!status.connected) {
    setConnectionBadge("Not connected", "neutral");
    tenantSelect.innerHTML = "<option>Connect Xero to load organisations</option>";
    setMessage("Connect Xero to load organisations.");
    return;
  }
  setConnectionBadge("Connected", "ok");
  const { tenants } = await api("/api/tenants");
  tenantSelect.innerHTML = tenants.map(tenant => `
    <option value="${escapeHtml(tenant.tenantId)}">${escapeHtml(tenant.tenantName || tenant.tenantId)}</option>
  `).join("");
  setMessage(tenants.length ? "Connected. Choose a period and fetch the return." : "Connected, but no Xero organisations were returned.", !tenants.length);
}

previewButton.addEventListener("click", async () => {
  try {
    setMessage("Fetching Xero data...");
    returnStatus.textContent = "Fetching";
    previewButton.disabled = true;
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
    returnStatus.textContent = "Action needed";
    setMessage(error.message, true);
  } finally {
    previewButton.disabled = false;
  }
});

refreshButton.addEventListener("click", () => previewButton.click());
fromDate.addEventListener("change", updatePeriodLabel);
toDate.addEventListener("change", updatePeriodLabel);

setDefaultDates();
loadStatus().catch(error => setMessage(error.message, true));
