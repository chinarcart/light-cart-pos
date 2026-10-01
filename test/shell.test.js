"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const vm = require("node:vm")
const { PRINT_HOOK } = require("../src/print-hook")
const { requestAllowed } = require("../src/permissions")
const { menuTemplate } = require("../src/lib/menu-template")
const {
  DEFAULT_START_URL,
  allowedOriginSet,
  isAllowedAppUrl,
  isOfflinePageUrl,
  isSafeExternalUrl,
  merchantUrl,
  parseStartUrl,
  shouldShowOfflinePage,
} = require("../src/lib/origins")
const {
  decodeReceiptImage,
  pageSizeMicrons,
  parseReceiptRequest,
  receiptDocument,
  summarizePrinters,
} = require("../src/lib/receipt")
const {
  classifyUpdateError,
  compareVersions,
  formatBytes,
  releaseNotes,
  updateIsAvailable,
} = require("../src/lib/updates")

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

test("start url stays on the merchant counter unless overridden with http(s)", () => {
  assert.equal(parseStartUrl(""), DEFAULT_START_URL)
  assert.equal(parseStartUrl("javascript:alert(1)"), DEFAULT_START_URL)
  assert.equal(parseStartUrl("not a url"), DEFAULT_START_URL)
  assert.equal(
    parseStartUrl("http://localhost:3000/merchant/pos"),
    "http://localhost:3000/merchant/pos"
  )
})

test("navigation stays on the till origin", () => {
  const origins = allowedOriginSet(DEFAULT_START_URL, "http://localhost:3000, nope, ftp://files.example")
  assert.equal(isAllowedAppUrl("https://light-cart-eta.vercel.app/merchant/bills", origins), true)
  assert.equal(isAllowedAppUrl("http://localhost:3000/merchant/pos", origins), true)
  assert.equal(isAllowedAppUrl("https://evil.example/merchant/pos", origins), false)
  assert.equal(isAllowedAppUrl("http://light-cart-eta.vercel.app/merchant/pos", origins), false)
  assert.equal(isAllowedAppUrl("javascript:alert(1)", origins), false)
  assert.equal(isAllowedAppUrl("file:///C:/Windows/win.ini", origins), false)
  assert.equal(isSafeExternalUrl("mailto:till@lightcart.example"), true)
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false)
})

test("menu routes cannot leave the site", () => {
  assert.equal(
    merchantUrl(DEFAULT_START_URL, "/merchant/settings"),
    "https://light-cart-eta.vercel.app/merchant/settings"
  )
  assert.throws(() => merchantUrl(DEFAULT_START_URL, "https://evil.example"))
  assert.throws(() => merchantUrl(DEFAULT_START_URL, "//evil.example"))
})

test("offline page detection ignores the counter site", () => {
  assert.equal(isOfflinePageUrl("file:///C:/Program%20Files/Light%20Cart%20POS/resources/app.asar/src/offline.html"), true)
  assert.equal(isOfflinePageUrl("https://light-cart-eta.vercel.app/offline.html"), false)
  assert.equal(shouldShowOfflinePage(-105), true)
  assert.equal(shouldShowOfflinePage(-106), true)
  assert.equal(shouldShowOfflinePage(-3), false)
  assert.equal(shouldShowOfflinePage(-20), false)
})

test("receipt images are real files, not HTML", () => {
  const request = parseReceiptRequest({
    dataUrl: `data:image/png;base64,${PNG}`,
    paperMm: "80",
    printWidthMm: 64,
    heightPx: 900,
    printerName: " Counter \n Printer ",
  })
  assert.equal(request.paperMm, "80")
  assert.equal(request.printerName, "Counter Printer")
  const image = decodeReceiptImage(request.dataUrl)
  assert.equal(image.fileName, "ticket.png")
  assert.equal(image.buffer[0], 0x89)
  const html = receiptDocument({
    paperMm: request.paperMm,
    printWidthMm: request.printWidthMm,
    imageSrc: "file:///tmp/lc-receipt-abc/ticket.png",
  })
  assert.match(html, /src="file:\/\/\/tmp\/lc-receipt-abc\/ticket\.png"/)
  assert.equal(html.includes(PNG), false)
  assert.equal(html.includes("data:image"), false)
  assert.throws(() =>
    receiptDocument({
      paperMm: "58",
      printWidthMm: 42,
      imageSrc: 'file:///tmp/ticket.png" onerror="alert(1)',
    })
  )
})

test("malicious receipt payloads are rejected", () => {
  assert.throws(() =>
    decodeReceiptImage(`data:image/png;base64,${PNG}" onerror="alert(1)`)
  )
  assert.throws(() => decodeReceiptImage("data:image/svg+xml;base64,PHN2Zy8+"))
  assert.throws(() => decodeReceiptImage(`data:image/png,${PNG}`))
  assert.throws(() => parseReceiptRequest({ dataUrl: "https://evil.example/ticket.png" }))
  assert.throws(() => parseReceiptRequest({ dataUrl: "data:image/png;base64,aa", printerName: "bad\u0000name" }))
})

