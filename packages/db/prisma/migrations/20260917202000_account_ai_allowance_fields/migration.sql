-- The customer's AI ceiling, and the per-account exceptions cosmo-admin
-- writes. All nullable with no default, so existing accounts land on exactly
-- the published policy: no ceiling, no override, the plan's allowance.
ALTER TABLE "Account"
  ADD COLUMN "aiOverageCapBrl" DECIMAL(10,2),
  ADD COLUMN "aiAllowanceOverride" INTEGER,
  ADD COLUMN "aiAllowanceOverrideUntil" TIMESTAMP(3),
  ADD COLUMN "limitsOverrideUntil" TIMESTAMP(3);
