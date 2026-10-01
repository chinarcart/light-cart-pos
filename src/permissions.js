"use strict"

const { isAllowedAppUrl } = require("./lib/origins")

const SAFE_PERMISSIONS = new Set([
  "geolocation",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
])

function requestAllowed(permission, details) {
  if (permission !== "media") return SAFE_PERMISSIONS.has(permission)
  const types = details && Array.isArray(details.mediaTypes) ? details.mediaTypes : ["video"]
  return types.length > 0 && types.every((type) => type === "video")
}

function installPermissions(session, origins) {
  const allowed = (url) => isAllowedAppUrl(url, origins)

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = (details && details.requestingUrl) || webContents.getURL()
    callback(allowed(url) && requestAllowed(permission, details))
  })

  session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const url = requestingOrigin || (webContents && webContents.getURL && webContents.getURL()) || ""
    return allowed(url) && requestAllowed(permission, null)
  })
}

module.exports = {
  installPermissions,
  requestAllowed,
}
