# Big Red Buddy browser helper

Version **0.2.0** fills supported job application fields using your saved BRB profile, answers and résumé PDF. You can start on an employer website, in Telegram, or in Career Studio. The helper never clicks Submit.

## Install or update

1. Download BRB’s browser-helper ZIP and unzip it into a folder you will keep.
2. Open `chrome://extensions` in desktop Chrome and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Pin **Big Red Buddy - Application Helper** using Chrome’s Extensions menu.

For an existing installation, replace the files in the installed folder with this release, then click **Reload** on the extension in `chrome://extensions`. Verify **0.2.0** and refresh open BRB tabs. Updating the BRB website does not update an unpacked extension.

## Start on an employer application

1. Open the application in the Chrome profile where you installed the helper.
2. Click **B → Autofill this application**.
3. If asked, sign in to BRB, return to the employer tab and click Autofill again.
4. Check the filled fields and upload status, finish remaining questions, then submit on the employer website.

This works without creating an application in BRB first. Standard text fields, dropdowns, radio buttons, checkboxes and résumé uploads are supported where their labels and choices match saved information. Existing answers are preserved. A saved job match can use its selected enhanced résumé and current accepted application answers; other applications use your original résumé and reusable saved facts. Company-specific answers are used only for a matching saved job.

CAPTCHA, custom widgets, cross-origin embedded forms and questions without a matching saved answer may need your input. If the application opens inside an embedded frame, open its direct application page before using the helper. The helper does not invent answers or check unanswered consent boxes.

## Start from Telegram or BRB

- An ordinary employer link from either place works with **B → Autofill this application** once the application is open.
- In Career Studio’s application tracker or a Telegram BRB handoff page, **Open & autofill application** opens the exact employer URL and fills the application’s saved answers and documents.
- From a BRB handoff page, the toolbar also offers **Open & fill application**.

If a previous submission could not be confirmed, the helper keeps that warning. Check for the employer’s confirmation before submitting again; the earlier attempt may already have succeeded. Autofill does not retry or reset submissions.

## Data handling and permissions

- Filling starts only after your toolbar click or a trusted click on a BRB autofill link. There is no browsing monitor.
- The existing BRB, Lever, Greenhouse, Ashby and Workable host permissions support handoffs. Chrome’s temporary `activeTab` permission supports the employer page you explicitly choose; no all-sites permission is requested.
- The scan sends field labels, types and choices to BRB. It does not send entered values, passwords, cookies, full page text or browsing history.
- BRB uses your authenticated session, CSRF protection and student isolation. The standalone request does not create an application or require Telegram.
- Saved information is bound to the requested URL and the scanned document. If the page navigates or its fields change, scan again.
- Exports expire after five minutes and stay in memory. No persistent profile storage, analytics, remote scripts or model calls are added.
- Only matching saved answers and documents are exported. Unknown answers and the rest of your workspace stay in BRB.
