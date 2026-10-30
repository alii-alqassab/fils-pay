package settlement

import (
	"context"
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// A float32 accumulator loses whole fils above 2^24 (16,777,216). The estimate
// must stay exact well past that.
func TestUpdateLifetimePayoutMonitoringEstimate_LargeValuesExact(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	for _, net := range []money.Fils{16_777_217, 1, 123_456_789} {
		if err := UpdateLifetimePayoutMonitoringEstimate(ctx, tx, merchantID, net); err != nil {
			t.Fatalf("update(%d): %v", net, err)
		}
	}
	var got float64
	if err := tx.QueryRow(ctx, `SELECT lifetime_net_payout_monitoring_estimate FROM merchants WHERE id = $1`, merchantID).Scan(&got); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got != 140_234_007 {
		t.Fatalf("estimate = %v, want exactly 140234007", got)
	}
}
