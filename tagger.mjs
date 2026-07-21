import fs from 'node:fs'
import assert from 'node:assert'

const PORT = 9222
const VERSION = 6 // bump when PAYLOAD changes
try { process.loadEnvFile(new URL('./.env', import.meta.url)) } catch {}
const KEY = process.env.PANGRAM_API_KEY
const SCORER = process.env.SCORER || 'pangram' // 'pangram' (cloud API) or 'editlens' (local server, see editlens_server.py)
const PLATFORM = (process.env.PLATFORM || 'slack').toLowerCase() // 'slack' or 'discord'
const PLATFORMS = {
  slack: {
    name: 'Slack',
    urlMatch: 'app.slack.com',
    msgSelector: '[data-qa="message-text"]',
    rowSelector: '[data-qa="virtual-list-item"]',
    botSelector: '.c-app_badge, [data-qa="bot_label"]',
  },
  discord: {
    name: 'Discord',
    urlMatch: 'discord.com',
    msgSelector: '[id^="message-content-"]',
    rowSelector: '[id^="chat-messages-"]',
    botSelector: '[class*="botTag"]',
  },
}
const P = PLATFORMS[PLATFORM]
if (!P) { console.error(`Unknown PLATFORM="${PLATFORM}". Use "slack" or "discord".`); process.exit(1) }
const EDITLENS_URL = process.env.EDITLENS_URL || 'http://127.0.0.1:8000/score'
const ready = SCORER === 'editlens' || !!KEY // editlens needs no key; pangram does
const CACHE_FILE = new URL('./scores.json', import.meta.url)
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {}
const store = cache[SCORER] ??= {}
const saveCache = () => fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1))

// helpers
function djb2(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0; return h.toString(16) }
function wordCount(s) { return s.trim() ? s.trim().split(/\s+/).length : 0 }

if (process.argv.includes('--selftest')) {
  assert.equal(wordCount('  a  b\nc '), 3)
  assert.equal(wordCount(''), 0)
  assert.equal(wordCount(Array(51).fill('w').join(' ')), 51)
  assert.equal(djb2('hello'), djb2('hello'))
  assert.notEqual(djb2('hello'), djb2('hellp'))
  console.log('selftest ok')
  process.exit(0)
}

const PAYLOAD = `(() => {
  if (window.__pangramV === ${VERSION}) return; window.__pangramV = ${VERSION};
  const djb2 = ${djb2};
  const wordCount = ${wordCount};
  const MSG_SEL = '${P.msgSelector}';
  const ROW_SEL = '${P.rowSelector}';
  const BOT_SEL = '${P.botSelector}';
  const seen = new Map();
  const STYLE = 'display:block;width:fit-content;margin-top:4px;padding:0 6px;border-radius:9px;font-size:11px;font-weight:700;';
  const COLORS = { AI: 'background:#fdd8d8;color:#a00000', Human: 'background:#d8f0d8;color:#006600', Mixed: 'background:#fdeecb;color:#946200' };
  const GRAY = 'background:#e8e8e8;color:#555';
  function badge(el, res) {
    const old = el.querySelector('.pangram-badge');
    if (old) { if (old.dataset.pending && !res.pending) old.remove(); else return; }
    const b = document.createElement('span');
    b.className = 'pangram-badge';
    if (res.pending) b.dataset.pending = '1';
    b.style.cssText = STYLE + (COLORS[res.label] || GRAY);
    b.textContent = res.pending ? '\\u23F3 Checking for AI\\u2026'
      : (res.label === 'AI' ? '\\u{1F916} ' : res.label === 'Human' ? '\\u{1F9D1} ' : '') + res.label + (res.pct == null ? '' : ' \\u00b7 ' + res.pct + '% AI');
    el.appendChild(b);
  }
  window.__pangramApply = (hash, res) => {
    seen.set(hash, res);
    document.querySelectorAll('[data-pangram-hash="' + hash + '"]').forEach(el => badge(el, res));
  };
  function scan() {
    document.querySelectorAll(MSG_SEL).forEach(el => {
      if (el.querySelector('.pangram-badge')) return;
      const row = el.closest(ROW_SEL);
      if (row && row.querySelector(BOT_SEL)) return;
      const t = el.innerText || '';
      if (wordCount(t) <= 50) return;
      const h = djb2(t);
      el.dataset.pangramHash = h;
      const r = seen.get(h);
      if (r && r !== 'pending') badge(el, r);
      else if (r === 'pending') badge(el, { pending: true });
      else { seen.set(h, 'pending'); badge(el, { pending: true }); window.__pangramSend(JSON.stringify({ hash: h, text: t })); }
    });
  }
  let queued = false;
  const start = () => {
    new MutationObserver(() => {
      if (queued) return; queued = true;
      setTimeout(() => { queued = false; scan(); }, 400);
    }).observe(document.body, { childList: true, subtree: true });
    scan();
    console.log('[pangram] tagger installed v${VERSION}');
  };
  document.body ? start() : addEventListener('DOMContentLoaded', start);
})()`

// scorer dispatch: same {label, pct} shape from either backend
const score = text => (SCORER === 'editlens' ? scoreEditlens : scorePangram)(text)

