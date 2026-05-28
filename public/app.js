const tenantSelect = document.querySelector("#tenantSelect");
const appFrame = document.querySelector(".appFrame");
const loginScreen = document.querySelector("#loginScreen");
const loginForm = document.querySelector("#loginForm");
const loginEmail = document.querySelector("#loginEmail");
const loginPassword = document.querySelector("#loginPassword");
const loginMessage = document.querySelector("#loginMessage");
const connectLink = document.querySelector("#connectLink");
const message = document.querySelector("#message");
const fromDate = document.querySelector("#fromDate");
const toDate = document.querySelector("#toDate");
const previewButton = document.querySelector("#previewButton");

const vatRows = document.querySelector("#vatRows");
const icpRows = document.querySelector("#icpRows");
const exceptions = document.querySelector("#exceptions");
const connectionBadge = document.querySelector("#connectionBadge");
const checkCount = document.querySelector("#checkCount");
const returnStatus = document.querySelector("#returnStatus");
const periodLabel = document.querySelector("#periodLabel");
const transactionExportButton = document.querySelector("#transactionExportButton");
const vatNetTotal = document.querySelector("#vatNetTotal");
const vatVatTotal = document.querySelector("#vatVatTotal");
const vatPayableBadge = document.querySelector("#vatPayableBadge");
const vatDomestic = document.querySelector("#vatDomestic");
const vatImport = document.querySelector("#vatImport");
const vatTotalDue = document.querySelector("#vatTotalDue");
const vatInputTax = document.querySelector("#vatInputTax");
const vatSubtotal = document.querySelector("#vatSubtotal");
const vatSmallBusiness = document.querySelector("#vatSmallBusiness");
const vatPayableReceivable = document.querySelector("#vatPayableReceivable");
const transactionRows = document.querySelector("#transactionRows");
const transactionSheetCount = document.querySelector("#transactionSheetCount");
const vatReturnBadge = document.querySelector("#vatReturnBadge");
const saveDraftButton = document.querySelector("#saveDraftButton");
const filedButton = document.querySelector("#filedButton");
const icpReturnBadge = document.querySelector("#icpReturnBadge");
const icpExportButton = document.querySelector("#icpExportButton");
const icpDraftButton = document.querySelector("#icpDraftButton");
const icpFiledButton = document.querySelector("#icpFiledButton");
const icpTotalValue = document.querySelector("#icpTotalValue");
const icpTableTotal = document.querySelector("#icpTableTotal");
const vat3bValue = document.querySelector("#vat3bValue");
const icpReconDiffValue = document.querySelector("#icpReconDiffValue");
const icpReconStatus = document.querySelector("#icpReconStatus");
const refreshHistoryButton = document.querySelector("#refreshHistoryButton");
const historyRows = document.querySelector("#historyRows");
const historyCount = document.querySelector("#historyCount");
const pageLinks = document.querySelectorAll("[data-page-link]");
const pageViews = document.querySelectorAll("[data-page]");
const validPages = new Set(["vat-recon", "transactions", "icp", "history"]);

let currentPreviewData = null;

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
  if (response.status === 401) {
    showLogin();
  }
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function showLogin() {
  loginScreen.classList.add("active");
  appFrame.classList.add("locked");
}

function showApp() {
  loginScreen.classList.remove("active");
  appFrame.classList.remove("locked");
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
  loadVatReturnMark();
  loadIcpReturnMark();
}

function activePageFromHash() {
  const page = window.location.hash.replace("#", "");
  return validPages.has(page) ? page : "vat-recon";
}

function setActivePage(page) {
  pageLinks.forEach(link => {
    link.classList.toggle("active", link.dataset.pageLink === page);
  });
  pageViews.forEach(view => {
    view.classList.toggle("active", view.dataset.page === page);
  });
}

function vatReturnMarkKey() {
  return `stargrowvat:${tenantSelect.value || "no-tenant"}:${fromDate.value || "from"}:${toDate.value || "to"}:vat-status`;
}

async function setVatReturnMark(status) {
  await saveReturnSnapshot("VAT", status);
  window.localStorage.setItem(vatReturnMarkKey(), status);
  vatReturnBadge.textContent = status;
  returnStatus.textContent = status;
}

function loadVatReturnMark() {
  const status = window.localStorage.getItem(vatReturnMarkKey()) || "Not marked";
  vatReturnBadge.textContent = status;
}

function icpReturnMarkKey() {
  return `stargrowvat:${tenantSelect.value || "no-tenant"}:${fromDate.value || "from"}:${toDate.value || "to"}:icp-status`;
}

async function setIcpReturnMark(status) {
  await saveReturnSnapshot("ICP", status);
  window.localStorage.setItem(icpReturnMarkKey(), status);
  icpReturnBadge.textContent = status;
}

function loadIcpReturnMark() {
  const status = window.localStorage.getItem(icpReturnMarkKey()) || "Not marked";
  icpReturnBadge.textContent = status;
}

