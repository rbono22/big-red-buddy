# Big Red Buddy browser helper

Version **0.3.0** can tailor your latest saved résumé to an employer’s role, attach a company-named PDF, and fill supported job application fields using your saved BRB profile and answers. You can start on an employer website, in Telegram, or in Career Studio. The helper never clicks Submit.

## Install or update

1. Download BRB’s browser-helper ZIP and unzip it into a folder you will keep.
2. Open `chrome://extensions` in desktop Chrome and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Pin **Big Red Buddy - Application Helper** using Chrome’s Extensions menu.

For an existing installation, replace the files in the installed folder with this release, then click **Reload** on the extension in `chrome://extensions`. Verify **0.3.0** and refresh open BRB tabs. Updating the BRB website does not update an unpacked extension.

## Start on an employer application

1. Open the application in the Chrome profile where you installed the helper.
2. Click **B → Tailor résumé & autofill** to customize your résumé, or **Autofill this application** to use your saved document.
3. If asked, sign in to BRB and return to the employer tab. If the application page does not include the job description or company name, enter those role details in the helper.
4. Keep the application and signed-in BRB tabs open while the PDF is prepared. You may close the popup; reopen it to check progress. Check the attachment and filled fields, finish remaining questions, then submit on the employer website.

This works without creating an application in BRB first. **Tailor résumé & autofill** uses BRB’s private model to add only supported role keywords to your existing experience. Job titles, employers, dates, and factual claims stay intact. It attaches `Resume_[Company].pdf` (for example, `Resume_Stripe.pdf`) and leaves your original saved résumé unchanged. Clicking Tailor authorizes replacing the résumé attachment that was present when the scan started; a file you choose while generation is running is preserved. If no verified wording changes are needed, the helper clearly says it created a PDF from your saved text. Model or PDF failures never masquerade as a tailored résumé.

The résumé reflects the latest file you saved in BRB; upload new experience there first. If the page or saved résumé changes during generation, start again. Retries reuse a current queued or ready request.

 Standard text fields, dropdowns, radio buttons, checkboxes and résumé uploads are supported where their labels and choices match saved information. Existing text answers and choices are preserved. Normal autofill also preserves existing attachments. A saved job match can use its selected enhanced résumé and current accepted application answers; normal autofill on other applications uses your original résumé and reusable saved facts. Company-specific answers are used only for a matching saved job.

CAPTCHA, custom widgets, cross-origin embedded forms and questions without a matching saved answer may need your input. If the application opens inside an embedded frame, open its direct application page before using the helper. The helper does not invent answers or check unanswered consent boxes.

## Start from Telegram or BRB

- An ordinary employer link from either place works with **B → Autofill this application** once the application is open.
- In Career Studio’s application tracker or a Telegram BRB handoff page, **Open & autofill application** opens the exact employer URL and fills the application’s saved answers and documents.
- From a BRB handoff page, the toolbar also offers **Open & fill application**.

If a previous submission could not be confirmed, the helper keeps that warning. Check for the employer’s confirmation before submitting again; the earlier attempt may already have succeeded. Autofill does not retry or reset submissions.

## Data handling and permissions

- Filling starts only after your toolbar click or a trusted click on a BRB autofill link. There is no browsing monitor.
- The existing BRB, Lever, Greenhouse, Ashby and Workable host permissions support handoffs. Chrome’s temporary `activeTab` permission supports the employer page you explicitly choose; no all-sites permission is requested.
- Normal autofill sends field labels, types, and choices to BRB. Tailoring additionally sends bounded public JobPosting metadata or job-description text from the page, or the role details you explicitly enter. It does not send entered application answers, passwords, cookies, arbitrary full page text, or browsing history.
- BRB uses your authenticated session, CSRF protection and student isolation. The standalone request does not create an application or require Telegram.
- Saved information is bound to the requested URL and the scanned document. If the page navigates or its fields change, scan again.
- Autofill exports expire after five minutes and stay in memory. The extension keeps no persistent profile storage, analytics, or remote scripts. Tailoring runs as a private, account-scoped model job in BRB and does not expose the rest of your workspace to the employer.
- Only matching saved answers and documents are exported. Unknown answers and the rest of your workspace stay in BRB.
