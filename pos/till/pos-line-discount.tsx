"use client"

import { useEffect, useState } from "react"

import type { DiscountedPosLine, LineDiscountMode } from "@/hooks/use-pos-ticket"

const MARK = "§LD"

type TicketWindow = Window & {
  __lcPos?: {
    getLines: () => DiscountedPosLine[]
    setLineDiscount: (
      productId: string,
      variantName: string | undefined,
      mode: LineDiscountMode,
      input: string
    ) => void
  }
  __lcLineDiscountFetch?: boolean
}

function money(amount: number) {
  return `₹${(Math.round(amount * 100) / 100).toFixed(2)}`
}

function roundMoney(amount: number) {
  return Math.round(amount * 100) / 100
}

function installSalePatch() {
  const host = window as TicketWindow
  if (host.__lcLineDiscountFetch) return
  host.__lcLineDiscountFetch = true
  const original = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase()
    if (method === "POST" && url.includes("/api/merchant/pos/sale") && init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as {
          items?: Array<{
            productId: string
            variantId?: string | null
            quantity: number
            unitPrice: number
            lineDiscount?: number
          }>
          notes?: string | null
        }
        const lines = host.__lcPos?.getLines() ?? []
        const marks: Array<{ p: string; v: string; a: number }> = []
        if (Array.isArray(body.items)) {
          body.items = body.items.map((item) => {
            const line = lines.find(
              (row) =>
                row.productId === item.productId &&
                (row.variantId ?? null) === (item.variantId ?? null)
            )
            const list = line?.listUnitPrice
            if (list == null || !(line.lineDiscount && line.lineDiscount > 0)) return item
            const off = roundMoney(Math.max(0, list * item.quantity - item.unitPrice * item.quantity))
            if (off <= 0) return item
            marks.push({ p: item.productId, v: item.variantId || "", a: off })
            return { ...item, unitPrice: list, lineDiscount: off }
          })
        }
        if (marks.length > 0) {
          const note = typeof body.notes === "string" ? body.notes.replace(/\n?§LD[\s\S]*$/, "") : ""
          body.notes = `${note}${note ? "\n" : ""}${MARK}${JSON.stringify(marks)}`
        }
        init = { ...init, body: JSON.stringify(body) }
      } catch {
        // Leave the original bill alone if it is not JSON we understand.
      }
    }
    return original(input, init)
  }
}

export function PosLineDiscount() {
  const [lines, setLines] = useState<DiscountedPosLine[]>([])

  useEffect(() => {
    installSalePatch()
    const read = () => setLines((window as TicketWindow).__lcPos?.getLines() ?? [])
    read()
    const timer = window.setInterval(read, 400)
    window.addEventListener("lc-ticket", read)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("lc-ticket", read)
    }
  }, [])

  if (lines.length === 0) return null

  return (
    <section
      aria-label="Line discounts"
      className="fixed bottom-3 left-3 z-[70] w-[min(24rem,calc(100vw-1.5rem))] rounded-2xl border border-white/15 bg-zinc-950/95 p-3 text-white shadow-2xl"
    >
      <p className="text-[11px] font-medium tracking-wide text-white/50 uppercase">Line discount</p>
      <ul className="mt-2 max-h-48 space-y-2 overflow-auto">
        {lines.map((line) => {
          const mode = line.lineDiscountMode === "percent" ? "percent" : "amount"
          const list = line.listUnitPrice ?? line.unitPrice
          return (
            <li key={`${line.productId}-${line.variantName ?? ""}`} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{line.name}</p>
                <p className="text-[11px] text-white/45 tabular-nums">
                  {money(list)} each
                  {line.lineDiscount && line.lineDiscount > 0 ? ` · off ${money(line.lineDiscount)}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <div className="flex rounded-lg border border-white/15 p-0.5">
                  {(
                    [
                      ["amount", "₹"],
                      ["percent", "%"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={`rounded-md px-2 py-1 text-xs font-bold ${
                        mode === id ? "bg-emerald-500 text-white" : "text-white/50"
                      }`}
                      onClick={() =>
                        (window as TicketWindow).__lcPos?.setLineDiscount(
                          line.productId,
                          line.variantName,
                          id,
                          line.lineDiscountInput ?? ""
                        )
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <input
                  aria-label={`Discount for ${line.name}`}
                  inputMode="decimal"
                  className="h-8 w-16 rounded-lg border border-white/15 bg-white/5 px-2 text-right text-sm tabular-nums outline-none"
                  placeholder={mode === "percent" ? "%" : "₹"}
                  value={line.lineDiscountInput ?? ""}
                  onChange={(event) =>
                    (window as TicketWindow).__lcPos?.setLineDiscount(
                      line.productId,
                      line.variantName,
                      mode,
                      event.target.value
                    )
                  }
                />
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
