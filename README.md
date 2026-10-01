# Light Cart POS

Windows till app for [Light Cart](https://light-cart-eta.vercel.app/merchant/pos). It opens the merchant counter, prints thermal receipts without a print dialog, and updates from GitHub Releases.

Install `LightCartPOS-Setup-*.exe` once on each till. Later versions install from **Help → Update**. The installed app reads `latest.yml` from [Releases](https://github.com/chinarcart/light-cart-pos/releases).

## Develop

```bash
npm install
npm test
npm start
```

`LIGHT_CART_URL` points the window at another counter, for example `http://localhost:3000/merchant/pos`. `LIGHT_CART_DEVTOOLS=1` shows DevTools. The packaged app hides DevTools.

## Build a Windows installer

On Windows:

```bash
npm run dist
```

The Setup file is written to `dist/`. Publishing that file, its blockmap, and `latest.yml` on a GitHub Release is what tills download.

## What the shell is responsible for

The counter itself (bills, products, inventory, GST) lives on the merchant site. This app is the desktop shell:

- Loads only the Light Cart site. Other links open in the browser.
- Silent receipt printing to the printer chosen in Settings.
- Camera access for barcode scan, limited to that site.
- An offline screen with retry when the counter cannot load.
- **POS → Refresh saved pages** when a till is stuck on an old cached counter.
- Update check on startup, and from **Help → Update**.
