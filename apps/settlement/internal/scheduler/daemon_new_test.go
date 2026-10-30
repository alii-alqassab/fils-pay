package scheduler

import (
	"testing"
	"time"
)

func TestDueBusinessDate_HonoursRunDelayInBahrainTime(t *testing.T) {
	bh, _ := time.LoadLocation("Asia/Bahrain")
	cases := []struct {
		name    string
		now     time.Time
		wantDue bool
		wantDay string
	}{
		// Bahrain 00:05 on 2026-03-25 == 21:05 UTC on 03-24: delay (15m) not elapsed.
		{"restart at 00:05 local waits", time.Date(2026, 3, 24, 21, 5, 0, 0, time.UTC), false, ""},
		{"00:15 local is due, closes the 24th", time.Date(2026, 3, 24, 21, 15, 0, 0, time.UTC), true, "2026-03-24"},
		// 01:00 local 03-25 (22:00 UTC 03-24) must close the 24th, not the 23rd.
		{"22:00 UTC closes previous Bahrain day", time.Date(2026, 3, 24, 22, 0, 0, 0, time.UTC), true, "2026-03-24"},
		{"midday", time.Date(2026, 3, 25, 9, 0, 0, 0, time.UTC), true, "2026-03-24"},
	}
	for _, c := range cases {
		got, due := dueBusinessDate(c.now, 15)
		if due != c.wantDue {
			t.Errorf("%s: due=%v want %v", c.name, due, c.wantDue)
			continue
		}
		if due && got.In(bh).Format("2006-01-02") != c.wantDay {
			t.Errorf("%s: day=%s want %s", c.name, got.In(bh).Format("2006-01-02"), c.wantDay)
		}
	}
}
