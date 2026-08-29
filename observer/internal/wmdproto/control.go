package wmdproto

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/model"
)

type ConflictError struct {
	Message           string
	CurrentGeneration uint64
}

func (e *ConflictError) Error() string { return e.Message }

type undoTransaction struct {
	instanceID  string
	generation  uint64
	operation   string
	pairs       []model.PairUpdate
	frequencies []frequencyWireUpdate
}

type frequencyWireUpdate struct {
	model.FrequencyUpdate
	Override bool
}

// Controller is deliberately a small typed façade. It cannot issue arbitrary
// opcodes, execute commands, or tunnel bytes to the writable socket.
type Controller struct {
	Path    string
	Timeout time.Duration

	mu      sync.Mutex
	undo    *undoTransaction
	refresh func()
}

func NewController(path string, timeout time.Duration, refresh func()) *Controller {
	return &Controller{Path: path, Timeout: timeout, refresh: refresh}
}

func (c *Controller) Status() model.UndoStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.undo == nil {
		return model.UndoStatus{}
	}
	return model.UndoStatus{Available: true, Operation: c.undo.operation, Generation: c.undo.generation}
}

func (c *Controller) SetPairs(ctx context.Context, request model.PairControlRequest) (model.ControlResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(request.Updates) == 0 {
		return model.ControlResult{}, fmt.Errorf("updates must contain at least one pair")
	}
	return c.withConnection(ctx, request.ControlRequest, func(conn net.Conn, info daemonInfo) (model.ControlResult, error) {
		if uint32(len(request.Updates)) > info.MaxUpdates {
			return model.ControlResult{}, fmt.Errorf("%d updates exceed daemon maximum %d", len(request.Updates), info.MaxUpdates)
		}
		inverse := make([]model.PairUpdate, 0, len(request.Updates))
		seen := make(map[string]struct{}, len(request.Updates))
		for _, update := range request.Updates {
			wire, err := encodePair(update)
			if err != nil {
				return model.ControlResult{}, err
			}
			key := update.Source + ">" + update.Destination
			if _, exists := seen[key]; exists {
				return model.ControlResult{}, fmt.Errorf("duplicate pair %s", key)
			}
			seen[key] = struct{}{}
			generation, payload, err := requestProtocol(conn, opGetLink, 0, wire)
			if err != nil {
				return model.ControlResult{}, err
			}
			if generation != info.Generation {
				return model.ControlResult{}, stale(info.Generation, generation)
			}
			previous, err := decodeSinglePair(payload)
			if err != nil {
				return model.ControlResult{}, err
			}
			inverse = append(inverse, previous)
		}
		payload, err := encodePairs(request.Updates)
		if err != nil {
			return model.ControlResult{}, err
		}
		generation, echo, err := requestProtocol(conn, opApply, info.Generation+1, payload)
		if err != nil {
			return model.ControlResult{}, controlError(err)
		}
		if generation != info.Generation+1 || !bytes.Equal(echo, payload) {
			return model.ControlResult{}, fmt.Errorf("pair apply acknowledgement did not match the requested generation/payload")
		}
		c.undo = &undoTransaction{instanceID: info.InstanceID, generation: generation, operation: "pair_set", pairs: inverse}
		return result("pair_set", info.InstanceID, generation, len(request.Updates), true), nil
	})
}

func (c *Controller) SetFrequencies(ctx context.Context, request model.FrequencyControlRequest) (model.ControlResult, error) {
	updates := make([]frequencyWireUpdate, len(request.Updates))
	for i, update := range request.Updates {
		updates[i] = frequencyWireUpdate{FrequencyUpdate: update, Override: true}
	}
	return c.applyFrequencies(ctx, request.ControlRequest, "frequency_set", updates)
}

func (c *Controller) ClearFrequencies(ctx context.Context, request model.FrequencyClearRequest) (model.ControlResult, error) {
	updates := make([]frequencyWireUpdate, len(request.Targets))
	for i, target := range request.Targets {
		updates[i] = frequencyWireUpdate{FrequencyUpdate: model.FrequencyUpdate{Source: target.Source, Destination: target.Destination, FrequencyMHz: target.FrequencyMHz}, Override: false}
	}
	return c.applyFrequencies(ctx, request.ControlRequest, "frequency_clear", updates)
}

