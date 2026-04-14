// ============================================================
// Debt Tracker — Apps Script Web App
// Deploy as: Execute as Me | Access: Anyone
// ============================================================

const SS_ID       = '1Cb6aVmMojV27sLS1O_W_EZkhZndWgwU88UtYUZI9sxo';
const OWNER_EMAIL = 'felipe.jacob.g@gmail.com';

// ── ENTRY POINT ─────────────────────────────────────────────
function doPost(e) {
  try {
    const req   = JSON.parse(e.postData.contents);
    const email = verifyToken(req.token);
    if (!email) return jsonOut({ error: 'Unauthorized' });

    const ss = SpreadsheetApp.openById(SS_ID);

    switch (req.action) {
      case 'load':          return jsonOut(handleLoad(ss, email));
      case 'saveDebt':      return jsonOut(handleSaveDebt(ss, email, req.data));
      case 'deleteDebt':    return jsonOut(handleDeleteDebt(ss, email, req.id));
      case 'savePayment':   return jsonOut(handleSavePayment(ss, email, req.data));
      case 'deletePayment': return jsonOut(handleDeletePayment(ss, email, req.id));
      case 'saveUser':      return jsonOut(handleSaveUser(ss, email, req.data));
      case 'deleteUser':    return jsonOut(handleDeleteUser(ss, email, req.targetEmail));
      default:              return jsonOut({ error: 'Unknown action' });
    }
  } catch (err) {
    return jsonOut({ error: err.toString() });
  }
}

// ── HELPERS ─────────────────────────────────────────────────
function jsonOut(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function verifyToken(token) {
  if (!token) return null;
  try {
    const r = UrlFetchApp.fetch(
      'https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + token,
      { muteHttpExceptions: true }
    );
    const d = JSON.parse(r.getContentText());
    return d.email || null;
  } catch (e) { return null; }
}

function isOwner(email) { return email === OWNER_EMAIL; }

function getSheet(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function findRow(sheet, id) {
  const vals = sheet.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === String(id)) return i + 1;
  }
  return -1;
}

function sheetRows(sheet) {
  const data = sheet.getDataRange().getValues();
  return data.slice(1).filter(r => r[0]);
}

// ── LOAD (filtered by role) ──────────────────────────────────
function handleLoad(ss, email) {
  const debtsSheet    = getSheet(ss, 'Debts');
  const paymentsSheet = getSheet(ss, 'Payments');
  const usersSheet    = getSheet(ss, 'Users');

  // Ensure headers
  if (debtsSheet.getLastRow()    === 0) debtsSheet.appendRow(['id','name','total_installments','start_date','description','total_amount']);
  if (paymentsSheet.getLastRow() === 0) paymentsSheet.appendRow(['id','debt_id','date','amount','method','payment_number','file_name','file_url','drive_file_id','notes']);
  if (usersSheet.getLastRow()    === 0) usersSheet.appendRow(['email','role','allowed_debt_ids']);

  const allDebts = sheetRows(debtsSheet).map(r => ({
    id: r[0], name: r[1], total: parseInt(r[2]) || 1, startDate: r[3] || '', desc: r[4] || '',
    totalAmount: parseFloat(r[5]) || 0
  }));

  const allPayments = sheetRows(paymentsSheet).map(r => ({
    id: r[0], debtId: r[1], date: r[2], amount: parseFloat(r[3]) || 0,
    method: r[4] || '', num: parseInt(r[5]) || 0, fileName: r[6] || '',
    fileUrl: r[7] || '', fileId: r[8] || '', notes: r[9] || ''
  }));

  const allUsers = sheetRows(usersSheet).map(r => ({
    email: r[0], role: r[1] || 'viewer',
    debtIds: r[2] ? String(r[2]).split(',').map(s => s.trim()).filter(Boolean) : []
  }));

  // Auto-register owner on first sign-in
  if (isOwner(email) && !allUsers.find(u => u.email === email)) {
    usersSheet.appendRow([email, 'owner', '']);
    allUsers.push({ email, role: 'owner', debtIds: [] });
  }

  const user = allUsers.find(u => u.email === email);
  if (!user && !isOwner(email)) return { error: 'Access denied' };

  const role           = isOwner(email) ? 'owner' : 'viewer';
  const allowedDebtIds = (isOwner(email) || !user || !user.debtIds.length) ? null : user.debtIds;

  const debts    = allowedDebtIds ? allDebts.filter(d => allowedDebtIds.includes(d.id)) : allDebts;
  const debtIds  = new Set(debts.map(d => d.id));
  const payments = allPayments.filter(p => debtIds.has(p.debtId));
  const users    = isOwner(email) ? allUsers : [];

  return { debts, payments, users, role, email };
}

