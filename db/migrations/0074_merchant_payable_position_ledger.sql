-- merchant_payable_position (0054) summed scheme_export_lines, i.e. historical
-- exported gross. It ignored fees, payouts and journaled credits, so paid-out
-- activity reappeared as payable when the console rebuilt balances.
-- Outstanding payable is the net credit balance of the merchant_payable
-- ledger account, the same computation as ledger.RebuildMerchantBalance.

CREATE OR REPLACE VIEW merchant_payable_position AS
SELECT le.merchant_id,
       COALESCE(SUM(CASE WHEN le.direction = 'credit' THEN le.amount_fils
                         ELSE -le.amount_fils END), 0) AS payable_fils
  FROM ledger_entries le
 WHERE le.account_id = 'merchant_payable'
 GROUP BY le.merchant_id;