test("print size stays inside a thermal page", () => {
  const page = pageSizeMicrons({ paperMm: "58", printWidthMm: 999, heightPx: 999999 })
  assert.equal(page.width, 58000)
  assert.equal(page.height, 3000000)
  const narrow = parseReceiptRequest({ dataUrl: "data:image/png;base64,aa", printWidthMm: 1, paperMm: "nope" })
  assert.equal(narrow.paperMm, "58")
  assert.equal(narrow.printWidthMm, 20)
})

test("printer list keeps the shape the counter settings page expects", () => {
  const printers = summarizePrinters([
    { name: "Office", displayName: "Office\u0000", isDefault: false },
    { name: "", displayName: "Skip" },
    { name: "Counter", displayName: "Counter printer", isDefault: true },
    null,
    { name: "bad\u0000", displayName: "nope" },
  ])
  assert.deepEqual(printers, [
    { name: "Counter", displayName: "Counter printer", isDefault: true },
    { name: "Office", displayName: "Office", isDefault: false },
    { name: "Skip", displayName: "Skip", isDefault: false },
  ])
})

test("update errors stay quiet for an offline till and honest for a missing release", () => {
  assert.equal(classifyUpdateError(new Error("net::ERR_INTERNET_DISCONNECTED")), "offline")
  assert.equal(classifyUpdateError("Unable to find latest.yml in github.com releases.atom 404"), "missing")
  assert.equal(classifyUpdateError("Please check update first"), "current")
  assert.equal(classifyUpdateError(new Error("EPERM")), "unknown")
  assert.equal(formatBytes(0), "unknown size")
  assert.equal(formatBytes(1536 * 1024), "1.5 MB")
  assert.equal(compareVersions("1.2.1", "1.3.0") < 0, true)
  assert.equal(compareVersions("1.3.0", "1.3.0"), 0)
  assert.equal(updateIsAvailable({ updateInfo: { version: "1.3.0" } }, "1.2.1"), true)
  assert.equal(updateIsAvailable({ isUpdateAvailable: false, updateInfo: { version: "9.0.0" } }, "1.2.1"), false)
  assert.equal(releaseNotes({ releaseNotes: [{ note: "Print fixes" }, "Cache"] }), "Print fixes\nCache")
})

test("production menu has no DevTools and still reaches every counter page", () => {
  const opened = []
  const template = menuTemplate({
    devTools: false,
    openRoute: (route) => opened.push(route),
  })
  const labels = template.flatMap((menu) => (menu.submenu || []).map((item) => item.label).filter(Boolean))
  assert.equal(labels.includes("Counter"), true)
  assert.equal(labels.includes("Settings"), true)
  assert.equal(labels.includes("Refresh saved pages"), true)
  assert.equal(labels.includes("Update…"), true)
  assert.equal(JSON.stringify(template).includes("toggleDevTools"), false)
  const withTools = menuTemplate({ devTools: true, openRoute: () => {} })
  assert.equal(JSON.stringify(withTools).includes("toggleDevTools"), true)
  template[0].submenu[0].click()
  assert.deepEqual(opened, ["/merchant/pos"])
})

test("camera permission is video-only and only named permissions are allowed", () => {
  assert.equal(requestAllowed("media", { mediaTypes: ["video"] }), true)
  assert.equal(requestAllowed("media", { mediaTypes: ["audio"] }), false)
  assert.equal(requestAllowed("media", { mediaTypes: ["video", "audio"] }), false)
  assert.equal(requestAllowed("notifications", {}), false)
  assert.equal(requestAllowed("geolocation", {}), true)
})

test("print hook sends the ticket to the desktop bridge and reports failures", async () => {
  const calls = []
  const events = []
  const img = {
    src: "data:image/png;base64,abc",
    naturalHeight: 480,
    getAttribute(name) {
      if (name === "data-paper-mm") return "80"
      if (name === "data-print-width-mm") return "0"
      return ""
    },
  }
  const   sandbox = {
    console: { error() {}, log() {} },
    Promise,
    Number,
    JSON,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type
        this.detail = init && init.detail
      }
    },
  }
  sandbox.window = {
    print() {
      throw new Error("browser print")
    },
    lightCartDesktop: {
      printTicket(payload) {
        calls.push(payload)
        return Promise.reject(new Error("printer offline"))
      },
    },
    document: { querySelector: () => img },
    localStorage: {
      getItem: () => JSON.stringify({ paperWidth: "58", contentWidthMm: 48, printerName: "Till" }),
    },
    dispatchEvent(event) {
      events.push(event)
    },
  }
  sandbox.document = sandbox.window.document
  sandbox.localStorage = sandbox.window.localStorage
  vm.runInNewContext(PRINT_HOOK, sandbox)
  sandbox.window.print()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].paperMm, "58")
  assert.equal(calls[0].printWidthMm, 48)
  assert.equal(calls[0].printerName, "Till")
  assert.equal(calls[0].heightPx, 480)
  assert.equal(events.length, 1)
  assert.match(events[0].detail, /printer offline/)
  sandbox.window.print()
  assert.equal(calls.length, 2)
})
