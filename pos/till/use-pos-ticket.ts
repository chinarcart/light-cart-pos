"use client"

import {
  startTransition,
  useCallback,
  useEffect,
  useOptimistic,
  useRef,
  useState,
} from "react"

import type { PosBillLine } from "@/lib/merchant/pos"
import {
  EMPTY_POS_TICKET,
  loadActiveTicket,
  saveActiveTicket,
  type PosTicket,
} from "@/lib/offline/pos-ticket"

export type LineDiscountMode = "amount" | "percent"

export type DiscountedPosLine = PosBillLine & {
  /** Price before this line's own discount. Price overrides update this. */
  listUnitPrice?: number
  lineDiscountMode?: LineDiscountMode
  lineDiscountInput?: string
}

export type PosTicketAction =
  | { type: "add"; line: PosBillLine }
  | {
      type: "qty"
      productId: string
      variantName?: string
      delta: number
    }
  | { type: "remove"; productId: string; variantName?: string }
  | { type: "removeLast" }
  | {
      type: "setPrice"
      productId: string
      variantName?: string
      unitPrice: number
    }
  | {
      type: "setDiscount"
      mode?: LineDiscountMode
      input?: string
    }
  | {
      type: "setLineDiscount"
      productId: string
      variantName?: string
      mode?: LineDiscountMode
      input?: string
    }
  | { type: "replace"; ticket: PosTicket }
  | { type: "clear" }

type TicketApi = {
  getLines: () => DiscountedPosLine[]
  setLineDiscount: (
    productId: string,
    variantName: string | undefined,
    mode: LineDiscountMode,
    input: string
  ) => void
}

declare global {
  interface Window {
    __lcPos?: TicketApi
  }
}

function roundMoney(amount: number) {
  return Math.round(amount * 100) / 100
}

function sameLine(line: PosBillLine, productId: string, variantName?: string) {
  return line.productId === productId && (line.variantName ?? "") === (variantName ?? "")
}

function asDiscounted(line: PosBillLine): DiscountedPosLine {
  return line as DiscountedPosLine
}

/** Rupees off the whole line, from the typed percent or amount. */
export function lineDiscountRupees(line: DiscountedPosLine) {
  const list = line.listUnitPrice ?? line.unitPrice
  const gross = Math.max(0, list) * Math.max(0, line.quantity)
  const raw = line.lineDiscountInput
  if (raw == null || String(raw).trim() === "") return 0
  const input = Number(raw)
  if (!Number.isFinite(input) || input < 0) return 0
  if (line.lineDiscountMode === "percent") {
    return roundMoney((gross * Math.min(input, 100)) / 100)
  }
  return Math.min(input, gross)
}

/**
 * Keep the list price, and fold the line discount into unitPrice so the
 * existing bill total (price × quantity, then the bill discount) stays right.
 */
export function applyLineDiscount(line: DiscountedPosLine): DiscountedPosLine {
  const list = line.listUnitPrice ?? line.unitPrice
  const next: DiscountedPosLine = { ...line, listUnitPrice: list }
  const off = lineDiscountRupees(next)
  const net = Math.max(roundMoney(list * Math.max(0, next.quantity) - off), 0)
  next.lineDiscount = off
  next.unitPrice = next.quantity > 0 ? net / next.quantity : list
  return next
}

export function reducePosTicket(ticket: PosTicket, action: PosTicketAction): PosTicket {
  switch (action.type) {
    case "add": {
      const variantName = action.line.variantName ?? ""
      const qty = action.line.quantity
      const existing = ticket.lines.find((line) =>
        sameLine(line, action.line.productId, variantName)
      )
      const lines = existing
        ? ticket.lines.map((line) =>
            sameLine(line, action.line.productId, variantName)
              ? applyLineDiscount({ ...asDiscounted(line), quantity: line.quantity + qty })
              : line
          )
        : [
            ...ticket.lines,
            applyLineDiscount({
              ...asDiscounted(action.line),
              listUnitPrice: asDiscounted(action.line).listUnitPrice ?? action.line.unitPrice,
            }),
          ]
      return { ...ticket, lines }
    }
    case "qty": {
      const current = ticket.lines.find((line) =>
        sameLine(line, action.productId, action.variantName)
      )
      if (!current) return ticket
      const quantity = current.quantity + action.delta
      const lines =
        quantity <= 0
          ? ticket.lines.filter((line) => !sameLine(line, action.productId, action.variantName))
          : ticket.lines.map((line) =>
              sameLine(line, action.productId, action.variantName)
                ? applyLineDiscount({ ...asDiscounted(line), quantity })
                : line
            )
      return { ...ticket, lines }
    }
    case "remove":
      return {
        ...ticket,
        lines: ticket.lines.filter((line) => !sameLine(line, action.productId, action.variantName)),
      }
    case "removeLast":
      return { ...ticket, lines: ticket.lines.slice(0, -1) }
    case "setPrice":
      return {
        ...ticket,
        lines: ticket.lines.map((line) =>
          sameLine(line, action.productId, action.variantName)
            ? applyLineDiscount({
                ...asDiscounted(line),
                listUnitPrice: action.unitPrice,
                originalPrice:
                  line.originalPrice ?? asDiscounted(line).listUnitPrice ?? line.unitPrice,
              })
            : line
        ),
      }
    case "setDiscount":
      return {
        ...ticket,
        discountMode: action.mode ?? ticket.discountMode,
        discountInput: action.input !== undefined ? action.input : ticket.discountInput,
      }
    case "setLineDiscount":
      return {
        ...ticket,
        lines: ticket.lines.map((line) => {
          if (!sameLine(line, action.productId, action.variantName)) return line
          const current = asDiscounted(line)
          return applyLineDiscount({
            ...current,
            listUnitPrice: current.listUnitPrice ?? current.unitPrice,
            lineDiscountMode: action.mode ?? current.lineDiscountMode ?? "amount",
            lineDiscountInput:
              action.input !== undefined ? action.input : (current.lineDiscountInput ?? ""),
          })
        }),
      }
    case "replace":
      return action.ticket
    case "clear":
      return EMPTY_POS_TICKET
    default:
      return ticket
  }
}

