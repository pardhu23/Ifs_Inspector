'use strict';

// ─── Storage keys ────────────────────────────────────────────────────────────
const LS_HIDDEN     = 'ioi_hidden';
const LS_MODE       = 'ioi_mode';
const LS_HIDE_NULL  = 'ioi_hide_null_indent';
const LS_LOG_HIDDEN = 'ioi_log_hidden';
const LS_REQ_HIDDEN = 'ioi_req_hidden';
const LS_CLIPBOARD  = 'ioi_clipboard_history';

// Default URL patterns to exclude from the request sidebar list.
// Each entry is a substring matched case-insensitively against the full request URL.
const DEFAULT_REQ_HIDDEN = [
    '/main/ifsapplications/projection/v1/FrameworkServices.svc/',
    '/main/ifsapplications/projection/v1/UserProfileService.svc/',
    '/main/ifsapplications/projection/v1/RemoteAssistanceHandling.svc/',
    '/main/ifsapplications/projection/v1/ClientContext.svc/',
    '/main/ifsapplications/projection/v1/StreamSubscriptions.svc/',
    '/main/ifsapplications/projection/v1/AppearanceConfiguration.svc/',
    '/main/ifsapplications/projection/v1/ClientNavigator.svc/',
    '/main/ifsapplications/projection/v1/BookmarkService.svc/',
    '/main/ifsapplications/projection/v1/GetPartyTypeWidgetInfo.svc/',
    '/main/ifsapplications/web/locales/cldr-data/',
    'https://edge.eu1.fullstory.com/',
    'https://rs.eu1.fullstory.com/',
    'data:image/',
    '/main/ifsapplications/extensions/imageresize/',
    '/main/ifsapplications/web/media/',
    '/main/ifsapplications/web/images/',
    '/web/server/metadata/cpi/ResolveBrandingContext',
    '/web/server/metadata/cpi/ResolveConfigurationContext',
    '/main/ifsapplications/web/manifest.json',
    '/main/ifsapplications/web/favicon.png',
    '/main/ifsapplications/projection/v1/Translations.svc/',
    '/main/ifsapplications/web/style/fonts/',
];

const DEFAULT_HIDDEN = [
    'Domain_API.',
    'Language_Code_API.',
    'Fnd_Setting_API.',
    'Assert_API.',
    'Login_SYS',
    'Fnd_Proj_Action_Grant_API',
    'Foundation User',
    'Current Language Code',
    'Language Code',
    'Checking CUD security for',
    'Checking security for',
    'Context:',
    'Calendar:',
];

const DEFAULT_LOG_HIDDEN = [
    'Reading batch requests from old attribute \'ifs-trace\'',
    'Session timeout is set to',
    'Theme \'Light\' successfully loaded',
];


// ─── State ────────────────────────────────────────────────────────────────────
let requests     = [];
let selected     = null;
let paused       = false;
let filterText   = '';
let filterMethod = 'ALL';
let hiddenPats   = loadHidden();
let viewMode     = localStorage.getItem(LS_MODE) || 'compact';
let hideNullIndent = localStorage.getItem(LS_HIDE_NULL) === null ? true : localStorage.getItem(LS_HIDE_NULL) === 'true';
let reqHiddenPats = loadReqHidden();

// ─── Client Logs global store ─────────────────────────────────────────────────
// Flat list of every normalised log entry for the session.
// Shown in the consolidated Client Logs view; deduped by content key.
const globalClientLogs = [];
const seenLogKeys      = new Set();

// Ingest raw log entries from a hook snapshot, dedup by content key, store with timeMs.
function addNewLogs(rawLogs) {
    let added = false;
    for (const raw of rawLogs) {
        const d   = (raw && raw.data) ? raw.data : (raw || {});
        const key = `${d.time}|${d.severity}|${d.message}`;
        if (seenLogKeys.has(key)) continue;
        seenLogKeys.add(key);
        const isoTime = d.time ? String(d.time) : '';
        globalClientLogs.push({
            timeMs:   isoTime ? (new Date(isoTime).getTime() || 0) : 0,
            time:     isoTime.includes('T') ? isoTime.split('T')[1].replace('Z', '') : isoTime,
            severity: String(d.severity || 'Info'),
            message:  String(d.message  || ''),
            object:   d.object || null,
        });
        added = true;
    }
    return added;
}

// ─── Clipboard history store ──────────────────────────────────────────────────
// Every time IFS's "Copy Selected Rows" grid action fires, it overwrites a single
// localStorage key on the page with the new selection — no history, no editing.
// We capture each write (via the page-side hook, see inject-hook.js) and keep a
// capped history here so the user can browse, edit, and re-push an old selection.
const CLIPBOARD_HISTORY_MAX = 50;
let clipboardHistory = loadClipboardHistory();
let clipboardSelectedId = clipboardHistory.length ? clipboardHistory[0].id : null;
let clipboardDraftRows = null; // working copy while editing the selected entry

function loadClipboardHistory() {
    try { return JSON.parse(localStorage.getItem(LS_CLIPBOARD)) || []; }
    catch (e) { return []; }
}
function saveClipboardHistory() {
    try { localStorage.setItem(LS_CLIPBOARD, JSON.stringify(clipboardHistory)); }
    catch (e) { /* storage quota or disabled — history just won't persist across reloads */ }
}

// Ingest one clipboard snapshot from the hook. Skips exact-duplicate consecutive
// copies (e.g. re-render noise) by comparing raw JSON to the most recent entry.
function addClipboardSnapshot(payload) {
    const rows = (payload && payload.rows) || [];
    if (!Array.isArray(rows) || !rows.length) return false;

    const raw = payload.raw || JSON.stringify(rows);
    if (clipboardHistory.length && clipboardHistory[0].raw === raw) return false;

    const entry = {
        id:    (payload.ts || Date.now()) + '-' + Math.random().toString(36).slice(2, 7),
        ts:    payload.ts || Date.now(),
        rows:  rows,
        raw:   raw,
        page:  payload.page || null,
        url:   payload.url  || null,
    };
    clipboardHistory.unshift(entry);
    if (clipboardHistory.length > CLIPBOARD_HISTORY_MAX) clipboardHistory.length = CLIPBOARD_HISTORY_MAX;
    saveClipboardHistory();
    clipboardSelectedId = entry.id;
    clipboardDraftRows = null; // reset any in-progress edit to show the fresh copy
    return true;
}

// ── Debounce + RAF render scheduling ─────────────────────────────────────────
// Prevents layout thrash and jank when many events fire rapidly.
function debounce(fn, ms) {
    let t; return function(...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
}
// Schedule a render on the next animation frame; coalesces multiple calls.
const rafSchedule = (() => {
    const pending = new Map();
    return function(key, fn) {
        if (!pending.has(key)) {
            pending.set(key, requestAnimationFrame(() => { pending.delete(key); fn(); }));
        }
    };
})();

// ── Hidden pattern fast-match: compile once into a single RegExp ─────────────
// O(1) per test instead of O(n patterns) — huge speedup for large traces.
let hiddenRegex  = buildHiddenRegex(hiddenPats);
function buildHiddenRegex(pats) {
    const valid = pats.filter(Boolean);
    if (!valid.length) return null;
    return new RegExp(valid.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
}
function isHiddenEntry(text) {
    return hiddenRegex ? hiddenRegex.test(text || '') : false;
}

function loadHidden() {
    try { return JSON.parse(localStorage.getItem(LS_HIDDEN)) || DEFAULT_HIDDEN.slice(); }
    catch { return DEFAULT_HIDDEN.slice(); }
}
function saveHidden() {
    localStorage.setItem(LS_HIDDEN, JSON.stringify(hiddenPats));
    hiddenRegex = buildHiddenRegex(hiddenPats);   // recompile on every change
}

// ── Request URL exclude list ──────────────────────────────────────────────────
let reqHiddenRegex = buildHiddenRegex(reqHiddenPats);

function loadReqHidden() {
    try { return JSON.parse(localStorage.getItem(LS_REQ_HIDDEN)) || DEFAULT_REQ_HIDDEN.slice(); }
    catch { return DEFAULT_REQ_HIDDEN.slice(); }
}
function saveReqHidden() {
    localStorage.setItem(LS_REQ_HIDDEN, JSON.stringify(reqHiddenPats));
    reqHiddenRegex = buildHiddenRegex(reqHiddenPats);
}
function isReqHidden(url) {
    return reqHiddenRegex ? reqHiddenRegex.test(url || '') : false;
}

// ── Client Log hidden-message patterns ───────────────────────────────────────
let logHiddenPats  = loadLogHidden();
let logHiddenRegex = buildHiddenRegex(logHiddenPats);

function loadLogHidden() {
    try { return JSON.parse(localStorage.getItem(LS_LOG_HIDDEN)) || DEFAULT_LOG_HIDDEN.slice(); }
    catch { return DEFAULT_LOG_HIDDEN.slice(); }
}
function saveLogHidden() {
    localStorage.setItem(LS_LOG_HIDDEN, JSON.stringify(logHiddenPats));
    logHiddenRegex = buildHiddenRegex(logHiddenPats);
}
function isLogHidden(text) {
    return logHiddenRegex ? logHiddenRegex.test(text || '') : false;
}

// ─── Port ─────────────────────────────────────────────────────────────────────
let devtoolsPort = null; // our end (port1) — used to send messages back to devtools.js
window.connectDevtools = function() {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => handleMessage(event.data);
    devtoolsPort = channel.port1;
    return channel.port2;
};

// ── Hook event buffer ─────────────────────────────────────────────────────────
// Hook events (Path B) may arrive slightly before or after the HAR entry (Path A)
// for the same request. We buffer up to 200 recent hook payloads and merge them
// when a matching HAR entry arrives (matched by storeContext URL or timing).
const hookBuffer = [];
const HOOK_BUFFER_MAX = 200;

function bufferHookEvent(hookPayload) {
    hookBuffer.push({ ts: Date.now(), hookPayload });
    if (hookBuffer.length > HOOK_BUFFER_MAX) hookBuffer.shift();
}

// Try to find and remove the best-matching buffered hook event for a HAR entry.
// Matching strategy: the storeContext inside hookPayload.data often contains
// the request URL or a service name that appears in the HAR URL.
function drainHookEvent(url) {
    if (!hookBuffer.length) return null;
    // Prefer an entry whose hookPayload.data contains any path segment of url
    let best = -1, bestScore = 0;
    const urlLower = url.toLowerCase();
    for (let i = 0; i < hookBuffer.length; i++) {
        const hp = hookBuffer[i].hookPayload;
        const ctx = (hp.storeContext || '').toLowerCase();
        const dataUrl = (hp.data && (hp.data.url || hp.data.requestUrl || '')).toLowerCase();
        let score = 0;
        if (ctx && urlLower.includes(ctx)) score += 2;
        if (dataUrl && urlLower.includes(dataUrl)) score += 3;
        // Fallback: take the most-recently buffered entry (LIFO) within 3 s
        if (score === 0 && (Date.now() - hookBuffer[i].ts) < 3000) score = 1;
        if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) return null;
    return hookBuffer.splice(best, 1)[0].hookPayload;
}

function handleMessage(msg) {

    // ── Coexistence notice (not affected by pause) ────────────────────────────
    if (msg.type === 'IFS_COEXIST_WARNING') {
        showCoexistBanner();
        return;
    }

    // ── Clipboard snapshot (not affected by pause — separate from trace capture) ─
    if (msg.type === 'IFS_HOOK_EVENT' && msg.hookPayload && msg.hookPayload.type === 'clipboard') {
        if (addClipboardSnapshot(msg.hookPayload.data)) renderClipboardView();
        return;
    }

    // ── Ack for a restore-to-page request (see requestRestoreClipboard) ───────
    if (msg.type === 'RESTORE_CLIPBOARD_RESULT') {
        onRestoreClipboardResult(msg);
        return;
    }

    if (paused) return;

    // ── Path B: hook event ────────────────────────────────────────────────────
    if (msg.type === 'IFS_HOOK_EVENT') {
        const hp = msg.hookPayload;
        // Client log events carry the full cumulative store snapshot — ingest new entries.
        if (hp.type === 'client logs') {
            const rawLogs = (hp.data && hp.data.data && hp.data.data.logs) || [];
            if (addNewLogs(rawLogs)) renderClientLogs();
            return;
        }
        // Try to attach to an existing HAR entry that has no hook data yet
        const req = requests.slice().reverse().find(r =>
            !r._hookMerged &&
            hp.storeContext && r.url.toLowerCase().includes((hp.storeContext || '').toLowerCase())
        );
        if (req) {
            mergeHookData(req, hp);
        } else {
            bufferHookEvent(hp);
        }
        return;
    }

    // ── Path A: HAR entry ─────────────────────────────────────────────────────
    if (msg.type !== 'IFS_REQUEST') return;
    const har  = msg.request;
    const url  = har.request.url;
    try { const p = new URL(url).pathname; if (p.endsWith('.js') || p.endsWith('.js.map')) return; } catch {}

    const data     = msg.data;
    const name     = extractName(url);
    const method   = har.request.method || 'GET';
    const status   = har.response.status;
    const duration = har.time;

    const id = Date.now() + Math.random();
    const entry = { id, url, name, method, status, duration, har, data,
                    _hookMerged: false };

    // Immediately try to merge any buffered hook event for this URL
    const buffered = drainHookEvent(url);
    if (buffered) mergeHookData(entry, buffered);

    requests.push(entry);
    renderSidebar();
    if (requests.length === 1) selectRequest(id);
}

// Merge hook payload into an existing request entry.
// Hook data has the rich server-side fields the HAR body alone may not contain.
function mergeHookData(entry, hookPayload) {
    entry._hookMerged = true;
    const hookData = hookPayload.data || {};
    // Deep-merge: hook data wins over HAR-parsed data for server/trace fields
    entry.data = Object.assign({}, entry.data || {}, hookData, {
        // Always keep any HAR-parsed top-level fields that hook data doesn't have
        ...(entry.data && !hookData.response ? { response: entry.data.response } : {}),
    });
    // Re-render the detail pane if this entry is currently selected
    if (selected === entry.id) selectRequest(entry.id);
}

// Legacy alias — keeps any external callers working
function handleRequest(msg) { handleMessage(msg); }

// ════════════════════════════════════════════════════════════════════════════
// CLIENT LOGS — consolidated global view
// ════════════════════════════════════════════════════════════════════════════
let logSearchText = '';
let logSevFilter  = 'ALL';

// Detect special log line types for colour coding.
function getLogType(msg) {
    if (/^POST:/i.test(msg))   return 'post';
    if (/^PATCH:/i.test(msg))  return 'patch';
    if (/^DELETE:/i.test(msg)) return 'delete';
    if (/^PUT:/i.test(msg))    return 'put';
    if (/^GET:/i.test(msg))    return 'get';
    if (/^CRUD\b/i.test(msg))  return 'crud';
    return null;
}

// Strip the standard IFS Cloud path prefix from full URLs, keep only the API-specific tail.
// e.g. "https://…/main/ifsapplications/projection/v1/RequestHandling.svc/Foo(Bar='1')"
//   → "RequestHandling.svc/Foo(Bar='1')"
// If the value is already a short path it is returned as-is.
function extractUrlHint(raw) {
    if (!raw) return '';
    const m = raw.match(/\/main\/ifsapplications\/(?:projection\/v\d+|web)\/(.+)/);
    return m ? m[1] : raw;
}

// JSON syntax highlighter — returns HTML string safe to set via innerHTML.
function highlightJson(str) {
    // Escape first so angle brackets in values don't become tags.
    const safe = str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    return safe.replace(
        /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
        function (match) {
            if (/^"/.test(match)) {
                return /:$/.test(match)
                    ? `<span class="json-key">${match}</span>`
                    : `<span class="json-str">${match}</span>`;
            }
            if (match === 'true' || match === 'false') return `<span class="json-bool">${match}</span>`;
            if (match === 'null')                      return `<span class="json-null">${match}</span>`;
            return `<span class="json-num">${match}</span>`;
        }
    );
}

function renderClientLogs() { rafSchedule('clientLogs', _renderClientLogs); }
function _renderClientLogs() {
    const list    = document.getElementById('log-list');
    const listD   = document.getElementById('log-list-docked');
    const countEl = document.getElementById('log-count');
    const countElD= document.getElementById('log-count-docked');
    const badge   = document.getElementById('log-count-badge');
    const badgeD  = document.getElementById('log-count-badge-docked');

    const s   = logSearchText.toLowerCase();
    const sev = logSevFilter;
    const filtered = globalClientLogs.filter(l => {
        if (isLogHidden(l.message)) return false;
        const sevOk = sev === 'ALL' || l.severity.toLowerCase() === sev.toLowerCase();
        const txtOk = !s || l.message.toLowerCase().includes(s);
        return sevOk && txtOk;
    });
    const hiddenCount = globalClientLogs.length - globalClientLogs.filter(l => !isLogHidden(l.message)).length;
    const countText = `${filtered.length} of ${globalClientLogs.length} log${globalClientLogs.length !== 1 ? 's' : ''}` +
        (hiddenCount ? ` (${hiddenCount} hidden)` : '');
    if (countEl) countEl.textContent = countText;
    if (countElD) countElD.textContent = countText;

    const badgeVal = globalClientLogs.length > 0 ? String(globalClientLogs.length) : '';
    if (badge) badge.textContent = badgeVal;
    if (badgeD) badgeD.textContent = badgeVal;

    function populateList(target) {
        if (!target) return;
        target.innerHTML = '';
        if (!filtered.length) {
            const empty = el('div', 'class=log-empty');
            empty.textContent = globalClientLogs.length ? 'No logs match the filter.' : 'No client logs captured yet.';
            target.appendChild(empty);
            return;
        }
        filtered.forEach(log => {
            const sv      = log.severity.toLowerCase();
            const logType = getLogType(log.message);
            const hasObj  = log.object && typeof log.object === 'object' && Object.keys(log.object).length > 0;

            let urlHint = '';
            if (logType && hasObj) {
                const o = log.object;
                urlHint = extractUrlHint(o.url || o.baseUrl || o.datasource || '');
            }

            const rowEl = document.createElement('div');
            rowEl.className = `log-row log-sev-${sv}${logType ? ' log-type-' + logType : ''}`;

            rowEl.innerHTML =
                `<span class="log-time">${esc(log.time)}</span>` +
                `<span class="log-sev-badge sev-${sv}">${esc(log.severity)}</span>` +
                `<span class="log-message">${esc(log.message)}` +
                (urlHint ? `<span class="log-url-hint">${esc(urlHint)}</span>` : '') +
                `</span>` +
                (hasObj ? `<span class="log-expand-icon">▶</span>` : '');

            if (hasObj) {
                const copyBtn = document.createElement('button');
                copyBtn.className = 'log-copy-btn';
                copyBtn.title = 'Copy JSON';
                copyBtn.innerHTML =
                    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                    '<rect x="9" y="9" width="13" height="13" rx="2"/>' +
                    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
                    '</svg>';
                copyBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    const text = JSON.stringify(log.object, null, 2);
                    navigator.clipboard.writeText(text).then(() => {
                        copyBtn.classList.add('copied');
                        setTimeout(() => copyBtn.classList.remove('copied'), 1500);
                    }).catch(() => {
                        const ta = document.createElement('textarea');
                        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
                        document.body.appendChild(ta); ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                        copyBtn.classList.add('copied');
                        setTimeout(() => copyBtn.classList.remove('copied'), 1500);
                    });
                });
                rowEl.appendChild(copyBtn);

                const detail = el('div', 'class=log-detail');
                detail.style.display = 'none';
                try {
                    detail.innerHTML = highlightJson(JSON.stringify(log.object, null, 2));
                } catch (e) {
                    detail.textContent = JSON.stringify(log.object, null, 2);
                }
                rowEl.appendChild(detail);
                rowEl.style.cursor = 'pointer';
                rowEl.addEventListener('click', () => {
                    const open = detail.style.display !== 'none';
                    detail.style.display = open ? 'none' : 'block';
                    const icon = rowEl.querySelector('.log-expand-icon');
                    if (icon) icon.textContent = open ? '▶' : '▼';
                });
            }
            target.appendChild(rowEl);
        });
    }

    populateList(list);
    populateList(listD);
}

