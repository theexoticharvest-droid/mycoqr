/**
 * MycoQR -> Google Sheets receiver (optional, NOT yet tested against a live sheet).
 *
 * Setup when the tracker sheet is decided:
 *   1. Open the Google Sheet > Extensions > Apps Script, paste this file.
 *   2. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
 *   3. Copy the web app URL into MycoQR > Data > Tracker sync.
 *
 * Anyone holding the URL can add rows, so treat it like a password.
 * Rows land in a tab called "Entries". Deleted entries are removed again by their id.
 */
var TAB = 'Entries';

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.app !== 'mycoqr' || !data.entries) return reply({ ok: false, error: 'bad request' });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(TAB) || ss.insertSheet(TAB);
    if (sh.getLastRow() === 0) sh.appendRow(data.columns);

    var ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];

    data.entries.forEach(function (en) {
      var target = en.type === 'void' ? en.ref : en.id;
      var at = ids.indexOf(String(target));
      if (en.type === 'void' || en.voided) {
        if (at >= 0) { sh.deleteRow(at + 2); ids.splice(at, 1); }
        return;
      }
      var row = en.row.map(safe);
      if (at >= 0) sh.getRange(at + 2, 1, 1, row.length).setValues([row]);   // resend or flush renumber
      else { sh.appendRow(row); ids.push(String(en.id)); }
    });
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Text that starts like a formula is stored as plain text.
function safe(v) {
  return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v;
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
