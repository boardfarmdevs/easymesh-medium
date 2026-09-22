package wmdproto

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"time"

	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/model"
)

type Reader struct {
	Path       string
	Timeout    time.Duration
	connection net.Conn
	Requests   uint64
	Bytes      uint64
}

type Page struct {
	Generation  uint64
	Sequence    uint64
	Total       uint32
	Next        uint32
	Gap         bool
	Pairs       []model.Link
	Frequencies []model.FrequencyLink
	Paths       []model.ActiveLink
	Radios      []model.RadioFrequency
	VIFs        []model.VIF
	Events      []model.TelemetryEvent
}

func (reader *Reader) Close() {
	if reader.connection != nil {
		reader.connection.Close()
		reader.connection = nil
	}
}

func (reader *Reader) query(ctx context.Context, opcode uint16, payload []byte) (uint64, []byte, error) {
	if reader.Timeout <= 0 {
		reader.Timeout = time.Second
	}
	if reader.connection == nil {
		connection, err := dial(ctx, reader.Path, reader.Timeout)
		if err != nil {
			return 0, nil, err
		}
		reader.connection = connection
	}
	deadline := time.Now().Add(reader.Timeout)
	if limit, ok := ctx.Deadline(); ok && limit.Before(deadline) {
		deadline = limit
	}
	if err := reader.connection.SetDeadline(deadline); err != nil {
		reader.Close()
		return 0, nil, err
	}
	reader.Requests++
	generation, response, err := request(reader.connection, opcode, 0, payload)
	reader.Bytes += uint64(headerSize*2 + len(payload) + len(response))
	if err != nil {
		if _, protocol := err.(*ProtocolError); !protocol {
			reader.Close()
		}
	}
	return generation, response, err
}

func (reader *Reader) Info(ctx context.Context) (model.Daemon, error) {
	generation, payload, err := reader.query(ctx, opHello, nil)
	if err != nil {
		return model.Daemon{}, err
	}
	if len(payload) != infoSize {
		return model.Daemon{}, fmt.Errorf("invalid daemon information length")
	}
	capabilities := binary.BigEndian.Uint32(payload[16:20])
	if capabilities&capReadOnly == 0 {
		return model.Daemon{}, fmt.Errorf("Console NG requires a read-only telemetry endpoint")
	}
	return model.Daemon{
		InstanceID: fmt.Sprintf("%016x%016x", binary.BigEndian.Uint64(payload[:8]), binary.BigEndian.Uint64(payload[8:16])),
		Generation: generation, Capabilities: capabilityList(capabilities),
		MaxUpdates: binary.BigEndian.Uint32(payload[20:24]), NumStations: binary.BigEndian.Uint32(payload[24:28]),
	}, nil
}

func (reader *Reader) Summary(ctx context.Context) (model.TelemetrySummary, error) {
	_, payload, err := reader.query(ctx, opTelemetrySummary, nil)
	if err != nil {
		return model.TelemetrySummary{}, err
	}
	return decodeTelemetrySummary(payload)
}

