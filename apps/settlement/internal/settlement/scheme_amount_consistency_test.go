package settlement

import (
	"fmt"
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// The scheme file amount must be exactly amount_fils/1000 at two decimals
// (ADR 0002): derived from the truncated value, not the raw gross.
func TestSchemeAmountMatchesTruncatedFils(t *testing.T) {
	for _, gross := range []int64{93270, 93275, 93279, 5, 10, 999} {
		tr := TruncateToSchemeAmount(money.Fils(gross))
		want := fmt.Sprintf("%d.%02d", int64(tr)/1000, int64(tr)%1000/10)
		if got := fmt.Sprintf("%.2f", SchemeAmountBD(tr)); got != want {
			t.Errorf("gross %d: amount %s, want %s", gross, got, want)
		}
	}
}
