package state

import (
	"testing"
	"time"

	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/model"
)

func TestUpdateDerivesCounterRatesWithoutCrossingDaemonRestart(t *testing.T) {
	store := New()
	first := rateSnapshot("one", time.Unix(100, 0), 100, 1000, 10)
	store.Update(first)
	second := rateSnapshot("one", time.Unix(102, 0), 120, 3048, 14)
	store.Update(second)
	rates := store.View().Snapshot.PacketMetrics.Rates
	if rates.WindowSeconds != 2 || rates.FramesPerSecond != 10 || rates.BytesPerSecond != 1024 || rates.DropsPerSecond != 2 {
		t.Fatalf("unexpected rates: %+v", rates)
	}
	restarted := rateSnapshot("two", time.Unix(104, 0), 5, 50, 1)
	store.Update(restarted)
	if got := store.View().Snapshot.PacketMetrics.Rates.FramesPerSecond; got != 0 {
		t.Fatalf("rate crossed daemon restart: %f", got)
	}
}

func rateSnapshot(instance string, captured time.Time, frames, bytes, drops uint64) model.Snapshot {
	summary := model.TelemetrySummary{TelemetrySequence: frames, FramesSeen: frames, BytesSeen: bytes, DropsPER: drops, TXAttempts: frames, Retries: drops, RXInjected: frames - drops}
	return model.Snapshot{CapturedAt: captured, Daemon: model.Daemon{InstanceID: instance}, PacketMetrics: model.PacketMetrics{Available: true, Summary: &summary}}
}
