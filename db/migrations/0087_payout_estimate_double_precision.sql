-- lifetime_net_payout_monitoring_estimate was REAL (float4): exact only up to
-- 2^24 fils (about 16,777 BD), so busy merchants' totals drifted. DOUBLE
-- PRECISION is exact for whole fils up to 2^53, far beyond any payout total.
ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE DOUBLE PRECISION;
