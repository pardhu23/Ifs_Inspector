// Service worker (background).
// Acts as the message bus between:
//   - content script (proxy.js)  → port name: 'ifs-inspector-content'
//   - devtools panel (devtools.js) → port name: numeric tab id string
//
// When both ports for the same tab are connected, it pipes
// messages from the content side to the devtools side.

const ports = {};   // tabId → { content: port|null, devtools: port|null }

function getTab(port, name) {
    // devtools.js connects with the inspected tab id as the port name
    if (/^\d+$/.test(name)) return { tabId: name, role: 'devtools' };
    // content proxy.js connects with 'ifs-inspector-content'
    if (name === 'ifs-inspector-content') {
        const tabId = port.sender && port.sender.tab && String(port.sender.tab.id);
        return tabId ? { tabId, role: 'content' } : null;
    }
    return null;
}

chrome.runtime.onConnect.addListener(function (port) {
    const info = getTab(port, port.name);
    if (!info) return;

    const { tabId, role } = info;
    if (!ports[tabId]) ports[tabId] = { content: null, devtools: null };
    ports[tabId][role] = port;

    port.onDisconnect.addListener(function () {
        if (ports[tabId]) ports[tabId][role] = null;
        if (chrome.runtime.lastError) {
            // Port disconnected — could be bfcache, service worker timeout, extension reload
            console.warn('[IFS Inspector SW] port disconnected:', role, chrome.runtime.lastError.message);
        }
    });

    port.onMessage.addListener(function (msg) {
        // Content → DevTools: forward hook events
        if (role === 'content') {
            const devtools = ports[tabId] && ports[tabId].devtools;
            if (devtools) {
                try {
                    devtools.postMessage(msg);
                } catch (err) {
                    console.error('[IFS Inspector SW] failed to forward to devtools:', err.message);
                    ports[tabId].devtools = null;
                }
            }
        }
        // DevTools → Content: not needed currently, but wired for future use
        if (role === 'devtools') {
            const content = ports[tabId] && ports[tabId].content;
            if (content) {
                try {
                    content.postMessage(msg);
                } catch (err) {
                    console.error('[IFS Inspector SW] failed to forward to content:', err.message);
                    ports[tabId].content = null;
                }
            }
        }
    });
});