// EditLens: local HTTP server wrapping the open-source model. Server owns model + labels.
async function scoreEditlens(text) {
  const r = await fetch(EDITLENS_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  })
  if (!r.ok) throw new Error(`editlens ${r.status}: ${await r.text()}`)
  const { score, label } = await r.json() // score is 0-1 (fraction AI); label is Human|Mixed|AI
  return { label, pct: score == null ? null : Math.round(score * 100) }
}

// Pangram v3: create async task, poll to terminal stage
async function scorePangram(text) {
  const headers = { 'content-type': 'application/json', 'x-api-key': KEY }
  const r = await fetch('https://text.external-api.pangram.com/task', {
    method: 'POST', headers, body: JSON.stringify({ text, public_dashboard_link: false }),
  })
  if (!r.ok) throw new Error(`pangram POST ${r.status}: ${await r.text()}`)
  const { task_id } = await r.json()
  for (let i = 0; i < 40; i++) {
    await new Promise(res => setTimeout(res, 1500))
    const t = await (await fetch(`https://text.external-api.pangram.com/task/${task_id}`, { headers })).json()
    if (t.stage === 'STAGE_SUCCESS') {
      return {
        label: t.prediction_short || (t.fraction_ai >= 0.5 ? 'AI' : 'Human'),
        pct: t.fraction_ai == null ? null : Math.round(t.fraction_ai * 100),
      }
    }
    if (t.stage === 'STAGE_FAILED') throw new Error('pangram task failed')
  }
  throw new Error('pangram poll timeout')
}

// chromium devtools stuff
const inflight = new Set()

async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let msgId = 0
  const pending = new Map()
  const waiters = new Map() // CDP event name -> resolve
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evalJson = async expr =>
    (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value
  const apply = (hash, res) =>
    send('Runtime.evaluate', { expression: `window.__pangramApply(${JSON.stringify(hash)}, ${JSON.stringify(res)})` })

  ws.addEventListener('message', async ev => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
      return
    }
    if (waiters.has(m.method)) { waiters.get(m.method)(m.params); waiters.delete(m.method) }
    if (m.method === 'Runtime.bindingCalled' && m.params.name === '__pangramSend') {
      const { hash, text } = JSON.parse(m.params.payload)
      if (!ready) return apply(hash, { label: '?', pct: null }) // no key (pangram) — dry run, don't poison the cache
      if (store[hash]) {
        console.log(`cached  ${hash}: ${store[hash].label} ${store[hash].pct}% — "${text.slice(0, 60).replace(/\n/g, ' ')}…"`)
        return apply(hash, store[hash])
      }
      if (inflight.has(hash)) return
      inflight.add(hash)
      console.log(`scoring ${hash} (${wordCount(text)} words): "${text.slice(0, 60).replace(/\n/g, ' ')}…"`)
      try {
        store[hash] = await score(text)
        saveCache()
        console.log(`      → ${hash}: ${store[hash].label} · ${store[hash].pct}% AI`)
        apply(hash, store[hash])
      } catch (e) {
        console.error(`      ✗ ${hash}: ${e.message}`)
        apply(hash, { label: '?', pct: null })
      } finally {
        inflight.delete(hash)
      }
    }
  })

  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws connect failed'))) })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Runtime.addBinding', { name: '__pangramSend' })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PAYLOAD }) // survives reloads

  const stale = await evalJson(
    `!!((window.__pangramInstalled && !window.__pangramV) || (window.__pangramV && window.__pangramV !== ${VERSION}))`)
  if (stale) {
    console.log(`stale tagger found in page — reloading the ${P.name} window once to refresh it`)
    await send('Page.reload')
    await new Promise(res => waiters.set('Page.loadEventFired', res))
    await new Promise(res => setTimeout(res, 5000))
  } else {
    await send('Runtime.evaluate', { expression: PAYLOAD })
  }
  const info = await evalJson(`(() => {
    const els = [...document.querySelectorAll('${P.msgSelector}')];
    return { msgs: els.length, over50: els.filter(e => (e.innerText || '').trim().split(/\\s+/).length > 50).length };
  })()`)
  console.log(`attached: "${target.title}" — ${info.msgs} messages in view, ${info.over50} over 50 words. Watching…`)
  ws.addEventListener('close', () => { console.log(`${P.name} window closed — rerun me when ${P.name} is back.`); process.exit(0) })
}



const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json()).catch(() => null)
const pages = targets?.filter(t => t.type === 'page' && t.url.includes(P.urlMatch)) ?? []
if (!pages.length) {
  console.error(
    `No ${P.name} debug target on port ${PORT}. Quit ${P.name} and relaunch it with:\n` +
    `  osascript -e 'quit app "${P.name}"'; sleep 2; open -a ${P.name} --args --remote-debugging-port=${PORT}\n` +
    `then rerun this script.`)
  process.exit(1)
}
console.log(`platform: ${P.name}`)
console.log(SCORER === 'editlens' ? `scorer: EditLens (local, ${EDITLENS_URL})` : 'scorer: Pangram (cloud API)')
if (!ready) console.warn('PANGRAM_API_KEY not set — dry run, everything gets a gray "?" badge. (Or set SCORER=editlens for the local model.)')
for (const t of pages) attach(t).catch(e => console.error(`attach "${t.title}" failed:`, e.message))
