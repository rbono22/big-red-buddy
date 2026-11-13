# Big Red Buddy browser helper

Use this optional Chrome extension when an employer needs you to finish in your own browser. It fills saved application answers, your résumé PDF, and a prepared cover-letter PDF where supported. It never clicks the employer’s Submit button.

## Install once

1. Download BRB’s browser-helper ZIP and unzip it into a folder you will keep.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Pin **Big Red Buddy - Application Helper** using Chrome’s Extensions menu.

## Use

1. In Telegram, choose **Continue in my browser** for the current application.
2. Open its BRB link in the Chrome profile where you installed the helper. Sign in to BRB if asked.
3. Click the BRB extension, then **Open and fill application**.
4. Finish any remaining questions, check the upload status, and submit on the employer website.

An ordinary employer link cannot carry a previously filled server-side browser session. This helper transfers only the current application’s accepted answers and selected documents to a new employer tab on your computer. Unsupported controls stay for you to complete. If an employer changes a question or the application changes in BRB, open a fresh handoff.

## Data handling and permissions

- Runs only when you click its button; no browsing monitor or automatic application submission.
- Access is limited to BRB and the supported Lever, Greenhouse, Ashby, and Workable hosts listed in the manifest.
- Uses your existing BRB session and normal CSRF checks on the BRB page. No public cross-origin export endpoint is needed.
- One-time handoff tokens expire after five minutes, stay in memory, and never appear in employer URLs.
- Only accepted saved answers and selected PDF files are transferred. Unaccepted drafts, unknown optional answers, cookies, account credentials, and the rest of your BRB workspace are excluded.
- No persistent extension storage, external analytics, remote scripts, or model calls. Data is discarded after filling the tab.

This first version is installed manually; updating BRB does not update an unpacked extension. Replace the extension folder with the new release and click **Reload** in `chrome://extensions` when BRB provides an update.
