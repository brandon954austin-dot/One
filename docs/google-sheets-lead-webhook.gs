/**
 * AMA Quality Consulting - lead capture webhook.
 *
 * Receives form submissions from the website (landing page and
 * contact page) and appends them as rows in this spreadsheet.
 *
 * SETUP (one time, ~3 minutes):
 * 1. Create a Google Sheet (e.g. "AMA Leads").
 * 2. In the sheet: Extensions → Apps Script. Delete any code there
 *    and paste this whole file. Save.
 * 3. Click Deploy → New deployment → type: Web app.
 *     - Execute as: Me
 *     - Who has access: Anyone
 *    Click Deploy and authorize when prompted.
 * 4. Copy the Web app URL (ends in /exec).
 * 5. In Shopify: Online Store → Customize → Theme settings →
 *    Tracking → paste the URL into "Google Sheet webhook URL". Save.
 *
 * Each submission appends: timestamp, page, URL, name, business,
 * email, phone, supplier status, message.
 */

var SHEET_NAME = 'Leads';

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Timestamp', 'Page', 'URL', 'Name', 'Business', 'Email', 'Phone', 'Supplier status', 'Message']);
      sheet.setFrozenRows(1);
    }
    var p = (e && e.parameter) || {};
    sheet.appendRow([
      new Date(),
      p.page || '',
      p.url || '',
      p.name || '',
      p.business_name || '',
      p.email || '',
      p.phone || '',
      p.supplier_status || '',
      p.message || ''
    ]);
    return ContentService.createTextOutput('ok');
  } finally {
    lock.releaseLock();
  }
}