func (reader *Reader) Page(ctx context.Context, topic string, cursor uint32, since uint64, paged bool) (Page, error) {
	opcodes := map[string]uint16{"pairs": opDumpLinks, "frequencies": opDumpFrequencies, "paths": opDumpActiveLinks, "radios": opDumpRadioFrequencies, "vifs": opDumpVIFs, "events": opDumpEvents}
	sizes := map[string]int{"pairs": linkSize, "frequencies": freqLinkSize, "paths": activeLinkSize, "radios": radioFrequencySize, "vifs": vifSize, "events": eventSize}
	opcode, exists := opcodes[topic]
	if !exists {
		return Page{}, fmt.Errorf("unknown telemetry topic %q", topic)
	}
	var payload []byte
	if paged {
		payload = make([]byte, pageRequestSize)
		binary.BigEndian.PutUint64(payload[:8], since)
		binary.BigEndian.PutUint32(payload[8:12], cursor)
		binary.BigEndian.PutUint32(payload[12:16], 128)
	}
	generation, response, err := reader.query(ctx, opcode, payload)
	if err != nil {
		return Page{}, err
	}
	result := Page{Generation: generation, Next: pageEnd}
	if paged {
		page, entries, parseErr := decodePage(response, sizes[topic])
		if parseErr != nil {
			return Page{}, parseErr
		}
		if page.NextCursor != pageEnd && (page.NextCursor <= cursor || page.Flags&pageMore == 0) {
			return Page{}, fmt.Errorf("invalid advancing page cursor")
		}
		result.Sequence, result.Total, result.Next, result.Gap = page.SnapshotSequence, page.Total, page.NextCursor, page.Flags&pageGap != 0
		response = entries
	} else {
		result.Total = uint32(len(response) / sizes[topic])
	}
	switch topic {
	case "pairs":
		result.Pairs, err = decodeLinks(response)
	case "frequencies":
		result.Frequencies, err = decodeFrequencyLinks(response)
	case "paths":
		result.Paths, err = decodeActiveLinks(response)
	case "radios":
		result.Radios, err = decodeRadioFrequencies(response)
	case "vifs":
		result.VIFs, err = decodeVIFs(response)
	case "events":
		result.Events, err = decodeEvents(response)
	}
	return result, err
}

func (reader *Reader) Pair(ctx context.Context, source, destination string, frequency uint32) (model.FrequencyLink, uint64, error) {
	var requestPayload []byte
	var err error
	opcode := opGetFrequency
	if frequency == 0 {
		requestPayload, err = encodePair(model.PairUpdate{Source: source, Destination: destination})
		opcode = opGetLink
	} else {
		requestPayload, err = encodeFrequency(frequencyWireUpdate{FrequencyUpdate: model.FrequencyUpdate{Source: source, Destination: destination, FrequencyMHz: frequency}})
	}
	if err != nil {
		return model.FrequencyLink{}, 0, err
	}
	generation, response, err := reader.query(ctx, opcode, requestPayload)
	if err != nil {
		return model.FrequencyLink{}, generation, err
	}
	if frequency == 0 {
		pairs, decodeErr := decodeLinks(response)
		if decodeErr != nil || len(pairs) != 1 {
			return model.FrequencyLink{}, generation, fmt.Errorf("invalid pair readback")
		}
		return model.FrequencyLink{Source: pairs[0].Source, Destination: pairs[0].Destination, SNRDB: pairs[0].SNRDB}, generation, nil
	}
	rows, err := decodeFrequencyLinks(response)
	if err != nil || len(rows) != 1 {
		return model.FrequencyLink{}, generation, fmt.Errorf("invalid frequency readback")
	}
	return rows[0], generation, nil
}

func (reader *Reader) Association(ctx context.Context, radio string) (model.Association, error) {
	address, err := net.ParseMAC(radio)
	if err != nil || len(address) != 6 {
		return model.Association{}, fmt.Errorf("invalid radio address")
	}
	payload := make([]byte, associationSize)
	copy(payload, address)
	_, response, err := reader.query(ctx, opGetAssociation, payload)
	if err != nil {
		return model.Association{}, err
	}
	return decodeAssociation(response)
}

func (reader *Reader) Detail(ctx context.Context, source, destination string, frequency uint32) (map[string]any, error) {
	payload := make([]byte, 16)
	for index, value := range []string{source, destination} {
		if value == "" {
			continue
		}
		address, err := net.ParseMAC(value)
		if err != nil || len(address) != 6 {
			return nil, fmt.Errorf("invalid radio identity")
		}
		copy(payload[index*6:], address)
	}
	binary.BigEndian.PutUint32(payload[12:], frequency)
	_, response, err := reader.query(ctx, 17, payload)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	decoder := json.NewDecoder(bytes.NewReader(response))
	decoder.UseNumber()
	if err := decoder.Decode(&result); err != nil {
		return nil, err
	}
	return result, nil
}
