"use strict"

function formatBytes(bytes) {
  const size = Number(bytes) || 0
  if (size <= 0) return "unknown size"
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function compareVersions(left, right) {
  const a = String(left || "").split(".").map((part) => parseInt(part, 10) || 0)
  const b = String(right || "").split(".").map((part) => parseInt(part, 10) || 0)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0)
    if (delta !== 0) return delta
  }
  return 0
}

function updateIsAvailable(result, installed) {
  if (!result || !result.updateInfo) return false
  if (typeof result.isUpdateAvailable === "boolean") return result.isUpdateAvailable
  const latest = result.updateInfo.version
  if (!latest) return false
  return compareVersions(latest, installed) > 0
}

function releaseNotes(info) {
  const notes = info && info.releaseNotes
  if (!notes) return ""
  if (typeof notes === "string") return notes.trim().slice(0, 800)
  if (Array.isArray(notes)) {
    return notes
      .map((row) => (typeof row === "string" ? row : row && row.note) || "")
      .filter(Boolean)
      .join("\n")
      .trim()
      .slice(0, 800)
  }
  return ""
}

function downloadSize(info) {
  const files = info && Array.isArray(info.files) ? info.files : []
  return files.reduce((sum, file) => sum + (Number(file && file.size) || 0), 0)
}

function classifyUpdateError(error) {
  const raw = error instanceof Error ? error.message : String(error || "")
  if (/please check update first/i.test(raw)) return "current"
  if (
    /ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION|ETIMEDOUT|timed out|net::ERR_|ENETUNREACH|ECONNREFUSED|ECONNRESET/i.test(
      raw
    )
  ) {
    return "offline"
  }
  if (/404|releases\.atom|github\.com/i.test(raw)) return "missing"
  return "unknown"
}

module.exports = {
  formatBytes,
  compareVersions,
  updateIsAvailable,
  releaseNotes,
  downloadSize,
  classifyUpdateError,
}
