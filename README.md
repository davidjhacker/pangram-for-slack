# Unofficial Pangram + Slack/Discord Integration

Uses Chromium debugging tools to send all rendered messages to Pangram's API and inject the results into the DOM.

<img width="621" height="463" alt="pangram_img" src="https://github.com/user-attachments/assets/cc66e305-17d0-49b1-931f-2e3ed77205ab" />

## Usage

1. Set environment variables (or use .env)

```bash
export PANGRAM_API_KEY=<your key> # for Pangram API. See editlens instructions below
export PLATFORM=discord # slack or discord
```

1. Launch the platform of your choice with the debugger attached. Make sure you quit the application first!

```bash
open -a Discord --args --remote-debugging-port=9222 # or Slack
```

1. Run the message tagger

```
node tagger.mjs
```

Done!

## Appendix: EditLens

Pangram's API is expensive for short messages. Luckily, they have released an [open source model](https://huggingface.co/pangram/editlens_roberta-large) that we can run locally.

NOTE: EditLens is only available to approved users. You can petition for approval at the above link.

### Setup

```bash
hf auth login # authenticate with huggingface to run the model
pip install -r editlens_requirements.txt
export SCORER=editlens
python editlens_server.py    
```

Then, in a separate terminal, run `node tagger.mjs` as normal.
