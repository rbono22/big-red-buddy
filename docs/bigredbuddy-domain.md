# Big Red Buddy domain cutover

Canonical pilot address: `https://app.bigredbuddy.com`.

1. In Cloudflare, make sure `bigredbuddy.com` is Active. Create a named tunnel called `big-red-buddy`, install its connector on the Mac, and add a published application route: hostname `app.bigredbuddy.com`, service `http://127.0.0.1:4319`. Keep its token private. Run the connector as a service for restart recovery.
2. In Google Auth Platform → Clients, edit the existing web OAuth client. Add authorized JavaScript origin `https://app.bigredbuddy.com` and authorized redirect URI `https://app.bigredbuddy.com/auth/google/callback`. Keep the current temporary callback until cutover is verified. No new client or secret is needed.
3. In Google Auth Platform → Branding, change the app name to Big Red Buddy and add authorized domain `bigredbuddy.com`. Update existing homepage/privacy/terms URLs to real, working pages on the new domain. Keep the five pilot test users under Audience; do not widen access.
4. For the Slack app, update its display name and add `https://app.bigredbuddy.com/auth/slack/callback` under OAuth & Permissions → Redirect URLs. Workspace installation approval remains a separate requirement.
5. After the named tunnel and Google callback are configured, change `APP_ORIGIN` in the active deployment configuration (`data/public-demo.env` for this Mac pilot) to `https://app.bigredbuddy.com`. Restart web and workers, verify sign-in, calendar linking, Telegram linking, and health through the new address. Existing cookies are hostname-specific, so sign in again.
6. Optionally redirect the bare `bigredbuddy.com` domain to the canonical app hostname in Cloudflare. Retire the temporary tunnel/callback only after successful verification.

The Telegram display name and descriptions can be updated with `node --env-file=.env --env-file=data/public-demo.env scripts/brand-telegram.mjs`. Its existing username stays valid. If changing the handle through BotFather, update `TELEGRAM_BOT_USERNAME` to the actual assigned username and restart the application. Students do not need a new bot.

The permanent hostname does not keep the Mac, application workers, PostgreSQL, or Ollama running: these must remain available, and the Mac must remain awake. Internal storage keys and existing calendar mappings remain unchanged during rebranding.
