/**
 * Counter discount math for Light Cart POS.
 *
 * A line discount is either a percent or a fixed rupee amount on that line.
 * The bill discount (percent or rupees) and loyalty redemption still apply
 * to whatever is left after line discounts. GST stays inclusive: tax is
 * pulled out of the amount the customer actually pays.
 */

export function roundMoney(amount) {
  return Math.round((Number(amount) || 0) * 100) / 100
}

function nonNegative(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/**
 * Rupees off one line. A percent is of this line's price × quantity and is
 * recomputed when the quantity changes. A fixed amount is capped at the line.
 * Saved bills that only have `lineDiscount` rupees use that figure.
 */
export function lineDiscountRupees(line) {
  const gross = nonNegative(line?.unitPrice) * nonNegative(line?.quantity)
  const rawInput = line?.lineDiscountInput
  const hasInput = rawInput != null && String(rawInput).trim() !== ""
  if (hasInput) {
    const input = Number(rawInput)
    if (!Number.isFinite(input) || input < 0) return 0
    if (line.lineDiscountMode === "percent") {
      return roundMoney((gross * Math.min(input, 100)) / 100)
    }
    return Math.min(input, gross)
  }
  const saved = Number(line?.lineDiscount)
  if (!Number.isFinite(saved) || saved < 0) return 0
  return Math.min(saved, gross)
}

/** Same rules the till already uses for the whole-bill discount box. */
export function billDiscountRupees(base, mode, input) {
  const raw = String(input ?? "")
  const amount = Number(raw)
  const cap = Math.max(0, Number(base) || 0)
  if (!raw.trim() || Number.isNaN(amount) || amount < 0) return 0
  if (mode === "percent") return roundMoney((cap * Math.min(amount, 100)) / 100)
  return Math.min(amount, cap)
}

export function loyaltyRupees(redeemRupees, remaining) {
  return Math.min(Math.max(0, Number(redeemRupees) || 0), Math.max(0, Number(remaining) || 0))
}

export function saleTotals(lines, options = {}) {
  const rows = Array.isArray(lines) ? lines : []
  const gross = rows.reduce(
    (sum, line) => sum + nonNegative(line.unitPrice) * nonNegative(line.quantity),
    0
  )
  const lineDiscounts = rows.reduce((sum, line) => sum + lineDiscountRupees(line), 0)
  const afterLines = Math.max(gross - lineDiscounts, 0)
  const billDiscount = billDiscountRupees(afterLines, options.discountMode, options.discountInput)
  const loyalty = loyaltyRupees(options.redeemRupees, afterLines - billDiscount)
  // Header `discount` keeps today's meaning: bill discount plus loyalty rupees.
  const headerDiscount = billDiscount + loyalty
  const total = Math.max(gross - lineDiscounts - headerDiscount, 0)
  return {
    gross,
    lineDiscounts,
    billDiscount,
    loyalty,
    headerDiscount,
    total,
  }
}

function gstRate(value, fallback) {
  const number = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  return Math.min(40, roundMoney(number))
}

function splitInclusiveTax(amount, rate) {
  const value = Math.max(0, Number(amount) || 0)
  const slab = gstRate(rate, 0)
  if (slab <= 0 || value <= 0) return { taxable: roundMoney(value), tax: 0 }
  const taxable = roundMoney(value / (1 + slab / 100))
  return { taxable, tax: roundMoney(value - taxable) }
}

/**
 * Inclusive GST bill. `billDiscount` is the header discount (bill box + loyalty),
 * allocated across lines after each line's own discount.
 */
export function computeDetailedGstBill(lines, billDiscount, prefs = {}) {
  const rows = Array.isArray(lines) ? lines : []
  const fallbackRate = gstRate(prefs.gstRatePercent, 18)
  const gross = rows.reduce(
    (sum, line) => sum + nonNegative(line.unitPrice) * nonNegative(line.quantity),
    0
  )
  const lineDiscounts = rows.reduce((sum, line) => sum + lineDiscountRupees(line), 0)
  const net = Math.max(gross - lineDiscounts, 0)
  const bill = Math.min(Math.max(0, Number(billDiscount) || 0), net)
  const taxMode = prefs.taxMode === "igst" ? "igst" : "cgst_sgst"

  const detailed = rows.map((line) => {
    const lineGross = nonNegative(line.unitPrice) * nonNegative(line.quantity)
    const afterLine = lineGross - lineDiscountRupees(line)
    const share = net > 0 ? afterLine / net : 0
    const lineTotal = roundMoney(afterLine - bill * share)
    const rate = gstRate(line.gstRate, fallbackRate)
    const { taxable, tax } = splitInclusiveTax(lineTotal, rate)
    const igst = taxMode === "igst" ? tax : 0
    const cgst = taxMode === "igst" ? 0 : roundMoney(tax / 2)
    const sgst = taxMode === "igst" ? 0 : roundMoney(tax - cgst)
    return {
      name: line.name,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      unit: line.unit ?? null,
      lineDiscount: lineDiscountRupees(line),
      lineTotal,
      gstRate: rate,
      hsnCode: line.hsnCode ?? null,
      taxable,
      tax,
      cgst,
      sgst,
      igst,
    }
  })

  const slabs = new Map()
  for (const line of detailed) {
    const slab = slabs.get(line.gstRate) ?? {
      rate: line.gstRate,
      taxable: 0,
      tax: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
    }
    slab.taxable = roundMoney(slab.taxable + line.taxable)
    slab.tax = roundMoney(slab.tax + line.tax)
    slab.cgst = roundMoney(slab.cgst + line.cgst)
    slab.sgst = roundMoney(slab.sgst + line.sgst)
    slab.igst = roundMoney(slab.igst + line.igst)
    slabs.set(line.gstRate, slab)
  }
  const slabRows = [...slabs.values()].sort((left, right) => left.rate - right.rate)
  const sum = (key) => roundMoney(slabRows.reduce((total, slab) => total + slab[key], 0))
  const grandTotal = roundMoney(net - bill)
  const roundedTotal = Math.round(grandTotal)
  return {
    lines: detailed,
    slabs: slabRows,
    taxableValue: sum("taxable"),
    totalTax: sum("tax"),
    cgst: sum("cgst"),
    sgst: sum("sgst"),
    igst: sum("igst"),
    grandTotal,
    roundedTotal,
    roundOff: roundMoney(roundedTotal - grandTotal),
    taxMode,
  }
}

/**
 * Partial refund of `quantity` units from a saved line.
 * The bill discount is shared in proportion to what each line actually cost
 * after its own discount. Refunding every remaining unit returns the unpaid balance.
 */
export function partialRefundAmount({ subtotal, headerDiscount, total, lines, alreadyRefunded = 0, selections }) {
  const saved = Array.isArray(lines) ? lines : []
  const lineDiscountSum = saved.reduce((sum, line) => sum + Math.min(nonNegative(line.lineDiscount), nonNegative(line.unitPrice) * nonNegative(line.quantity)), 0)
  const netBase = Math.max((Number(subtotal) || 0) - lineDiscountSum, 0)
  const remaining = Math.max((Number(total) || 0) - (Number(alreadyRefunded) || 0), 0)
  let refundNet = 0
  let allDone = saved.length > 0
  for (const line of saved) {
    const sold = nonNegative(line.quantity)
    const already = Math.min(nonNegative(line.refundedQty), sold)
    const pick = selections.find((row) => row.lineId === line.id)
    const qty = pick ? nonNegative(pick.quantity) : 0
    if (already + qty < sold) allDone = false
    if (qty <= 0 || sold <= 0) continue
    const lineDiscount = Math.min(nonNegative(line.lineDiscount), nonNegative(line.unitPrice) * sold)
    refundNet += nonNegative(line.unitPrice) * qty - (lineDiscount * qty) / sold
  }
  if (allDone) return roundMoney(remaining)
  if (netBase <= 0) return 0
  return roundMoney(Math.min((refundNet * (Number(total) || 0)) / netBase, remaining))
}
