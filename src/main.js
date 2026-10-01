"use strict"

const path = require("path")
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron")
const { autoUpdater } = require("electron-updater")
const { createLogger } = require("./log")
const { SHORTCUT_HELP, installMenu } = require("./menu")
const { installPermissions } = require("./permissions")
const { PRINT_HOOK } = require("./print-hook")
const { createPrintQueue, senderUrl, summarizePrinters } = require("./printing")
const { attachUpdater } = require("./updater")
const {
  allowedOriginSet,
  isAllowedAppUrl,
  isOfflinePageUrl,
  isSafeExternalUrl,
  merchantUrl,
  parseStartUrl,
  shouldShowOfflinePage,
} = require("./lib/origins")

const APP_USER_MODEL_ID = "com.electron.light-cart-pos"
const START_URL = parseStartUrl(process.env.LIGHT_CART_URL)
const ORIGINS = allowedOriginSet(START_URL, process.env.LIGHT_CART_ALLOWED_ORIGINS)
const OFFLINE_PAGE = path.join(__dirname, "offline.html")

/** @type {BrowserWindow | null} */
let mainWindow = null
let showingOffline = false
let logger = console

function currentUrl() {
  if (!mainWindow || mainWindow.isDestroyed()) return ""
  return mainWindow.webContents.getURL()
}

function reloadCurrentPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve()
  if (!isAllowedAppUrl(currentUrl(), ORIGINS)) return loadCounter()
  showingOffline = false
  mainWindow.webContents.reload()
  return Promise.resolve()
}

function devToolsEnabled() {
  return process.env.LIGHT_CART_DEVTOOLS === "1" || !app.isPackaged
}

function openExternal(url) {
  if (isSafeExternalUrl(url)) void shell.openExternal(url)
}

function handleNavigation(event, url) {
  if (isAllowedAppUrl(url, ORIGINS) || isOfflinePageUrl(url)) return
  event.preventDefault()
  openExternal(url)
}

function showOfflinePage() {
  if (!mainWindow || mainWindow.isDestroyed() || showingOffline) return
  showingOffline = true
  void mainWindow.loadFile(OFFLINE_PAGE).catch((error) => {
    showingOffline = false
    logger.error("offline page failed", error)
  })
}

function loadCounter() {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve()
  showingOffline = false
  return mainWindow.loadURL(START_URL)
}

