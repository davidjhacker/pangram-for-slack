## Usage:
1. Launch Slack with the Chrome Devtools debugger attached:
```
open -a Slack --args --remote-debugging-port=9222
```
2. Add Pangram API Key
```
export PANGRAM_API_KEY=<your-key>
```
or add to .env
3. 
Run the message tagger
```
node tagger.mjs
```

This injects javascript into Slack's window that passes rendered messages into Pangram, tags them with AI/not AI, and caches the result.
