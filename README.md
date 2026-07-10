# Pangram Labs (Unofficial) Slack Integration
Takes advantage of Chromium debugging tools to auto-send Slack messages to Pangram's API and inject results into Slack's DOM.

<img width="678" height="617" alt="Screenshot 2026-07-10 at 2 08 24 AM" src="https://github.com/user-attachments/assets/1a31e8ea-59d1-4701-9c98-bd3939d09c0f" />.

Works on messages of at least 50 words (Pangram's minimum) and ignores Slackbots. Caches results so you don't query the same message twice.

## Usage:
1. Launch Slack with the debugger attached:
```
open -a Slack --args --remote-debugging-port=9222
```
2. Add Pangram API Key
```
export PANGRAM_API_KEY=<your-key>
```
or add to .env

3. Run the message tagger
```
node tagger.mjs
```
