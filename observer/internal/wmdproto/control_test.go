package wmdproto

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/model"
)

func TestTypedPairSetAndOneStepUndo(t *testing.T) {
	daemon := newWritableDaemon(t)
	defer daemon.close()
	controller := NewController(daemon.path, time.Second, nil)
	expected := model.ControlRequest{ExpectedInstanceID: "0123456789abcdeffedcba9876543210", ExpectedGeneration: 5}
	update := model.PairUpdate{Source: macText(testMACs[0][:]), Destination: macText(testMACs[1][:]), SNRDB: 47}
	result, err := controller.SetPairs(context.Background(), model.PairControlRequest{ControlRequest: expected, Updates: []model.PairUpdate{update}})
	if err != nil {
		t.Fatalf("SetPairs: %v", err)
	}
	if result.Generation != 6 || !result.UndoAvailable || controller.Status().Generation != 6 {
		t.Fatalf("unexpected set result/status: %+v %+v", result, controller.Status())
	}
	if got := daemon.pair(0, 1); got != 47 {
		t.Fatalf("pair after set = %d", got)
	}
	undo, err := controller.Undo(context.Background(), model.ControlRequest{ExpectedInstanceID: expected.ExpectedInstanceID, ExpectedGeneration: 6})
	if err != nil {
		t.Fatalf("Undo: %v", err)
	}
	if undo.Generation != 7 || undo.UndoAvailable || controller.Status().Available {
		t.Fatalf("unexpected undo: %+v", undo)
	}
	if got := daemon.pair(0, 1); got != 31 {
		t.Fatalf("pair after undo = %d, want 31", got)
	}
	if _, err := controller.Undo(context.Background(), model.ControlRequest{ExpectedInstanceID: expected.ExpectedInstanceID, ExpectedGeneration: 7}); err == nil {
		t.Fatal("second undo unexpectedly succeeded")
	}
}

func TestTypedFrequencySetClearAndUndo(t *testing.T) {
	t.Run("set then undo restores absence", func(t *testing.T) {
		daemon := newWritableDaemon(t)
		defer daemon.close()
		controller := NewController(daemon.path, time.Second, nil)
		expected := model.ControlRequest{ExpectedInstanceID: "0123456789abcdeffedcba9876543210", ExpectedGeneration: 5}
		update := model.FrequencyUpdate{Source: macText(testMACs[0][:]), Destination: macText(testMACs[1][:]), FrequencyMHz: 5180, SNRDB: 44}
		result, err := controller.SetFrequencies(context.Background(), model.FrequencyControlRequest{ControlRequest: expected, Updates: []model.FrequencyUpdate{update}})
		if err != nil {
			t.Fatal(err)
		}
		if result.Generation != 6 || daemon.frequency(0, 1, 5180) == nil || *daemon.frequency(0, 1, 5180) != 44 {
			t.Fatalf("set failed: %+v", result)
		}
		_, err = controller.Undo(context.Background(), model.ControlRequest{ExpectedInstanceID: expected.ExpectedInstanceID, ExpectedGeneration: 6})
		if err != nil {
			t.Fatal(err)
		}
		if daemon.frequency(0, 1, 5180) != nil {
			t.Fatal("undo did not restore absent override")
		}
	})
	t.Run("clear then undo restores value", func(t *testing.T) {
		daemon := newWritableDaemon(t)
		defer daemon.close()
		value := int16(42)
		daemon.frequencies[frequencyKey(0, 1, 5180)] = value
		controller := NewController(daemon.path, time.Second, nil)
		expected := model.ControlRequest{ExpectedInstanceID: "0123456789abcdeffedcba9876543210", ExpectedGeneration: 5}
		target := model.FrequencyTarget{Source: macText(testMACs[0][:]), Destination: macText(testMACs[1][:]), FrequencyMHz: 5180}
		_, err := controller.ClearFrequencies(context.Background(), model.FrequencyClearRequest{ControlRequest: expected, Targets: []model.FrequencyTarget{target}})
		if err != nil {
			t.Fatal(err)
		}
		if daemon.frequency(0, 1, 5180) != nil {
			t.Fatal("override not cleared")
		}
		_, err = controller.Undo(context.Background(), model.ControlRequest{ExpectedInstanceID: expected.ExpectedInstanceID, ExpectedGeneration: 6})
		if err != nil {
			t.Fatal(err)
		}
		if got := daemon.frequency(0, 1, 5180); got == nil || *got != 42 {
			t.Fatalf("undo value = %v", got)
		}
	})
}

func TestTypedControlRejectsStaleGenerationBeforeMutation(t *testing.T) {
	daemon := newWritableDaemon(t)
	defer daemon.close()
	controller := NewController(daemon.path, time.Second, nil)
	_, err := controller.SetPairs(context.Background(), model.PairControlRequest{ControlRequest: model.ControlRequest{ExpectedInstanceID: "0123456789abcdeffedcba9876543210", ExpectedGeneration: 4}, Updates: []model.PairUpdate{{Source: macText(testMACs[0][:]), Destination: macText(testMACs[1][:]), SNRDB: 50}}})
	if err == nil {
		t.Fatal("stale request accepted")
	}
	if _, ok := err.(*ConflictError); !ok {
		t.Fatalf("error type = %T: %v", err, err)
	}
	if got := daemon.pair(0, 1); got != 31 {
		t.Fatalf("stale request mutated pair to %d", got)
	}
}