async function saveReturnSnapshot(returnKind, status) {
  if (!currentPreviewData) {
    setMessage("Fetch or open a return before saving it.", true);
    return;
  }
  const tenantName = tenantSelect.selectedOptions[0]?.textContent || tenantSelect.value;
  await api("/api/returns", {
    method: "POST",
    body: JSON.stringify({
      returnKind,
      status,
      tenantId: tenantSelect.value,
      tenantName,
      returnData: currentPreviewData
    })
  });
  transactionExportButton.disabled = false;
  icpExportButton.disabled = false;
  setMessage(`${returnKind} return ${status.toLowerCase()}.`);
  await loadHistory();
}

function renderPreview(data) {
  currentPreviewData = data;
  transactionExportButton.disabled = false;
  icpExportButton.disabled = false;
  vatNetTotal.textContent = money(data.vat.totals.net);
  vatVatTotal.textContent = money(data.vat.totals.vat);
  renderVatPayable(data.vat.payable || calculateVatPayable(data.vat.rows));
  loadVatReturnMark();
  loadIcpReturnMark();
  returnStatus.textContent = vatReturnBadge.textContent === "Not marked"
    ? (data.exceptions.length ? "Needs review" : "Reconciled")
    : vatReturnBadge.textContent;
  icpTotalValue.textContent = money(data.icp.total);
  icpTableTotal.textContent = money(data.icp.total);
  vat3bValue.textContent = money(data.icp.vat3b);
  icpReconDiffValue.textContent = money(data.icp.reconciliationDifference);
  const icpPassed = Math.abs(Number(data.icp.reconciliationDifference || 0)) < 0.01;
  icpReconStatus.textContent = icpPassed ? "Passed" : "Review";
  icpReconStatus.className = icpPassed ? "reconPass" : "reconReview";

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

  renderTransactionSheet(data.transactions || []);
}

function renderVatPayable(payable = {}) {
  vatDomestic.textContent = money(payable.domesticVat);
  vatImport.textContent = money(payable.importVat);
  vatTotalDue.textContent = money(payable.totalDue);
  vatInputTax.textContent = money(payable.inputTax);
  vatSubtotal.textContent = money(payable.subtotal);
  vatSmallBusiness.textContent = money(payable.smallBusinessRelief);
  vatPayableReceivable.textContent = money(payable.payableReceivable);
  vatPayableBadge.textContent = Number(payable.payableReceivable || 0) < 0 ? "Te ontvangen" : "Te betalen";
}

function sumVatRows(rows, boxes) {
  return rows
    .filter(row => boxes.includes(row.box))
    .reduce((sum, row) => sum + Number(row.vat || 0), 0);
}

function calculateVatPayable(rows = []) {
  const domesticVat = sumVatRows(rows, ["1a", "1b", "1d", "1d-verlegd", "1e"]);
  const importVat = sumVatRows(rows, ["4a-high", "4a-low", "4b-high", "4b-low"]);
  const totalDue = domesticVat + importVat;
  const inputTax = Math.abs(sumVatRows(rows, ["5b"]));
  const subtotal = totalDue - inputTax;
  return {
    domesticVat,
    importVat,
    totalDue,
    inputTax,
    subtotal,
    smallBusinessRelief: 0,
    payableReceivable: subtotal
  };
}

