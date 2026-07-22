// devtools.js — runs in the DevTools page context.
// Two parallel capture paths:
//
//  Path A (HAR):  chrome.devtools.network.onRequestFinished
//                 → captures every completed network request with full headers/body.
//                 Works in all cases. Does NOT include server-side trace data.
//
//  Path B (Hook): inject backend.js into the inspected page → page hook emits
//                 → proxy.js content script forwards via port → service worker
//                 → port here → panel gets rich { type, data, storeContext }.
//                 Provides server stacktrace, db trace, runtime waterfall, etc.
//                 Works whether or not IFS Cloud Web DevTools is installed,
//                 because our own inject-hook.js installs the global at document_start.

chrome.devtools.panels.create('IFS Inspector', '', '../panel/panel.html',
  function (panel) {
    let port      = null;   // MessageChannel port to the panel window
    const queue   = [];     // messages buffered before panel is shown

    // ── Port to panel window ──────────────────────────────────────────────────
    panel.onShown.addListener(function (panelWindow) {
      if (panelWindow.connectDevtools) {
        port = panelWindow.connectDevtools();
        port.onmessage = handlePanelMessage;
      }
      queue.splice(0).forEach(function (msg) { port && port.postMessage(msg); });
    });

    panel.onHidden.addListener(function () {
      port = null;
    });

    // ── Panel → page: restore an (edited) clipboard snapshot ──────────────────
    // The Clipboard tab lets the user pick a past copy, edit fields, then push
    // it back into the page so a subsequent "Paste Rows" in IFS uses it.
    // This writes directly via inspectedWindow.eval — no content-script round
    // trip needed, since it's a one-shot write rather than an ongoing stream.
    function handlePanelMessage(event) {
      var msg = event.data;
      if (!msg || msg.type !== 'RESTORE_CLIPBOARD') return;

      var json = JSON.stringify(msg.rows || []);
      chrome.devtools.inspectedWindow.eval(
        '(function(){' +
        '  try {' +
        '    localStorage.setItem("IFS-Aurena-CopyPasteRecordStorage", ' + JSON.stringify(json) + ');' +
        '    return true;' +
        '  } catch (e) { return false; }' +
        '})()',
        function (result, isException) {
          send({ type: 'RESTORE_CLIPBOARD_RESULT', ok: !!result && !isException, requestId: msg.requestId });
        }
      );
    }

    function send(msg) {
      if (port) {
        try {
          port.postMessage(msg);
          if (chrome.runtime.lastError) {
            console.warn('[IFS Inspector devtools] postMessage error:', chrome.runtime.lastError.message);
            port = null;
            queue.push(msg); // Re-queue for when panel reconnects
          }
        } catch (err) {
          console.error('[IFS Inspector devtools] postMessage threw:', err.message);
          port = null;
          queue.push(msg); // Re-queue for when panel reconnects
        }
      } else {
        queue.push(msg);
      }
    }

    // ── Path B: service worker port (hook events) ─────────────────────────────
    // MV3 service workers terminate after ~30 s of inactivity. When that happens
    // the port disconnects. We must reconnect so the service worker can register
    // a fresh devtools port and resume forwarding content-script messages.
    var swPort = null;

    function connectToSW() {
      try {
        swPort = chrome.runtime.connect({
          name: String(chrome.devtools.inspectedWindow.tabId),
        });
        swPort.onMessage.addListener(function (msg) {
          if (msg && msg.type === 'IFS_HOOK_EVENT') {
            send({ type: 'IFS_HOOK_EVENT', hookPayload: msg.hookPayload });
          }
        });
        swPort.onDisconnect.addListener(function () {
          swPort = null;
          // Check for disconnect errors (e.g., bfcache, extension reload)
          if (chrome.runtime.lastError) {
            console.warn('[IFS Inspector devtools] service worker port disconnected:', chrome.runtime.lastError.message);
          }
          // Back off briefly so a crash loop doesn't spin the CPU.
          // Longer backoff on repeated failures.
          setTimeout(connectToSW, 500);
        });
      } catch (e) {
        console.error('[IFS Inspector devtools] failed to connect to service worker:', e.message);
        swPort = null;
        setTimeout(connectToSW, 1000);
      }
    }
    connectToSW();

    // ── Inject backend.js ─────────────────────────────────────────────────────
    // Done here (not from a content script) so it only runs when the panel is open.
    // Re-injected on page navigation because a full reload clears the flag and
    // drops the hook subscription.
    function injectBackend() {
      chrome.devtools.inspectedWindow.eval(
        '(function(){' +
        '  if(window.__IFS_INSPECTOR_BACKEND_LOADED__) return;' +
        '  window.__IFS_INSPECTOR_BACKEND_LOADED__ = true;' +
        '  var s=document.createElement("script");' +
        '  s.src="' + chrome.runtime.getURL('content/backend.js') + '";' +
        '  s.dataset.extId="' + chrome.runtime.id + '";' +
        '  s.onload=function(){s.remove();};' +
        '  (document.head||document.documentElement).appendChild(s);' +
        '})()'
      );
    }
    injectBackend();

    if (chrome.devtools.network.onNavigated) {
      chrome.devtools.network.onNavigated.addListener(injectBackend);
    }

    // ── Coexistence notice ────────────────────────────────────────────────────
    // IFS Cloud Web DevTools sets window.__ifsDevtoolsCtx when active.
    // Notify the panel so it can show a subtle heads-up to the user.
    chrome.devtools.inspectedWindow.eval(
      '!!(window.__ifsDevtoolsCtx)',
      function (result) {
        if (result === true) send({ type: 'IFS_COEXIST_WARNING' });
      }
    );

    // ── Path A: HAR network listener ──────────────────────────────────────────
    chrome.devtools.network.onRequestFinished.addListener(function (request) {
      var url      = request.request.url || '';
      var postText = (request.request.postData && request.request.postData.text) || '';

      function sendMsg(body) {
        var har = {
          time: request.time,
          request: {
            method:      request.request.method,
            url:         request.request.url,
            headers:     (request.request.headers     || []).map(function (h) { return { name: h.name, value: h.value }; }),
            queryString: (request.request.queryString || []).map(function (q) { return { name: q.name, value: q.value }; }),
            postData:    postText ? { text: postText } : null,
          },
          response: {
            status:     request.response.status,
            statusText: request.response.statusText,
            headers:    (request.response.headers || []).map(function (h) { return { name: h.name, value: h.value }; }),
            bodySize:   request.response.bodySize,
            content:    { mimeType: request.response.content && request.response.content.mimeType, 
                          text    : body || null, },
          },
          timings: request.timings || {},
        };

        var data = null;
        if (body) {
          try { data = JSON.parse(body); } catch (e) { data = { raw: body }; }
        }

        send({ type: 'IFS_REQUEST', request: har, data: data });
      }

      if (typeof request.getContent === 'function') {
        request.getContent(function (body) {
          sendMsg(body || (request.response && request.response.content && request.response.content.text) || null);
        });
      } else {
        var body = request.response && request.response.content && request.response.content.text;
        sendMsg(body || null);
      }
    });
  }
);
