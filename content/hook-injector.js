// Runs in Chrome's isolated world (content script context).
// Injects inject-hook.js into the REAL page context so it can
// set window.__IFS_AURENA_DEVTOOLS__ before any IFS app code runs.
(function () {
    // If IFS Cloud Web DevTools is also installed it will have already
    // injected the real hook — don't clobber it, just let it be.
    // Our inject-hook.js checks for this guard itself.
    var s = document.createElement('script');
    s.src = chrome.runtime.getURL('content/inject-hook.js');
    s.onload = function () { s.remove(); };
    (document.head || document.documentElement).appendChild(s);
}());
