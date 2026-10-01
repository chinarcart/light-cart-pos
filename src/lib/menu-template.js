"use strict"

const { ROUTES } = require("./origins")

const SHORTCUT_HELP = `Counter
F1 — Payment, then charge & print
F2 — Search products
F3 — Back to barcode
F4 — Add a new product
F8 — Hold bill for another customer
F9 — Show held bills / recall
Enter — Add scanned barcode to bill
1 / 2 / 3 — UPI / Cash / Card (payment)
+ / − — Change qty of last line
Delete — Remove last bill line
Esc — Exit payment / close panels
? — Shortcuts on the counter

Pages
Ctrl+1 — Counter
Ctrl+0 — Scan
Ctrl+2 — Dashboard
Ctrl+3 — Products
Ctrl+4 — Inventory
Ctrl+5 — Bills
Ctrl+6 — Reports
Ctrl+9 — Settings
Ctrl+R — Reload
F11 — Fullscreen`

function menuTemplate(actions) {
  return [
    {
      label: "POS",
      submenu: [
        ...ROUTES.map((route) => ({
          label: route.label,
          accelerator: route.accelerator,
          click: () => actions.openRoute(route.path),
        })),
        { type: "separator" },
        { label: "Hold bill", accelerator: "F8", click: () => actions.sendKey("F8") },
        { label: "Held bills", accelerator: "F9", click: () => actions.sendKey("F9") },
        { type: "separator" },
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => actions.reload() },
        { label: "Refresh saved pages", click: () => actions.refreshSavedPages() },
        { label: "Fullscreen", accelerator: "F11", role: "togglefullscreen" },
        { type: "separator" },
        { label: "Quit", accelerator: "Alt+F4", role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        ...(actions.devTools ? [{ type: "separator" }, { role: "toggleDevTools" }] : []),
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "Shortcuts", click: () => actions.showShortcuts() },
        { label: "Open in browser", click: () => actions.openBrowser() },
        { label: "Update…", click: () => actions.checkForUpdates() },
        { label: "About Light Cart POS", click: () => actions.showAbout() },
      ],
    },
  ]
}

module.exports = {
  SHORTCUT_HELP,
  menuTemplate,
}
