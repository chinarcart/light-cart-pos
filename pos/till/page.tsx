"use client"

import { MerchantGate } from "@/components/merchant/merchant-gate"
import { MerchantShell } from "@/components/merchant/merchant-shell"
import { MerchantPos } from "@/components/merchant/merchant-pos"
import { PosLineDiscount } from "@/components/merchant/pos-line-discount"

export default function MerchantPosPage() {
  return (
    <MerchantGate requireRight="pos">
      {({ storeId, businessName, rights, isMerchant, role }) => (
        <MerchantShell
          storeId={storeId}
          businessName={businessName}
          rights={rights}
          isMerchant={isMerchant}
        >
          <MerchantPos
            storeId={storeId}
            businessName={businessName}
            canOverridePrice={
              isMerchant || role === "manager" || role === "full"
            }
            requireShift={!isMerchant}
          />
          <PosLineDiscount />
        </MerchantShell>
      )}
    </MerchantGate>
  )
}
