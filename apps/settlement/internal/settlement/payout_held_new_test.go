package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/filspay/settlement/internal/money"
)

func postPayableLegs(t *testing.T, merchantID uuid.UUID, direction string, amount int64, why string) {
	t.Helper()
	pool := mustPool(t)
	other := "credit"
	if direction == "credit" {
		other = "debit"
	}
	_, err := pool.Exec(context.Background(), `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES ($1, $2, 'merchant_payable', $3, $5, now(), $6),
		       ($1, $2, 'platform_cash',    $4, $5, now(), $6)
	`, uuid.New(), merchantID, direction, other, amount, why)
	if err != nil {
		t.Fatalf("post %s legs: %v", why, err)
	}
}

// F-1: a payout must never exceed what the merchant is owed. A refund posted
// against merchant_payable after the capture must hold the batch, and the
// batch must be paid once the position covers it again.
func TestPayoutBatch_HeldWhileRefundsExceedPosition(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdr = 250
	merchantID := insertActiveMerchant(t, pool, mdr)
	businessDate := time.Date(2026, 3, 16, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, mdr, money.Fils(1_000_000), start.Add(2*time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	postPayableLegs(t, merchantID, "debit", 400_000, "test refund")

	held, err := PayoutBatch(ctx, pool, closed.BatchID)
	if err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	if !held.Held {
		t.Fatalf("expected the payout to be held, got %+v", held)
	}
	var status string
	var disbursements int
	_ = pool.QueryRow(ctx, `SELECT status FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&status)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM settlement_payout_disbursements WHERE settlement_batch_id = $1`, closed.BatchID).Scan(&disbursements)
	if status != "closed" || disbursements != 0 {
		t.Fatalf("a held batch must stay closed with no disbursement; status=%s disbursements=%d", status, disbursements)
	}

	// The refund is covered (e.g. by a recovered credit), so the batch pays.
	postPayableLegs(t, merchantID, "credit", 400_000, "test recovery")
	paid, err := PayoutBatch(ctx, pool, closed.BatchID)
	if err != nil {
		t.Fatalf("PayoutBatch retry: %v", err)
	}
	if paid.Held || paid.AlreadyPaid {
		t.Fatalf("expected a normal payout after recovery, got %+v", paid)
	}
	_ = pool.QueryRow(ctx, `SELECT status FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&status)
	if status != "paid" {
		t.Fatalf("status = %s, want paid", status)
	}
}