export function usePosTicket(storeId: string) {
  const [ticket, setTicket] = useState<PosTicket>(EMPTY_POS_TICKET)
  const [optimistic, applyOptimistic] = useOptimistic(ticket, reducePosTicket)
  const ticketRef = useRef(ticket)
  const ready = useRef(false)

  const commit = useCallback(() => {
    const write = () => {
      setTicket(ticketRef.current)
      if (ready.current) void saveActiveTicket(storeId, ticketRef.current)
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("lc-ticket"))
      }
    }
    if (typeof queueMicrotask === "function") queueMicrotask(write)
    else write()
  }, [storeId])

  const dispatch = useCallback(
    (action: PosTicketAction) => {
      ticketRef.current = reducePosTicket(ticketRef.current, action)
      startTransition(() => {
        applyOptimistic(action)
      })
      commit()
    },
    [applyOptimistic, commit]
  )

  useEffect(() => {
    ready.current = false
    ticketRef.current = EMPTY_POS_TICKET
    setTicket(EMPTY_POS_TICKET)
    let cancelled = false
    void loadActiveTicket(storeId).then((saved) => {
      if (cancelled) return
      if (saved && ticketRef.current.lines.length === 0) {
        ticketRef.current = saved
        setTicket(saved)
      }
      ready.current = true
      if (ticketRef.current.lines.length > 0) void saveActiveTicket(storeId, ticketRef.current)
      window.dispatchEvent(new CustomEvent("lc-ticket"))
    })
    return () => {
      cancelled = true
    }
  }, [storeId])

  const addLine = useCallback(
    (line: PosBillLine) => {
      dispatch({ type: "add", line })
      return ticketRef.current.lines.find(
        (row) => row.productId === line.productId && (row.variantName ?? "") === (line.variantName ?? "")
      )
    },
    [dispatch]
  )
  const bumpQty = useCallback(
    (productId: string, variantName: string | undefined, delta: number) => {
      dispatch({ type: "qty", productId, variantName, delta })
    },
    [dispatch]
  )
  const removeLine = useCallback(
    (productId: string, variantName?: string) => {
      dispatch({ type: "remove", productId, variantName })
    },
    [dispatch]
  )
  const removeLast = useCallback(() => {
    dispatch({ type: "removeLast" })
  }, [dispatch])
  const setPrice = useCallback(
    (productId: string, variantName: string | undefined, unitPrice: number) => {
      dispatch({ type: "setPrice", productId, variantName, unitPrice })
    },
    [dispatch]
  )
  const setDiscount = useCallback(
    (patch: { mode?: LineDiscountMode; input?: string }) => {
      dispatch({ type: "setDiscount", ...patch })
    },
    [dispatch]
  )
  const replace = useCallback(
    (next: PosTicket) => {
      dispatch({ type: "replace", ticket: next })
    },
    [dispatch]
  )
  const clear = useCallback(() => {
    dispatch({ type: "clear" })
  }, [dispatch])

  const setLineDiscount = useCallback(
    (productId: string, variantName: string | undefined, mode: LineDiscountMode, input: string) => {
      dispatch({ type: "setLineDiscount", productId, variantName, mode, input })
    },
    [dispatch]
  )

  if (typeof window !== "undefined") {
    window.__lcPos = {
      getLines: () => ticketRef.current.lines as DiscountedPosLine[],
      setLineDiscount,
    }
  }

  return {
    lines: optimistic.lines,
    discountMode: optimistic.discountMode,
    discountInput: optimistic.discountInput,
    ticketRef,
    addLine,
    bumpQty,
    removeLine,
    removeLast,
    setPrice,
    setDiscount,
    replace,
    clear,
  }
}
