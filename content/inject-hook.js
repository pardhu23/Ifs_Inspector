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
