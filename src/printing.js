"use strict"

const fs = require("fs/promises")
const os = require("os")
const path = require("path")
const { pathToFileURL } = require("url")
const { BrowserWindow } = require("electron")
const { decodeReceiptImage, pageSizeMicrons, parseReceiptRequest, receiptDocument, summarizePrinters } = require("./lib/receipt")

const PRINT_TIMEOUT_MS = 20_000

function senderUrl(event) {
  if (event && event.senderFrame && event.senderFrame.url) return event.senderFrame.url
  if (event && event.sender && event.sender.getURL) return event.sender.getURL()
  return ""
}

function createPrintWindow(parent) {
  return new BrowserWindow({
    show: false,
    skipTaskbar: true,
    focusable: false,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    width: 400,
    height: 800,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
    },
  })
}

function waitForLoad(printWin) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("The receipt took too long to prepare"))
    }, PRINT_TIMEOUT_MS)
    const finish = (error) => {
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    printWin.webContents.once("did-finish-load", () => finish())
    printWin.webContents.once("did-fail-load", () => finish(new Error("Could not prepare the receipt")))
  })
}

function sendToPrinter(printWin, options) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("The printer did not respond"))
    }, PRINT_TIMEOUT_MS)
    printWin.webContents.print(options, (success, failureReason) => {
      clearTimeout(timer)
      if (success) {
        resolve()
        return
      }
      const printerName = options.deviceName
      const hint = printerName
        ? ` Could not reach "${printerName}". Pick another printer in Settings.`
        : " Set a default printer in Settings, or choose one in Windows."
      reject(new Error(`${failureReason || "Print failed"}${hint}`))
    })
  })
}

async function printTicketNow(payload, parent) {
  const request = parseReceiptRequest(payload)
  const image = decodeReceiptImage(request.dataUrl)
  const pageSize = pageSizeMicrons(request)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lc-receipt-"))
  const htmlPath = path.join(directory, "ticket.html")
  const imagePath = path.join(directory, image.fileName)
  let printWin = null
  try {
    await fs.writeFile(imagePath, image.buffer)
    await fs.writeFile(
      htmlPath,
      receiptDocument({
        paperMm: request.paperMm,
        printWidthMm: request.printWidthMm,
        imageSrc: pathToFileURL(imagePath).href,
      })
    )
    printWin = createPrintWindow(parent)
    printWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    const loaded = waitForLoad(printWin)
    loaded.catch(() => {})
    await printWin.loadFile(htmlPath)
    await loaded
    const options = {
      silent: true,
      printBackground: true,
      color: true,
      margins: { marginType: "none" },
      pagesPerSheet: 1,
      copies: 1,
      scaleFactor: 100,
      pageSize,
    }
    if (request.printerName) options.deviceName = request.printerName
    await sendToPrinter(printWin, options)
    return { ok: true }
  } finally {
    if (printWin && !printWin.isDestroyed()) printWin.close()
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

function createPrintQueue(getParent) {
  let chain = Promise.resolve()
  return function enqueue(payload) {
    const run = chain.then(() => printTicketNow(payload, getParent()))
    chain = run.then(
      () => {},
      () => {}
    )
    return run
  }
}

module.exports = {
  senderUrl,
  printTicketNow,
  createPrintQueue,
  summarizePrinters,
}
