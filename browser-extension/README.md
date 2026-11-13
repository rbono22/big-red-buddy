# Big Red Buddy browser helper

Use this optional Chrome extension when an employer needs you to finish in your own browser. It fills saved application answers, your résumé PDF, and a prepared cover-letter PDF where supported. It never clicks the employer’s Submit button.

## Install once

1. Download BRB’s browser-helper ZIP and unzip it into a folder you will keep.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Pin **Big Red Buddy - Application Helper** using Chrome’s Extensions menu.

## Use

1. Open BRB in the Chrome profile where you installed the helper. Sign in if asked.
2. In Career Studio’s application tracker, click **Open & autofill application**. The employer page opens and your saved answers and documents fill automatically.
3. For a Telegram or email handoff link, open its BRB page and click **Open & autofill application** there.
4. Finish any remaining questions, check the upload status, and submit on the employer website.

The toolbar shortcut still works: from a BRB handoff page, click **B → Open and fill application**. Opening a handoff link alone never starts filling; the helper waits for your click.

An ordinary employer link cannot carry a previously filled server-side browser session. This helper transfers only the current application’s accepted answers and selected documents to a new employer tab on your computer. Unsupported controls stay for you to complete. If an employer changes a question or the application changes in BRB, open a fresh handoff.

If BRB could not confirm a previous submission attempt, the helper can still fill the form for you to inspect. The application stays marked unconfirmed. Check for the employer’s confirmation before submitting again, because the earlier attempt may already have succeeded. The helper never retries that submission.

## Data handling and permissions

- Runs only after your click on a BRB autofill link or its toolbar button; no browsing monitor or automatic application submission. The page click handler runs only on BRB’s root page, never inside frames or on employer sites.
- Access is limited to BRB and the supported Lever, Greenhouse, Ashby, and Workable hosts listed in the manifest.
- Uses your existing BRB session and normal CSRF checks on the BRB page. No public cross-origin export endpoint is needed.
- One-time handoff tokens expire after five minutes, stay in memory, and never appear in employer URLs.
- Only accepted saved answers and selected PDF files are transferred. Unaccepted drafts, unknown optional answers, cookies, account credentials, and the rest of your BRB workspace are excluded.
- No persistent extension storage, external analytics, remote scripts, or model calls. Data is discarded after filling the tab.

This extension is installed manually; updating BRB does not update an unpacked extension. For version **0.1.3**, replace the extension folder with the new release, click **Reload** in `chrome://extensions`, then refresh any open BRB tabs so the new click handler loads.
