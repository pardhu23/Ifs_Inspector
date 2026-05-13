# Ifs_Inspector — Chrome DevTools Extension

A Chrome DevTools extension that transforms raw IFS Cloud PL/SQL trace output into a clean, structured, interactive debugging panel — right inside your browser.

> The backend logic, tracing infrastructure, and heavy lifting are already handled by IFS. This extension organises and presents that trace data in a developer-friendly way.

---

## The Problem

IFS Cloud logs every PL/SQL method call when extended traces are enabled — but the raw output in the IFS Cloud Extension is flooded with framework calls, making it painful to find what actually matters.

---

## What This Extension Does

Hooks into `chrome.devtools.network.onRequestFinished` — the same API the Network tab uses — to intercept every IFS Cloud response, parse the embedded trace data, and render it live inside a dedicated **IFS Inspector** DevTools panel.

---

## Features

### Sidebar — HTTP Requests
- Lists all intercepted IFS Cloud API requests
- **Flame bars** show each request's duration relative to all visible requests (red >2s, yellow >500ms, green otherwise)
- **Error badges** with inline tooltips — no need to dig into the Exceptions tab
- Filter by HTTP method (ALL / GET / POST / PUT / PATCH / DEL) or free-text search

### Trace Tab
Three view modes controlled by toolbar buttons:

| Mode | What it shows |
|---|---|
| **Key Events** | SQL/PL/SQL blocks, INFORMATION/WARNING/ERROR rows, call stack dumps only. All DEBUG rows hidden. |
| **Compact** | All calls, but consecutive calls from the same package collapse under a `PACKAGE_NAME · N calls` banner |
| **Full** | Everything, including entries matching hidden patterns (shown in muted italic) |

Live counters in the toolbar show exactly how many framework calls are being filtered at any moment.

**Additional trace features:**
- SQL and PL/SQL entries rendered at depth 0 with prominent type badges and a one-click copy button
- IFS attribute strings (`KEY\u001fVALUE\u001e...`) automatically decoded into an aligned key-value grid
- Right-click any method row to **Collapse children**, **Expand children**, or **Collapse all descendants**
- Error stack dumps detected and rendered as numbered, collapsible frame lists

### Request & Response Tabs
- **Request**: projection, method, filters, and parameters sent to the server
- **Response**: status, headers, response time, and the full returned payload

### Exceptions Tab
- Dedicated sub-tab beside Trace for every request
- Shows a count badge when exceptions are present
- Displays root cause, ORA error message, call stack, and raw stack trace

### Client Logs Panel
Records everything the IFS Cloud client does — every interaction, record created/updated/deleted, and every error returned. Useful for UI/UX debugging and tracing BPA_VALIDATION_FAILURE and similar client-side errors.

### Hidden Method Patterns (Gear Icon)
A live-editable list of prefix strings. Any trace entry whose text starts with a listed pattern is suppressed along with its entire subtree.

Default patterns cover common IFS framework namespaces:
- `Domain_API.`, `Language_Code_API.`, `Fnd_Setting_API.`, `Assert_API.`
- `Login_SYS`, `Fnd_Proj_Action_Grant_API`, `Foundation User`
- `Checking CUD security for`, `Checking security for`, `Context:`, `Calendar:`

Patterns persist across sessions via `localStorage`. **Reset to defaults** restores the original list.

### Export
The **↓ Export** button serialises the currently visible trace (honoring active view mode and hidden patterns) to a `.txt` file. The filename encodes context automatically, e.g. `POST_ContactRoleSet_minimal_2026-05-06T17-34-00.txt`. PL/SQL bind parameters and IFS attribute strings are expanded into readable `key ⇒ value` pairs — self-contained and ready to attach to a bug report.

---

## Setup

### 1. Enable Extended Method Traces in IFS

Go to **Solution Manager → Setup → System Parameters** and search for `%method traces%`.

| Parameter | Recommended Value |
|---|---|
| Enable/Disable Extended PLSQL method traces for debug sessions | **ENABLED** |
| Enable/Disable PLSQL method initialization traces for debug sessions | DISABLED |

> **Note:** This setting affects all users in active debug sessions. Enable it only in non-production environments or during a focused debugging window.

### 2. Load the Extension in Chrome

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the extension folder
5. Open DevTools on any IFS Cloud page — you'll see the **IFS Inspector** tab

---