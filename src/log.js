"use strict"

const fs = require("fs")
const path = require("path")

function createLogger(directory) {
  const file = path.join(directory, "light-cart-pos.log")
  function write(level, args) {
    const line = `[${new Date().toISOString()}] ${level} ${args
      .map((value) => (value instanceof Error ? value.stack || value.message : String(value)))
      .join(" ")}\n`
    try {
      fs.mkdirSync(directory, { recursive: true })
      const stat = fs.existsSync(file) ? fs.statSync(file) : null
      if (stat && stat.size > 512 * 1024) {
        fs.renameSync(file, `${file}.1`)
      }
      fs.appendFileSync(file, line)
    } catch {
      // Logging must not take down the till.
    }
  }
  return {
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  }
}

module.exports = { createLogger }