function groupedTransactions(transactions) {
  const groups = new Map();
  for (const row of transactions) {
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
  return [...groups.values()];
}

function renderTransactionSheet(transactions) {
  const lateCount = transactions.filter(row => row.isLatePosting).length;
  transactionSheetCount.textContent = lateCount
    ? `${transactions.length} lines, ${lateCount} late`
    : `${transactions.length} lines`;
  transactionRows.innerHTML = transactions.length
    ? groupedTransactions(transactions).map(group => `
      <tr class="groupRow">
        <td colspan="14">${escapeHtml(group.vatBox)} - ${escapeHtml(group.vatCategory)}</td>
      </tr>
      ${group.rows.map(row => `
      <tr class="${row.isLatePosting ? "latePostingRow" : ""}">
        <td>${escapeHtml(row.vatBox)}</td>
        <td>${escapeHtml(row.vatCategory)}</td>
        <td>${row.isLatePosting ? "Yes" : ""}</td>
        <td>${escapeHtml(row.lateFromPeriod || "")}</td>
        <td>${row.sourceUrl ? `<a href="${escapeHtml(row.sourceUrl)}" target="_blank" rel="noopener">Open</a>` : "-"}</td>
        <td>${escapeHtml(row.date)}</td>
        <td>${escapeHtml(row.source)}</td>
        <td>${escapeHtml(row.contact)}</td>
        <td>${escapeHtml(row.reference)}</td>
        <td>${escapeHtml(row.account)}</td>
        <td>${escapeHtml(row.taxName)}</td>
        <td class="num">${money(row.net)}</td>
        <td class="num">${money(row.tax)}</td>
        <td class="num">${money(row.gross)}</td>
      </tr>
      `).join("")}
      <tr class="subtotalRow">
        <td colspan="11">Subtotal</td>
        <td class="num">${money(group.net)}</td>
        <td class="num">${money(group.tax)}</td>
        <td class="num">${money(group.gross)}</td>
      </tr>
    `).join("")
    : "<tr class=\"emptyRow\"><td colspan=\"14\">No Xero transactions loaded yet.</td></tr>";
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
  loadVatReturnMark();
  loadIcpReturnMark();
}

async function loadHistory() {
  const { returns } = await api("/api/returns");
  historyCount.textContent = `${returns.length} returns`;
  historyRows.innerHTML = returns.length
    ? returns.map(item => `
      <tr>
        <td>${escapeHtml(new Date(item.savedAt).toLocaleString())}</td>
        <td>${escapeHtml(item.period?.fromDate || "-")} to ${escapeHtml(item.period?.toDate || "-")}</td>
        <td>${escapeHtml(item.returnKind)}</td>
        <td>${escapeHtml(item.status)}</td>
        <td>${escapeHtml(item.tenantName || item.tenantId)}</td>
        <td class="num">${escapeHtml(item.counts?.lines || 0)}</td>
        <td class="num">${money(item.vatTotals?.vat || 0)}</td>
        <td><button class="button secondaryButton historyOpenButton" type="button" data-return-id="${escapeHtml(item.id)}">Open</button></td>
      </tr>
    `).join("")
    : "<tr class=\"emptyRow\"><td colspan=\"8\">No saved returns yet.</td></tr>";
}

async function openSavedReturn(id) {
  const { return: record } = await api(`/api/returns/${encodeURIComponent(id)}`);
  currentPreviewData = record.returnData;
  transactionExportButton.disabled = false;
  icpExportButton.disabled = false;
  if (record.period?.fromDate) fromDate.value = record.period.fromDate;
  if (record.period?.toDate) toDate.value = record.period.toDate;
  updatePeriodLabel();
  vatReturnBadge.textContent = record.returnKind === "VAT" ? record.status : "Opened from history";
  icpReturnBadge.textContent = record.returnKind === "ICP" ? record.status : "Opened from history";
  returnStatus.textContent = record.status;
  renderPreview(record.returnData);
  window.location.hash = "#vat-recon";
  setActivePage("vat-recon");
  setMessage("Saved return opened.");
}

async function exportCurrentReturn() {
  if (!currentPreviewData) {
    setMessage("Fetch or open a return before exporting.", true);
    return;
  }
  const response = await fetch("/api/export-excel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ returnData: currentPreviewData })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Export failed");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `stargrow-vat-${fromDate.value || "from"}-${toDate.value || "to"}.xls`;
  link.click();
  URL.revokeObjectURL(url);
}

async function checkAuth() {
  const response = await fetch("/api/me");
  const me = await response.json();
  if (!me.authenticated) {
    showLogin();
    loginMessage.textContent = me.loginConfigured ? "" : "Login is not configured on the server.";
    return false;
  }
  showApp();
  return true;
}

async function initApp() {
  setDefaultDates();
  setActivePage(activePageFromHash());
  if (await checkAuth()) {
    await loadStatus();
    await loadHistory();
  }
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
    await loadHistory();
    setMessage("Return preview updated.");
  } catch (error) {
    returnStatus.textContent = "Action needed";
    setMessage(error.message, true);
  } finally {
    previewButton.disabled = false;
  }
});

transactionExportButton.addEventListener("click", () => exportCurrentReturn().catch(error => setMessage(error.message, true)));
icpExportButton.addEventListener("click", () => exportCurrentReturn().catch(error => setMessage(error.message, true)));
fromDate.addEventListener("change", updatePeriodLabel);
toDate.addEventListener("change", updatePeriodLabel);
tenantSelect.addEventListener("change", loadVatReturnMark);
tenantSelect.addEventListener("change", loadIcpReturnMark);
saveDraftButton.addEventListener("click", () => setVatReturnMark("Saved as draft").catch(error => setMessage(error.message, true)));
filedButton.addEventListener("click", () => setVatReturnMark("Finalised and filed").catch(error => setMessage(error.message, true)));
icpDraftButton.addEventListener("click", () => setIcpReturnMark("Saved as draft").catch(error => setMessage(error.message, true)));
icpFiledButton.addEventListener("click", () => setIcpReturnMark("Finalised and filed").catch(error => setMessage(error.message, true)));
refreshHistoryButton.addEventListener("click", () => loadHistory().catch(error => setMessage(error.message, true)));
historyRows.addEventListener("click", event => {
  const button = event.target.closest("[data-return-id]");
  if (button) openSavedReturn(button.dataset.returnId).catch(error => setMessage(error.message, true));
});
window.addEventListener("hashchange", () => setActivePage(activePageFromHash()));
loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  loginMessage.textContent = "";
  try {
    await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: loginEmail.value,
        password: loginPassword.value
      })
    });
    loginPassword.value = "";
    showApp();
    await loadStatus();
    await loadHistory();
  } catch (error) {
    loginMessage.textContent = error.message;
    loginMessage.classList.add("error");
  }
});

initApp().catch(error => setMessage(error.message, true));
