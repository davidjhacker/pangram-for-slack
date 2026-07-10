# Unofficial Pangram + Slack Integration  <p>

Uses Chromium debugging tools to send all rendered Slack messages to Pangram's API and inject the results into the DOM.

<img width="621" height="463" alt="Screenshot 2026-07-10 at 2 31 55 AM" src="https://github.com/user-attachments/assets/0ee5e212-5f12-4082-8f34-d2d24b7175ea" />  <br><br>


Works on messages of at least 50 words (Pangram's minimum) and ignores bot users. Caches results so you don't query the same message twice.

## Usage:
1. Launch Slack with the debugger attached:
```
open -a Slack --args --remote-debugging-port=9222
```
2. Export Pangram API Key (or add to .env)
```
export PANGRAM_API_KEY=<your-key>
```
or add to .env

3. 
Run the message tagger
```
node tagger.mjs
```
