// Injected into the real page context by devtools.js when the panel opens.
// Subscribes to window.__IFS_AURENA_DEVTOOLS__ and forwards every
// TO_DEVTOOLS_MESSAGE event to the DevTools panel via postMessage → proxy.js.
//
// Coexistence with IFS Cloud Web DevTools:
//   Both extensions subscribe to the same hook EventEmitter — that is fine,
//   the hook supports multiple listeners. The only risk is that IFS Cloud Web
//   DevTools replaces the hook object after we subscribed to the old one.
//   We guard against this by polling indefinitely for hook replacement and
//   re-subscribing whenever the object changes.
//
// Isolation from other extensions:
//   We use a unique postMessage source tag '__ifs_inspector_<EXTENSION_ID>__'
//   so that a second copy of this extension (or a similar extension) never
//   double-processes our own events.  The proxy.js counterpart must match.
(function () {
    'use strict';

    // ── Extension-unique channel name ─────────────────────────────────────────
    // Derived from chrome.runtime.id injected as a data attribute on the script
    // tag, or falls back to a stable sentinel. This prevents two copies of the
    // extension from cross-posting to each other's proxy.
    var EXT_ID = (document.currentScript && document.currentScript.dataset.extId) || 'ifs-inspector';
    var MSG_SOURCE = '__ifs_inspector_' + EXT_ID + '__';

    var hook = window.__IFS_AURENA_DEVTOOLS__;
    if (!hook || typeof hook.on !== 'function') {
        console.warn('[IFS Inspector backend] hook not found — trace events will not be captured.');
        return;
    }

    // Mark devtools as shown so the IFS client activates its trace mode.
    window.__IFS_AURENA_DEVTOOLS_SHOWN__ = true;
    if (hook.enabled === undefined) hook.enabled = true;

    function forward(payload) {
        window.postMessage({
            source: MSG_SOURCE,
            payload: { type: 'IFS_HOOK_EVENT', hookPayload: payload },
        }, '*');
    }

    // Subscribe and remember what we subscribed to so we can detect swaps.
    function subscribe(h) {
        h.on('d:message', forward);
        window.__IFS_AURENA_DEVTOOLS_SHOWN__ = true;
        if (h.enabled === undefined) h.enabled = true;
    }
    subscribe(hook);

    // ── Coexistence guard (indefinite) ────────────────────────────────────────
    // If IFS Cloud Web DevTools loads after us and replaces window.__IFS_AURENA_DEVTOOLS__
    // with its own hook object, our subscription above is now on a dead stub.
    // Poll continuously (slower after 10 s to save CPU) and re-subscribe
    // whenever the hook object is swapped out.
    var activeHook = hook;
    var guardInterval = 300;

    function runGuard() {
        var current = window.__IFS_AURENA_DEVTOOLS__;
        if (current && current !== activeHook && typeof current.on === 'function') {
            activeHook = current;
            subscribe(activeHook);
        }
        // Slow down after the page has been stable for 10 s
        if (guardInterval < 2000) guardInterval = Math.min(guardInterval * 2, 2000);
        setTimeout(runGuard, guardInterval);
    }
    setTimeout(runGuard, guardInterval);

    // ── Broadcast the unique source name to proxy.js ──────────────────────────
    // proxy.js is loaded in the isolated world and needs to know which source
    // tag to filter on. We post a one-time handshake that proxy.js picks up.
    window.postMessage({ source: '__ifs_inspector_handshake__', msgSource: MSG_SOURCE }, '*');
}());