function sendCounterKey(keyCode) {
  const contents = mainWindow && mainWindow.webContents
  if (!contents || contents.isDestroyed()) return
  if (!isAllowedAppUrl(contents.getURL(), ORIGINS)) return
  mainWindow.focus()
  contents.sendInputEvent({ type: "keyDown", keyCode })
  contents.sendInputEvent({ type: "keyUp", keyCode })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 864,
    minWidth: 1024,
    minHeight: 700,
    title: "Light Cart POS",
    backgroundColor: "#f4f4f5",
    show: false,
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [`--light-cart-version=${app.getVersion()}`],
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })

  const session = mainWindow.webContents.session
  session.setUserAgent(`${session.getUserAgent()} LightCartPOS/${app.getVersion()}`)
  installPermissions(session, ORIGINS)

  mainWindow.once("ready-to-show", () => {
    mainWindow.show()
    mainWindow.maximize()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: "deny" }
  })

  mainWindow.webContents.on("will-navigate", handleNavigation)
  mainWindow.webContents.on("will-redirect", handleNavigation)

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame || !shouldShowOfflinePage(errorCode)) return
    logger.warn("page failed", errorCode, errorDescription)
    showOfflinePage()
  })

  mainWindow.webContents.on("did-finish-load", () => {
    const url = mainWindow.webContents.getURL()
    if (isOfflinePageUrl(url)) return
    showingOffline = false
    if (!isAllowedAppUrl(url, ORIGINS)) return
    mainWindow.webContents.executeJavaScript(PRINT_HOOK).catch((error) => {
      logger.warn("print hook failed", error)
    })
  })

  mainWindow.on("unresponsive", () => {
    dialog
      .showMessageBox(mainWindow, {
        type: "warning",
        title: "Light Cart POS",
        message: "The till is not responding.",
        detail: "Reload the counter, or wait if a bill is still saving.",
        buttons: ["Reload", "Wait"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then((choice) => {
        if (choice.response === 0) void reloadCurrentPage()
      })
      .catch((error) => logger.error("unresponsive dialog failed", error))
  })

  mainWindow.on("closed", () => {
    mainWindow = null
  })

  void loadCounter()
}

function assertSender(event, { allowOffline }) {
  const url = senderUrl(event)
  if (isAllowedAppUrl(url, ORIGINS)) return
  if (allowOffline && isOfflinePageUrl(url)) return
  throw new Error("This page cannot use the till")
}

const printQueue = createPrintQueue(() => mainWindow)

async function refreshSavedPages() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const session = mainWindow.webContents.session
  const url = currentUrl()
  await session.clearCache()
  await session.clearStorageData({ storages: ["serviceworkers", "cachestorage"] })
  if (isAllowedAppUrl(url, ORIGINS)) {
    showingOffline = false
    await mainWindow.loadURL(url)
    return
  }
  await loadCounter()
}

function installIpc() {
  ipcMain.handle("print-ticket", async (event, payload) => {
    assertSender(event, { allowOffline: false })
    return printQueue(payload)
  })

  ipcMain.handle("list-printers", async (event) => {
    assertSender(event, { allowOffline: false })
    const printers = await event.sender.getPrintersAsync()
    return summarizePrinters(printers)
  })

  ipcMain.handle("reload", async (event) => {
    assertSender(event, { allowOffline: true })
    if (isOfflinePageUrl(senderUrl(event))) await loadCounter()
    else await reloadCurrentPage()
    return { ok: true }
  })
}

app.setName("Light Cart POS")
app.setAppUserModelId(APP_USER_MODEL_ID)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    logger = createLogger(path.join(app.getPath("userData"), "logs"))
    autoUpdater.logger = logger
    const updates = attachUpdater({
      getWindow: () => mainWindow,
      getVersion: () => app.getVersion(),
      log: logger,
      isPackaged: () => app.isPackaged,
    })

    installMenu({
      devTools: devToolsEnabled(),
      openRoute: (route) => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        void mainWindow.loadURL(merchantUrl(START_URL, route))
      },
      sendKey: sendCounterKey,
      reload: () => {
        reloadCurrentPage().catch((error) => logger.error("reload failed", error))
      },
      refreshSavedPages: () => {
        refreshSavedPages().catch((error) => {
          logger.error("refresh saved pages failed", error)
          dialog.showMessageBox({
            type: "error",
            title: "Refresh saved pages",
            message: "Could not refresh the saved counter pages.",
            detail: error instanceof Error ? error.message : String(error),
          })
        })
      },
      showShortcuts: () => {
        void dialog.showMessageBox({
          type: "info",
          title: "Shortcuts",
          message: "Keyboard shortcuts",
          detail: SHORTCUT_HELP,
          buttons: ["OK"],
          noLink: true,
        })
      },
      openBrowser: () => openExternal(START_URL),
      checkForUpdates: () => {
        updates.checkForUpdates({ interactive: true }).catch((error) => logger.error(error))
      },
      showAbout: () => {
        void dialog.showMessageBox({
          type: "info",
          title: "Light Cart POS",
          message: "Light Cart POS for Windows",
          detail: `Counter billing, products, inventory, GST bills, and receipts.\nVersion ${app.getVersion()}`,
          buttons: ["OK"],
          noLink: true,
        })
      },
    })

    installIpc()
    createWindow()
    updates.scheduleStartupCheck()
  })
}

app.on("window-all-closed", () => {
  app.quit()
})