// ── DEBTS ────────────────────────────────────────────────────
function handleSaveDebt(ss, email, debt) {
  if (!isOwner(email)) return { error: 'Forbidden' };
  const sheet = getSheet(ss, 'Debts');
  const row    = [debt.id, debt.name, debt.total, debt.startDate, debt.desc, debt.totalAmount || 0];
  const rowNum = findRow(sheet, debt.id);
  if (rowNum > 0) sheet.getRange(rowNum, 1, 1, 6).setValues([row]);
  else sheet.appendRow(row);
  return { ok: true };
}

function handleDeleteDebt(ss, email, id) {
  if (!isOwner(email)) return { error: 'Forbidden' };
  const debtsSheet    = getSheet(ss, 'Debts');
  const paymentsSheet = getSheet(ss, 'Payments');
  const dRow = findRow(debtsSheet, id);
  if (dRow > 0) debtsSheet.getRange(dRow, 1, 1, 6).clearContent();
  // Clear all payments for this debt
  const payVals = paymentsSheet.getDataRange().getValues();
  for (let i = payVals.length - 1; i >= 1; i--) {
    if (String(payVals[i][1]) === String(id)) {
      paymentsSheet.getRange(i + 1, 1, 1, 10).clearContent();
    }
  }
  return { ok: true };
}

// ── PAYMENTS ─────────────────────────────────────────────────
function handleSavePayment(ss, email, payment) {
  if (!isOwner(email)) {
    const allowed = getAllowedDebtIds(ss, email);
    if (allowed !== null && !allowed.includes(payment.debtId)) return { error: 'Forbidden' };
  }
  const sheet  = getSheet(ss, 'Payments');
  const row    = [payment.id, payment.debtId, payment.date, payment.amount, payment.method,
                  payment.num, payment.fileName, payment.fileUrl, payment.fileId, payment.notes];
  const rowNum = findRow(sheet, payment.id);
  if (rowNum > 0) sheet.getRange(rowNum, 1, 1, 10).setValues([row]);
  else sheet.appendRow(row);
  return { ok: true };
}

function handleDeletePayment(ss, email, id) {
  const sheet  = getSheet(ss, 'Payments');
  const rowNum = findRow(sheet, id);
  if (rowNum < 0) return { error: 'Not found' };
  if (!isOwner(email)) {
    const debtId  = sheet.getRange(rowNum, 2).getValue();
    const allowed = getAllowedDebtIds(ss, email);
    if (allowed !== null && !allowed.includes(String(debtId))) return { error: 'Forbidden' };
  }
  sheet.getRange(rowNum, 1, 1, 10).clearContent();
  return { ok: true };
}

// ── USERS ────────────────────────────────────────────────────
function handleSaveUser(ss, email, user) {
  if (!isOwner(email)) return { error: 'Forbidden' };
  const sheet  = getSheet(ss, 'Users');
  const row    = [user.email, user.role, user.debtIds.join(',')];
  const rowNum = findRow(sheet, user.email);
  if (rowNum > 0) sheet.getRange(rowNum, 1, 1, 3).setValues([row]);
  else sheet.appendRow(row);
  return { ok: true };
}

function handleDeleteUser(ss, email, targetEmail) {
  if (!isOwner(email)) return { error: 'Forbidden' };
  const sheet  = getSheet(ss, 'Users');
  const rowNum = findRow(sheet, targetEmail);
  if (rowNum > 0) sheet.getRange(rowNum, 1, 1, 3).clearContent();
  return { ok: true };
}

// ── PERMISSION HELPER ────────────────────────────────────────
function getAllowedDebtIds(ss, email) {
  const usersSheet = getSheet(ss, 'Users');
  const rows = sheetRows(usersSheet);
  const user = rows.find(r => r[0] === email);
  if (!user) return [];
  const ids = user[2] ? String(user[2]).split(',').map(s => s.trim()).filter(Boolean) : [];
  return ids.length ? ids : null; // null = all debts allowed
}
