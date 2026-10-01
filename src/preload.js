"use strict"

const { contextBridge, ipcRenderer } = require("electron")

function readArg(name) {
  const prefix = `--${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : ""
}

contextBridge.exposeInMainWorld("lightCartDesktop", {
  isDesktop: true,
  platform: process.platform,
  version: readArg("light-cart-version"),
  printTicket: (payload) => ipcRenderer.invoke("print-ticket", payload),
  listPrinters: () => ipcRenderer.invoke("list-printers"),
  reload: () => ipcRenderer.invoke("reload"),
})
