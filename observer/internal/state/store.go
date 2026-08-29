package state

import (
	"context"
	"sync"
	"time"

	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/model"
)

type View struct {
	Snapshot      *model.Snapshot `json:"snapshot,omitempty"`
	LastAttemptAt time.Time       `json:"last_attempt_at"`
	LastSuccessAt time.Time       `json:"last_success_at,omitempty"`
	Error         string          `json:"error,omitempty"`
}

type Event struct {
	Type     string          `json:"type"`
	Sequence uint64          `json:"sequence"`
	At       time.Time       `json:"at"`
	Snapshot *model.Snapshot `json:"snapshot,omitempty"`
	Error    string          `json:"error,omitempty"`
}

type Store struct {
	mu          sync.RWMutex
	view        View
	sequence    uint64
	nextID      uint64
	subscribers map[uint64]chan Event
}

func New() *Store {
	return &Store{subscribers: make(map[uint64]chan Event)}
}

func (s *Store) Update(snapshot model.Snapshot) {
	now := time.Now().UTC()
	s.mu.Lock()
	if s.view.Snapshot != nil {
		deriveRates(&snapshot, s.view.Snapshot)
	}
	s.sequence++
	snapshot.Sequence = s.sequence
	snapshotCopy := snapshot
	s.view = View{Snapshot: &snapshotCopy, LastAttemptAt: now, LastSuccessAt: now}
	event := Event{Type: "snapshot", Sequence: s.sequence, At: now, Snapshot: &snapshotCopy}
	s.broadcastLocked(event)
	s.mu.Unlock()
}

func deriveRates(current *model.Snapshot, previous *model.Snapshot) {
	if !current.PacketMetrics.Available || current.PacketMetrics.Summary == nil ||
		!previous.PacketMetrics.Available || previous.PacketMetrics.Summary == nil ||
		current.Daemon.InstanceID != previous.Daemon.InstanceID {
		return
	}
	seconds := current.CapturedAt.Sub(previous.CapturedAt).Seconds()
	if seconds <= 0 {
		return
	}
	before, after := previous.PacketMetrics.Summary, current.PacketMetrics.Summary
	if after.TelemetrySequence < before.TelemetrySequence || after.FramesSeen < before.FramesSeen {
		return
	}
	delta := func(a, b uint64) float64 {
		if a < b {
			return 0
		}
		return float64(a-b) / seconds
	}
	drops := func(value *model.TelemetrySummary) uint64 {
		return value.DropsOffChannel + value.DropsCCA + value.DropsInterference + value.DropsPER + value.DropsNoReceiver
	}
	current.PacketMetrics.Rates = model.TelemetryRates{
		WindowSeconds:     seconds,
		FramesPerSecond:   delta(after.FramesSeen, before.FramesSeen),
		BytesPerSecond:    delta(after.BytesSeen, before.BytesSeen),
		AttemptsPerSecond: delta(after.TXAttempts, before.TXAttempts),
		RetriesPerSecond:  delta(after.Retries, before.Retries),
		InjectedPerSecond: delta(after.RXInjected, before.RXInjected),
		DropsPerSecond:    delta(drops(after), drops(before)),
	}
}

func (s *Store) UpdateError(err error) {
	now := time.Now().UTC()
	s.mu.Lock()
	s.view.LastAttemptAt = now
	if err != nil {
		s.view.Error = err.Error()
	}
	event := Event{Type: "collector_error", Sequence: s.sequence, At: now, Error: s.view.Error}
	s.broadcastLocked(event)
	s.mu.Unlock()
}

func (s *Store) View() View {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.view
}

func (s *Store) Subscribe(ctx context.Context) <-chan Event {
	s.mu.Lock()
	s.nextID++
	id := s.nextID
	updates := make(chan Event, 1)
	s.subscribers[id] = updates
	if s.view.Snapshot != nil {
		updates <- Event{
			Type: "snapshot", Sequence: s.view.Snapshot.Sequence,
			At: s.view.LastSuccessAt, Snapshot: s.view.Snapshot,
		}
	} else if s.view.Error != "" {
		updates <- Event{Type: "collector_error", Sequence: s.sequence, At: s.view.LastAttemptAt, Error: s.view.Error}
	}
	s.mu.Unlock()
	go func() {
		<-ctx.Done()
		s.mu.Lock()
		if current, ok := s.subscribers[id]; ok {
			delete(s.subscribers, id)
			close(current)
		}
		s.mu.Unlock()
	}()
	return updates
}

func (s *Store) broadcastLocked(event Event) {
	for _, subscriber := range s.subscribers {
		select {
		case subscriber <- event:
		default:
			select {
			case <-subscriber:
			default:
			}
			select {
			case subscriber <- event:
			default:
			}
		}
	}
}
