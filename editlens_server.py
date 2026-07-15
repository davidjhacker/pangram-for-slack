#!/usr/bin/env python3
"""Local EditLens scorer for slack-ai-tagger.

Serves Pangram's open-source EditLens model at http://127.0.0.1:8000/score so
tagger.mjs can score messages locally, no cloud API, no per-message cost:
    SCORER=editlens node tagger.mjs

The model is gated + NON-COMMERCIAL (CC BY-NC-SA 4.0). Accept its terms and log in first:
    pip install -r editlens_requirements.txt
    hf auth login                    # then accept terms at hf.co/pangram/editlens_roberta-large
    python editlens_server.py        # first run downloads ~1.4GB; prints the bucket count

The roberta checkpoint is a full RobertaForSequenceClassification (4 ordinal buckets,
0 = human ... N-1 = fully AI), not a LoRA adapter — so we just load it directly.

Contract (matches scoreEditlens() in tagger.mjs):
    POST /score  {"text": "..."}  ->  {"score": 0.0-1.0, "bucket": int, "label": "Human|Mixed|AI"}
    score = extent of AI editing (0 = human, 1 = fully AI-generated).
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification

MODEL = os.environ.get("EDITLENS_MODEL", "pangram/editlens_roberta-large")
PORT = int(os.environ.get("EDITLENS_PORT", "8000"))
MAX_LEN = int(os.environ.get("EDITLENS_MAX_LEN", "512"))

print(f"loading EditLens ({MODEL})… first run downloads ~1.4GB")
tokenizer = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForSequenceClassification.from_pretrained(MODEL)
model.eval()
N_BUCKETS = model.config.num_labels  # 4 for roberta-large
_bucket_idx = torch.arange(N_BUCKETS, dtype=torch.float32)
print(f"loaded, {N_BUCKETS} buckets")


def score_text(text):
    enc = tokenizer(text, truncation=True, max_length=MAX_LEN, return_tensors="pt")
    with torch.no_grad():
        logits = model(**enc).logits[0]
    probs = torch.softmax(logits, dim=-1)
    # EditLens score: expected bucket index, normalized to [0,1]. (their scripts/inference.py)
    score = float((probs @ _bucket_idx) / (N_BUCKETS - 1))
    bucket = int(probs.argmax())
    # ponytail: bucket-extreme -> ternary label. Paper calibrates score thresholds on a
    # val set for tighter Human/Mixed/AI cuts; swap here if you want their exact boundaries.
    label = "Human" if bucket == 0 else "AI" if bucket == N_BUCKETS - 1 else "Mixed"
    return {"score": score, "bucket": bucket, "label": label}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/score":
            return self.send_error(404)
        try:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            text = json.loads(body)["text"]
            out = json.dumps(score_text(text)).encode()
        except (
            Exception
        ) as e:  # noqa: BLE001 — surface any failure to the tagger, don't crash the server
            return self.send_error(500, str(e))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):  # quiet default access log
        pass


if __name__ == "__main__":
    print(f"serving EditLens on http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