func (c *Controller) applyFrequencies(ctx context.Context, expected model.ControlRequest, operation string, updates []frequencyWireUpdate) (model.ControlResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(updates) == 0 {
		return model.ControlResult{}, fmt.Errorf("updates must contain at least one frequency target")
	}
	return c.withConnection(ctx, expected, func(conn net.Conn, info daemonInfo) (model.ControlResult, error) {
		if uint32(len(updates)) > info.MaxUpdates {
			return model.ControlResult{}, fmt.Errorf("%d updates exceed daemon maximum %d", len(updates), info.MaxUpdates)
		}
		inverse := make([]frequencyWireUpdate, 0, len(updates))
		seen := make(map[string]struct{}, len(updates))
		for _, update := range updates {
			wire, err := encodeFrequency(update)
			if err != nil {
				return model.ControlResult{}, err
			}
			key := fmt.Sprintf("%s>%s@%d", update.Source, update.Destination, update.FrequencyMHz)
			if _, exists := seen[key]; exists {
				return model.ControlResult{}, fmt.Errorf("duplicate frequency target %s", key)
			}
			seen[key] = struct{}{}
			generation, payload, err := requestProtocol(conn, opGetFrequency, 0, wire)
			if err != nil {
				return model.ControlResult{}, err
			}
			if generation != info.Generation {
				return model.ControlResult{}, stale(info.Generation, generation)
			}
			previous, err := decodeSingleFrequency(payload)
			if err != nil {
				return model.ControlResult{}, err
			}
			inverse = append(inverse, previous)
		}
		payload, err := encodeFrequencies(updates)
		if err != nil {
			return model.ControlResult{}, err
		}
		generation, echo, err := requestProtocol(conn, opApplyFrequency, info.Generation+1, payload)
		if err != nil {
			return model.ControlResult{}, controlError(err)
		}
		if generation != info.Generation+1 || !bytes.Equal(echo, payload) {
			return model.ControlResult{}, fmt.Errorf("frequency apply acknowledgement did not match the requested generation/payload")
		}
		c.undo = &undoTransaction{instanceID: info.InstanceID, generation: generation, operation: operation, frequencies: inverse}
		return result(operation, info.InstanceID, generation, len(updates), true), nil
	})
}

func (c *Controller) Undo(ctx context.Context, expected model.ControlRequest) (model.ControlResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.undo == nil {
		return model.ControlResult{}, &ConflictError{Message: "no control transaction is available to undo"}
	}
	undo := *c.undo
	if expected.ExpectedGeneration != undo.generation || expected.ExpectedInstanceID != undo.instanceID {
		return model.ControlResult{}, &ConflictError{Message: "undo request does not match the last transaction", CurrentGeneration: undo.generation}
	}
	return c.withConnection(ctx, expected, func(conn net.Conn, info daemonInfo) (model.ControlResult, error) {
		var opcode uint16
		var payload []byte
		var err error
		updates := 0
		if len(undo.pairs) > 0 {
			opcode = opApply
			payload, err = encodePairs(undo.pairs)
			updates = len(undo.pairs)
		} else {
			opcode = opApplyFrequency
			payload, err = encodeFrequencies(undo.frequencies)
			updates = len(undo.frequencies)
		}
		if err != nil {
			return model.ControlResult{}, err
		}
		generation, echo, err := requestProtocol(conn, opcode, info.Generation+1, payload)
		if err != nil {
			return model.ControlResult{}, controlError(err)
		}
		if generation != info.Generation+1 || !bytes.Equal(echo, payload) {
			return model.ControlResult{}, fmt.Errorf("undo acknowledgement did not match the requested generation/payload")
		}
		c.undo = nil
		return result("undo_"+undo.operation, info.InstanceID, generation, updates, false), nil
	})
}

func (c *Controller) withConnection(ctx context.Context, expected model.ControlRequest, fn func(net.Conn, daemonInfo) (model.ControlResult, error)) (model.ControlResult, error) {
	if expected.ExpectedInstanceID == "" {
		return model.ControlResult{}, fmt.Errorf("expected_instance_id is required")
	}
	conn, err := dial(ctx, c.Path, c.Timeout)
	if err != nil {
		return model.ControlResult{}, err
	}
	defer conn.Close()
	info, err := requestInfo(conn, opHello)
	if err != nil {
		return model.ControlResult{}, err
	}
	required := capAtomicGenerations | capReadback | capRadioPairSNR
	if info.Capabilities&required != required || info.Capabilities&capReadOnly != 0 {
		return model.ControlResult{}, fmt.Errorf("control endpoint is not a writable atomic wmediumd socket (capabilities 0x%x)", info.Capabilities)
	}
	if info.InstanceID != expected.ExpectedInstanceID {
		return model.ControlResult{}, &ConflictError{Message: "wmediumd instance changed; refresh before applying controls", CurrentGeneration: info.Generation}
	}
	if info.Generation != expected.ExpectedGeneration {
		return model.ControlResult{}, stale(expected.ExpectedGeneration, info.Generation)
	}
	result, err := fn(conn, info)
	if err == nil && c.refresh != nil {
		c.refresh()
	}
	return result, err
}

func requestProtocol(conn net.Conn, opcode uint16, generation uint64, payload []byte) (uint64, []byte, error) {
	return request(conn, opcode, generation, payload)
}

