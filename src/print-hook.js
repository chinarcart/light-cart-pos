"use strict"

// Installed into the merchant page so a window.print() of the receipt image
// goes to the thermal printer. The page also calls printTicket directly.
const PRINT_HOOK = `
(() => {
  if (window.__lcNativePrintHooked) return;
  window.__lcNativePrintHooked = true;
  const original = window.print.bind(window);
  window.print = function () {
    const img = document.querySelector("#lc-pos-receipt-print img.lc-ticket, #lc-pos-receipt-print img");
    if (img && img.src && img.src.indexOf("data:image/") === 0 && window.lightCartDesktop) {
      let paperMm = img.getAttribute("data-paper-mm") || "58";
      let printWidthMm = Number(img.getAttribute("data-print-width-mm")) || 0;
      let printerName = img.getAttribute("data-printer") || "";
      try {
        const prefs = JSON.parse(localStorage.getItem("lc:receipt-prefs:v1") || "{}");
        if (prefs.paperWidth === "80" || prefs.paperWidth === "58") paperMm = prefs.paperWidth;
        if (Number(prefs.contentWidthMm) > 0) printWidthMm = Number(prefs.contentWidthMm);
        if (!printerName && typeof prefs.printerName === "string") printerName = prefs.printerName;
      } catch (e) {}
      if (!printWidthMm) printWidthMm = paperMm === "80" ? 64 : 42;
      Promise.resolve(window.lightCartDesktop.printTicket({
        dataUrl: img.src,
        paperMm: paperMm,
        printWidthMm: printWidthMm,
        printerName: printerName,
        heightPx: img.naturalHeight || 1400
      })).catch((error) => {
        const message = error && error.message ? error.message : "Print failed";
        window.dispatchEvent(new CustomEvent("lc-print-error", { detail: message }));
        console.error(message);
      });
      return;
    }
    return original();
  };
})();
`

module.exports = { PRINT_HOOK }
