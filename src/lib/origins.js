"use strict"

const DEFAULT_START_URL = "https://light-cart-eta.vercel.app/merchant/pos"

const ROUTES = [
  { label: "Counter", accelerator: "CmdOrCtrl+1", path: "/merchant/pos" },
  { label: "Scan", accelerator: "CmdOrCtrl+0", path: "/merchant/scan" },
  { label: "Dashboard", accelerator: "CmdOrCtrl+2", path: "/merchant" },
  { label: "Products", accelerator: "CmdOrCtrl+3", path: "/merchant/products" },
  { label: "Inventory", accelerator: "CmdOrCtrl+4", path: "/merchant/inventory" },
  { label: "Bills", accelerator: "CmdOrCtrl+5", path: "/merchant/bills" },
  { label: "Reports", accelerator: "CmdOrCtrl+6", path: "/merchant/reports" },
  { label: "Settings", accelerator: "CmdOrCtrl+9", path: "/merchant/settings" },
]

function parseStartUrl(value) {
  const raw = String(value || "").trim()
  if (!raw) return DEFAULT_START_URL
  try {
    const url = new URL(raw)
    if (url.protocol !== "https:" && url.protocol !== "http:") return DEFAULT_START_URL
    return url.toString()
  } catch {
    return DEFAULT_START_URL
  }
}

function extraOrigins(value) {
  const origins = []
  for (const part of String(value || "").split(",")) {
    const raw = part.trim()
    if (!raw) continue
    try {
      const url = new URL(raw.includes("://") ? raw : `https://${raw}`)
      if (url.protocol === "https:" || url.protocol === "http:") origins.push(url.origin)
    } catch {
      // Ignore a bad extra origin instead of refusing to boot the till.
    }
  }
  return origins
}

function allowedOriginSet(startUrl, extra) {
  return new Set([new URL(startUrl).origin, ...extraOrigins(extra)])
}

function isAllowedAppUrl(url, origins) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false
    return origins.has(parsed.origin)
  } catch {
    return false
  }
}

function isSafeExternalUrl(url) {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === "https:" ||
      parsed.protocol === "http:" ||
      parsed.protocol === "mailto:" ||
      parsed.protocol === "tel:"
    )
  } catch {
    return false
  }
}

function isOfflinePageUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "file:") return false
    const pathname = decodeURIComponent(parsed.pathname).replace(/\\/g, "/")
    return pathname.endsWith("/offline.html")
  } catch {
    return false
  }
}

function merchantUrl(startUrl, route) {
  if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//")) {
    throw new Error("Till route is not valid")
  }
  const url = new URL(route, startUrl)
  if (url.origin !== new URL(startUrl).origin) {
    throw new Error("Till route left the Light Cart site")
  }
  return url.toString()
}

// Chromium abort / client-block codes happen when we cancel a navigation ourselves.
function shouldShowOfflinePage(errorCode) {
  const code = Number(errorCode)
  if (!Number.isFinite(code)) return false
  if (code === -3 || code === -20) return false
  return code <= -2
}

module.exports = {
  DEFAULT_START_URL,
  ROUTES,
  parseStartUrl,
  extraOrigins,
  allowedOriginSet,
  isAllowedAppUrl,
  isSafeExternalUrl,
  isOfflinePageUrl,
  merchantUrl,
  shouldShowOfflinePage,
}
