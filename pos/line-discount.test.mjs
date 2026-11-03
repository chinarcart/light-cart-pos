import assert from "node:assert/strict"
import test from "node:test"

import {
  billDiscountRupees,
  computeDetailedGstBill,
  lineDiscountRupees,
  partialRefundAmount,
  saleTotals,
} from "./line-discount.mjs"

const prefs = { gstRatePercent: 18, taxMode: "cgst_sgst" }

test("a fixed rupee line discount is capped at the line", () => {
  assert.equal(lineDiscountRupees({ unitPrice: 40, quantity: 2, lineDiscountMode: "amount", lineDiscountInput: "15" }), 15)
  assert.equal(lineDiscountRupees({ unitPrice: 40, quantity: 1, lineDiscountMode: "amount", lineDiscountInput: "90" }), 40)
  assert.equal(lineDiscountRupees({ unitPrice: 40, quantity: 1, lineDiscountMode: "amount", lineDiscountInput: "" }), 0)
})

test("a percent line discount follows quantity", () => {
  assert.equal(
    lineDiscountRupees({ unitPrice: 100, quantity: 2, lineDiscountMode: "percent", lineDiscountInput: "10" }),
    20
  )
  assert.equal(
    lineDiscountRupees({ unitPrice: 100, quantity: 3, lineDiscountMode: "percent", lineDiscountInput: "10" }),
    30
  )
  assert.equal(
    lineDiscountRupees({ unitPrice: 80, quantity: 1, lineDiscountMode: "percent", lineDiscountInput: "250" }),
    80
  )
})

test("saved line rupees are used when the till is reprinting a bill", () => {
  assert.equal(lineDiscountRupees({ unitPrice: 50, quantity: 2, lineDiscount: 12 }), 12)
  assert.equal(lineDiscountRupees({ unitPrice: 50, quantity: 1, lineDiscount: 80 }), 50)
})

test("bill discount still applies, but only after line discounts", () => {
  const lines = [
    { unitPrice: 100, quantity: 2, lineDiscountMode: "percent", lineDiscountInput: "10" },
    { unitPrice: 50, quantity: 1, lineDiscountMode: "amount", lineDiscountInput: "10" },
  ]
  const totals = saleTotals(lines, { discountMode: "percent", discountInput: "10", redeemRupees: 0 })
  assert.equal(totals.gross, 250)
  assert.equal(totals.lineDiscounts, 30)
  assert.equal(totals.billDiscount, 22)
  assert.equal(totals.headerDiscount, 22)
  assert.equal(totals.total, 198)
})

test("a bill with no line discounts matches the till's current total", () => {
  const lines = [
    { unitPrice: 100, quantity: 2 },
    { unitPrice: 50, quantity: 1 },
  ]
  const totals = saleTotals(lines, { discountMode: "amount", discountInput: "30", redeemRupees: 5 })
  assert.equal(totals.lineDiscounts, 0)
  assert.equal(totals.billDiscount, 30)
  assert.equal(totals.loyalty, 5)
  assert.equal(totals.headerDiscount, 35)
  assert.equal(totals.total, 215)
  assert.equal(billDiscountRupees(250, "percent", "10"), 25)
})

test("inclusive GST ignores nothing the customer was charged", () => {
  const lines = [
    { name: "Rice", unitPrice: 118, quantity: 1, gstRate: 18, lineDiscountMode: "amount", lineDiscountInput: "18" },
  ]
  const bill = computeDetailedGstBill(lines, 0, prefs)
  assert.equal(bill.lines[0].lineTotal, 100)
  assert.equal(bill.lines[0].taxable, 84.75)
  assert.equal(bill.lines[0].tax, 15.25)
  assert.equal(bill.lines[0].cgst, 7.63)
  assert.equal(bill.lines[0].sgst, 7.62)
  assert.equal(bill.grandTotal, 100)
})

test("a bill discount is shared by what each line costs after its own discount", () => {
  const lines = [
    { name: "A", unitPrice: 200, quantity: 1, gstRate: 18, lineDiscount: 0 },
    { name: "B", unitPrice: 100, quantity: 1, gstRate: 5, lineDiscount: 100 },
  ]
  const bill = computeDetailedGstBill(lines, 20, prefs)
  assert.equal(bill.lines[0].lineTotal, 180)
  assert.equal(bill.lines[1].lineTotal, 0)
  assert.equal(bill.grandTotal, 180)
  assert.equal(bill.lines[1].tax, 0)
})

test("zero line discounts keep the previous GST allocation", () => {
  const lines = [
    { name: "A", unitPrice: 100, quantity: 2, gstRate: 18, unit: "pc", hsnCode: "1006" },
    { name: "B", unitPrice: 50, quantity: 1, gstRate: 5, unit: "pc", hsnCode: null },
  ]
  const current = computeDetailedGstBill(lines, 30, prefs)
  const gross = 250
  const billDiscount = 30
  const expectedLines = lines.map((line) => {
    const lineGross = line.unitPrice * line.quantity
    return Math.round((lineGross - billDiscount * (lineGross / gross)) * 100) / 100
  })
  assert.deepEqual(current.lines.map((line) => line.lineTotal), expectedLines)
  assert.equal(current.grandTotal, 220)
  assert.equal(current.lines[0].cgst + current.lines[0].sgst, current.lines[0].tax)
})

test("refunding one discounted unit does not refund the full price", () => {
  const amount = partialRefundAmount({
    subtotal: 200,
    headerDiscount: 20,
    total: 160,
    alreadyRefunded: 0,
    lines: [
      { id: "a", unitPrice: 100, quantity: 2, lineDiscount: 20, refundedQty: 0 },
    ],
    selections: [{ lineId: "a", quantity: 1 }],
  })
  // Line net is 180 for both units. One unit is 90, then the ₹20 bill discount
  // is shared across the ₹180 base: 90 * 160 / 180 = 80.
  assert.equal(amount, 80)
})

test("refunding a bill with no line discounts still prorates the bill discount", () => {
  const amount = partialRefundAmount({
    subtotal: 200,
    headerDiscount: 20,
    total: 180,
    lines: [{ id: "a", unitPrice: 100, quantity: 2, lineDiscount: 0, refundedQty: 0 }],
    selections: [{ lineId: "a", quantity: 1 }],
  })
  assert.equal(amount, 90)
})

test("the last unit of a bill refunds whatever balance is left", () => {
  const amount = partialRefundAmount({
    subtotal: 100,
    headerDiscount: 0,
    total: 90,
    alreadyRefunded: 45,
    lines: [{ id: "a", unitPrice: 50, quantity: 2, lineDiscount: 10, refundedQty: 1 }],
    selections: [{ lineId: "a", quantity: 1 }],
  })
  assert.equal(amount, 45)
})
