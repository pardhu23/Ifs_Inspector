// Runs in isolated-world content script context.
// Listens for hook events posted from the page via postMessage
// and forwards them to the service worker over a chrome.runtime port.
//
// Isolation: Only messages whose `source` field matches our extension's
// unique channel name (received via handshake) are forwarded.
// This prevents two copies of this extension from double-counting events.

(function () {
    'use strict';

    var port = null;
    // The source tag our backend.js will use. Derived from our extension ID
    // so that if two copies of the extension run they each use a distinct tag.
    var mySource = '__ifs_inspector_' + chrome.runtime.id + '__';

    function connect() {
        try {
            port = chrome.runtime.connect({ name: 'ifs-inspector-content' });
            port.onDisconnect.addListener(function () {
                port = null;
                // Check if the disconnect was due to an error
                if (chrome.runtime.lastError) {
                    console.warn('[IFS Inspector proxy] port disconnected:', chrome.runtime.lastError.message);
                }
                // Auto-reconnect after a short back-off so we don't lose events
                // if the service worker was temporarily asleep or page is back from bfcache.
                setTimeout(connect, 500);
            });
        } catch (e) {
            // Extension context invalidated (e.g. extension reloaded while page is open).
            // Stop retrying — we're a dead stub.
            console.warn('[IFS Inspector proxy] connection failed:', e.message);
            port = null;
        }
    }
    connect();

    window.addEventListener('message', function (e) {
        if (!e.data) return;

        // Receive the handshake from backend.js (sanity-check only — we already
        // know our own source from chrome.runtime.id, but this confirms backend
        // loaded correctly).
        if (e.data.source === '__ifs_inspector_handshake__') {
            // Nothing to do; our source is already set from chrome.runtime.id.
            return;
        }

        // Only forward messages from our own backend — ignore any other extension.
        if (e.data.source !== mySource) return;

        if (!port) connect();
        if (!port) return;
        try {
            port.postMessage(e.data.payload);
            // Check for errors after postMessage (port might have been closed)
            if (chrome.runtime.lastError) {
                console.warn('[IFS Inspector proxy] postMessage error:', chrome.runtime.lastError.message);
                port = null;
                // Try to reconnect immediately for next message
                setTimeout(connect, 100);
            }
        } catch (err) {
            console.error('[IFS Inspector proxy] postMessage threw:', err.message);
            port = null;
            setTimeout(connect, 100);
        }
    }, false);
}());
