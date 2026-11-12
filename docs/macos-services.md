# Mac pilot background services

The web server and model, reminder, and discovery workers run as four separate per-user macOS launchd services:

- `com.bigredbuddy.web`
- `com.bigredbuddy.model`
- `com.bigredbuddy.reminders`
- `com.bigredbuddy.discovery`

Definitions are in `~/Library/LaunchAgents/`. They use the existing `.env` plus `data/public-demo.env`, with private logs in `~/Library/Logs/BigRedBuddy/`. No credentials are embedded in the service definitions. Generate or update the definitions with `node scripts/prepare-macos-services.mjs`. For initial installation, bootstrap each definition using `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bigredbuddy.ROLE.plist`, replacing ROLE with each name above.

launchd starts these jobs at user login and restarts them when they exit, with a 10-second restart throttle. They do not depend on an open Terminal window or a coding session. After changing code or environment settings, restart the applicable service with `launchctl kickstart -k gui/$(id -u)/com.bigredbuddy.ROLE`. Do not also start manual copies of the server/workers.

To deliberately stop a service, use `launchctl bootout gui/$(id -u)/com.bigredbuddy.ROLE`; merely killing its process causes launchd to restart it. To uninstall, boot out the services before removing their four definitions.

Cloudflare's named tunnel is managed separately by its installed system service. PostgreSQL and Ollama must also be available; the app services do not install or manage them. The Mac must remain awake and online, and this user must remain logged in. Locking the screen is fine. Sleeping, shutting down, or logging out interrupts service. After reboot, sign into this Mac to start these user services. An always-on host is still required for availability independent of the laptop.

Verification: public `https://app.bigredbuddy.com/healthz` should return HTTP 200, `launchctl print gui/$(id -u)/com.bigredbuddy.ROLE` should report running, and `/private/tmp/dabas-ROLE-heartbeat` for each worker should be fresh. Logs are private but not automatically rotated; review their sizes during pilot operations.
