"use strict"

const { Menu } = require("electron")
const { SHORTCUT_HELP, menuTemplate } = require("./lib/menu-template")

function installMenu(actions) {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(actions)))
}

module.exports = {
  SHORTCUT_HELP,
  installMenu,
}