function initClientLogsView() {
    // ── Side panel controls ──────────────────────────────────────────────────
    const search = document.getElementById('log-search');
    const sevSel = document.getElementById('log-sev');
    const cogBtn = document.getElementById('log-cog-btn');
    const sidePanel = document.getElementById('client-logs-panel');

    const sp = buildLogSettingsPanel(renderClientLogs);
    sp.className = 'log-settings-panel';
    sp.style.display = 'none';
    if (sidePanel) sidePanel.insertBefore(sp, document.getElementById('log-list'));

    if (cogBtn) {
        cogBtn.addEventListener('click', e => {
            e.stopPropagation();
            sp.style.display = sp.style.display === 'none' ? 'block' : 'none';
        });
    }

    // ── Docked panel controls ────────────────────────────────────────────────
    const searchD = document.getElementById('log-search-docked');
    const sevSelD = document.getElementById('log-sev-docked');
    const cogBtnD = document.getElementById('log-cog-btn-docked');
    const dockedPanel2 = document.getElementById('client-logs-docked');

    const spD = buildLogSettingsPanel(renderClientLogs);
    spD.className = 'log-settings-panel';
    spD.style.display = 'none';
    if (dockedPanel2) dockedPanel2.insertBefore(spD, document.getElementById('log-list-docked'));

    if (cogBtnD) {
        cogBtnD.addEventListener('click', e => {
            e.stopPropagation();
            spD.style.display = spD.style.display === 'none' ? 'block' : 'none';
        });
    }

    document.addEventListener('click', () => { sp.style.display = 'none'; spD.style.display = 'none'; });
    sp.addEventListener('click', e => e.stopPropagation());
    spD.addEventListener('click', e => e.stopPropagation());

    if (search) search.addEventListener('input', debounce(() => { logSearchText = search.value; renderClientLogs(); }, 60));
    if (searchD) searchD.addEventListener('input', debounce(() => { logSearchText = searchD.value; renderClientLogs(); }, 60));

    renderClientLogs();
}

// ── View switching (Requests ↔ Client Logs ↔ Clipboard) ──────────────────────
document.querySelectorAll('.view-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        document.querySelectorAll('.view-tab').forEach(b => b.classList.toggle('active', b === btn));
        const appEl = document.getElementById('app');
        const logsEl = document.getElementById('view-client-logs'); // legacy, no longer a real tab
        const clipEl = document.getElementById('view-clipboard');
        if (appEl)  appEl.style.display  = view === 'requests'  ? 'flex' : 'none';
        if (logsEl) logsEl.style.display = view === 'logs'      ? 'flex' : 'none';
        if (clipEl) clipEl.style.display = view === 'clipboard' ? 'flex' : 'none';
        if (view === 'logs') renderClientLogs();
        if (view === 'clipboard') renderClipboardView();
    });
});

function buildLogSettingsPanel(onRebuild) {
    const panel = document.createElement('div');

    function refresh() {
        panel.innerHTML = `
        <h4>Hidden Message Patterns</h4>
        <p>Log entries whose message matches any pattern are suppressed.</p>
        <div class="pat-list">${logHiddenPats.map((p, i) =>
            `<div class="pat-row">
                <label title="${esc(p)}">${esc(p)}</label>
                <button class="pat-del" data-i="${i}">✕</button>
            </div>`
        ).join('')}</div>
        <div class="pat-add">
            <input id="log-pat-input" type="text" placeholder="e.g. [Bootstrap]">
            <button id="log-pat-add-btn">Add</button>
        </div>
        <button class="pat-reset" id="log-pat-reset">Reset to defaults</button>`;

        panel.querySelectorAll('.pat-del').forEach(b => b.addEventListener('click', () => {
            logHiddenPats.splice(+b.dataset.i, 1); saveLogHidden(); refresh(); onRebuild();
        }));
        panel.querySelector('#log-pat-add-btn').addEventListener('click', () => {
            const v = panel.querySelector('#log-pat-input').value.trim();
            if (v && !logHiddenPats.includes(v)) { logHiddenPats.push(v); saveLogHidden(); refresh(); onRebuild(); }
        });
        panel.querySelector('#log-pat-input').addEventListener('keydown', e => {
            if (e.key === 'Enter') panel.querySelector('#log-pat-add-btn').click();
        });
        panel.querySelector('#log-pat-reset').addEventListener('click', () => {
            logHiddenPats = DEFAULT_LOG_HIDDEN.slice(); saveLogHidden(); refresh(); onRebuild();
        });
    }

    refresh(); return panel;
}

// ── Request URL exclude-list settings panel ───────────────────────────────────
function buildReqHiddenPanel() {
    const panel = document.createElement('div');

    function refresh() {
        panel.innerHTML = `
        <h4>Excluded URL Patterns</h4>
        <p>Requests whose URL contains any pattern below are hidden from the list.</p>
        <div class="pat-list">${reqHiddenPats.map((p, i) =>
            `<div class="pat-row">
                <label title="${esc(p)}">${esc(p)}</label>
                <button class="pat-del" data-i="${i}">✕</button>
            </div>`
        ).join('')}</div>
        <div class="pat-add">
            <input id="req-pat-input" type="text" placeholder="e.g. /locales/cldr-data/">
            <button id="req-pat-add-btn">Add</button>
        </div>
        <button class="pat-reset" id="req-pat-reset">Reset to defaults</button>`;

        panel.querySelectorAll('.pat-del').forEach(b => b.addEventListener('click', () => {
            reqHiddenPats.splice(+b.dataset.i, 1); saveReqHidden(); refresh(); renderSidebar();
        }));
        panel.querySelector('#req-pat-add-btn').addEventListener('click', () => {
            const v = panel.querySelector('#req-pat-input').value.trim();
            if (v && !reqHiddenPats.includes(v)) { reqHiddenPats.push(v); saveReqHidden(); refresh(); renderSidebar(); }
        });
        panel.querySelector('#req-pat-input').addEventListener('keydown', e => {
            if (e.key === 'Enter') panel.querySelector('#req-pat-add-btn').click();
        });
        panel.querySelector('#req-pat-reset').addEventListener('click', () => {
            reqHiddenPats = DEFAULT_REQ_HIDDEN.slice(); saveReqHidden(); refresh(); renderSidebar();
        });
    }

    refresh(); return panel;
}

// ─── Clipboard History view ───────────────────────────────────────────────────
// Renders the history list (left) + editable row grid (right) for whatever
// entry is currently selected, and wires up restore/edit/delete actions.
// The schema (which columns exist) is derived from the entry's own rows, since
// different IFS list pages copy different shapes (Contact Roles vs. others).

let clipboardRestoreSeq = 0;
const clipboardPendingRestores = new Map(); // requestId → callback

function requestRestoreClipboard(rows, onDone) {
    if (!devtoolsPort) { onDone && onDone(false, 'DevTools port not connected'); return; }
    const requestId = 'restore-' + (++clipboardRestoreSeq);
    clipboardPendingRestores.set(requestId, onDone);
    devtoolsPort.postMessage({ type: 'RESTORE_CLIPBOARD', rows, requestId });
}

function onRestoreClipboardResult(msg) {
    const cb = clipboardPendingRestores.get(msg.requestId);
    clipboardPendingRestores.delete(msg.requestId);
    if (cb) cb(!!msg.ok);
}

function renderClipboardView() { rafSchedule('clipboard', _renderClipboardView); }

function _renderClipboardView() {
    const root = document.getElementById('view-clipboard');
    if (!root) return;

    if (!clipboardHistory.length) {
        root.innerHTML = `
        <div class="clip-empty">
            <div class="empty-icon">⧉</div>
            <div class="empty-title">No copied rows yet</div>
            <div class="empty-sub">Use "Copy Selected Rows" or "Copy Data Link" on any IFS list page — captures appear here automatically, even across page reloads.</div>
            <button id="clip-import-empty" class="clip-import-btn">Import History…</button>
            <input type="file" id="clip-import-file" accept="application/json,.json" style="display:none">
        </div>`;
        wireClipboardImportExport(root);
        return;
    }

    if (!clipboardHistory.find(e => e.id === clipboardSelectedId)) {
        clipboardSelectedId = clipboardHistory[0].id;
        clipboardDraftRows = null;
    }
    const entry = clipboardHistory.find(e => e.id === clipboardSelectedId);
    const rows  = clipboardDraftRows || entry.rows;
    const dirty = !!clipboardDraftRows;

    // Column set: union of keys across the entry's rows, in first-seen order.
    const cols = [];
    rows.forEach(r => Object.keys(r || {}).forEach(k => { if (!cols.includes(k)) cols.push(k); }));

    root.innerHTML = `
    <div id="clip-history-list">
        <div id="clip-history-hdr">
            <span id="clip-history-hdr-label">History (${clipboardHistory.length})</span>
            <span id="clip-history-hdr-spacer"></span>
            <button id="clip-export-btn" title="Download all history as a JSON file">Export</button>
            <button id="clip-import-btn" title="Import history from a JSON file (merges, doesn't replace)">Import</button>
            <input type="file" id="clip-import-file" accept="application/json,.json" style="display:none">
        </div>
        <div id="clip-history-items">${clipboardHistory.map(e => `
            <div class="clip-hist-item${e.id === clipboardSelectedId ? ' active' : ''}" data-id="${e.id}">
                ${e.page ? `<div class="clip-hist-page">${esc(e.page)}</div>` : ''}
                <div class="clip-hist-time">${new Date(e.ts).toLocaleTimeString()}</div>
                <div class="clip-hist-count">${e.rows.length} row${e.rows.length === 1 ? '' : 's'}</div>
                <div class="clip-hist-preview">${esc(clipRowPreview(e.rows[0]))}${e.rows.length > 1 ? ' …' : ''}</div>
                <div class="clip-hist-actions">
                    <button class="clip-hist-export" data-id="${e.id}" title="Export this entry as a JSON file">⤓</button>
                    <button class="clip-hist-del" data-id="${e.id}" title="Delete this entry">✕</button>
                </div>
            </div>`).join('')}
        </div>
    </div>
    <div id="clip-editor">
        <div id="clip-editor-toolbar">
            <span id="clip-editor-title">${entry.page ? esc(entry.page) + ' · ' : ''}${rows.length} row${rows.length === 1 ? '' : 's'}${dirty ? ' · edited' : ''}</span>
            <span id="clip-editor-spacer"></span>
            <button id="clip-add-row" title="Add a blank row">+ Row</button>
            <button id="clip-revert" ${dirty ? '' : 'disabled'} title="Discard edits, revert to captured copy">Revert</button>
            <button id="clip-export-entry" title="Export this entry as a JSON file (includes unsaved edits)">Export</button>
            <button id="clip-restore" title="Write this back into the page so IFS's Paste Rows uses it">↩ Restore to Page</button>
        </div>
        <div id="clip-grid-wrap">
            <table id="clip-grid">
                <thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}<th class="clip-col-actions"></th></tr></thead>
                <tbody>${rows.map((r, ri) => `
                    <tr data-ri="${ri}">${cols.map(c => `
                        <td><input type="text" data-ri="${ri}" data-col="${esc(c)}" value="${esc(r[c] == null ? '' : r[c])}"></td>
                    `).join('')}<td class="clip-col-actions">
                        <button class="clip-row-dup" data-ri="${ri}" title="Duplicate row">⧉</button>
                        <button class="clip-row-del" data-ri="${ri}" title="Delete row">✕</button>
                    </td></tr>`).join('')}
                </tbody>
            </table>
        </div>
        <div id="clip-restore-status"></div>
    </div>`;

    wireClipboardImportExport(root);

    // ── History item selection / delete / per-entry export ───────────────────
    root.querySelectorAll('.clip-hist-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.clip-hist-del') || e.target.closest('.clip-hist-export')) return;
            clipboardSelectedId = item.dataset.id;
            clipboardDraftRows = null;
            renderClipboardView();
        });
    });
    root.querySelectorAll('.clip-hist-export').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const entry = clipboardHistory.find(h => h.id === btn.dataset.id);
            if (entry) exportClipboardEntry(entry);
        });
    });
    root.querySelectorAll('.clip-hist-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            clipboardHistory = clipboardHistory.filter(h => h.id !== btn.dataset.id);
            saveClipboardHistory();
            if (clipboardSelectedId === btn.dataset.id) { clipboardSelectedId = null; clipboardDraftRows = null; }
            renderClipboardView();
        });
    });

    // ── Cell edits ─────────────────────────────────────────────────────────────
    root.querySelectorAll('#clip-grid input').forEach(input => {
        input.addEventListener('input', () => {
            const draft = (clipboardDraftRows || rows.map(r => ({ ...r }))).slice();
            draft[input.dataset.ri] = { ...draft[input.dataset.ri], [input.dataset.col]: input.value };
            clipboardDraftRows = draft;
            document.getElementById('clip-revert').disabled = false;
            const title = document.getElementById('clip-editor-title');
            if (title && !title.textContent.includes('edited')) title.textContent += ' · edited';
        });
    });

    // ── Row add / duplicate / delete ──────────────────────────────────────────
    const btnAdd = document.getElementById('clip-add-row');
    if (btnAdd) btnAdd.addEventListener('click', () => {
        const draft = (clipboardDraftRows || rows.map(r => ({ ...r }))).slice();
        const blank = {}; cols.forEach(c => blank[c] = '');
        draft.push(blank);
        clipboardDraftRows = draft;
        renderClipboardView();
    });
    root.querySelectorAll('.clip-row-dup').forEach(btn => {
        btn.addEventListener('click', () => {
            const draft = (clipboardDraftRows || rows.map(r => ({ ...r }))).slice();
            draft.splice(+btn.dataset.ri + 1, 0, { ...draft[+btn.dataset.ri] });
            clipboardDraftRows = draft;
            renderClipboardView();
        });
    });
    root.querySelectorAll('.clip-row-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const draft = (clipboardDraftRows || rows.map(r => ({ ...r }))).slice();
            draft.splice(+btn.dataset.ri, 1);
            clipboardDraftRows = draft;
            renderClipboardView();
        });
    });

    // ── Revert / Restore / Export this entry ──────────────────────────────────
    const btnRevert = document.getElementById('clip-revert');
    if (btnRevert) btnRevert.addEventListener('click', () => { clipboardDraftRows = null; renderClipboardView(); });

    const btnExportEntry = document.getElementById('clip-export-entry');
    if (btnExportEntry) btnExportEntry.addEventListener('click', () => {
        exportClipboardEntry({ ...entry, rows: clipboardDraftRows || entry.rows });
    });

    const btnRestore = document.getElementById('clip-restore');
    const status = document.getElementById('clip-restore-status');
    if (btnRestore) btnRestore.addEventListener('click', () => {
        const finalRows = clipboardDraftRows || rows;
        btnRestore.disabled = true;
        status.textContent = 'Restoring…';
        requestRestoreClipboard(finalRows, (ok, err) => {
            btnRestore.disabled = false;
            status.textContent = ok
                ? '✓ Restored — go to IFS and use Paste Rows.'
                : ('✗ Failed to restore' + (err ? ': ' + err : ''));
            status.className = ok ? 'clip-status-ok' : 'clip-status-err';
            if (ok) setTimeout(() => { if (status) status.textContent = ''; }, 4000);
        });
    });
}

