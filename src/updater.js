"use strict"

const { dialog } = require("electron")
const { autoUpdater } = require("electron-updater")
const { classifyUpdateError, downloadSize, formatBytes, releaseNotes, updateIsAvailable } = require("./lib/updates")

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

function attachUpdater({ getWindow, getVersion, log, isPackaged }) {
  let updateBusy = false
  let progressHooked = false

  function window() {
    const current = getWindow()
    if (!current || current.isDestroyed()) return null
    return current
  }

  function setProgress(fraction) {
    const current = window()
    if (!current) return
    current.setProgressBar(fraction)
    if (fraction < 0) current.setTitle("Light Cart POS")
  }

  function hookProgress() {
    if (progressHooked) return
    progressHooked = true
    autoUpdater.on("download-progress", (progress) => {
      const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0))
      const current = window()
      if (!current) return
      current.setProgressBar(percent / 100)
      current.setTitle(`Light Cart POS — downloading update ${Math.round(percent)}%`)
    })
  }

  async function showInfo(title, message, detail, buttons) {
    return dialog.showMessageBox(window() || undefined, {
      type: "info",
      title,
      message,
      detail,
      buttons: buttons || ["OK"],
      defaultId: 0,
      cancelId: buttons ? buttons.length - 1 : 0,
      noLink: true,
    })
  }

  async function explainFailure(error) {
    const kind = classifyUpdateError(error)
    const installed = getVersion()
    if (kind === "current") {
      await showInfo("Update", `You are on version ${installed}.`, "No newer version is available.")
      return
    }
    if (kind === "offline") {
      await showInfo(
        "Update",
        `You are on version ${installed}.`,
        "This till could not reach GitHub Releases. Keep using it and try Help → Update again when online."
      )
      return
    }
    const raw = error instanceof Error ? error.message : String(error)
    await dialog.showMessageBox(window() || undefined, {
      type: "error",
      title: "Update",
      message: kind === "missing" ? "Could not find the update on GitHub." : "Could not check for updates.",
      detail:
        kind === "missing"
          ? `${raw}\n\nThe public repo github.com/chinarcart/light-cart-pos must have a Release with latest.yml and the Setup file.`
          : `${raw}\n\nYou can keep using this till.`,
      buttons: ["OK"],
      noLink: true,
    })
  }

  async function offerUpdate(result) {
    const installed = getVersion()
    const latest = result.updateInfo.version
    if (!updateIsAvailable(result, installed)) {
      await showInfo(
        "Update",
        `You are on version ${installed}.`,
        latest
          ? `The published version is ${latest}. This till is already on ${installed}.`
          : "No newer version is available."
      )
      return
    }

    const notes = releaseNotes(result.updateInfo)
    const choice = await showInfo(
      "Update available",
      `Version ${latest} is available.`,
      `This computer is on ${installed}. Download is about ${formatBytes(downloadSize(result.updateInfo))}.\n` +
        "The till keeps working while the update downloads, then restarts to install it." +
        (notes ? `\n\n${notes}` : ""),
      ["Download and restart", "Later"]
    )
    if (choice.response !== 0) return

    hookProgress()
    setProgress(0)
    const current = window()
    if (current) current.setTitle("Light Cart POS — downloading update 0%")
    try {
      await autoUpdater.downloadUpdate()
    } finally {
      setProgress(-1)
    }

    const restart = await showInfo(
      "Update ready",
      `Version ${latest} is ready to install.`,
      "Light Cart POS will restart to finish the update. If you choose Later, it installs the next time the till closes.",
      ["Restart now", "Later"]
    )
    if (restart.response === 0) autoUpdater.quitAndInstall(false, true)
  }

  async function checkForUpdates({ interactive }) {
    if (updateBusy) return
    if (!isPackaged()) {
      if (interactive) {
        await showInfo(
          "Update",
          "Install Light Cart POS with the Setup file first.",
          "Help → Update works on the installed app, not while running from source."
        )
      }
      return
    }

    updateBusy = true
    hookProgress()
    try {
      const result = await autoUpdater.checkForUpdates()
      if (!result) {
        if (interactive) {
          await showInfo("Update", `You are on version ${getVersion()}.`, "No newer version is available.")
        }
        return
      }
      const available = updateIsAvailable(result, getVersion())
      if (!interactive && !available) return
      await offerUpdate(result)
    } catch (error) {
      log.error("update check failed", error)
      setProgress(-1)
      if (interactive) await explainFailure(error)
    } finally {
      updateBusy = false
    }
  }

  function scheduleStartupCheck() {
    setTimeout(() => {
      checkForUpdates({ interactive: false }).catch((error) => log.error("startup update failed", error))
    }, 8000)
  }

  return { checkForUpdates, scheduleStartupCheck }
}

module.exports = { attachUpdater }
