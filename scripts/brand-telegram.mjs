// Operator command: loads credentials from the environment; never logs tokens.
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
async function call(method, body = {}) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error(`Telegram ${method}: network request failed`); }
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method} failed (HTTP ${response.status})`);
  return result.result;
}
await call('setMyName', {name: 'Big Red Buddy'});
await call('setMyShortDescription', {short_description: 'Your Cornell Tech student assistant for classes, deadlines, events, and career planning.'});
await call('setMyDescription', {description: 'Big Red Buddy (BRB) helps Cornell Tech students organize classes, deadlines, campus events, and career opportunities. Link your student account to receive your chosen reminders and morning briefing.'});
const result = await call('getMyName');
if (result.name !== 'Big Red Buddy') throw new Error('Bot name verification failed');
console.log('Verified Telegram display name: Big Red Buddy. Description and about text updated. Username unchanged.');