// ── Export / Import ────────────────────────────────────────────────────────────
// Export: download the full history (as currently stored, including any
// draft-less committed edits) as a single JSON file the user can archive or
// move to another machine. Import: merge entries from a chosen file into the
// existing history, deduped by raw JSON (same rule live captures use), so
// importing is additive and never silently wipes what's already there.

function wireClipboardImportExport(root) {
    const exportBtn = root.querySelector('#clip-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', exportClipboardHistory);

    const fileInput = root.querySelector('#clip-import-file');
    const importBtn = root.querySelector('#clip-import-btn') || root.querySelector('#clip-import-empty');
    if (importBtn && fileInput) {
        importBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (file) importClipboardHistoryFromFile(file);
            fileInput.value = ''; // allow re-selecting the same file later
        });
    }
}

// Shared file-download mechanics for both whole-history and single-entry export.
function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function exportClipboardHistory() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadJson({
        exportedFrom: 'IFS Inspector — Clipboard History',
        exportedAt:   new Date().toISOString(),
        entries:      clipboardHistory,
    }, `ifs-clipboard-history_${stamp}.json`);
}

// Export a single history entry (or an entry-shaped object built from the
// currently-open draft rows) as its own importable JSON file.
function exportClipboardEntry(entry) {
    const stamp = new Date(entry.ts || Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const pageSlug = (entry.page || 'clipboard').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'clipboard';
    downloadJson({
        exportedFrom: 'IFS Inspector — Clipboard History',
        exportedAt:   new Date().toISOString(),
        entries:      [{
            id:   entry.id,
            ts:   entry.ts,
            rows: entry.rows,
            raw:  JSON.stringify(entry.rows), // recompute in case rows were edited since capture
            page: entry.page || null,
            url:  entry.url  || null,
        }],
    }, `ifs-clipboard_${pageSlug}_${stamp}.json`);
}

function importClipboardHistoryFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
        let parsed;
        try { parsed = JSON.parse(reader.result); }
        catch (e) { alert('Import failed: file is not valid JSON.'); return; }

        // Accept either our export wrapper ({ entries: [...] }) or a bare array,
        // so files exported by an older version of this feature still import.
        const incoming = Array.isArray(parsed) ? parsed
                        : Array.isArray(parsed && parsed.entries) ? parsed.entries
                        : null;
        if (!incoming) { alert('Import failed: no recognizable history entries found in this file.'); return; }

        const existingRaw = new Set(clipboardHistory.map(e => e.raw));
        let added = 0;
        incoming.forEach(raw => {
            if (!raw || !Array.isArray(raw.rows) || !raw.rows.length) return;
            const rawJson = raw.raw || JSON.stringify(raw.rows);
            if (existingRaw.has(rawJson)) return; // skip duplicates already present
            existingRaw.add(rawJson);
            clipboardHistory.push({
                id:   raw.id || (Date.now() + '-' + Math.random().toString(36).slice(2, 7)),
                ts:   raw.ts || Date.now(),
                rows: raw.rows,
                raw:  rawJson,
                page: raw.page || null,
                url:  raw.url  || null,
            });
            added++;
        });

        if (!added) { alert('Nothing new to import — all entries in this file already exist in your history.'); return; }

        // Newest-first, capped, same as live capture.
        clipboardHistory.sort((a, b) => b.ts - a.ts);
        if (clipboardHistory.length > CLIPBOARD_HISTORY_MAX) clipboardHistory.length = CLIPBOARD_HISTORY_MAX;
        saveClipboardHistory();
        clipboardSelectedId = clipboardHistory[0].id;
        clipboardDraftRows = null;
        renderClipboardView();
    };
    reader.onerror = () => alert('Import failed: could not read the file.');
    reader.readAsText(file);
}


// Short single-line preview of a row for the history list, e.g. "310 · End Customer".
function clipRowPreview(row) {
    if (!row) return '';
    const vals = Object.values(row).filter(v => v !== null && v !== undefined && v !== '');
    return vals.slice(0, 2).join(' · ');
}


function extractName(url) {
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/');
        const svc = parts.find(p => p.includes('.svc'));
        const idx = svc ? parts.indexOf(svc) : -1;
        return idx >= 0 ? parts.slice(idx+1).join('/').split('?')[0] : parts[parts.length-1].split('?')[0];
    } catch { return url.split('/').pop().split('?')[0]; }
}

function speedClass(ms) {
    if (ms > 2000) return 'very-slow';
    if (ms > 500)  return 'slow';
    return '';
}
// ── HAR body helpers (used when debug/hook data is absent) ───────────────────

// Parse the HAR response body text as JSON. Returns the object or null.
function getHarBodyJson(r) {
    try {
        const text = r.har && r.har.response && r.har.response.content && r.har.response.content.text;
        if (!text) return null;
        return typeof text === 'string' ? JSON.parse(text) : text;
    } catch { return null; }
}

// Extract the OData { error: { code, message, details } } object from the HAR body.
function getODataError(r) {
    const body = getHarBodyJson(r);
    if (!body || !body.error) return null;
    const e = body.error;
    if (!e.code && !e.message) return null;
    return e;
}

// Return the canonical exceptions array for a request:
// • Hook data with real exceptions → use those (full stack-trace path, debug enabled).
// • Otherwise synthesise a single exception from the OData error JSON in the HAR body.
function getExceptions(r) {
    const hookExc = r.data && r.data.server && r.data.server.stacktrace && r.data.server.stacktrace.exceptions;
    if (hookExc && hookExc.length) return hookExc;

    const odataErr = getODataError(r);
    if (!odataErr) return null;

    // Build message string: "CODE: top-level message\ndetail1\ndetail2…"
    const parts = [];
    if (odataErr.code)         parts.push(`${odataErr.code}: ${odataErr.message || ''}`);
    else if (odataErr.message) parts.push(odataErr.message);
    (Array.isArray(odataErr.details) ? odataErr.details : []).forEach(d => {
        parts.push((d.code ? `${d.code}: ` : '') + (d.message || ''));
    });

    return [{ class: 'OData Error', message: parts.join('\n'), _isOdata: true, _odataErr: odataErr }];
}

function hasLogicalError(r) {
    if (r.status >= 400) return true;
    const bodyStatus = r.data && r.data.response && r.data.response.status && r.data.response.status.code;
    if (bodyStatus && Number(bodyStatus) >= 400) return true;
    const exc = getExceptions(r);
    if (exc && exc.length > 0) return true;
    return false;
}
function methodBadgeClass(method) {
    const m = (method||'').toUpperCase();
    if (m==='GET')    return 'badge-GET';
    if (m==='POST')   return 'badge-POST';
    if (m==='PUT')    return 'badge-PUT';
    if (m==='PATCH')  return 'badge-PATCH';
    if (m==='DELETE') return 'badge-DELETE';
    return 'badge-OTHER';
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function renderSidebar() { rafSchedule('sidebar', _renderSidebar); }
function _renderSidebar() {
    const list = document.getElementById('request-list');
    const lo = filterText.toLowerCase();
    const filtered = requests.filter(r => {
        if (isReqHidden(r.url)) return false;
        const textOk   = !filterText || r.name.toLowerCase().includes(lo) || r.url.includes(filterText);
        const methodOk = filterMethod === 'ALL' || r.method.toUpperCase() === filterMethod;
        return textOk && methodOk;
    });
    const hiddenCount = requests.filter(r => isReqHidden(r.url)).length;
    document.getElementById('req-count').textContent =
        `${filtered.length} request${filtered.length !== 1 ? 's' : ''}` +
        (hiddenCount ? ` (${hiddenCount} hidden)` : '');

    list.innerHTML = '';

    filtered.slice().reverse().forEach(r => {
        const item = document.createElement('div');
        const sc = speedClass(r.duration);
        item.className = 'req-item' + (r.id===selected?' active':'') + (sc?' '+sc:'');
        item.dataset.id = r.id;

        const top = document.createElement('div'); top.className = 'req-top';
        const badge = document.createElement('span');
        badge.className = 'req-method-badge ' + methodBadgeClass(r.method);
        badge.textContent = r.method==='DELETE' ? 'DEL' : r.method;
        top.appendChild(badge);

        const nameEl = document.createElement('span');
        nameEl.className = 'req-name'; nameEl.title = r.url; nameEl.textContent = r.name;
        top.appendChild(nameEl);

        item.appendChild(top);

        const meta = document.createElement('div'); meta.className = 'req-meta';
        const tc = speedClass(r.duration);
        const isErr = hasLogicalError(r);
        const errBadge = isErr ? `<span class="req-error-badge">Error</span>` : '';
        meta.innerHTML = `<span class="req-status ${isErr?'err':'ok'}">${r.status}</span>` +
            errBadge +
            `<span class="req-time${tc?' '+tc:''}">${fmtMs(r.duration)}</span>`;
        item.appendChild(meta);

        // Flame bar — proportional to max duration in current visible set
        const maxDur = Math.max(...filtered.map(x => x.duration || 0), 1);
        const flamePct = Math.max(3, Math.round((r.duration / maxDur) * 100));
        const flameColor = tc === 'very-slow' ? 'var(--red)' : tc === 'slow' ? 'var(--yellow)' : 'var(--accent)';
        const flameBar = document.createElement('div');
        flameBar.className = 'req-flame-bar';
        flameBar.style.setProperty('--flame-pct', flamePct + '%');
        flameBar.style.setProperty('--flame-color', flameColor);
        item.appendChild(flameBar);

        // Error tooltip (inline root cause, no tab switching needed)
        if (isErr) {
            const tip = document.createElement('div');
            tip.className = 'req-error-tooltip';
            const summary = getRootCauseSummary(r);
            if (summary) {
                const titleEl = document.createElement('div'); titleEl.className = 'req-err-tip-title';
                titleEl.textContent = summary.code ? `${summary.code}: ${summary.msg}` : summary.msg;
                tip.appendChild(titleEl);
                if (summary.origin) {
                    const locEl = document.createElement('div'); locEl.className = 'req-err-tip-loc';
                    locEl.textContent = `↳ ${summary.origin.pkg} line ${summary.origin.line}`;
                    tip.appendChild(locEl);
                }
            } else {
                const titleEl = document.createElement('div'); titleEl.className = 'req-err-tip-title';
                titleEl.textContent = 'Request failed';
                tip.appendChild(titleEl);
            }
            item.appendChild(tip);
        }

        item.addEventListener('click', () => selectRequest(r.id));
        list.appendChild(item);
    });
}

function selectRequest(id) {
    selected = id; renderSidebar();
    const r = requests.find(x => x.id===id);
    if (!r) return;
    document.getElementById('empty-state').style.display = 'none';
    const dc = document.getElementById('detail-content');
    dc.style.display = 'flex';

    // ── Summary tab ───────────────────────────────────────────────────────────
    renderSummaryBar(r);
    renderRequestCard(r);
    renderResponseCard(r);
    renderTrace(r);

    const exceptions = getExceptions(r);
    const hasExc = exceptions && exceptions.length > 0;
    const excSection = document.getElementById('exc-section');
    excSection.style.display = hasExc ? '' : 'none';
    if (hasExc) {
        document.getElementById('exc-hdr-meta').textContent = `(${exceptions.length})`;
        renderExceptions(document.getElementById('tab-exceptions'), exceptions);
    }

    // ── Standalone Trace tab ──────────────────────────────────────────────────
    renderTraceStandalone(r);

    // ── Waterfall / Request / Response / Server tabs ──────────────────────────
    renderWaterfall(r);
    renderRequestTab(r);
    renderResponseTab(r);
    renderServerTab(r);
}

// ── Summary bar: stat chips ───────────────────────────────────────────────────
function renderSummaryBar(r) {
    const bar = document.getElementById('detail-summary-bar');
    const trace = r.data && r.data['ifs-trace'] && r.data['ifs-trace'].trace;
    const stats = trace ? calcStats(trace) : { info:0, debug:0, sql:0, plsql:0, warn:0, err:0, hidden:0 };
    const exceptions = getExceptions(r);
    const errCount = stats.err + (exceptions ? exceptions.length : 0);
    const isErr = hasLogicalError(r);

    // Response status from body payload (data.response.status) or HAR
    const bodyStatus = r.data && r.data.response && r.data.response.status;
    const statusCode = bodyStatus ? bodyStatus.code : String(r.status);
    const statusInfo = bodyStatus ? bodyStatus.info : (r.har.response.statusText || '');

    bar.innerHTML =
        `<span class="stat-chip info">INFO ${stats.info}</span>` +
        `<span class="stat-chip debug">DEBUG ${stats.debug}${stats.hidden ? ` <span style="color:var(--text3)">(${stats.hidden} hidden)</span>` : ''}</span>` +
        (stats.sql   ? `<span class="stat-chip sql">SQL ${stats.sql}</span>` : '') +
        (stats.plsql ? `<span class="stat-chip plsql">PLSQL ${stats.plsql}</span>` : '') +
        (stats.warn  ? `<span class="stat-chip warn">WARN ${stats.warn}</span>` : '') +
        (errCount    ? `<span class="stat-chip err">ERROR ${errCount}</span>` : '') +
        `<span style="margin-left:auto;display:flex;gap:5px;align-items:center">` +
        `<span class="req-method-badge ${methodBadgeClass(r.method)}" style="font-size:10px">${r.method}</span>` +
        `<span class="req-status ${isErr?'err':'ok'}" style="font-size:11px;font-weight:700">${statusCode} ${statusInfo}</span>` +
        `<span style="font-size:10px;color:var(--text3)">${fmtMs(r.duration)}</span>` +
        `</span>`;
}

// ── Request card ──────────────────────────────────────────────────────────────
function renderRequestCard(r) {
    const body = document.getElementById('req-card-body');
    body.innerHTML = '';
    const har = r.har;

    // ── URL ───────────────────────────────────────────────────────────────────
    dcUrlField(body, 'URL', har.request.url);

    // ── Referer/Client ─────────────────────────────────────────────────────────
    const reqRef = (har.request.headers || []).find(h => h.name.toLowerCase() === 'referer');
    if (reqRef) {
        const m = reqRef.value.match(/\/main\/ifsapplications\/web\/(.+)/);
        const clientPath = m ? m[1].split(';')[0] : reqRef.value;
        dcKv(body, 'Client', clientPath);
    }

    // ── Path Info/Projection (check server.environment.pathInfo, if null then from URL) ──────────────────────────
    let pathInfo =
        r.data?.server?.environment?.pathInfo;

    // fallback from URL
    if (!pathInfo && har.request.url) {
        const marker = 'main/ifsapplications/projection/v1/';
        const idx = har.request.url.indexOf(marker);
        if (idx !== -1) {
            pathInfo =
                har.request.url.substring(
                    idx + marker.length
                );
        }
    }

    if (!pathInfo && har.request.url) {
        const marker = 'web/server/metadata/cpi/';
        const idx = har.request.url.indexOf(marker);
        if (idx !== -1) {
            pathInfo = 'metadata/cpi/' + 
                har.request.url.substring(
                    idx + marker.length
                );
        }
    }

    if (pathInfo) {
        dcKv(body, 'Projection', pathInfo);
    }
    
    // ── Filter ────────────────────────────────────────────────────────────────
    const parsedUrl = new URL(har.request.url);
    const filter = parsedUrl.searchParams.get('$filter');
    if (filter) {
       dcKv(body, 'Filter', decodeURIComponent(filter));
    }

    // ── HTTP Method ───────────────────────────────────────────────────────────
    dcKv(body, 'HTTP Method', har.request.method);

    // ── Content-Type ─────────────────────────────────────────────────────────
    const reqCT = (har.request.headers || []).find(h => h.name.toLowerCase() === 'content-type');
    if (reqCT) dcKv(body, 'Content-Type', reqCT.value);

    // ── Status (HAR) ─────────────────────────────────────────────────────────
    const isErr = hasLogicalError(r);
    dcKv(body, 'Status', `${har.response.status} ${har.response.statusText || ''}`, isErr ? 'err' : 'ok');

    // ── Request Headers ───────────────────────────────────────────────────────
    /*if (har.request.headers && har.request.headers.length) {
        const t = document.createElement('div'); t.className = 'dc-section-title'; t.textContent = 'Headers';
        body.appendChild(t);
        const tbl = document.createElement('table'); tbl.className = 'dc-headers-table';
        har.request.headers.forEach(h => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${esc(h.name)}</td><td>${esc(h.value)}</td>`;
            tbl.appendChild(tr);
        });
        body.appendChild(tbl);
    }*/

    // ── Request Body ─────────────────────────────────────────────────────────
    if (har.request.postData && har.request.postData.text) {
        const t2 = document.createElement('div'); t2.className = 'dc-section-title'; t2.textContent = 'Request Body';
        body.appendChild(t2);
        const pre = document.createElement('div'); pre.className = 'dc-code-block';
        try {
            pre.innerHTML = highlightJson(
                JSON.stringify(JSON.parse(har.request.postData.text), null, 2)
            );
        }
        catch {
            pre.innerHTML = highlightJson(har.request.postData.text);
        }
        body.appendChild(pre);
    }
}

// ── Response card ─────────────────────────────────────────────────────────────
function renderResponseCard(r) {
    const body = document.getElementById('resp-card-body');
    body.innerHTML = '';
    const har = r.har;

    // ── response.status.code + response.status.info (from payload) ───────────
    const payloadResp = r.data && r.data.response;
    const bodyStatus  = payloadResp && payloadResp.status;
    const isErr       = hasLogicalError(r);

    if (bodyStatus) {
        dcKv(body, 'Status Code', bodyStatus.code || '', isErr ? 'err' : 'ok');
        dcKv(body, 'Status Info', bodyStatus.info || '');
    } else {
        dcKv(body, 'Status', `${har.response.status} ${har.response.statusText || ''}`, isErr ? 'err' : 'ok');
    }

    // ── Content-Type ─────────────────────────────────────────────────────────
    const respCT = (har.response.headers || []).find(h => h.name.toLowerCase() === 'content-type');
    if (respCT) dcKv(body, 'Content-Type', respCT.value);

    // ── Duration / Size ───────────────────────────────────────────────────────
    dcKv(body, 'Duration', fmtMs(har.time), speedClass(har.time) || '');
    if (har.response.bodySize > 0) dcKv(body, 'Size', fmtBytes(har.response.bodySize));

    // ── Response Headers ──────────────────────────────────────────────────────
    /*if (har.response.headers && har.response.headers.length) {
        const t = document.createElement('div'); t.className = 'dc-section-title'; t.textContent = 'Headers';
        body.appendChild(t);
        const tbl = document.createElement('table'); tbl.className = 'dc-headers-table';
        har.response.headers.forEach(h => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${esc(h.name)}</td><td>${esc(h.value)}</td>`;
            tbl.appendChild(tr);
        });
        body.appendChild(tbl);
    }*/

    // ── Response Body — prefer hook payload, fall back to HAR content ────────
    const respBody = (payloadResp && payloadResp.body) || getHarBodyJson(r);
    if (respBody) {
        const t2 = document.createElement('div'); t2.className = 'dc-section-title'; t2.textContent = 'Response Body';
        body.appendChild(t2);
        const pre = document.createElement('div'); pre.className = 'dc-code-block';
        try {
            const o = typeof respBody === 'string' ? JSON.parse(respBody) : respBody;
            pre.innerHTML = highlightJson(JSON.stringify(o, null, 2));
        }
        catch {
            pre.innerHTML = highlightJson(
                typeof respBody === 'string'
                    ? respBody
                    : JSON.stringify(respBody, null, 2)
            );
        }
        body.appendChild(pre);
    }
}

// ── Helper: add a key-value row to a card body ────────────────────────────────
function dcKv(parent, key, val, cls) {
    const row = document.createElement('div'); row.className = 'dc-kv-row';
    row.innerHTML = `<span class="dc-kv-key">${esc(key)}</span><span class="dc-kv-val${cls?' '+cls:''}">${esc(String(val))}</span>`;
    parent.appendChild(row);
}

// ── URL field with horizontal scroll and copy button ────────────────────────
function dcUrlField(parent, key, val) {
    const row = document.createElement('div'); row.className = 'dc-kv-row dc-url-row';
    const keySpan = document.createElement('span'); keySpan.className = 'dc-kv-key'; keySpan.textContent = key;
    const valContainer = document.createElement('div'); valContainer.className = 'dc-url-container';
    const valSpan = document.createElement('span'); valSpan.className = 'dc-url-text'; valSpan.textContent = val;
    const copyBtn = document.createElement('button'); copyBtn.className = 'dc-url-copy-btn'; copyBtn.title = 'Copy URL';
    copyBtn.innerHTML = '📋';
    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(val).then(() => {
            copyBtn.innerHTML = '✓';
            setTimeout(() => { copyBtn.innerHTML = '📋'; }, 2000);
        });
    });
    valContainer.appendChild(valSpan);
    valContainer.appendChild(copyBtn);
    row.appendChild(keySpan);
    row.appendChild(valContainer);
    parent.appendChild(row);
}