type writableDaemon struct {
	t           *testing.T
	path        string
	listener    *net.UnixListener
	done        chan struct{}
	mu          sync.Mutex
	generation  uint64
	pairs       map[string]int16
	frequencies map[string]int16
}

func newWritableDaemon(t *testing.T) *writableDaemon {
	path := filepath.Join(t.TempDir(), "control.sock")
	listener := listenUnixPacket(t, path)
	daemon := &writableDaemon{t: t, path: path, listener: listener, done: make(chan struct{}), generation: 5, pairs: make(map[string]int16), frequencies: make(map[string]int16)}
	for source := range testMACs {
		for destination := range testMACs {
			if source != destination {
				daemon.pairs[pairKey(source, destination)] = int16(30 + source + destination)
			}
		}
	}
	go daemon.serve()
	return daemon
}

func (d *writableDaemon) close()             { close(d.done); _ = d.listener.Close() }
func pairKey(source, destination int) string { return fmt.Sprintf("%d>%d", source, destination) }
func frequencyKey(source, destination int, frequency uint32) string {
	return fmt.Sprintf("%d>%d@%d", source, destination, frequency)
}
func (d *writableDaemon) pair(source, destination int) int16 {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.pairs[pairKey(source, destination)]
}
func (d *writableDaemon) frequency(source, destination int, frequency uint32) *int16 {
	d.mu.Lock()
	defer d.mu.Unlock()
	value, ok := d.frequencies[frequencyKey(source, destination, frequency)]
	if !ok {
		return nil
	}
	copy := value
	return &copy
}

func (d *writableDaemon) serve() {
	for {
		conn, err := d.listener.AcceptUnix()
		if err != nil {
			return
		}
		go d.serveConnection(conn)
	}
}
func (d *writableDaemon) serveConnection(conn *net.UnixConn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	for {
		frame := make([]byte, maxFrame)
		n, err := conn.Read(frame)
		if err != nil {
			return
		}
		if n < headerSize {
			return
		}
		opcode := binary.BigEndian.Uint16(frame[6:8])
		generation := binary.BigEndian.Uint64(frame[16:24])
		payload := frame[headerSize:n]
		status := uint32(0)
		var response []byte
		d.mu.Lock()
		switch opcode {
		case opHello:
			response = infoPayload(capRadioPairSNR|capAtomicGenerations|capReadback|capDump|capFrequencyQualifiedSNR, 3)
		case opGetLink:
			source, destination, ok := indices(payload[0:6], payload[6:12])
			if !ok {
				status = 4
			} else {
				response = append([]byte(nil), payload...)
				binary.BigEndian.PutUint16(response[12:14], uint16(d.pairs[pairKey(source, destination)]))
			}
		case opApply:
			if generation != d.generation+1 {
				status = 3
			} else {
				for offset := 0; offset < len(payload); offset += linkSize {
					source, destination, ok := indices(payload[offset:offset+6], payload[offset+6:offset+12])
					if !ok {
						status = 4
						break
					}
					d.pairs[pairKey(source, destination)] = int16(binary.BigEndian.Uint16(payload[offset+12 : offset+14]))
				}
				if status == 0 {
					d.generation = generation
					response = append([]byte(nil), payload...)
				}
			}
		case opGetFrequency:
			source, destination, ok := indices(payload[0:6], payload[6:12])
			if !ok {
				status = 4
			} else {
				frequency := binary.BigEndian.Uint32(payload[12:16])
				response = append([]byte(nil), payload...)
				value, override := d.frequencies[frequencyKey(source, destination, frequency)]
				if !override {
					value = d.pairs[pairKey(source, destination)]
				}
				binary.BigEndian.PutUint16(response[16:18], uint16(value))
				if override {
					binary.BigEndian.PutUint16(response[18:20], 1)
				} else {
					binary.BigEndian.PutUint16(response[18:20], 0)
				}
			}
		case opApplyFrequency:
			if generation != d.generation+1 {
				status = 3
			} else {
				for offset := 0; offset < len(payload); offset += freqLinkSize {
					source, destination, ok := indices(payload[offset:offset+6], payload[offset+6:offset+12])
					if !ok {
						status = 4
						break
					}
					frequency := binary.BigEndian.Uint32(payload[offset+12 : offset+16])
					key := frequencyKey(source, destination, frequency)
					if binary.BigEndian.Uint16(payload[offset+18:offset+20])&1 != 0 {
						d.frequencies[key] = int16(binary.BigEndian.Uint16(payload[offset+16 : offset+18]))
					} else {
						delete(d.frequencies, key)
					}
				}
				if status == 0 {
					d.generation = generation
					response = append([]byte(nil), payload...)
				}
			}
		default:
			status = 1
		}
		current := d.generation
		d.mu.Unlock()
		if _, err := conn.Write(responseFrameStatus(opcode, current, status, response)); err != nil {
			return
		}
	}
}

func indices(source, destination []byte) (int, int, bool) {
	a, b := -1, -1
	for i, mac := range testMACs {
		if string(source) == string(mac[:]) {
			a = i
		}
		if string(destination) == string(mac[:]) {
			b = i
		}
	}
	return a, b, a >= 0 && b >= 0 && a != b
}
func responseFrameStatus(opcode uint16, generation uint64, status uint32, payload []byte) []byte {
	frame := responseFrame(opcode, generation, payload)
	binary.BigEndian.PutUint32(frame[12:16], status)
	return frame
}