func stale(expected, actual uint64) error {
	return &ConflictError{Message: fmt.Sprintf("generation changed: expected %d, current %d", expected, actual), CurrentGeneration: actual}
}

func controlError(err error) error {
	var protocol *ProtocolError
	if errors.As(err, &protocol) && protocol.Status == 3 {
		return &ConflictError{Message: protocol.Error(), CurrentGeneration: protocol.Generation}
	}
	return err
}

func encodePair(update model.PairUpdate) ([]byte, error) {
	source, err := parseMAC(update.Source)
	if err != nil {
		return nil, fmt.Errorf("source: %w", err)
	}
	destination, err := parseMAC(update.Destination)
	if err != nil {
		return nil, fmt.Errorf("destination: %w", err)
	}
	if source == destination {
		return nil, fmt.Errorf("source and destination must differ")
	}
	if update.SNRDB < -20 || update.SNRDB > 60 {
		return nil, fmt.Errorf("snr_db %d is outside -20..60", update.SNRDB)
	}
	payload := make([]byte, linkSize)
	copy(payload[0:6], source[:])
	copy(payload[6:12], destination[:])
	binary.BigEndian.PutUint16(payload[12:14], uint16(update.SNRDB))
	return payload, nil
}

func encodePairs(updates []model.PairUpdate) ([]byte, error) {
	payload := make([]byte, 0, len(updates)*linkSize)
	for _, update := range updates {
		wire, err := encodePair(update)
		if err != nil {
			return nil, err
		}
		payload = append(payload, wire...)
	}
	return payload, nil
}

func encodeFrequency(update frequencyWireUpdate) ([]byte, error) {
	source, err := parseMAC(update.Source)
	if err != nil {
		return nil, fmt.Errorf("source: %w", err)
	}
	destination, err := parseMAC(update.Destination)
	if err != nil {
		return nil, fmt.Errorf("destination: %w", err)
	}
	if source == destination {
		return nil, fmt.Errorf("source and destination must differ")
	}
	if update.FrequencyMHz < 2300 || update.FrequencyMHz > 7125 {
		return nil, fmt.Errorf("frequency_mhz %d is outside 2300..7125", update.FrequencyMHz)
	}
	if update.Override && (update.SNRDB < -20 || update.SNRDB > 60) {
		return nil, fmt.Errorf("snr_db %d is outside -20..60", update.SNRDB)
	}
	payload := make([]byte, freqLinkSize)
	copy(payload[0:6], source[:])
	copy(payload[6:12], destination[:])
	binary.BigEndian.PutUint32(payload[12:16], update.FrequencyMHz)
	binary.BigEndian.PutUint16(payload[16:18], uint16(update.SNRDB))
	if update.Override {
		binary.BigEndian.PutUint16(payload[18:20], 1)
	}
	return payload, nil
}

func encodeFrequencies(updates []frequencyWireUpdate) ([]byte, error) {
	payload := make([]byte, 0, len(updates)*freqLinkSize)
	for _, update := range updates {
		wire, err := encodeFrequency(update)
		if err != nil {
			return nil, err
		}
		payload = append(payload, wire...)
	}
	return payload, nil
}

func decodeSinglePair(payload []byte) (model.PairUpdate, error) {
	links, err := decodeLinks(payload)
	if err != nil {
		return model.PairUpdate{}, err
	}
	if len(links) != 1 {
		return model.PairUpdate{}, fmt.Errorf("GET_LINK returned %d records", len(links))
	}
	return model.PairUpdate(links[0]), nil
}

func decodeSingleFrequency(payload []byte) (frequencyWireUpdate, error) {
	links, err := decodeFrequencyLinks(payload)
	if err != nil {
		return frequencyWireUpdate{}, err
	}
	if len(links) != 1 {
		return frequencyWireUpdate{}, fmt.Errorf("GET_FREQUENCY returned %d records", len(links))
	}
	link := links[0]
	return frequencyWireUpdate{FrequencyUpdate: model.FrequencyUpdate{Source: link.Source, Destination: link.Destination, FrequencyMHz: link.FrequencyMHz, SNRDB: link.SNRDB}, Override: link.Override}, nil
}

func parseMAC(value string) ([6]byte, error) {
	var result [6]byte
	parsed, err := net.ParseMAC(value)
	if err != nil || len(parsed) != 6 {
		return result, fmt.Errorf("%q is not a six-octet MAC address", value)
	}
	copy(result[:], parsed)
	return result, nil
}

func result(operation, instance string, generation uint64, updates int, undo bool) model.ControlResult {
	var random [8]byte
	_, _ = rand.Read(random[:])
	return model.ControlResult{TransactionID: fmt.Sprintf("%x", random[:]), Operation: operation, InstanceID: instance, Generation: generation, Updates: updates, UndoAvailable: undo, AppliedAt: time.Now().UTC()}
}