// ─── Controls ─────────────────────────────────────────────────────────────────
document.getElementById('btn-clear').addEventListener('click', () => {
    requests=[]; selected=null; globalClientLogs.length=0; seenLogKeys.clear();
    document.getElementById('request-list').innerHTML = '';
    document.getElementById('req-count').textContent  = '0 requests';
    document.getElementById('empty-state').style.display = '';
    document.getElementById('detail-content').style.display = 'none';
    renderClientLogs();
});

document.getElementById('btn-pause').addEventListener('click', function() {
    paused = !paused;
    this.textContent = paused ? '▶' : '⏸';
    this.title = paused ? 'Resume capturing' : 'Pause capturing';
});

document.getElementById('filter-input').addEventListener('input', debounce(function() {
    filterText = this.value; renderSidebar();
}, 60));

document.querySelectorAll('.mf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        filterMethod = btn.dataset.method;
        document.querySelectorAll('.mf-btn').forEach(b => {
            const active = b.dataset.method === filterMethod;
            b.classList.toggle('active', active);
            b.classList.toggle('dimmed', filterMethod !== 'ALL' && !active);
        });
        renderSidebar();
    });
});

// ── Sidebar URL-exclude cog button ────────────────────────────────────────────
(function initSidebarCog() {
    const cogBtn   = document.getElementById('sidebar-cog-btn');
    const sp       = buildReqHiddenPanel();
    sp.className   = 'log-settings-panel';
    sp.style.cssText = 'display:none;position:absolute;top:100%;left:0;z-index:999;min-width:280px';
    const toolbar  = document.getElementById('sidebar-toolbar');
    toolbar.style.position = 'relative';
    toolbar.appendChild(sp);

    cogBtn.addEventListener('click', e => {
        e.stopPropagation();
        sp.style.display = sp.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { sp.style.display = 'none'; });
    sp.addEventListener('click', e => e.stopPropagation());
})();

// ─── Resizable sidebar divider ────────────────────────────────────────────────
const divider = document.getElementById('divider');
const sidebar = document.getElementById('sidebar');
let dragging=false, startX=0, startW=0;
divider.addEventListener('mousedown', e => {
    dragging=true; startX=e.clientX; startW=sidebar.offsetWidth;
    document.body.style.cursor='col-resize'; document.body.style.userSelect='none';
});
document.addEventListener('mousemove', e => {
    if (!dragging) return;
    sidebar.style.width = Math.max(160, Math.min(startW+e.clientX-startX, window.innerWidth*.55))+'px';
});
document.addEventListener('mouseup', () => {
    dragging=false; document.body.style.cursor=''; document.body.style.userSelect='';
});

// ─── Resizable client-logs side panel divider ─────────────────────────────────
const logsDivider = document.getElementById('logs-divider');
const logsPanel   = document.getElementById('client-logs-panel');
let logsDrag=false, logsStartX=0, logsStartW=0;
if (logsDivider && logsPanel) {
    logsDivider.addEventListener('mousedown', e => {
        logsDrag=true; logsStartX=e.clientX; logsStartW=logsPanel.offsetWidth;
        document.body.style.cursor='col-resize'; document.body.style.userSelect='none';
    });
    document.addEventListener('mousemove', e => {
        if (!logsDrag) return;
        const newW = Math.max(160, Math.min(logsStartW - (e.clientX - logsStartX), window.innerWidth*.6));
        logsPanel.style.width = newW+'px';
    });
    document.addEventListener('mouseup', () => {
        if (!logsDrag) return;
        logsDrag=false; document.body.style.cursor=''; document.body.style.userSelect='';
    });
}

// ─── Logs panel: swap layout + collapse ──────────────────────────────────────
const sidePanel          = document.getElementById('client-logs-panel');
const sideDivider        = document.getElementById('logs-divider');
const dockedPanel        = document.getElementById('client-logs-docked');
const logsSwapBtn        = document.getElementById('logs-swap-btn');
const logsCollapseBtn    = document.getElementById('logs-collapse-btn');
const logsSwapBtnDocked  = document.getElementById('logs-swap-btn-docked');
const logsCollapseBtnDocked = document.getElementById('logs-collapse-btn-docked');
const sideHeader         = document.getElementById('logs-panel-header');
const dockedHeader       = document.getElementById('docked-logs-header');

let logsMode = 'vertical'; // 'vertical' (right side) | 'horizontal' (bottom)

function setLogsMode(mode) {
    logsMode = mode;
    sidePanel.classList.remove('logs-collapsed');
    dockedPanel.classList.remove('logs-collapsed');
    if (mode === 'horizontal') {
        sidePanel.style.display   = 'none';
        sideDivider.style.display = 'none';
        dockedPanel.style.display = 'flex';
    } else {
        sidePanel.style.display   = '';
        sideDivider.style.display = '';
        dockedPanel.style.display = 'none';
    }
    renderClientLogs();
}

function collapseLogs() {
    if (logsMode === 'vertical') {
        const isCollapsed = sidePanel.classList.contains('logs-collapsed');
        sidePanel.classList.toggle('logs-collapsed');
        if (isCollapsed) {
            sideDivider.style.display = ''; // show divider when expanding
            sidePanel.style.width = '30%'; // restore to original width
            sidePanel.style.minWidth = '180px'; // restore min-width
        } else {
            sideDivider.style.display = 'none'; // hide divider when collapsing
            sidePanel.style.width = 'auto'; // shrink to header content width
            sidePanel.style.minWidth = '0'; // allow header-only width
        }
    } else {
        dockedPanel.classList.toggle('logs-collapsed');
        if (collapsed) {
            dockedPanel.dataset.prevHeight = dockedPanel.style.height;
            dockedPanel.style.height = '32px'; // header height
        } 
        else {
            dockedPanel.style.height =
            dockedPanel.dataset.prevHeight || '180px';
        }
    }
}

function expandLogsOnHeaderClick(e) {
    // Allow expansion on header click only (ignore button clicks)
    if (e.target.closest('button')) return; // let button clicks pass through
    const panel = logsMode === 'vertical' ? sidePanel : dockedPanel;
    if (panel.classList.contains('logs-collapsed')) {
        panel.classList.remove('logs-collapsed');
        if (logsMode === 'vertical') {
            sideDivider.style.display = ''; // show divider when expanded
            sidePanel.style.width = '30%'; // restore to original width
            sidePanel.style.minWidth = '180px'; // restore min-width
        }
    }
}

if (logsSwapBtn)           logsSwapBtn.addEventListener('click', () => setLogsMode('horizontal'));
if (logsCollapseBtn)       logsCollapseBtn.addEventListener('click', collapseLogs);
if (logsSwapBtnDocked)     logsSwapBtnDocked.addEventListener('click', () => setLogsMode('vertical'));
if (logsCollapseBtnDocked) logsCollapseBtnDocked.addEventListener('click', collapseLogs);
if (sideHeader)            sideHeader.addEventListener('click', expandLogsOnHeaderClick);
if (dockedHeader)          dockedHeader.addEventListener('click', expandLogsOnHeaderClick);

// Docked resize handle
const dockedHandle = document.getElementById('docked-resize-handle');
if (dockedHandle && dockedPanel) {
    let dH=false, dStartY=0, dStartH=0;
    dockedHandle.addEventListener('mousedown', e => {
        dH=true; dStartY=e.clientY; dStartH=dockedPanel.offsetHeight;
        document.body.style.cursor='row-resize'; document.body.style.userSelect='none';
    });
    document.addEventListener('mousemove', e => {
        if (!dH) return;
        const newH = Math.max(80, Math.min(dStartH - (e.clientY - dStartY), window.innerHeight*.6));
        dockedPanel.style.height = newH+'px';
    });
    document.addEventListener('mouseup', () => {
        if (!dH) return;
        dH=false; document.body.style.cursor=''; document.body.style.userSelect='';
    });
}

// ─── Section collapsible headers ─────────────────────────────────────────────
function initSectionHdr(hdrId, sectionId) {
    const hdr = document.getElementById(hdrId);
    const sec = document.getElementById(sectionId);
    if (!hdr || !sec) return;
    hdr.addEventListener('click', () => sec.classList.toggle('collapsed'));

    // ─── Auto-dock sections to bottom when collapsed ─────────────────────────────────
    const traceSectionHdr = document.getElementById('trace-section-hdr');
    const traceSection    = document.getElementById('trace-section');
    const excSectionHdr   = document.getElementById('exc-section-hdr');
    const excSection      = document.getElementById('exc-section');
    const detailPane      = document.getElementById('detail-pane');
    const summaryTab      = document.getElementById('dtab-summary');

    function dockSection(sectionEl, headerEl, isTrace) {
        if (!headerEl || !sectionEl || !detailPane || !summaryTab) return;
        headerEl.addEventListener('click', () => {
            const isCollapsed = sectionEl.classList.contains('collapsed');
            if (isCollapsed) {
                // Move section to bottom of detail-pane (outside scroll area)
                detailPane.appendChild(sectionEl);
                sectionEl.style.borderTop = '1px solid var(--border)';
                sectionEl.style.flexShrink = '0';
            } else {
                // Move it back inside dtab-summary in its original position
                summaryTab.appendChild(sectionEl);
                sectionEl.style.borderTop = '';
                sectionEl.style.flexShrink = '';
            }
        });
    }

    // Apply docking to both trace and exceptions
    if (traceSectionHdr && traceSection) dockSection(traceSection, traceSectionHdr, true);
    if (excSectionHdr && excSection) dockSection(excSection, excSectionHdr, false);
}
initSectionHdr('trace-section-hdr', 'trace-section');
initSectionHdr('exc-section-hdr',   'exc-section');

// ─── Theme toggle ─────────────────────────────────────────────────────────────
const themeBtn = document.getElementById('theme-toggle');
const LS_THEME = 'ioi_theme';
(function applyTheme() {
    const saved = localStorage.getItem(LS_THEME) || 'dark';
    if (saved === 'light') { document.body.classList.add('light-theme'); if (themeBtn) themeBtn.textContent = '🌙 Dark'; }
    else { document.body.classList.remove('light-theme'); if (themeBtn) themeBtn.textContent = '☀ Light'; }
})();
if (themeBtn) {
    themeBtn.addEventListener('click', () => {
        const isLight = document.body.classList.toggle('light-theme');
        themeBtn.textContent = isLight ? '🌙 Dark' : '☀ Light';
        localStorage.setItem(LS_THEME, isLight ? 'light' : 'dark');
    });
}

// ════════════════════════════════════════════════════════════════════════════
// TRACE TAB
// ════════════════════════════════════════════════════════════════════════════
const MODES = ['minimal','compact','full'];
const MODE_LABELS = {minimal:'◎ Key Events', compact:'⊞ Compact', full:'≡ Full'};

function renderTrace(r) {
    const pane = document.getElementById('tab-trace');
    pane.innerHTML = '';

    // Update trace section header meta
    const traceMeta = document.getElementById('trace-hdr-meta');
    const traceActions = document.getElementById('trace-hdr-actions');
    if (traceMeta) traceMeta.textContent = '';
    if (traceActions) traceActions.innerHTML = '';

    const trace = r.data && r.data['ifs-trace'] && r.data['ifs-trace'].trace;
    if (!trace || !trace.length) {
        pane.innerHTML = '<div style="padding:20px;color:var(--text3)">No trace data in this response.</div>';
        return;
    }

    // Update meta in section header
    const stats = calcStats(trace);
    if (traceMeta) traceMeta.textContent = `(${trace.length} entries)`;

    // ── Toolbar ───────────────────────────────────────────────────────────────
    const toolbar = el('div','id=trace-toolbar');

    const statsWrap = el('div','class=toolbar-stats');
    statsWrap.innerHTML =
        `<span class="stat-chip info">INFO ${stats.info}</span>` +
        `<span class="stat-chip debug">DEBUG ${stats.debug}` +
        (stats.hidden ? ` <span style="color:var(--text3)">(${stats.hidden} hidden)</span>` : '') +
        `</span>` +
        (stats.sql   ? `<span class="stat-chip sql">SQL ${stats.sql}</span>` : '') +
        (stats.plsql ? `<span class="stat-chip plsql">PLSQL ${stats.plsql}</span>` : '') +
        (stats.warn  ? `<span class="stat-chip warn">WARN ${stats.warn}</span>` : '') +
        (stats.err   ? `<span class="stat-chip err">ERROR ${stats.err}</span>` : '');
    toolbar.appendChild(statsWrap);

    const modeWrap = el('div','style=display:flex;gap:3px');
    const treeContainer = el('div','id=trace-tree');

    MODES.forEach(m => {
        const b = el('button',`class=mode-btn${viewMode===m?' active':''}`);
        b.textContent = MODE_LABELS[m]; b.dataset.m = m;
        b.addEventListener('click', () => {
            viewMode = m; localStorage.setItem(LS_MODE, m);
            modeWrap.querySelectorAll('.mode-btn').forEach(x => x.classList.toggle('active', x.dataset.m===m));
            renderTraceTree(trace, treeContainer);
        });
        modeWrap.appendChild(b);
    });
    toolbar.appendChild(modeWrap);

    if (stats.err > 0) {
        const jumpBtn = el('button','id=jump-error-btn');
        jumpBtn.innerHTML = '⬇ Jump to Error';
        jumpBtn.title = 'Scroll to first error in trace';
        jumpBtn.addEventListener('click', () => {
            const firstErr = treeContainer.querySelector('.lv-error, .is-error-origin');
            if (firstErr) firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        toolbar.appendChild(jumpBtn);
    }

    const exportBtn = el('button','id=export-btn');
    exportBtn.textContent = '⬇ Export';
    exportBtn.title = `Export trace as text (current mode: ${viewMode})`;
    exportBtn.addEventListener('click', e => { e.stopPropagation(); exportTrace(trace, r); });
    toolbar.appendChild(exportBtn);

    const cogBtn = el('button','id=settings-btn');
    cogBtn.textContent = '⚙'; cogBtn.title = 'Filter settings';
    const sp = buildSettingsPanel(() => renderTraceTree(trace, treeContainer));
    sp.id = 'settings-panel'; sp.style.display = 'none';
    cogBtn.addEventListener('click', e => {
        e.stopPropagation();
        sp.style.display = sp.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => sp.style.display = 'none');
    sp.addEventListener('click', e => e.stopPropagation());
    toolbar.appendChild(cogBtn);

    pane.appendChild(toolbar);
    pane.appendChild(sp);
    pane.appendChild(treeContainer);
    renderTraceTree(trace, treeContainer);
}

// ── Parse ORA stack lines from an exception message ──────────────────────────
// Returns { rootOra, rootMsg, layers } where layers = [{pkg, line}]
function parseOraStack(msg) {
    if (!msg) return null;
    const lines = msg.split('\n').map(l => l.trim()).filter(Boolean);
    let rootOra = '', rootMsg = '', layers = [];
    lines.forEach(line => {
        // ORA-20112: Some message text
        const oraRoot = line.match(/^(ORA-\d+):\s*(.+)/);
        if (oraRoot && !rootOra) { rootOra = oraRoot[1]; rootMsg = oraRoot[2]; return; }
        // ORA-06512: at "IFSAPP.CONTACT_ROLE_API", line 672
        const oraAt = line.match(/ORA-06512:\s+at\s+"([^"]+)",\s+line\s+(\d+)/);
        if (oraAt) { layers.push({ pkg: oraAt[1], line: oraAt[2] }); return; }
        // Fallback: collect as plain message
        if (!rootMsg) rootMsg = line;
    });
    return { rootOra, rootMsg, layers };
}

// Deduplicate exceptions — if 3 exceptions share the same ORA root, keep the richest one
function deduplicateExceptions(exceptions) {
    if (!exceptions || !exceptions.length) return { unique: [], dupeCount: 0 };
    const seen = new Map();
    exceptions.forEach(exc => {
        const parsed = parseOraStack(exc.message);
        const key = parsed ? (parsed.rootOra + '|' + parsed.rootMsg) : (exc.class + '|' + (exc.message||''));
        const existing = seen.get(key);
        // Keep the one with more stack layers (richer context)
        const score = parsed ? parsed.layers.length : 0;
        const existScore = existing ? (parseOraStack(existing.message) || { layers: [] }).layers.length : -1;
        if (!existing || score > existScore) seen.set(key, exc);
    });
    return { unique: Array.from(seen.values()), dupeCount: exceptions.length - seen.size };
}

function renderExceptions(pane, exceptions) {
    pane.innerHTML = '';
    if (!exceptions || !exceptions.length) {
        pane.innerHTML = '<div style="padding:20px;color:var(--text3)">No exceptions in this response.</div>';
        return;
    }

    // ── OData error fast-path (no debug, synthesised from HAR body) ───────────
    if (exceptions.length === 1 && exceptions[0]._isOdata) {
        const e = exceptions[0]._odataErr;
        const wrap = el('div','class=exc-pane-inner');
        const card = el('div','class=exc-root-card');

        const hdr = el('div','class=exc-root-header');
        const lbl = el('span','class=exc-root-label'); lbl.textContent = 'Root Cause';
        const cls = el('span','class=exc-root-class'); cls.textContent = 'OData Error (no debug)';
        hdr.appendChild(lbl); hdr.appendChild(cls);
        card.appendChild(hdr);

        const msgBox = el('div','class=exc-root-message');
        msgBox.innerHTML =
            (e.code    ? `<span class="exc-ora-code">${esc(e.code)}:</span> ` : '') +
            `<span class="exc-ora-text">${esc(e.message || '')}</span>`;
        card.appendChild(msgBox);

        const details = Array.isArray(e.details) ? e.details : [];
        if (details.length) {
            const chain = el('div','class=exc-chain');
            const chainTitle = el('div','class=exc-chain-title'); chainTitle.textContent = 'Details';
            chain.appendChild(chainTitle);
            details.forEach(d => {
                const dRow = el('div','class=exc-chain-row');
                dRow.innerHTML =
                    `<span class="exc-chain-key">${d.code ? esc(String(d.code)) : '—'}</span>` +
                    `<span class="exc-chain-val exc-ora-text">${esc(d.message || '')}</span>`;
                chain.appendChild(dRow);
            });
            card.appendChild(chain);
        }

        const note = el('div','style=padding:6px 10px 2px;font-size:10px;color:var(--text3)');
        note.textContent = 'Enable IFS debug mode for full server-side stack traces.';
        wrap.appendChild(card);
        wrap.appendChild(note);
        pane.appendChild(wrap);
        return;
    }

    const { unique, dupeCount } = deduplicateExceptions(exceptions);
    const wrap = el('div','class=exc-pane-inner');

    unique.forEach((exc, i) => {
        const parsed = parseOraStack(exc.message);
        const card = el('div','class=exc-root-card');

        // ── Header: label + exception class ──────────────────────────────────
        const hdr = el('div','class=exc-root-header');
        const lbl = el('span','class=exc-root-label'); lbl.textContent = i === 0 ? 'Root Cause' : `Exception ${i+1}`;
        const cls = el('span','class=exc-root-class'); cls.textContent = exc.class || '(unknown)';
        hdr.appendChild(lbl); hdr.appendChild(cls);
        card.appendChild(hdr);

        // ── Root cause message (highlighted) ─────────────────────────────────
        const msgBox = el('div','class=exc-root-message');
        if (parsed && parsed.rootOra) {
            msgBox.innerHTML =
                `<span class="exc-ora-code">${esc(parsed.rootOra)}:</span>` +
                `<span class="exc-ora-text">${esc(parsed.rootMsg)}</span>`;
        } else {
            msgBox.textContent = exc.message || '(no message)';
        }
        card.appendChild(msgBox);

        // ── Chain: Raised in → Bubbled via → HTTP result ──────────────────────
        if (parsed && parsed.layers.length) {
            const chain = el('div','class=exc-chain');
            const chainTitle = el('div','class=exc-chain-title'); chainTitle.textContent = 'Call Stack';
            chain.appendChild(chainTitle);

            // First layer = origin (where error was raised)
            const origin = parsed.layers[0];
            const raisedRow = el('div','class=exc-chain-row');
            raisedRow.innerHTML =
                `<span class="exc-chain-key">Raised in</span>` +
                `<span class="exc-chain-val">` +
                formatPkgLine(origin.pkg, null, origin.line) +
                `</span>`;
            chain.appendChild(raisedRow);

            // Middle layers = bubble path (skip last which is usually "at line 1")
            const mid = parsed.layers.slice(1).filter(l => l.line !== '1' && l.pkg !== 'at line 1');
            if (mid.length) {
                const bubbleRow = el('div','class=exc-chain-row');
                const valEl = el('span','class=exc-chain-val');
                valEl.innerHTML = mid.map((l, idx) =>
                    (idx > 0 ? '<span class="cv-arrow">→</span>' : '') + formatPkgLine(l.pkg, null, l.line)
                ).join('');
                bubbleRow.innerHTML = `<span class="exc-chain-key">Via</span>`;
                bubbleRow.appendChild(valEl);
                chain.appendChild(bubbleRow);
            }

            // HTTP result
            if (exc.invocation) {
                const inv = exc.invocation;
                const httpRow = el('div','class=exc-chain-row');
                httpRow.innerHTML =
                    `<span class="exc-chain-key">HTTP</span>` +
                    `<span class="exc-chain-val">` +
                    (inv.class  ? `<span class="cv-pkg">${esc(inv.class)}</span>` : '') +
                    (inv.method ? `<span class="cv-sep">.</span><span class="cv-fn">${esc(inv.method)}</span>` : '') +
                    (inv.line   ? `<span class="cv-sep"> line </span><span class="cv-line">${esc(String(inv.line))}</span>` : '') +
                    `</span>`;
                chain.appendChild(httpRow);
            }

            card.appendChild(chain);
        } else if (exc.invocation) {
            // No stack but we have invocation
            const inv = exc.invocation;
            const chain = el('div','class=exc-chain');
            const locRow = el('div','class=exc-chain-row');
            locRow.innerHTML =
                `<span class="exc-chain-key">Location</span>` +
                `<span class="exc-chain-val">` +
                (inv.class  ? `<span class="cv-pkg">${esc(inv.class)}</span>` : '') +
                (inv.method ? `<span class="cv-sep">.</span><span class="cv-fn">${esc(inv.method)}</span>` : '') +
                (inv.line   ? `<span class="cv-sep"> : </span><span class="cv-line">${esc(String(inv.line))}</span>` : '') +
                `</span>`;
            chain.appendChild(locRow);
            card.appendChild(chain);
        }

        // ── Collapsible raw stack ─────────────────────────────────────────────
        if (exc.message && exc.message.includes('ORA-06512')) {
            const tog = el('button','class=exc-stack-toggle');
            tog.innerHTML = `<span class="exc-tog-icon">▶</span> Raw Stack Trace`;
            const body = el('div','class=exc-stack-body');
            body.innerHTML = exc.message.split('\n').map(line => {
                const trimmed = line.trim();
                if (!trimmed) return '';
                const atMatch = trimmed.match(/ORA-06512:\s+at\s+"([^.]+)\.([^"]+)",\s+line\s+(\d+)/);
                if (atMatch) {
                    return `<div class="exc-stack-line"><span class="esf-pkg">${esc(atMatch[1])}.${esc(atMatch[2])}</span> <span class="esf-line">line ${esc(atMatch[3])}</span></div>`;
                }
                return `<div class="exc-stack-line">${esc(trimmed)}</div>`;
            }).join('');
            tog.addEventListener('click', () => {
                const open = body.classList.toggle('open');
                tog.classList.toggle('open', open);
            });
            card.appendChild(tog);
            card.appendChild(body);
        }

        wrap.appendChild(card);
    });

    // Dedup notice
    if (dupeCount > 0) {
        const note = el('div','class=exc-dedup-note');
        note.textContent = `${dupeCount} duplicate exception${dupeCount > 1 ? 's' : ''} hidden — same root cause from different JDBC layers.`;
        wrap.appendChild(note);
    }

    pane.appendChild(wrap);
}

function formatPkgLine(pkg, fn, line) {
    const parts = (pkg || '').split('.');
    const pkgName = parts[0] || '';
    const fnName  = fn || parts[1] || '';
    return `<span class="cv-pkg">${esc(pkgName)}</span>` +
           (fnName ? `<span class="cv-sep">.</span><span class="cv-fn">${esc(fnName)}</span>` : '') +
           (line   ? `<span class="cv-sep"> line </span><span class="cv-line">${esc(String(line))}</span>` : '');
}

// ── Extract root cause summary for sidebar tooltip ────────────────────────────
function getRootCauseSummary(r) {
    const exc = getExceptions(r);
    if (!exc || !exc.length) return null;
    const first = exc[0];

    // OData error (no-debug path) — surface code + top-level message directly
    if (first._isOdata && first._odataErr) {
        const e = first._odataErr;
        const detail = Array.isArray(e.details) && e.details.length ? e.details[0] : null;
        return {
            code: e.code || null,
            msg:  (detail && detail.message) ? detail.message.slice(0, 160) : (e.message || '(error)'),
            origin: null
        };
    }

    const { unique } = deduplicateExceptions(exc);
    if (!unique.length) return null;
    const top = unique[0];
    const parsed = parseOraStack(top.message);
    if (parsed && parsed.rootMsg) {
        return {
            code: parsed.rootOra,
            msg: parsed.rootMsg,
            origin: parsed.layers && parsed.layers[0] ? parsed.layers[0] : null
        };
    }
    return { code: null, msg: top.message ? top.message.slice(0, 120) : '(error)', origin: null };
}

// ── Batch DOM flush via rAF for responsiveness ────────────────────────────────
function renderTraceTree(trace, container) {
    const nodes = buildNodes(trace);

    requestAnimationFrame(() => {
        const frag = document.createDocumentFragment();

        if (viewMode === 'full' || viewMode === 'minimal') {
            // No grouping in full/minimal mode — render flat
            nodes.forEach((node, gi) => {
                buildNodeRows(node, gi, nodes).forEach(r => frag.appendChild(r));
            });
        } else {
            // Compact: group consecutive call nodes at depth 0/1 by package
            renderGrouped(nodes, frag);
        }

        container.textContent = '';
        if (!frag.childNodes.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:20px;color:var(--text3)';
            empty.textContent = 'All entries are hidden by current filters.';
            container.appendChild(empty);
        } else {
            container.appendChild(frag);
            markErrorOrigins(container);
        }
    });
}

// ── Package grouping ──────────────────────────────────────────────────────────
function getPkgName(node) {
    if (node.kind !== 'call') return null;
    const m = (node.e.text||'').match(/Calling method:\s*([^.\s]+)\./);
    return m ? m[1] : null;
}

function renderGrouped(nodes, frag) {
    // Group only top-level (depth 0-1) consecutive call nodes sharing same package
    // Non-call nodes and nodes at depth > 1 are always rendered flat
    let i = 0;
    while (i < nodes.length) {
        const node = nodes[i];
        const pkg = getPkgName(node);

        // Only group depth-0 or depth-1 call nodes that aren't hidden
        if (pkg && (node.depth === 0 || node.depth === 1) && !shouldHide(node)) {
            // Look ahead for consecutive nodes with the same package at same depth
            let j = i + 1;
            while (j < nodes.length) {
                const next = nodes[j];
                // include params belonging to current call group
                if (next.kind === 'param' && next.depth === node.depth + 1) { j++; continue; }
                if (getPkgName(next) === pkg && next.depth === node.depth && !shouldHide(next)) { j++; continue; }
                break;
            }
            const groupNodes = nodes.slice(i, j);
            // Only group if ≥ 3 calls in same package (below that, no visual benefit)
            const callCount = groupNodes.filter(n => n.kind === 'call').length;
            if (callCount >= 3) {
                buildGroupHeader(pkg, groupNodes, frag);
                i = j; continue;
            }
        }

        // Fall through: render normally
        buildNodeRows(node, i, nodes).forEach(r => frag.appendChild(r));
        i++;
    }
}

function buildGroupHeader(pkg, groupNodes, frag) {
    const callNodes = groupNodes.filter(n => n.kind === 'call');
    const depth = groupNodes[0].depth;
    const hasError = groupNodes.some(n => n.lv === 'ERROR');
    const hasWarn  = groupNodes.some(n => n.lv === 'WARNING');

    const header = document.createElement('div');
    header.className = 'tr-group-header' + (hasError ? ' has-group-error' : hasWarn ? ' has-group-warn' : '');
    // depth indent
    const ind = document.createElement('span'); ind.className = 'tr-ind';
    for (let k = 0; k < depth; k++) { const u = document.createElement('span'); u.className = 'tr-iu'; ind.appendChild(u); }
    header.appendChild(ind);

    const tog = document.createElement('span'); tog.className = 'tr-tog'; tog.textContent = '▼'; header.appendChild(tog);
    const pkgBadge = document.createElement('span'); pkgBadge.className = 'tr-group-pkg'; pkgBadge.textContent = pkg; header.appendChild(pkgBadge);
    const countBadge = document.createElement('span'); countBadge.className = 'tr-group-count'; countBadge.textContent = `${callNodes.length} calls`; header.appendChild(countBadge);
    if (hasError) { const eb = document.createElement('span'); eb.className = 'tr-group-err-badge'; eb.textContent = '⚠ error'; header.appendChild(eb); }

    // Build child rows
    const childRows = [];
    groupNodes.forEach((node, gi) => {
        buildNodeRows(node, gi, groupNodes).forEach(r => childRows.push(r));
    });

    let collapsed = false;
    header.addEventListener('click', () => {
        collapsed = !collapsed;
        tog.textContent = collapsed ? '▶' : '▼';
        childRows.forEach(r => r.classList.toggle('cc-hidden', collapsed));
    });

    frag.appendChild(header);
    childRows.forEach(r => frag.appendChild(r));
}

// Walk rendered rows bottom-up; if a row is lv-error, mark parent call rows
function markErrorOrigins(container) {
    const rows = Array.from(container.querySelectorAll('.tr-node'));
    // Find error rows and mark them as origin
    rows.forEach(row => {
        if (row.classList.contains('lv-error')) {
            row.classList.add('is-error-origin');
        }
    });
    // Bubble upward: for each error row, mark shallower ancestors
    const errorRows = rows.filter(r => r.classList.contains('is-error-origin'));
    errorRows.forEach(errRow => {
        const errDepth = getRowDepth(errRow);
        let prev = errRow.previousElementSibling;
        while (prev) {
            if (prev.classList.contains('tr-node')) {
                const d = getRowDepth(prev);
                if (d < errDepth && prev.classList.contains('clickable')) {
                    prev.classList.add('has-error-child');
                }
            }
            prev = prev.previousElementSibling;
        }
    });
}

// ── Node building ─────────────────────────────────────────────────────────────
function isCall(e)  { return /Calling method:/i.test(e.text||''); }
function isParam(e) { return /^\s*\w[\w#]*_?\s*:\s*[\s\S]+/.test(e.text||'') && !isCall(e); }
function isSql(e)   { return e.origin==='MT' && e.type==='sql'; }
function isPLSQL(text) {
    // PL/SQL blocks start with DECLARE or BEGIN (ignoring leading whitespace)
    return /^\s*(DECLARE|BEGIN)\b/i.test(text||'');
}
function isMt(e)    { return e.origin==='MT' && e.type!=='sql'; }
function isDiv(e)   { return /^[\u2500\u2501\u2550=\-]{3,}\s*$/.test((e.text||'').trim()); }

// getInd returns null when indentation is absent/empty (these are "null indent" rows)
function getInd(e) {
    const v = e.indentation;
    if (v === null || v === undefined || v === '') return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
}
function getLv(e)  { return (e.level||'').toUpperCase(); }
function lvCls(lv) { return lv==='INFORMATION'?'lv-info':lv==='WARNING'?'lv-warn':lv==='ERROR'?'lv-error':''; }

// ── Raw ^-delimited row normaliser ────────────────────────────────────────────
// When the server emits a row with blank structured fields and packs everything
// into `text` as "indentation^time^category^level^type^actual text...", this
// function unpacks those fields back onto the entry object in-place.
// Format: N^TIMESTAMP^CATEGORY^LEVEL^TYPE^rest-of-text
// The actual text may itself contain ^ (e.g. list values), so we only split the
// first 5 tokens and rejoin the remainder.
// Called once per entry the first time buildNodes processes it; safe to re-run
// (after the first pass the structured fields are populated so getInd won't be null).
const RAW_ROW_RE = /^(\d+)\^(\d+)\^([A-Z]+)\^([A-Z]+)\^([A-Za-z]\w*)\^([\s\S]*)$/;

function normaliseRawEntry(e) {
    // Only applies when indentation is absent — i.e. the structured fields weren't populated
    if (getInd(e) !== null) return;
    const m = RAW_ROW_RE.exec(e.text || '');
    if (!m) return;
    e.indentation = m[1];
    e.time        = m[2];
    e.category    = m[3];
    e.level       = m[4];
    e.type        = m[5];
    e.text        = m[6];
}

function buildNodes(arr) {
    const nodes=[]; let i=0;
    while (i < arr.length) {
        const e = arr[i];
        // Unpack any ^-delimited raw rows before classification
        normaliseRawEntry(e);
        const rawInd   = getInd(e);
        const depth    = rawInd === null ? 0 : rawInd;
        const nullIndent = rawInd === null;   // true for rows like the big attr_ dumps
        const lv = getLv(e);

        if (isSql(e)) { nodes.push({kind:'sql', e, depth, nullIndent, plsql: isPLSQL(e.text || e.textWithBinds)}); i++; continue; }
        if (isMt(e))  { nodes.push({kind:'mt',e,depth:0,nullIndent}); i++; continue; }
        if (isDiv(e)) { i++; continue; }

        if (isHiddenEntry(e.text)) {
            // Skip all child rows of this hidden call (depth-based fast skip)
            let j = i+1;
            while (j < arr.length) {
                normaliseRawEntry(arr[j]);   // unpack raw row before depth/text checks
                const childInd = getInd(arr[j]);
                const childDepth = childInd === null ? 0 : childInd;
                if (childDepth > depth && (isParam(arr[j]) || isHiddenEntry(arr[j].text))) j++;
                else break;
            }
            nodes.push({kind:'hidden',e,count:j-i,depth,nullIndent}); i=j; continue;
        }

        if (isCall(e)) {
            const params=[]; let j=i+1;
            while (j < arr.length) {
                const ne = arr[j];
                normaliseRawEntry(ne);   // unpack raw row before depth/param checks
                const neInd = getInd(ne);
                const neDepth = neInd === null ? 0 : neInd;
                if (neDepth===depth+1 && isParam(ne) && !isCall(ne) && !isHiddenEntry(ne.text)) {
                    params.push(ne); j++;
                } else break;
            }
            nodes.push({kind:'call',e,params,depth,lv,nullIndent,
                collapsed: viewMode==='compact' && lv==='DEBUG' && params.length>0});
            i=j; continue;
        }

        if (isParam(e)) { nodes.push({kind:'param',e,depth,lv,nullIndent}); i++; continue; }
        nodes.push({kind:'text',e,depth,lv,nullIndent}); i++;
    }
    return nodes;
}

// ── Filter decision (centralised) ─────────────────────────────────────────────
// "Key Events" (minimal) mode shows:
//   • SQL / PLSQL blocks
//   • INFORMATION / WARNING / ERROR level rows
//   • Callstack dump text rows (expanded by default)
// Everything else is hidden.
function shouldHide(node) {
    if (hideNullIndent && node.nullIndent) return true;
    if (viewMode !== 'minimal') return false;
    if (node.kind === 'sql') return false;  // SQL/PLSQL always shown
    if (node.lv === 'INFORMATION' || node.lv === 'WARNING' || node.lv === 'ERROR') return false;
    if (node.kind === 'text' && isCallstackDump(node.e.text || '')) return false;
    return true;
}

// ── Copy button ───────────────────────────────────────────────────────────────
const SVG_COPY  = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="5" y="1" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="4" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="var(--bg)"/></svg>';
const SVG_CHECK = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><polyline points="2,9 6,13 14,4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function copyText(text, cb) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch(e) {}
    document.body.removeChild(ta);
    if (!ok && navigator.clipboard) { navigator.clipboard.writeText(text).then(cb).catch(()=>{}); } else { cb(); }
}
function addCopyBtn(rowEl, textFn) {
    const btn = document.createElement('button'); btn.className='tr-copy-btn'; btn.title='Copy to clipboard'; btn.innerHTML=SVG_COPY;
    btn.addEventListener('click', e => {
        e.stopPropagation();
        copyText(textFn(), () => { btn.innerHTML=SVG_CHECK; btn.classList.add('copied'); setTimeout(()=>{btn.innerHTML=SVG_COPY;btn.classList.remove('copied');},1500); });
    });
    rowEl.appendChild(btn);
}

// ── Row building ──────────────────────────────────────────────────────────────
function buildNodeRows(node, gi, nodes) {
    const rows = [];
    const hide = shouldHide(node);

    if (node.kind==='hidden') {
        if (viewMode !== 'full') return rows;
        const r = trNode('tr-node', node.depth);
        r.appendChild(sp());
        r.appendChild(txtSpan(`[hidden] ${esc(node.e.text)} (+${node.count-1})`, 'color: var(--text3);font-style:italic;opacity:.55'));
        if (hide) r.classList.add('hidden');
        rows.push(r); return rows;
    }

    if (node.kind==='sql') {
        const isPl = node.plsql;
        const sqlText = node.e.text || node.e.textWithBinds || '';
        const r = trNode('tr-node nd-sql' + (isPl ? ' nd-plsql' : ''), 0);
        r.appendChild(sp()); r.appendChild(origBadge('MT'));
        r.appendChild(lvBadge(isPl ? 'PLSQL' : 'SQL'));
        const block = document.createElement('div'); block.className='sql-block'; block.textContent=sqlText;
        r.appendChild(block); addCopyBtn(r, ()=>sqlText);
        rows.push(r); return rows;
    }

    if (node.kind==='mt') {
        const r = trNode('tr-node nd-mt', 0);
        if (hideNullIndent && node.nullIndent) r.classList.add('hidden');
        r.appendChild(sp()); r.appendChild(origBadge('MT')); r.appendChild(txtSpan(esc(node.e.text)));
        rows.push(r); return rows;
    }

    if (node.kind==='call') {
        const pm  = parseMethod(node.e.text||'');
        const hasP = node.params.length > 0;
        const r   = trNode('tr-node clickable '+lvCls(node.lv), node.depth);
        if (hide) r.classList.add('hidden');

        const tog = document.createElement('span'); tog.className = hasP ? 'tr-tog' : 'tr-sp';
        if (hasP) tog.textContent = node.collapsed ? '▶' : '▼';
        r.appendChild(tog); r.appendChild(origBadge(node.e.origin||'DB'));
        if (node.lv && node.lv!=='DEBUG') r.appendChild(lvBadge(node.lv==='INFORMATION'?'INFO':node.lv));

        const txt = document.createElement('span'); txt.className='tr-txt';
        if (pm) {
            txt.innerHTML = `<span class="tr-pkg">${esc(pm.pkg)}</span>.<span class="tr-fn">${esc(pm.fn)}</span>` +
                (pm.mod ? ` <span class="tr-mod">(${esc(pm.mod)})</span>` : '');
        } else { txt.textContent = node.e.text||''; }
        if (hasP && node.collapsed) {
            const hint = document.createElement('span'); hint.className='tr-hint';
            hint.textContent = ` [${node.params.length} params]`; txt.appendChild(hint);
        }
        r.appendChild(txt); addCopyBtn(r, ()=>node.e.text||'');
        addCollapseChildrenMenu(r, node.depth);
        rows.push(r);

        if (hasP) {
            const pEls = node.params.map(p => {
                const pr  = parseParam(p.text||'');
                const pr2 = trNode('tr-node nd-param', node.depth+1);
                if (node.collapsed || hide) pr2.classList.add('hidden');
                pr2.appendChild(sp());
                if (pr && hasAttrString(pr.val)) {
                    renderAttrParam(pr2, pr.key, pr.val, p.text||'');
                } else {
                    const pt = document.createElement('span'); pt.className='tr-txt';
                    if (pr) { pt.innerHTML = fmtParam(pr.key, pr.val, node.params); }
                    else { pt.textContent = p.text||''; }
                    pr2.appendChild(pt);
                }
                addCopyBtn(pr2, ()=>p.text||'');
                return pr2;
            });
            pEls.forEach(p => rows.push(p));
            r.addEventListener('click', () => {
                node.collapsed = !node.collapsed; tog.textContent = node.collapsed ? '▶' : '▼';
                const hint = txt.querySelector('.tr-hint');
                if (node.collapsed) {
                    if (!hint) { const h=document.createElement('span');h.className='tr-hint';h.textContent=` [${node.params.length} params]`;txt.appendChild(h); }
                } else { if (hint) hint.remove(); }
                pEls.forEach(p => p.classList.toggle('hidden', node.collapsed || hide));
            });
        }
        return rows;
    }

    if (node.kind==='param') {
        const r = trNode('tr-node nd-param', node.depth); if (hide) r.classList.add('hidden');
        r.appendChild(sp());
        const pr = parseParam(node.e.text||'');
        if (pr && hasAttrString(pr.val)) {
            // Param whose value IS an IFS attribute string  e.g.  attr_: KEY\x1fVAL\x1e...
            renderAttrParam(r, pr.key, pr.val, node.e.text||'');
        } else {
            const pt = document.createElement('span'); pt.className='tr-txt';
            if (pr) { pt.innerHTML = fmtParam(pr.key, pr.val, []); }
            else { pt.textContent = node.e.text||''; }
            r.appendChild(pt);
        }
        addCopyBtn(r, ()=>node.e.text||'');
        rows.push(r); return rows;
    }

    // text / INFO
    const r = trNode('tr-node '+lvCls(node.lv), node.depth); if (hide) r.classList.add('hidden');
    r.appendChild(sp()); r.appendChild(origBadge(node.e.origin||'DB'));
    if (node.lv && node.lv!=='DEBUG') r.appendChild(lvBadge(node.lv==='INFORMATION'?'INFO':node.lv));
    const isInfo = node.lv==='INFORMATION';
    // Check if the entire text is a bare IFS attribute string (e.g. raw dump rows)
    if (hasAttrString(node.e.text||'')) {
        renderAttrParam(r, null, node.e.text||'', node.e.text||'');
    } else if (isCallstackDump(node.e.text||'')) {
        renderCallstackDump(r, node.e.text||'');
    } else {
        r.appendChild(txtSpan(esc(node.e.text||''), '', isInfo?'tr-txt tr-info':'tr-txt'));
    }
    addCopyBtn(r, ()=>node.e.text||'');
    rows.push(r); return rows;
}

// ── Callstack dump detection & renderer ──────────────────────────────────────
// Detects the flat space-separated callstack string like:
// "__anonymous_block at line 1 CONTACT_ROLES_HANDLING_SVC.CRUD_CREATE at line 228 ..."
function isCallstackDump(text) {
    return (text.match(/\bat line \d+/g) || []).length >= 3;
}

function renderCallstackDump(rowEl, text) {
    // Parse: NAME at line N  (pairs)
    const frames = [];
    // Match: identifier_or_dotted at line N
    const re = /(\S+)\s+at line\s+(\d+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        frames.push({ name: m[1], line: m[2] });
    }
    if (!frames.length) {
        rowEl.appendChild(txtSpan(esc(text)));
        return;
    }

    const wrap = document.createElement('div'); wrap.className = 'callstack-wrap';
    const tog = document.createElement('button'); tog.className = 'callstack-toggle';
    tog.innerHTML = `<span class="callstack-tog-icon">▶</span> Call Stack <span class="callstack-count">${frames.length} frames</span>`;
    wrap.appendChild(tog);

    const body = document.createElement('div'); body.className = 'callstack-body open';
    frames.forEach((f, idx) => {
        const parts = f.name.split('.');
        const pkg = parts[0]; const fn = parts.slice(1).join('.');
        const row = document.createElement('div'); row.className = 'callstack-frame';
        row.innerHTML =
            `<span class="csf-idx">${idx + 1}</span>` +
            `<span class="csf-pkg">${esc(pkg)}</span>` +
            (fn ? `<span class="csf-sep">.</span><span class="csf-fn">${esc(fn)}</span>` : '') +
            `<span class="csf-line"> line ${esc(f.line)}</span>`;
        body.appendChild(row);
    });
    // Start toggle in open state
    tog.classList.add('open');
    tog.querySelector('.callstack-tog-icon').textContent = '▼';
    tog.addEventListener('click', e => {
        e.stopPropagation();
        const open = body.classList.toggle('open');
        tog.classList.toggle('open', open);
    });
    wrap.appendChild(body);
    rowEl.appendChild(wrap);
}

// ── Row helpers ────────────────────────────────────────────────────────────────
function trNode(cls, depth) {
    const r = document.createElement('div'); r.className = cls;
    const ind = document.createElement('span'); ind.className='tr-ind';
    for (let i=0; i<depth; i++) { const u=document.createElement('span');u.className='tr-iu';ind.appendChild(u); }
    r.appendChild(ind); return r;
}
function sp()                      { const s=document.createElement('span');s.className='tr-sp';return s; }
function txtSpan(html,style='',cls='tr-txt') { const s=document.createElement('span');s.className=cls;if(style)s.style.cssText=style;s.innerHTML=html;return s; }
function origBadge(o) { const s=document.createElement('span');s.className='tr-orig '+(o||'').toLowerCase();s.textContent=o||'';return s; }
function lvBadge(lv)  { const s=document.createElement('span');s.className='tr-lv '+lv;s.textContent=lv;return s; }

// ── Stats — single pass over raw array ────────────────────────────────────────
function calcStats(arr) {
    const c = {info:0, debug:0, warn:0, err:0, sql:0, plsql:0, hidden:0};
    for (let i=0; i<arr.length; i++) {
        const e = arr[i];
        if (isSql(e)) {
            if (isPLSQL(e.text || e.textWithBinds)) c.plsql++; else c.sql++;
            continue;
        }
        const lv = getLv(e);
        if      (lv==='INFORMATION') c.info++;
        else if (lv==='WARNING')     c.warn++;
        else if (lv==='ERROR')       c.err++;
        else                         c.debug++;
        if (isHiddenEntry(e.text))   c.hidden++;
    }
    return c;
}

// ── Parsers ────────────────────────────────────────────────────────────────────
function parseMethod(text) {
    const m = text.match(/Calling method:\s*([^.\s]+)\.([^\s(]+)\s*(?:\(([^)]+)\))?/);
    return m ? {pkg:m[1],fn:m[2],mod:m[3]||''} : null;
}
function parseParam(text) {
    // Match keys like attr_, customer_info_contact##, key_ref_ etc.
    // Value may contain \u001e \u001f and other control chars — use [\s\S]* not .*
    const m = text.match(/^(\w[\w#]*_?)\s*:\s*([\s\S]*)$/);
    return m ? {key:m[1], val:m[2]} : null;
}

// ── Aligned parameter formatter ───────────────────────────────────────────────
// Pads all keys in a sibling group to the same width, then uses => separator.
// `siblings` is the array of param entries from the same call (may be empty for
// standalone params, in which case no padding is applied).
function fmtParam(key, val, siblings) {
    let maxLen = key.length;
    if (siblings && siblings.length > 1) {
        siblings.forEach(s => {
            const pr = parseParam(s.text || '');
            if (pr && pr.key.length > maxLen) maxLen = pr.key.length;
        });
    }
    const pad = maxLen - key.length;
    const spaces = pad > 0 ? '\u00a0'.repeat(pad) : '';   // non-breaking spaces for reliable HTML spacing
    return `<span class="tr-pkey">${esc(key)}${spaces}</span>` +
           `<span class="tr-parrow"> =&gt; </span>` +
           `<span class="tr-pval">${esc(val)}</span>`;
}

// ── IFS attribute string (RS/US) parser & renderer ───────────────────────────
// IFS encodes key-value pairs as:  KEY\u001fVALUE\u001eKEY\u001fVALUE\u001e...
// \u001f = Unit Separator (US)  — separates key from value within a pair
// \u001e = Record Separator (RS) — separates pairs from each other
const US = '\u001f';
const RS = '\u001e';

function hasAttrString(text) {
    // Must contain at least one US and one RS to qualify
    return text.includes(US) && text.includes(RS);
}

function parseAttrString(attrStr) {
    // attrStr should already be the raw KEY\u001fVAL\u001e... portion
    // (callers must strip any "prefix_: " themselves before passing here)
    const pairs = [];
    const records = attrStr.split(RS);
    records.forEach(rec => {
        if (!rec) return;
        const sepIdx = rec.indexOf(US);
        if (sepIdx === -1) {
            pairs.push({ key: rec.trim(), val: null });
        } else {
            pairs.push({ key: rec.slice(0, sepIdx), val: rec.slice(sepIdx + 1) });
        }
    });
    return pairs;
}

// Renders an IFS attr string into the given row element.
// prefixKey: the "attr_" prefix name (or null for bare strings)
// raw: the full original text for copy
function renderAttrParam(rowEl, prefixKey, attrVal, raw) {
    const pairs = parseAttrString(attrVal);
    if (!pairs.length) {
        const pt = document.createElement('span'); pt.className='tr-txt';
        pt.textContent = raw; rowEl.appendChild(pt); return;
    }
    const maxKeyLen = pairs.reduce((m, p) => Math.max(m, p.key.length), 0);
    const wrap = document.createElement('div'); wrap.className = 'attr-wrap';

    // Prefix label row: "attr_:" + RS/US legend badges
    if (prefixKey) {
        const lbl = document.createElement('div'); lbl.className = 'attr-label-row';
        lbl.innerHTML =
            `<span class="tr-pkey attr-prefix">${esc(prefixKey)} (${raw?.length || 0})</span>` + ` = ` +
            `Column Name` + `<span class="attr-sep-badge us-badge" title="Unit Separator \\u001f">US</span>` + ' => ' +
            `Column Value` + `<span class="attr-sep-badge rs-badge" title="Record Separator \\u001e">RS</span>`;
        wrap.appendChild(lbl);
    } else {
        // Bare attr string — show badges inline at top
        const lbl = document.createElement('div'); lbl.className = 'attr-label-row';
        lbl.innerHTML =
            `<span class="attr-sep-badge rs-badge" title="Record Separator \\u001e">RS</span>` +
            `<span class="attr-sep-badge us-badge" title="Unit Separator \\u001f">US</span>`;
        wrap.appendChild(lbl);
    }

    // Key-value grid
    const grid = document.createElement('div'); grid.className = 'attr-grid';
    pairs.forEach(({ key, val }) => {
        const pad = '\u00a0'.repeat(Math.max(0, maxKeyLen - key.length));
        const keyEl = document.createElement('span'); keyEl.className = 'attr-key';
        keyEl.textContent = key + pad;
        const arrowEl = document.createElement('span'); arrowEl.className = 'attr-arrow';
        arrowEl.textContent = ' => ';
        const valEl = document.createElement('span');
        valEl.className = val === null ? 'attr-val attr-val-bare' : (val === '' ? 'attr-val attr-val-empty' : 'attr-val');
        valEl.textContent = val === null ? '(no value)' : (val === '' ? '∅' : val);
        grid.appendChild(keyEl);
        grid.appendChild(arrowEl);
        grid.appendChild(valEl);
    });
    wrap.appendChild(grid);
    rowEl.appendChild(wrap);
}

// ── Collapse-children context menu ───────────────────────────────────────────
// Right-clicking any call row shows a tiny menu with:
//   • Collapse children      — hide all rows with depth > this row's depth
//   • Expand children        — show all rows with depth > this row's depth
// "Children" = every DOM row between this row and the next sibling at same/
// shallower depth.  We detect depth from the .tr-ind span's child count.

let _ctxMenu = null;   // singleton menu element

function getRowDepth(rowEl) {
    const ind = rowEl.querySelector('.tr-ind');
    return ind ? ind.children.length : 0;
}

function getChildRows(anchorRow) {
    const depth = getRowDepth(anchorRow);
    const children = [];
    let el = anchorRow.nextElementSibling;
    while (el) {
        if (!el.classList.contains('tr-node') && !el.classList.contains('tr-group-header')) break;
        const d = getRowDepth(el);
        if (d <= depth) break;   // back to same or shallower — stop
        children.push(el);
        el = el.nextElementSibling;
    }
    return children;
}

function collapseChildren(anchorRow) {
    getChildRows(anchorRow).forEach(el => el.classList.add('cc-hidden'));
    anchorRow.classList.add('has-cc');   // marks that children are collapsed via context-menu
}

function expandChildren(anchorRow) {
    getChildRows(anchorRow).forEach(el => el.classList.remove('cc-hidden'));
    anchorRow.classList.remove('has-cc');
}

function dismissCtxMenu() {
    if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
}

function addCollapseChildrenMenu(rowEl, depth) {
    rowEl.addEventListener('contextmenu', e => {
        e.preventDefault();
        dismissCtxMenu();

        const children = getChildRows(rowEl);
        if (!children.length) return;   // no children — nothing to show

        const menu = document.createElement('div');
        menu.id = 'ctx-menu';
        _ctxMenu = menu;

        const alreadyCollapsed = children.some(c => c.classList.contains('cc-hidden'));

        function item(label, action) {
            const btn = document.createElement('button');
            btn.className = 'ctx-item'; btn.textContent = label;
            btn.addEventListener('click', () => { action(); dismissCtxMenu(); });
            menu.appendChild(btn);
        }

        item('⊟  Collapse children', () => collapseChildren(rowEl));
        item('⊞  Expand children',   () => expandChildren(rowEl));
        menu.appendChild(Object.assign(document.createElement('div'), {className:'ctx-sep'}));
        item('⊟  Collapse all descendants', () => {
            // Collapse every call-row within the children set that itself has children
            collapseChildren(rowEl);
            getChildRows(rowEl).filter(c => c.classList.contains('clickable')).forEach(child => {
                if (getChildRows(child).length) collapseChildren(child);
            });
        });

        // Position near cursor but keep inside the panel
        menu.style.cssText = `position:fixed;z-index:9999;left:${e.clientX}px;top:${e.clientY}px`;
        document.body.appendChild(menu);

        // Nudge back inside if it overflows
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            if (rect.right  > window.innerWidth)  menu.style.left = (e.clientX - rect.width)  + 'px';
            if (rect.bottom > window.innerHeight)  menu.style.top  = (e.clientY - rect.height) + 'px';
        });
    });
}

// Dismiss on any outside click or Escape
document.addEventListener('click',   dismissCtxMenu);
document.addEventListener('keydown', e => { if (e.key==='Escape') dismissCtxMenu(); });

// ── Export trace ──────────────────────────────────────────────────────────────
// Serialises the currently visible trace (honouring mode + hidden filters) to
// a plain-text file and triggers a browser download.
function exportTrace(traceArr, req) {
    const nodes = buildNodes(traceArr);
    const lines = [];

    // Header
    const ts  = new Date().toISOString().replace('T',' ').replace(/\..+/,'');
    const url = req.url || '';
    lines.push('='.repeat(80));
    lines.push(`IFS Inspector — Trace Export`);
    lines.push(`Mode    : ${viewMode.toUpperCase()}`);
    lines.push(`URL     : ${url}`);
    lines.push(`Exported: ${ts}`);
    lines.push('='.repeat(80));
    lines.push('');

    nodes.forEach(node => {
        if (shouldHide(node)) return;

        const indent = '  '.repeat(node.depth || 0);

        if (node.kind === 'hidden') {
            if (viewMode !== 'full') return;
            lines.push(`${indent}[hidden] ${node.e.text} (+${node.count - 1})`);
            return;
        }

        if (node.kind === 'sql' || node.kind === 'mt' && node.e.type === 'sql') {
            const label = isPLSQL(node.e.text) ? 'PLSQL' : 'SQL';
            lines.push(`${indent}[MT:${label}] ${node.e.text || ''}`);
            // Also export bind params if present
            if (node.e.bindParams) {
                Object.entries(node.e.bindParams).forEach(([k, v]) => {
                    const dir  = v.direction || '';
                    const val  = v.value != null ? String(v.value) : 'null';
                    const type = v.dbType || '';
                    lines.push(`${indent}  :${k} (${dir} ${type}) = ${val}`);
                });
            }
            lines.push('');
            return;
        }

        if (node.kind === 'mt') {
            if (viewMode === 'minimal') return;
            lines.push(`${indent}[MT] ${node.e.text || ''}`);
            return;
        }

        if (node.kind === 'call') {
            const pm  = parseMethod(node.e.text || '');
            const lv  = node.lv && node.lv !== 'DEBUG' ? ` [${node.lv}]` : '';
            const sig = pm ? `${pm.pkg}.${pm.fn}${pm.mod ? ` (${pm.mod})` : ''}` : (node.e.text || '');
            lines.push(`${indent}▶ ${sig}${lv}`);

            // Inline params
            if (node.params.length > 0) {
                const maxLen = node.params.reduce((m, p) => {
                    const pr = parseParam(p.text || '');
                    return pr ? Math.max(m, pr.key.length) : m;
                }, 0);
                node.params.forEach(p => {
                    const pr = parseParam(p.text || '');
                    if (pr) {
                        const pad = ' '.repeat(Math.max(0, maxLen - pr.key.length));
                        lines.push(`${indent}  ${pr.key}${pad} => ${pr.val}`);
                    } else {
                        lines.push(`${indent}  ${p.text || ''}`);
                    }
                });
            }
            return;
        }

        if (node.kind === 'param') {
            const pr = parseParam(node.e.text || '');
            if (pr) {
                lines.push(`${indent}  ${pr.key} => ${pr.val}`);
            } else {
                // attr_ string — expand key/value pairs
                if (hasAttrString(node.e.text || '')) {
                    const prOuter = parseParam(node.e.text || '');
                    const attrVal = prOuter ? prOuter.val : node.e.text;
                    const pairs   = parseAttrString(attrVal);
                    if (prOuter) lines.push(`${indent}  ${prOuter.key}:`);
                    pairs.forEach(({key, val}) => {
                        lines.push(`${indent}    ${key} => ${val !== null ? val : '(no value)'}`);
                    });
                } else {
                    lines.push(`${indent}  ${node.e.text || ''}`);
                }
            }
            return;
        }

        // text / INFO
        const lv  = node.lv && node.lv !== 'DEBUG' ? `[${node.lv}] ` : '';
        lines.push(`${indent}${lv}${node.e.text || ''}`);
    });

    lines.push('');
    lines.push(`— End of trace (${nodes.length} entries) —`);

    // Build filename: method_entityset_mode_timestamp.txt
    let namePart = 'trace';
    try {
        const u = new URL(url);
        const seg = u.pathname.split('/').filter(Boolean).pop() || 'trace';
        namePart = seg.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    } catch {}
    const method = (req.method || 'REQ').toUpperCase();
    const dateStr = new Date().toISOString().slice(0,19).replace(/[T:]/g,'-');
    const filename = `${method}_${namePart}_${viewMode}_${dateStr}.txt`;

    const blob = new Blob([lines.join('\n')], {type: 'text/plain;charset=utf-8'});
    const url2 = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url2; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url2), 2000);

    // Show brief "Exported" confirmation on the button
    const btn = document.getElementById('export-btn');
    if (btn) {
        const prev = btn.textContent;
        btn.textContent = '✓ Exported';
        btn.classList.add('exported');
        setTimeout(() => { btn.textContent = prev; btn.classList.remove('exported'); }, 2000);
    }
}

// ── Settings panel (patterns + null-indent checkbox) ──────────────────────────
function buildSettingsPanel(onRebuild) {
    const panel = document.createElement('div');

    function refresh() {
        panel.innerHTML = `
        <h4>Hidden Method Patterns</h4>
        <p>Entries whose text matches any pattern below are suppressed.</p>
        <div class="pat-list">${hiddenPats.map((p,i) =>
            `<div class="pat-row">
                <label title="${esc(p)}">${esc(p)}</label>
                <button class="pat-del" data-i="${i}">✕</button>
            </div>`
        ).join('')}</div>
        <div class="pat-add">
            <input id="pat-input" type="text" placeholder="e.g. Assert_API.">
            <button id="pat-add-btn">Add</button>
        </div>
        <button class="pat-reset" id="pat-reset">Reset to defaults</button>
        <div class="pat-divider"></div>
        <label class="pat-checkbox-row" title="Hides rows where indentation is empty/null (raw data dumps like attr_:)">
            <input type="checkbox" id="chk-hide-null" ${hideNullIndent ? 'checked' : ''}>
            Hide rows with no indentation
        </label>`;

        panel.querySelector('#chk-hide-null').addEventListener('change', function() {
            hideNullIndent = this.checked;
            localStorage.setItem(LS_HIDE_NULL, hideNullIndent);
            onRebuild();
        });
        panel.querySelectorAll('.pat-del').forEach(b => b.addEventListener('click', () => {
            hiddenPats.splice(+b.dataset.i,1); saveHidden(); refresh(); onRebuild();
        }));
        panel.querySelector('#pat-add-btn').addEventListener('click', () => {
            const v = panel.querySelector('#pat-input').value.trim();
            if (v && !hiddenPats.includes(v)) { hiddenPats.push(v); saveHidden(); refresh(); onRebuild(); }
        });
        panel.querySelector('#pat-input').addEventListener('keydown', e => {
            if (e.key==='Enter') panel.querySelector('#pat-add-btn').click();
        });
        panel.querySelector('#pat-reset').addEventListener('click', () => {
            hiddenPats=DEFAULT_HIDDEN.slice(); saveHidden(); refresh(); onRebuild();
        });
    }

    refresh(); return panel;
}

// ════════════════════════════════════════════════════════════════════════════
// WATERFALL TAB
// ════════════════════════════════════════════════════════════════════════════
function renderWaterfall(r) {
    const pane=document.getElementById('tab-waterfall'); const server=r.data&&r.data.server;
    const runtime=server&&server.runtime; const har=r.har; pane.innerHTML='';
    const wrap=el('div','id=waterfall-container');
    if (har.timings) {
        const t=har.timings; const total=Object.values(t).filter(v=>v>0).reduce((a,b)=>a+b,0);
        const sec=el('div','class=wf-section');
        sec.innerHTML=`<div class="wf-section-title">Network Timing</div>
            <div class="wf-total">Total: ${fmtMs(har.time)} &nbsp;|&nbsp; Transfer: ${fmtBytes(har.response.bodySize)}</div>`;
        [{key:'blocked',label:'Blocked',color:'#888'},{key:'dns',label:'DNS',color:'#4da6ff'},
         {key:'connect',label:'Connect',color:'#4ec9b0'},{key:'ssl',label:'SSL',color:'#c792ea'},
         {key:'send',label:'Send',color:'#dcdcaa'},{key:'wait',label:'Wait (TTFB)',color:'#f0a500'},
         {key:'receive',label:'Receive',color:'#4daa4d'}
        ].forEach(ph => {
            const v=t[ph.key]; if (!v||v<=0) return;
            const pct=total>0?(v/total*100):0; const rw=el('div','class=timing-bar-wrap');
            rw.innerHTML=`<span class="timing-label">${ph.label}</span>
                <div class="timing-bar" style="width:${Math.max(pct,.5)}%;background:${ph.color};flex:0 0 ${Math.max(pct*2,.5)}px;max-width:200px"></div>
                <span class="timing-val">${fmtMs(v)}</span>`;
            sec.appendChild(rw);
        });
        wrap.appendChild(sec);
    }
    if (runtime&&runtime.length) {
        const sec=el('div','class=wf-section'); sec.innerHTML='<div class="wf-section-title">Server Runtime</div>';
        renderRuntimeNodes(runtime,runtime[0].duration||1,sec,0); wrap.appendChild(sec);
    } else {
        const empty=document.createElement('div'); empty.style.cssText='color:var(--text3);padding:12px';
        empty.textContent='No runtime data available.'; wrap.appendChild(empty);
    }
    pane.appendChild(wrap);
}
function renderRuntimeNodes(nodes,totalUs,container,depth) {
    nodes.forEach(node => {
        const pct=Math.min((node.duration/totalUs)*100,100);
        const color=['#4da6ff','#4ec9b0','#dcdcaa','#f0a500','#c792ea','#4daa4d','#e05555'][depth%7];
        const dur=node.unit==='µs'?(node.duration/1000).toFixed(2)+'ms':fmtMs(node.duration);
        const rw=el('div','class=wf-row'); const labelW=Math.max(0,180-depth*12);
        rw.innerHTML=`<div class="wf-label" style="width:${labelW}px;padding-left:${depth*10}px" title="${esc(node.class)}.${esc(node.method)}">${esc(node.class)}.${esc(node.method)}</div>
            <div class="wf-bar-track"><div class="wf-bar" style="width:${Math.max(pct,.3)}%;background:${color};left:0"><span class="wf-dur">${dur}</span></div></div>`;
        container.appendChild(rw);
        if (node.children&&node.children.length) renderRuntimeNodes(node.children,totalUs,container,depth+1);
    });
}

// ════════════════════════════════════════════════════════════════════════════
// REQUEST / RESPONSE / SERVER TABS  (unchanged logic)
// ════════════════════════════════════════════════════════════════════════════
function renderRequestTab(r) {
    const pane=document.getElementById('tab-request'); const har=r.har; pane.innerHTML='';
    section(pane,'General',[['URL',har.request.url],['Method',har.request.method],
        ['Status',`${har.response.status} ${har.response.statusText||''}`,har.response.status>=400?'err':'ok'],
        ['Duration',fmtMs(har.time),speedClass(har.time)||''],['Size',fmtBytes(har.response.bodySize)]]);
    if (har.request.postData&&har.request.postData.text) {
        try { const p=JSON.parse(har.request.postData.text); codeBlockHtml(pane,'Request Body',highlightJson(JSON.stringify(p,null,2))); }
        catch { codeBlockHtml(pane,'Request Body',highlightJson(har.request.postData.text)); }
    }
    if (har.request.queryString&&har.request.queryString.length) {
        const qs=el('div','class=info-section'); qs.innerHTML='<h3>Query Parameters</h3>';
        const tbl=el('table','class=headers-table');
        har.request.queryString.forEach(p => { const tr2=document.createElement('tr');tr2.innerHTML=`<td>${esc(p.name)}</td><td>${esc(decodeURIComponent(p.value))}</td>`;tbl.appendChild(tr2); });
        qs.appendChild(tbl); pane.appendChild(qs);
    }
    if (har.request.headers&&har.request.headers.length) hdrs(pane,'Request Headers',har.request.headers);
}
function renderResponseTab(r) {
    const pane=document.getElementById('tab-response'); pane.innerHTML='';
    if (r.har.response.headers) hdrs(pane,'Response Headers',r.har.response.headers);

    // Prefer hook-provided body; fall back to HAR content body.
    const hookBody = r.data && r.data.response && r.data.response.body;
    const harBody  = !hookBody ? getHarBodyJson(r) : null;
    const bodyData = hookBody || harBody;

    if (bodyData) {
        try {
            const o = typeof bodyData === 'string' ? JSON.parse(bodyData) : bodyData;
            codeBlockHtml(pane, 'Response Body', highlightJson(JSON.stringify(o, null, 2)));
        } catch {
            codeBlockHtml(pane, 'Response Body', highlightJson(String(bodyData)));
        }
    }
}
function renderServerTab(r) {
    const pane=document.getElementById('tab-server'); pane.innerHTML='';
    const server=r.data&&r.data.server;
    if (!server) { pane.innerHTML='<div style="padding:20px;color:var(--text3)">No server data available.</div>'; return; }
    if (server.version) section(pane,'Server',[['Version',server.version]]);
    if (server.environment) {
        const env=server.environment;
        section(pane,'Environment',[['Auth Type',env.authType||''],['Remote User',env.remoteUser||''],
            ['Server Name',env.serverName||''],['Local Address',env.localAddr||''],
            ['Local Port',env.localPort||''],['Remote Addr',env.remoteAddr||''],
            ['Scheme',env.scheme||''],['Path Info',env.pathInfo||'']]);
    }
    if (server.uri) {
        const uri=server.uri; const sec=el('div','class=info-section'); sec.innerHTML='<h3>URI Info</h3>';
        row(sec,'Kind',uri.kind||'');
        if (uri.uriResourceParts) uri.uriResourceParts.forEach((part,i) => {
            row(sec,`Resource ${i+1}`,`${part.uriResourceKind}: ${part.segment||''} → ${part.type||''}`);
            if (part.parameters) Object.entries(part.parameters).forEach(([k,v])=>row(sec,`  ${k}`,v));
        });
        if (uri.aliases) Object.entries(uri.aliases).forEach(([k,v])=>row(sec,`Alias ${k}`,v));
        pane.appendChild(sec);
    }
    const ifsTrace=r.data['ifs-trace'];
    if (ifsTrace&&ifsTrace.authStatus) section(pane,'Auth',[['Status',ifsTrace.authStatus]]);
}

// ─── Shared UI helpers ────────────────────────────────────────────────────────
function el(tag,attrStr='') {
    const e=document.createElement(tag);
    attrStr.split(/\s+/).forEach(a=>{const[k,...v]=a.split('=');if(k&&v.length)e.setAttribute(k,v.join('='));});
    return e;
}
function section(parent,title,rows) {
    const sec=el('div','class=info-section'); sec.innerHTML=`<h3>${esc(title)}</h3>`;
    rows.forEach(([k,v,cls])=>row(sec,k,v,cls)); parent.appendChild(sec);
}
function row(parent,key,val,cls='') {
    const r=el('div','class=info-row');
    r.innerHTML=`<span class="info-key">${esc(key)}</span><span class="info-val ${cls}">${esc(String(val))}</span>`;
    parent.appendChild(r);
}
function hdrs(parent,title,headers) {
    const sec=el('div','class=info-section'); sec.innerHTML=`<h3>${esc(title)}</h3>`;
    const tbl=el('table','class=headers-table');
    headers.forEach(h=>{const tr2=document.createElement('tr');tr2.innerHTML=`<td>${esc(h.name)}</td><td>${esc(h.value)}</td>`;tbl.appendChild(tr2);});
    sec.appendChild(tbl); parent.appendChild(sec);
}
function codeBlock(parent,title,text) {
    const sec=el('div','class=info-section'); sec.innerHTML=`<h3>${esc(title)}</h3>`;
    const pre=el('div','class=code-block'); pre.textContent=text;
    parent.appendChild(sec); parent.appendChild(pre);
}
function codeBlockHtml(parent,title,html) {
    const sec=el('div','class=info-section'); sec.innerHTML=`<h3>${esc(title)}</h3>`;
    const pre=el('div','class=code-block'); pre.innerHTML=html;
    parent.appendChild(sec); parent.appendChild(pre);
}
function esc(s)     { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ─── Coexistence banner ───────────────────────────────────────────────────────
function showCoexistBanner() {
    if (document.getElementById('coexist-banner')) return;  // already shown
    const banner = document.createElement('div');
    banner.id = 'coexist-banner';
    banner.innerHTML =
        '<span>⚠ IFS Cloud Web DevTools is also active. Hook events are shared — ' +
        'both extensions receive the same data. HAR capture is independent.</span>' +
        '<button id="coexist-dismiss">✕</button>';
    document.body.insertBefore(banner, document.getElementById('views-bar'));
    document.getElementById('coexist-dismiss').addEventListener('click', function () {
        banner.remove();
    });
}
function fmtMs(ms)  { return ms>=1000?(ms/1000).toFixed(2)+'s':Math.round(ms)+'ms'; }
function fmtBytes(b){ if(!b||b<0)return'—';if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';return(b/1048576).toFixed(1)+'MB'; }

// ── Bootstrap ─────────────────────────────────────────────────────────────────
initClientLogsView();

// ════════════════════════════════════════════════════════════════════════════
// DETAIL TAB BAR — Summary | Trace | Waterfall | Request | Response | Server
// ════════════════════════════════════════════════════════════════════════════
(function initDetailTabs() {
    const btns  = document.querySelectorAll('.detail-tab-btn');
    const panes = document.querySelectorAll('.detail-tab-pane');
    btns.forEach(btn => {
        btn.addEventListener('click', () => {
            btns.forEach(b => b.classList.remove('active'));
            panes.forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const pane = document.getElementById('dtab-' + btn.dataset.dtab);
            if (pane) pane.classList.add('active');

            if (btn.dataset.dtab === 'trace-standalone') {
                const firstSubBtn  = pane && pane.querySelector('.subtab-btn');
                const firstSubPane = pane && pane.querySelector('.subtab-pane');
                if (firstSubBtn && firstSubPane) {
                    pane.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('active'));
                    pane.querySelectorAll('.subtab-pane').forEach(p => p.classList.remove('active'));
                    firstSubBtn.classList.add('active');
                    firstSubPane.classList.add('active');
                }
            }
        });
    });
})();

// ── Detail card collapse functionality ──────────────────────────────────────
(function initDetailCardCollapse() {
    function updateGridCollapseState() {
        const cards = document.querySelectorAll('#req-resp-grid .detail-card');
        const grid = document.getElementById('req-resp-grid');
        if (!grid) return;
        const allCollapsed = Array.from(cards).every(card => card.classList.contains('collapsed'));
        grid.classList.toggle('all-collapsed', allCollapsed);
    }

    document.addEventListener('click', (e) => {
        const header = e.target.closest('.detail-card-header');
        if (!header) return;
        const card = header.closest('.detail-card');
        if (card) {
            card.classList.toggle('collapsed');
            updateGridCollapseState();
        }
    });
})();

// ── Standalone Trace tab renderer (renders into #tab-trace-standalone) ────────
// Identical logic to renderTrace but targets the standalone pane.
function renderTraceStandalone(r) {
    const pane = document.getElementById('tab-trace-standalone');
    if (!pane) return;
    pane.innerHTML = '';

    const exceptions = getExceptions(r);
    const hasExc = exceptions && exceptions.length > 0;

    const subBar = el('div','class=subtab-bar');
    const btnTrace = el('button','class=subtab-btn active'); btnTrace.textContent = 'Trace';
    const btnExc   = el('button',`class=subtab-btn${hasExc?' has-errors':''}`);
    btnExc.innerHTML = `Exceptions${hasExc ? ` <span class="subtab-count-badge">${exceptions.length}</span>` : ''}`;
    subBar.appendChild(btnTrace);
    subBar.appendChild(btnExc);
    pane.appendChild(subBar);

    const tracePane = el('div','class=subtab-pane');
    const excPane   = el('div','class=subtab-pane');
    
    // ── FORCE visibility immediately with inline styles ──────────────────
    tracePane.style.display = 'flex';
    tracePane.style.flexDirection = 'column';
    tracePane.style.flex = '1';
    tracePane.style.overflow = 'auto';
    excPane.style.display = 'none';

    pane.appendChild(tracePane);
    pane.appendChild(excPane);

    btnTrace.addEventListener('click', () => {
        btnTrace.classList.add('active'); btnExc.classList.remove('active');
        tracePane.style.display = 'flex';
        excPane.style.display = 'none';
    });
    btnExc.addEventListener('click', () => {
        btnExc.classList.add('active'); btnTrace.classList.remove('active');
        excPane.style.display = 'flex';
        tracePane.style.display = 'none';
    })

    renderExceptions(excPane, exceptions);

    const trace = r.data && r.data['ifs-trace'] && r.data['ifs-trace'].trace;
    if (!trace || !trace.length) {
        tracePane.innerHTML = '<div style="padding:20px;color:var(--text3)">No trace data in this response.</div>';
        return;
    }

    // Toolbar
    const toolbar = el('div','id=trace-toolbar-standalone');
    toolbar.setAttribute('style', toolbar.getAttribute('style') || '');
    toolbar.className = 'trace-toolbar-standalone';

    // Apply same #trace-toolbar styles via class (reuse CSS)
    toolbar.id = ''; // avoid ID conflict with summary tab's toolbar
    toolbar.setAttribute('id','trace-toolbar-sa');

    const stats = calcStats(trace);
    const statsWrap = el('div','class=toolbar-stats');
    statsWrap.innerHTML =
        `<span class="stat-chip info">INFO ${stats.info}</span>` +
        `<span class="stat-chip debug">DEBUG ${stats.debug}${stats.hidden ? ` <span style="color:var(--text3)">(${stats.hidden} hidden)</span>` : ''}</span>` +
        (stats.sql   ? `<span class="stat-chip sql">SQL ${stats.sql}</span>` : '') +
        (stats.plsql ? `<span class="stat-chip plsql">PLSQL ${stats.plsql}</span>` : '') +
        (stats.warn  ? `<span class="stat-chip warn">WARN ${stats.warn}</span>` : '') +
        (stats.err   ? `<span class="stat-chip err">ERROR ${stats.err}</span>` : '');
    toolbar.appendChild(statsWrap);

    const modeWrap = el('div','style=display:flex;gap:3px');
    const treeContainer = el('div','class=trace-tree-sa');
    treeContainer.id = 'trace-tree-sa';

    MODES.forEach(m => {
        const b = el('button',`class=mode-btn${viewMode===m?' active':''}`);
        b.textContent = MODE_LABELS[m]; b.dataset.m = m;
        b.addEventListener('click', () => {
            viewMode = m; localStorage.setItem(LS_MODE, m);
            modeWrap.querySelectorAll('.mode-btn').forEach(x => x.classList.toggle('active', x.dataset.m===m));
            renderTraceTree(trace, treeContainer);
        });
        modeWrap.appendChild(b);
    });
    toolbar.appendChild(modeWrap);

    if (stats.err > 0) {
        const jumpBtn = el('button','class=jump-err-btn-sa');
        jumpBtn.id = 'jump-error-btn-sa';
        jumpBtn.innerHTML = '⬇ Jump to Error';
        jumpBtn.addEventListener('click', () => {
            const firstErr = treeContainer.querySelector('.lv-error, .is-error-origin');
            if (firstErr) firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        toolbar.appendChild(jumpBtn);
    }

    const exportBtn = el('button','class=export-btn-sa');
    exportBtn.textContent = '⬇ Export';
    exportBtn.addEventListener('click', e => { e.stopPropagation(); exportTrace(trace, r); });
    toolbar.appendChild(exportBtn);

    const cogBtn = el('button','class=cog-btn-sa');
    cogBtn.textContent = '⚙'; cogBtn.title = 'Filter settings';
    const sp = buildSettingsPanel(() => renderTraceTree(trace, treeContainer));
    sp.className = 'log-settings-panel'; sp.style.cssText = 'display:none;position:absolute;top:34px;right:6px;z-index:999';
    cogBtn.addEventListener('click', e => {
        e.stopPropagation();
        sp.style.display = sp.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { sp.style.display = 'none'; });
    sp.addEventListener('click', e => e.stopPropagation());
    toolbar.appendChild(cogBtn);

    // Wrap toolbar + settings in a relative container
    const toolbarWrap = el('div','style=position:relative');
    toolbarWrap.id = 'trace-toolbar';  // reuse existing CSS
    toolbarWrap.appendChild(toolbar);
    toolbarWrap.appendChild(sp);
    tracePane.appendChild(toolbarWrap);

    treeContainer.id = 'trace-tree'; // reuse CSS
    tracePane.appendChild(treeContainer);
    renderTraceTree(trace, treeContainer);
}
