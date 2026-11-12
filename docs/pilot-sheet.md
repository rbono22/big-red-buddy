# Private pilot invitation sheet

Configure `PILOT_SHEET_ID`, `PILOT_SHEET_GID` (numeric tab ID), and `PILOT_SHEET_OWNER` on the web service and every worker. The owner must be a Cornell email in the bootstrap `PILOT_EMAILS` list. Keep sheet editing limited to trusted operators; anyone who can edit this sheet can grant and revoke pilot access.

Set `PILOT_SHEET_ID` to the identifier between `/d/` and `/edit` in your private spreadsheet URL, `PILOT_SHEET_GID` to its numeric `gid` value (often `0`), and `PILOT_SHEET_OWNER` to the operator’s Cornell email. Store these deployment values in the ignored environment configuration; do not commit the live spreadsheet identifier or invitation list.

1. In the existing Google Cloud project, enable **Google Sheets API**.
2. Under Google Auth Platform → Data Access, add `https://www.googleapis.com/auth/spreadsheets.readonly`.
3. Sign into BRB as the operator. Open **Connections → Pilot invitations → Connect approval sheet** and grant read access using the same Cornell account.
4. Check for **Sheet active** and a recent successful sync. Until the first successful import, the existing configured pilot list remains in effect.

The first two columns must be **Email** and **Access**. Use **Approved** or **Revoked**, one row per Cornell email. After activation, the sheet replaces the bootstrap student list: removing a row also revokes that student's access. Keep the operator's row Approved. The operator retains recovery access from the server configuration and cannot be revoked through this sheet.

Sync runs every minute while the web server runs. An owner-only **Sync invitations now** button is also available. The importer resolves the configured numeric tab ID, so renaming the tab is supported. It rejects duplicate emails, formulas, invalid domains/statuses, missing headers/operator, and sheets over 10,000 rows. Failed reads do not overwrite the last validated list or restore the bootstrap list. After 15 minutes without a valid refresh, student requests and new background work fail closed; the configured operator retains recovery access. Fix the sheet, reconnect if necessary, then sync. Restarting does not clear revocations.

Google's Sheets read-only permission covers all spreadsheets accessible to the consenting account. BRB restricts its reader to this configured spreadsheet and two columns; this is an application restriction, not a Google-enforced per-file scope. The app neither publishes nor edits the sheet. Credentials and imported membership snapshots are encrypted in the server-only auth store. They are not provided to students or to the model. Only the operator can view connection status or initiate OAuth/sync; POST requests require CSRF protection.

Every web authentication checks current membership, including existing sessions. Telegram input, worker scheduling, and job dispatch check it too. Revocation does not undo already completed actions or forcibly cancel an action already executing. It does not delete student data; account deletion is separate.

While Google OAuth is in Testing, Google still requires invited connector users under **Audience → Test users**. This sheet does not edit Google's test-user list. Google may expire testing refresh grants, requiring the operator to reconnect; the panel shows errors and last successful refresh. The server and its workers must stay online.
