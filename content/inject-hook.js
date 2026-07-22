// Runs in the REAL page context (injected via <script> tag).
// Installs window.__IFS_AURENA_DEVTOOLS__ so the IFS client activates
// its DevTools mode and starts emitting hook events.
//
// Coexistence rule:
//   - If IFS Cloud Web DevTools is already present (a real hook object),
//     leave it completely untouched — we piggyback on its events instead.
//   - If only our stub is present (boolean true from an old detector),
//     replace it with a proper emitter.
//   - If nothing is there yet, install ours.
(function () {
    'use strict';

    // ── Clipboard watcher (runs unconditionally, before the early-return below) ─
    // IFS's own "Copy Selected Rows" grid action writes the selection as a JSON
    // array into localStorage['IFS-Aurena-CopyPasteRecordStorage']. Each copy
    // overwrites the previous value — there is no history and no editing.
    // We monkeypatch localStorage.setItem at document_start (before any IFS app
    // code runs) so we see every write the instant it happens, then emit it
    // through whichever hook object ends up installed (ours or IFS Cloud Web
    // DevTools') as a 'd:clipboard' event. This must live outside the
    // "already installed" early-return below so it runs regardless of which
    // hook implementation wins.

    // Pulls the IFS page name out of URLs like:
    //   .../web/page/AssignmentTypes/List;path=...
    //   .../web/page/ContactRoles/List;path=...
    // Falls back to the document title (minus any " - IFS" suffix) if the
    // URL doesn't match the expected /page/<Name>/ shape.
    function currentIfsPageName() {
        try {
            var m = window.location.pathname.match(/\/page\/([^\/;]+)/i);
            if (m && m[1]) return decodeURIComponent(m[1]);
        } catch (e) { /* fall through to title */ }
        return (document.title || '').replace(/\s*-\s*IFS.*$/i, '').trim() || null;
    }

    (function installClipboardWatcher() {
        var CLIP_KEY = 'IFS-Aurena-CopyPasteRecordStorage';
        var originalSetItem = window.localStorage.setItem;

        window.localStorage.setItem = function (key, value) {
            var result = originalSetItem.apply(this, arguments);
            if (key === CLIP_KEY) {
                try {
                    var rows = JSON.parse(value);
                    var hook = window.__IFS_AURENA_DEVTOOLS__;
                    if (hook && typeof hook.emit === 'function') {
                        hook.emit('d:clipboard', {
                            rows: rows,
                            raw: value,
                            ts: Date.now(),
                            page: currentIfsPageName(),
                            url: window.location.href,
                        });
                    }
                } catch (e) {
                    // Not JSON, or hook not ready yet — ignore silently.
                }
            }
            return result;
        };
    }());

    var existing = window.__IFS_AURENA_DEVTOOLS__;

    // Already a proper hook object installed by IFS Cloud Web DevTools —
    // nothing to do; our backend.js will subscribe to it normally.
    if (existing && typeof existing === 'object' && typeof existing.on === 'function') {
        return;
    }

    // ── Minimal event-emitter hook ────────────────────────────────────────────
    var listeners = {};
    var hook = {
        enabled: undefined,
        _buffer: [],

        on: function (event, fn) {
            var key = '$' + event;
            if (listeners[key]) {
                listeners[key].push(fn);
                // replay any buffered emissions that arrived before this subscriber
                this._replayBuffer(event);
            } else {
                listeners[key] = [fn];
                this._replayBuffer(event);
            }
        },

        once: function (event, fn) {
            var self = this;
            var wrapper = function () {
                self.off(event, wrapper);
                fn.apply(self, arguments);
            };
            wrapper._orig = fn;
            this.on(event, wrapper);
        },

        off: function (event, fn) {
            if (!arguments.length) { listeners = {}; return; }
            var key = '$' + event;
            if (!listeners[key]) return;
            if (!fn) { listeners[key] = null; return; }
            var cbs = listeners[key];
            for (var i = 0; i < cbs.length; i++) {
                if (cbs[i] === fn || cbs[i]._orig === fn) {
                    cbs.splice(i, 1);
                    break;
                }
            }
        },

        emit: function (event) {
            var args = Array.prototype.slice.call(arguments, 1);
            var key  = '$' + event;
            var cbs  = listeners[key];
            if (cbs && cbs.length) {
                cbs.slice().forEach(function (cb) {
                    try {
                        var result = cb.apply(hook, args);
                        if (result && typeof result.catch === 'function') {
                            result.catch(function (e) {
                                console.error('[IFS Inspector hook] async error in', event, e);
                            });
                        }
                    } catch (e) {
                        console.error('[IFS Inspector hook] error in', event, e);
                    }
                });
            } else {
                // No subscriber yet — buffer so nothing is lost
                this._buffer.push([event].concat(args));
            }
        },

        _replayBuffer: function (event) {
            var remaining = [];
            var buf = this._buffer;
            this._buffer = [];
            for (var i = 0; i < buf.length; i++) {
                if (buf[i][0] === event) {
                    this.emit.apply(this, buf[i]);
                } else {
                    remaining.push(buf[i]);
                }
            }
            this._buffer = remaining;
        },
    };

    Object.defineProperty(window, '__IFS_AURENA_DEVTOOLS__', {
        get: function () { return hook; },
        configurable: true,   // allows IFS Cloud Web DevTools to overwrite if it loads later
    });
}());
