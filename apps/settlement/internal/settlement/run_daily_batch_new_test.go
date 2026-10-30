package settlement

import (
	"context"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// F-2 (W3-A): one merchant whose CloseBatch fails must not strand the
// merchants after it. The middle merchant (by id order) carries a capture
// of 100,000,000,000 fils = 100,000,000.00 BD, which overflows the
// NUMERIC(10,2) scheme line amount inside CloseBatch's transaction.
func TestRunDailyBatch_FailureIsolatedPerMerchant(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250

	ids := []uuid.UUID{
		insertActiveMerchant(t, pool, mdrBps),
		insertActiveMerchant(t, pool, mdrBps),
		insertActiveMerchant(t, pool, mdrBps),
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	first, bad, last := ids[0], ids[1], ids[2]

	businessDate := time.Date(2033, 6, 15, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	at := start.Add(2 * time.Hour)

	insertCaptureEvent(t, pool, first, mdrBps, 4750, at)
	insertCaptureEvent(t, pool, bad, mdrBps, 100_000_000_000, at)
	insertCaptureEvent(t, pool, last, mdrBps, 9000, at)

	report, err := RunDailyBatch(ctx, pool, businessDate, nil)
	if err == nil {
		t.Fatal("RunDailyBatch returned nil error despite a failing merchant")
	}
	var agg *BatchFailuresError
	if !errors.As(err, &agg) {
		t.Fatalf("error is not *BatchFailuresError: %v", err)
	}
	if !strings.Contains(err.Error(), bad.String()) {
		t.Errorf("aggregate error does not name failing merchant %s: %v", bad, err)
	}
	for _, ok := range []uuid.UUID{first, last} {
		if strings.Contains(err.Error(), ok.String()) {
			t.Errorf("aggregate error wrongly names healthy merchant %s", ok)
		}
	}
	foundBad := false
	for _, f := range report.FailedMerchants {
		if f.MerchantID == bad {
			foundBad = true
		}
	}
	if !foundBad {
		t.Errorf("report.FailedMerchants missing %s: %+v", bad, report.FailedMerchants)
	}

	for _, m := range []uuid.UUID{first, last} {
		if n := countRows(t, pool, `SELECT count(*) FROM settlement_batches WHERE merchant_id=$1 AND status='paid'`, m); n != 1 {
			t.Errorf("merchant %s: paid batches = %d, want 1", m, n)
		}
	}
	// The failing merchant: no closed/paid batch, no partial writes, its
	// capture event is still unbatched.
	if n := countRows(t, pool, `SELECT count(*) FROM settlement_batches WHERE merchant_id=$1 AND status IN ('closed','paid')`, bad); n != 0 {
		t.Errorf("failing merchant has %d closed/paid batches, want 0", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM transaction_events te JOIN transactions t ON t.id=te.transaction_id WHERE t.merchant_id=$1 AND te.settlement_batch_id IS NOT NULL`, bad); n != 0 {
		t.Errorf("failing merchant has %d events stamped with a batch, want 0", n)
	}
}
