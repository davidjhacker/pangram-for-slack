import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification
from peft import PeftModel

BASE = os.environ.get("EDITLENS_BASE", "FacebookAI/roberta-large")
ADAPTER = os.environ.get("EDITLENS_ADAPTER", "pangram/editlens_roberta-large")
PORT = int(os.environ.get("EDITLENS_PORT", "8000"))
MAX_LEN = int(os.environ.get("EDITLENS_MAX_LEN", "512"))


def detect_buckets():
    if os.environ.get("EDITLENS_BUCKETS"):
        return int(os.environ["EDITLENS_BUCKETS"])
    from huggingface_hub import hf_hub_download
    from safetensors import safe_open

    path = hf_hub_download(ADAPTER, "adapter_model.safetensors")
    with safe_open(path, framework="pt") as f:
        # classification head is saved in modules_to_save; roberta -> classifier.out_proj,
        # llama/mistral -> score. Both are the small [n_buckets, hidden] 2-D weight.
        cands = {}
        for k in f.keys():
            if k.endswith("weight") and (
                "out_proj" in k or "score" in k or "classifier" in k
            ):
                shape = f.get_slice(k).get_shape()
                if len(shape) == 2 and 2 <= shape[0] <= 16:
                    cands[k] = shape[0]
        if not cands:
            raise SystemExit(
                "could not detect bucket count from adapter; set EDITLENS_BUCKETS=N"
            )
        n = sorted(cands.values())[0]  # the head is the narrowest such matrix
        print(f"detected {n} buckets from {sorted(cands.items())}")
        return n


N_BUCKETS = detect_buckets()
print(f"loading EditLens ({ADAPTER} on {BASE}), {N_BUCKETS} buckets…")
tokenizer = AutoTokenizer.from_pretrained(BASE)
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token
_base = AutoModelForSequenceClassification.from_pretrained(BASE, num_labels=N_BUCKETS)
model = PeftModel.from_pretrained(_base, ADAPTER)
model.eval()
_bucket_idx = torch.arange(N_BUCKETS, dtype=torch.float32)
print(f"ready on http://127.0.0.1:{PORT}/score")


def score_text(text):
    enc = tokenizer(text, truncation=True, max_length=MAX_LEN, return_tensors="pt")
    with torch.no_grad():
        logits = model(**enc).logits[0]
    probs = torch.softmax(logits, dim=-1)
    # EditLens score: expected bucket index, normalized to [0,1]. (scripts/inference.py)
    score = float((probs @ _bucket_idx) / (N_BUCKETS - 1))
    bucket = int(probs.argmax())
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
