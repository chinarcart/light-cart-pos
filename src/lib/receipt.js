"use strict"

const MAX_DATA_URL_LENGTH = 12_000_000
const MIN_PRINT_WIDTH_MM = 20
const MAX_PRINT_WIDTH_MM = 72
const MIN_HEIGHT_PX = 64
const MAX_HEIGHT_PX = 12_000
const MAX_HEIGHT_MICRONS = 3_000_000

function defaultPrintWidth(paperMm) {
  return paperMm === "80" ? 64 : 42
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function cleanPrinterName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim().slice(0, 200)
  if (!name) return ""
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Printer name is not valid")
  }
  return name
}

function paperMillimetres(value) {
  return String(value) === "80" ? "80" : "58"
}

function parseReceiptRequest(payload) {
  const source = payload && typeof payload === "object" ? payload : {}
  const dataUrl = String(source.dataUrl || "")
  if (!dataUrl.startsWith("data:image/")) {
    throw new Error("Receipt image is missing")
  }
  if (dataUrl.length > MAX_DATA_URL_LENGTH) {
    throw new Error("Receipt image is too large to print")
  }
  const paperMm = paperMillimetres(source.paperMm)
  const requestedWidth = Number(source.printWidthMm)
  const printWidthMm = clamp(
    Number.isFinite(requestedWidth) && requestedWidth > 0
      ? requestedWidth
      : defaultPrintWidth(paperMm),
    MIN_PRINT_WIDTH_MM,
    MAX_PRINT_WIDTH_MM
  )
  const requestedHeight = Number(source.heightPx)
  const heightPx = clamp(
    Number.isFinite(requestedHeight) && requestedHeight > 0 ? requestedHeight : 1200,
    MIN_HEIGHT_PX,
    MAX_HEIGHT_PX
  )
  return {
    dataUrl,
    paperMm,
    printWidthMm,
    heightPx,
    printerName: cleanPrinterName(source.printerName),
  }
}

function assertImageMagic(buffer, kind) {
  if (kind === "png") {
    const png = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    if (!png) throw new Error("Receipt image is not a PNG")
    return
  }
  if (kind === "jpeg") {
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    if (!jpeg) throw new Error("Receipt image is not a JPEG")
    return
  }
  if (kind === "webp") {
    const riff = buffer.toString("ascii", 0, 4) === "RIFF"
    const webp = buffer.toString("ascii", 8, 12) === "WEBP"
    if (!riff || !webp) throw new Error("Receipt image is not a WebP")
  }
}

function decodeReceiptImage(dataUrl) {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl)
  if (!match) {
    throw new Error("Receipt image must be a PNG, JPEG, or WebP")
  }
  const encoded = match[2].replace(/\s+/g, "")
  if (!encoded || encoded.length > MAX_DATA_URL_LENGTH) {
    throw new Error("Receipt image is too large to print")
  }
  const buffer = Buffer.from(encoded, "base64")
  if (buffer.length < 16) throw new Error("Receipt image is empty")
  const kind = match[1].toLowerCase() === "jpg" ? "jpeg" : match[1].toLowerCase()
  assertImageMagic(buffer, kind)
  const ext = kind === "jpeg" ? "jpg" : kind
  return { buffer, ext, fileName: `ticket.${ext}` }
}

function pageSizeMicrons({ paperMm, printWidthMm, heightPx }) {
  const widthMicrons = paperMm === "80" ? 80_000 : 58_000
  const canvasWidthPx = Math.max(192, Math.round(printWidthMm * 8))
  const rawHeight = Math.round((heightPx / canvasWidthPx) * widthMicrons) + 8_000
  return {
    width: widthMicrons,
    height: clamp(rawHeight, 20_000, MAX_HEIGHT_MICRONS),
  }
}

function receiptDocument({ paperMm, printWidthMm, imageSrc }) {
  const paper = paperMm === "80" ? 80 : 58
  const width = Number(printWidthMm)
  if (!Number.isFinite(width)) throw new Error("Print width is not valid")
  // Only a local ticket file we just wrote. Rejects quotes and other markup.
  if (
    typeof imageSrc !== "string" ||
    !/^file:\/\/\/[A-Za-z0-9:/._~%-]+$/.test(imageSrc) ||
    !/ticket\.(png|jpg|webp)$/.test(imageSrc)
  ) {
    throw new Error("Receipt file is not valid")
  }
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { margin: 0; size: ${paper}mm auto; }
      html, body { margin: 0; padding: 0; background: #fff; }
      img {
        display: block;
        width: ${width}mm;
        max-width: ${width}mm;
        height: auto;
      }
    </style>
  </head>
  <body><img src="${imageSrc}" alt="" /></body>
</html>`
}

function summarizePrinters(printers) {
  if (!Array.isArray(printers)) return []
  const rows = []
  for (const printer of printers) {
    if (!printer || typeof printer !== "object") continue
    let name = ""
    try {
      name = cleanPrinterName(printer.name || printer.displayName || "")
    } catch {
      continue
    }
    if (!name) continue
    const displayName =
      String(printer.displayName || name)
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200) || name
    rows.push({
      name,
      displayName,
      isDefault: Boolean(printer.isDefault),
    })
  }
  rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
  return rows
}

module.exports = {
  MAX_DATA_URL_LENGTH,
  parseReceiptRequest,
  decodeReceiptImage,
  pageSizeMicrons,
  receiptDocument,
  cleanPrinterName,
  summarizePrinters,
}
