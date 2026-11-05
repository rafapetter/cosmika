-- The payment link cosmo-admin issues at signup, kept so the "subscription
-- ended" screen can offer it. Nullable: accounts created before this, or whose
-- checkout call failed, have none and fall back to contacting finance.
ALTER TABLE "Account" ADD COLUMN "billingCheckoutUrl" TEXT;
