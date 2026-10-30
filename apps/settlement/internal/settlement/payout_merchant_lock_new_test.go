package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

// Two different batches of one merchant must not both spend the same available balance.
// Both payouts are made to wait on a lock until each is ready, then released together.
func TestConcurrentPayoutsOfOneMerchantRespectPayableCapacity(t *testing.T) {
	pool := mustPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	merchant := insertActiveMerchant(t, pool, 0)
	day := time.Date(2026, 3, 16, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)
	insertCaptureEvent(t, pool, merchant, 0, money.Fils(1000), start.Add(time.Hour))
	first, err := CloseBatch(ctx, pool, merchant, day)
	if err != nil {
		t.Fatal(err)
	}
	next := day.AddDate(0, 0, 1)
	start, _ = BusinessDayWindow(next)
	insertCaptureEvent(t, pool, merchant, 0, money.Fils(1000), start.Add(time.Hour))
	second, err := CloseBatch(ctx, pool, merchant, next)
	if err != nil {
		t.Fatal(err)
	}
	// 2,000 captured, a 500 deduction: only 1,500 is available for two 1,000 batches.
	postPayableLegs(t, merchant, "debit", 500, "refund deduction")

	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background()) //nolint:errcheck
	if _, err = blocker.Exec(ctx, "SELECT id FROM merchants WHERE id=$1 FOR NO KEY UPDATE", merchant); err != nil {
		t.Fatal(err)
	}

	type result struct {
		p PayoutResult
		e error
	}
	done := make(chan result, 2)
	go func() { p, e := PayoutBatch(ctx, pool, first.BatchID); done <- result{p, e} }()
	go func() { p, e := PayoutBatch(ctx, pool, second.BatchID); done <- result{p, e} }()

	// Wait until both payouts are blocked on a lock, then let them go.
	for {
		var waiting int
		if err = pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting >= 2 {
			break
		}
		select {
		case r := <-done:
			t.Fatalf("a payout finished before the barrier: %+v", r)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err = blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	a, b := <-done, <-done
	if a.e != nil || b.e != nil {
		t.Fatalf("payout errors: %v, %v", a.e, b.e)
	}

	var payable int64
	if err = pool.QueryRow(ctx, "SELECT payable_fils FROM merchant_payable_position WHERE merchant_id=$1", merchant).Scan(&payable); err != nil {
		t.Fatal(err)
	}
	if payable < 0 {
		t.Fatalf("payouts exceeded the merchant's payable capacity: %d fils", payable)
	}
	held := 0
	if a.p.Held {
		held++
	}
	if b.p.Held {
		held++
	}
	if held != 1 {
		t.Fatalf("exactly one of the two payouts should be held, got %d held", held)
	}
}
