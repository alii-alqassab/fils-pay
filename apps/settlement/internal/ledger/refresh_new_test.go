package ledger

import (
	"context"
	"testing"
)

// Migration 0074 redefined merchant_payable_position over ledger_entries
// (merchant_payable account), so RefreshBalanceCache is ledger-driven. The
// older refresh_test.go seeds scheme_export_lines only and no longer applies.
func TestRefreshBalanceCache_LedgerDriven(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)
	postLedgerLeg(t, pool, merchantID, "credit", 25000)
	postLedgerLeg(t, pool, merchantID, "debit", 1000)
	if _, err := pool.Exec(context.Background(), `INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at) VALUES ($1, 888888, now())`, merchantID); err != nil {
		t.Fatal(err)
	}
	diffs, err := RefreshBalanceCache(context.Background(), pool)
	if err != nil {
		t.Fatal(err)
	}
	d, ok := diffs[merchantID]
	if !ok || int64(d.CachedBefore) != 888888 || int64(d.Rebuilt) != 24000 {
		t.Fatalf("diff = %+v ok=%v, want before 888888 rebuilt 24000", d, ok)
	}
}
