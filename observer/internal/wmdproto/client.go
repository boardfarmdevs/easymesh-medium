package wmdproto

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/model"
)

const (
	magic                = uint32(0x574d4443)
	version              = uint16(1)
	maxFrame             = 64 * 1024
	headerSize           = 24
	infoSize             = 32
	linkSize             = 16
	freqLinkSize         = 20
	pageRequestSize      = 16
	pageHeaderSize       = 32
	telemetrySummarySize = 248
	radioFrequencySize   = 136
	activeLinkSize       = 164
	vifSize              = 24
	eventSize            = 44
	associationSize      = 28
	pageEnd              = ^uint32(0)
	defaultPageLimit     = uint32(128)

	opHello                = uint16(1)
	opStatus               = uint16(2)
	opApply                = uint16(3)
	opGetLink              = uint16(4)
	opDumpLinks            = uint16(5)
	opApplyFrequency       = uint16(6)
	opGetFrequency         = uint16(7)
	opDumpFrequencies      = uint16(8)
	opTelemetrySummary     = uint16(9)
	opDumpRadioFrequencies = uint16(10)
	opDumpActiveLinks      = uint16(11)
	opDumpVIFs             = uint16(12)
	opDumpEvents           = uint16(13)
	opGetAssociation       = uint16(14)

	capRadioPairSNR          = uint32(1 << 0)
	capAtomicGenerations     = uint32(1 << 1)
	capReadback              = uint32(1 << 2)
	capDump                  = uint32(1 << 3)
	capFrequencyQualifiedSNR = uint32(1 << 4)
	capReadOnly              = uint32(1 << 5)
	capTelemetry             = uint32(1 << 6)
	capPagedDumps            = uint32(1 << 7)
	capVIFOwnership          = uint32(1 << 8)
	capEventRing             = uint32(1 << 9)
	capAssociationOwnership  = uint32(1 << 10)
	capPagedLinkDumps        = uint32(1 << 11)

	pageMore = uint32(1 << 0)
	pageGap  = uint32(1 << 1)
)

var statusNames = map[uint32]string{
	0: "ok", 1: "protocol", 2: "length", 3: "generation",
	4: "identity", 5: "value", 6: "internal", 7: "frequency",
	8: "read-only", 9: "unknown",
}

var capabilityNames = []struct {
	bit  uint32
	name string
}{
	{capRadioPairSNR, "radio_pair_snr"},
	{capAtomicGenerations, "atomic_generations"},
	{capReadback, "readback"},
	{capDump, "dump_links"},
	{capFrequencyQualifiedSNR, "frequency_qualified_snr"},
	{capReadOnly, "read_only"},
	{capTelemetry, "telemetry"},
	{capPagedDumps, "paged_dumps"},
	{capVIFOwnership, "vif_ownership"},
	{capEventRing, "event_ring"},
	{capAssociationOwnership, "association_ownership"},
	{capPagedLinkDumps, "paged_link_dumps"},
}

type Client struct {
	Path       string
	Timeout    time.Duration
	MaxRetries int

	mu            sync.Mutex
	eventInstance string
	eventSequence uint64
	eventHistory  []model.TelemetryEvent
	eventGap      bool
}

type header struct {
	Opcode     uint16
	Length     uint32
	Status     uint32
	Generation uint64
}

type daemonInfo struct {
	InstanceID   string
	Generation   uint64
	Capabilities uint32
	MaxUpdates   uint32
	NumStations  uint32
}

type pageInfo struct {
	SnapshotSequence    uint64
	OldestEventSequence uint64
	Total               uint32
	NextCursor          uint32
	Flags               uint32
}

func NewClient(path string) *Client {
	return &Client{Path: path, Timeout: 2 * time.Second, MaxRetries: 3}
}

func (c *Client) Snapshot(ctx context.Context) (model.Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	retries := c.MaxRetries
	if retries < 1 {
		retries = 1
	}
	var last error
	for attempt := 1; attempt <= retries; attempt++ {
		snapshot, instance, eventSequence, events, err := c.snapshotOnce(ctx)
		if err == nil {
			c.eventInstance = instance
			c.eventSequence = eventSequence
			c.eventHistory = events
			c.eventGap = snapshot.Health.EventHistoryGap
			return snapshot, nil
		}
		last = err
		if !errors.Is(err, errGenerationChanged) {
			break
		}
	}
	return model.Snapshot{}, fmt.Errorf("read wmediumd snapshot from %s: %w", c.Path, last)
}

// ResolveAssociations reads wmediumd's protocol-positive ownership ledger for
// the client identities already enriched by the inventory loader. Unsupported
// older daemons retain the browser's legacy packet-path fallback.
func (c *Client) ResolveAssociations(ctx context.Context, snapshot *model.Snapshot) error {
	if snapshot == nil || !containsString(snapshot.Daemon.Capabilities, "association_ownership") {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	conn, err := dial(ctx, c.Path, c.Timeout)
	if err != nil {
		return err
	}
	defer conn.Close()
	hello, err := requestInfo(conn, opHello)
	if err != nil {
		return err
	}
	if hello.InstanceID != snapshot.Daemon.InstanceID || hello.Generation != snapshot.Daemon.Generation {
		return errGenerationChanged
	}
	if hello.Capabilities&capAssociationOwnership == 0 {
		return fmt.Errorf("association ownership disappeared during snapshot")
	}
	snapshot.Associations = make([]model.Association, 0)
	for _, station := range snapshot.Stations {
		if station.Role != "wlan-client" && station.Role != "iot-client" {
			continue
		}
		address, parseErr := net.ParseMAC(station.MAC)
		if parseErr != nil || len(address) != 6 {
			return fmt.Errorf("invalid client base-radio identity %q", station.MAC)
		}
		requestPayload := make([]byte, associationSize)
		copy(requestPayload[0:6], address)
		generation, response, requestErr := request(conn, opGetAssociation, hello.Generation, requestPayload)
		if requestErr != nil {
			var protocolErr *ProtocolError
			if errors.As(requestErr, &protocolErr) && (protocolErr.Status == 4 || protocolErr.Status == 9) {
				continue
			}
			return requestErr
		}
		if generation != hello.Generation {
			return errGenerationChanged
		}
		association, decodeErr := decodeAssociation(response)
		if decodeErr != nil {
			return decodeErr
		}
		snapshot.Associations = append(snapshot.Associations, association)
	}
	sort.Slice(snapshot.Associations, func(i, j int) bool {
		return snapshot.Associations[i].Station < snapshot.Associations[j].Station
	})
	return nil
}

var errGenerationChanged = errors.New("control generation changed during snapshot")

func (c *Client) snapshotOnce(ctx context.Context) (model.Snapshot, string, uint64, []model.TelemetryEvent, error) {
	if c.Path == "" {
		return model.Snapshot{}, "", 0, nil, fmt.Errorf("observer socket path is empty")
	}
	conn, err := dial(ctx, c.Path, c.Timeout)
	if err != nil {
		return model.Snapshot{}, "", 0, nil, err
	}
	defer conn.Close()

	hello, err := requestInfo(conn, opHello)
	if err != nil {
		return model.Snapshot{}, "", 0, nil, err
	}
	required := capReadOnly | capReadback | capDump | capRadioPairSNR
	if hello.Capabilities&required != required {
		return model.Snapshot{}, "", 0, nil, fmt.Errorf("endpoint is not a compatible read-only wmediumd endpoint (capabilities 0x%x)", hello.Capabilities)
	}

	var linkGeneration uint64
	var linkPayload []byte
	if hello.Capabilities&capPagedLinkDumps != 0 {
		linkPayload, _, err = requestPages(conn, opDumpLinks, hello.Generation, 0, linkSize)
		linkGeneration = hello.Generation
	} else {
		linkGeneration, linkPayload, err = request(conn, opDumpLinks, 0, nil)
	}
	if err != nil {
		return model.Snapshot{}, "", 0, nil, err
	}
	if linkGeneration != hello.Generation {
		return model.Snapshot{}, "", 0, nil, errGenerationChanged
	}
	links, err := decodeLinks(linkPayload)
	if err != nil {
		return model.Snapshot{}, "", 0, nil, err
	}

	var frequencyLinks []model.FrequencyLink
	if hello.Capabilities&capFrequencyQualifiedSNR != 0 {
		var frequencyGeneration uint64
		var payload []byte
		var requestErr error
		if hello.Capabilities&capPagedLinkDumps != 0 {
			payload, _, requestErr = requestPages(conn, opDumpFrequencies, hello.Generation, 0, freqLinkSize)
			frequencyGeneration = hello.Generation
		} else {
			frequencyGeneration, payload, requestErr = request(conn, opDumpFrequencies, 0, nil)
		}
		if requestErr != nil {
			return model.Snapshot{}, "", 0, nil, requestErr
		}
		if frequencyGeneration != hello.Generation {
			return model.Snapshot{}, "", 0, nil, errGenerationChanged
		}
		frequencyLinks, err = decodeFrequencyLinks(payload)
		if err != nil {
			return model.Snapshot{}, "", 0, nil, err
		}
	}

	snapshot := model.NewSnapshot()
	snapshot.CapturedAt = time.Now().UTC()
	snapshot.Daemon = model.Daemon{
		InstanceID: hello.InstanceID, Generation: hello.Generation,
		Capabilities: capabilityList(hello.Capabilities), MaxUpdates: hello.MaxUpdates,
		NumStations: hello.NumStations,
	}
	snapshot.PairLinks = links
	snapshot.FrequencyOverrides = frequencyLinks
	snapshot.Stations = model.StationsFromLinks(links)
	if hello.NumStations == 1 && len(snapshot.Stations) == 0 {
		return model.Snapshot{}, "", 0, nil, fmt.Errorf("protocol cannot identify the sole station from an empty pair dump")
	}

	eventSequence := c.eventSequence
	events := append([]model.TelemetryEvent(nil), c.eventHistory...)
	historyGap := c.eventGap
	if c.eventInstance != hello.InstanceID {
		eventSequence = 0
		events = nil
		historyGap = false
	}
	telemetryRequired := capTelemetry | capPagedDumps | capVIFOwnership | capEventRing
	if advertised := hello.Capabilities & telemetryRequired; advertised != 0 && advertised != telemetryRequired {
		return model.Snapshot{}, "", 0, nil, fmt.Errorf("endpoint advertises incomplete telemetry capabilities 0x%x", advertised)
	}
	if hello.Capabilities&telemetryRequired == telemetryRequired {
		firstSummaryGeneration, payload, requestErr := request(conn, opTelemetrySummary, 0, nil)
		if requestErr != nil {
			return model.Snapshot{}, "", 0, nil, requestErr
		}
		if firstSummaryGeneration != hello.Generation {
			return model.Snapshot{}, "", 0, nil, errGenerationChanged
		}
		firstSummary, decodeErr := decodeTelemetrySummary(payload)
		if decodeErr != nil {
			return model.Snapshot{}, "", 0, nil, decodeErr
		}

		radioPayload, radioPage, requestErr := requestPages(conn, opDumpRadioFrequencies, hello.Generation, 0, radioFrequencySize)
		if requestErr != nil {
			return model.Snapshot{}, "", 0, nil, requestErr
		}
		snapshot.RadioFrequencies, err = decodeRadioFrequencies(radioPayload)
		if err != nil {
			return model.Snapshot{}, "", 0, nil, err
		}
		activePayload, activePage, requestErr := requestPages(conn, opDumpActiveLinks, hello.Generation, 0, activeLinkSize)
		if requestErr != nil {
			return model.Snapshot{}, "", 0, nil, requestErr
		}
		snapshot.ActiveLinks, err = decodeActiveLinks(activePayload)
		if err != nil {
			return model.Snapshot{}, "", 0, nil, err
		}
		vifPayload, vifPage, requestErr := requestPages(conn, opDumpVIFs, hello.Generation, 0, vifSize)
		if requestErr != nil {
			return model.Snapshot{}, "", 0, nil, requestErr
		}
		snapshot.VIFs, err = decodeVIFs(vifPayload)
		if err != nil {
			return model.Snapshot{}, "", 0, nil, err
		}
		eventPayload, eventPage, requestErr := requestPages(conn, opDumpEvents, hello.Generation, eventSequence, eventSize)
		if requestErr != nil {
			return model.Snapshot{}, "", 0, nil, requestErr
		}
		newEvents, decodeErr := decodeEvents(eventPayload)
		if decodeErr != nil {
			return model.Snapshot{}, "", 0, nil, decodeErr
		}
		if eventPage.Flags&pageGap != 0 {
			events = nil
			historyGap = true
		}
		events = mergeEvents(events, newEvents, int(firstSummary.EventCapacity))
		if len(events) > 0 {
			eventSequence = events[len(events)-1].Sequence
		}
		finalSummaryGeneration, payload, requestErr := request(conn, opTelemetrySummary, 0, nil)
		if requestErr != nil {
			return model.Snapshot{}, "", 0, nil, requestErr
		}
		if finalSummaryGeneration != hello.Generation {
			return model.Snapshot{}, "", 0, nil, errGenerationChanged
		}
		finalSummary, decodeErr := decodeTelemetrySummary(payload)
		if decodeErr != nil {
			return model.Snapshot{}, "", 0, nil, decodeErr
		}
		snapshot.PacketMetrics = model.PacketMetrics{Available: true, Summary: &finalSummary}
		snapshot.Events = events
		latestEvent := uint64(0)
		if len(events) > 0 {
			latestEvent = events[len(events)-1].Sequence
		}
		gap := historyGap
		state, reasons := assessHealth(finalSummary, gap)
		oldest := eventPage.OldestEventSequence
		if oldest == 0 {
			oldest = radioPage.OldestEventSequence
		}
		snapshot.Health = model.Health{
			State: state, Reasons: reasons, EventHistoryGap: gap,
			OldestEventSequence: oldest, LatestEventSequence: latestEvent,
			TelemetrySequenceFrom: firstSummary.TelemetrySequence,
			TelemetrySequenceTo:   max64(finalSummary.TelemetrySequence, max64(radioPage.SnapshotSequence, max64(activePage.SnapshotSequence, vifPage.SnapshotSequence))),
		}
	}

	final, err := requestInfo(conn, opStatus)
	if err != nil {
		return model.Snapshot{}, "", 0, nil, err
	}
	if final.InstanceID != hello.InstanceID || final.Generation != hello.Generation {
		return model.Snapshot{}, "", 0, nil, errGenerationChanged
	}
	if err := snapshot.Validate(); err != nil {
		return model.Snapshot{}, "", 0, nil, err
	}
	return snapshot, hello.InstanceID, eventSequence, events, nil
}

func dial(ctx context.Context, path string, timeout time.Duration) (net.Conn, error) {
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, "unixpacket", path)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := conn.SetDeadline(deadline); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

func requestInfo(conn net.Conn, opcode uint16) (daemonInfo, error) {
	generation, payload, err := request(conn, opcode, 0, nil)
	if err != nil {
		return daemonInfo{}, err
	}
	if len(payload) != infoSize {
		return daemonInfo{}, fmt.Errorf("opcode %d returned %d info bytes, want %d", opcode, len(payload), infoSize)
	}
	return daemonInfo{
		InstanceID: fmt.Sprintf("%016x%016x", binary.BigEndian.Uint64(payload[0:8]), binary.BigEndian.Uint64(payload[8:16])),
		Generation: generation, Capabilities: binary.BigEndian.Uint32(payload[16:20]),
		MaxUpdates: binary.BigEndian.Uint32(payload[20:24]), NumStations: binary.BigEndian.Uint32(payload[24:28]),
	}, nil
}

type ProtocolError struct {
	Opcode     uint16
	Status     uint32
	Generation uint64
}

func (e *ProtocolError) Error() string {
	name := statusNames[e.Status]
	if name == "" {
		name = fmt.Sprintf("error-%d", e.Status)
	}
	return fmt.Sprintf("daemon rejected opcode %d: %s (generation %d)", e.Opcode, name, e.Generation)
}

func request(conn net.Conn, opcode uint16, generation uint64, payload []byte) (uint64, []byte, error) {
	if len(payload)+headerSize > maxFrame {
		return 0, nil, fmt.Errorf("opcode %d request exceeds %d bytes", opcode, maxFrame)
	}
	frame := make([]byte, headerSize+len(payload))
	binary.BigEndian.PutUint32(frame[0:4], magic)
	binary.BigEndian.PutUint16(frame[4:6], version)
	binary.BigEndian.PutUint16(frame[6:8], opcode)
	binary.BigEndian.PutUint32(frame[8:12], uint32(len(payload)))
	binary.BigEndian.PutUint64(frame[16:24], generation)
	copy(frame[headerSize:], payload)
	if written, err := conn.Write(frame); err != nil {
		return 0, nil, err
	} else if written != len(frame) {
		return 0, nil, fmt.Errorf("short control write: %d of %d bytes", written, len(frame))
	}
	response := make([]byte, maxFrame)
	n, err := conn.Read(response)
	if err != nil {
		return 0, nil, err
	}
	if n < headerSize {
		return 0, nil, fmt.Errorf("short control response: %d bytes", n)
	}
	h, err := decodeHeader(response[:headerSize])
	if err != nil {
		return 0, nil, err
	}
	if h.Opcode != opcode {
		return 0, nil, fmt.Errorf("response opcode %d, want %d", h.Opcode, opcode)
	}
	if int(h.Length) != n-headerSize {
		return 0, nil, fmt.Errorf("response payload length %d, received %d", h.Length, n-headerSize)
	}
	if h.Status != 0 {
		return h.Generation, nil, &ProtocolError{Opcode: opcode, Status: h.Status, Generation: h.Generation}
	}
	return h.Generation, append([]byte(nil), response[headerSize:n]...), nil
}

func requestPages(conn net.Conn, opcode uint16, generation, since uint64, entrySize int) ([]byte, pageInfo, error) {
	var all []byte
	var aggregate pageInfo
	cursor := uint32(0)
	for pages := 0; pages < 4096; pages++ {
		payload := make([]byte, pageRequestSize)
		binary.BigEndian.PutUint64(payload[0:8], since)
		binary.BigEndian.PutUint32(payload[8:12], cursor)
		binary.BigEndian.PutUint32(payload[12:16], defaultPageLimit)
		gotGeneration, response, err := request(conn, opcode, 0, payload)
		if err != nil {
			return nil, pageInfo{}, err
		}
		if gotGeneration != generation {
			return nil, pageInfo{}, errGenerationChanged
		}
		page, entries, err := decodePage(response, entrySize)
		if err != nil {
			return nil, pageInfo{}, fmt.Errorf("opcode %d: %w", opcode, err)
		}
		if pages == 0 {
			aggregate = page
		} else {
			aggregate.Flags |= page.Flags
			if page.OldestEventSequence != 0 {
				aggregate.OldestEventSequence = page.OldestEventSequence
			}
		}
		if page.SnapshotSequence > aggregate.SnapshotSequence {
			aggregate.SnapshotSequence = page.SnapshotSequence
		}
		all = append(all, entries...)
		if page.NextCursor == pageEnd {
			aggregate.NextCursor = pageEnd
			return all, aggregate, nil
		}
		if page.Flags&pageMore == 0 {
			return nil, pageInfo{}, fmt.Errorf("page has next cursor %d without MORE flag", page.NextCursor)
		}
		if page.NextCursor == cursor {
			return nil, pageInfo{}, fmt.Errorf("page cursor did not advance from %d", cursor)
		}
		cursor = page.NextCursor
	}
	return nil, pageInfo{}, fmt.Errorf("paged opcode %d exceeded page limit", opcode)
}

func decodePage(payload []byte, entrySize int) (pageInfo, []byte, error) {
	if len(payload) < pageHeaderSize || entrySize <= 0 || (len(payload)-pageHeaderSize)%entrySize != 0 {
		return pageInfo{}, nil, fmt.Errorf("invalid paged payload length %d for entry size %d", len(payload), entrySize)
	}
	page := pageInfo{
		SnapshotSequence:    binary.BigEndian.Uint64(payload[0:8]),
		OldestEventSequence: binary.BigEndian.Uint64(payload[8:16]),
		Total:               binary.BigEndian.Uint32(payload[16:20]),
		NextCursor:          binary.BigEndian.Uint32(payload[20:24]),
		Flags:               binary.BigEndian.Uint32(payload[24:28]),
	}
	if page.Flags & ^(pageMore|pageGap) != 0 {
		return pageInfo{}, nil, fmt.Errorf("unknown page flags 0x%x", page.Flags)
	}
	return page, payload[pageHeaderSize:], nil
}

func decodeHeader(frame []byte) (header, error) {
	if len(frame) != headerSize {
		return header{}, fmt.Errorf("invalid header length %d", len(frame))
	}
	if got := binary.BigEndian.Uint32(frame[0:4]); got != magic {
		return header{}, fmt.Errorf("invalid magic 0x%x", got)
	}
	if got := binary.BigEndian.Uint16(frame[4:6]); got != version {
		return header{}, fmt.Errorf("unsupported protocol version %d", got)
	}
	return header{Opcode: binary.BigEndian.Uint16(frame[6:8]), Length: binary.BigEndian.Uint32(frame[8:12]), Status: binary.BigEndian.Uint32(frame[12:16]), Generation: binary.BigEndian.Uint64(frame[16:24])}, nil
}

func decodeLinks(payload []byte) ([]model.Link, error) {
	if len(payload)%linkSize != 0 {
		return nil, fmt.Errorf("invalid pair-link payload length %d", len(payload))
	}
	links := make([]model.Link, 0, len(payload)/linkSize)
	for offset := 0; offset < len(payload); offset += linkSize {
		links = append(links, model.Link{Source: macText(payload[offset : offset+6]), Destination: macText(payload[offset+6 : offset+12]), SNRDB: int16(binary.BigEndian.Uint16(payload[offset+12 : offset+14]))})
	}
	sort.Slice(links, func(i, j int) bool {
		return links[i].Source < links[j].Source || links[i].Source == links[j].Source && links[i].Destination < links[j].Destination
	})
	return links, nil
}

func decodeFrequencyLinks(payload []byte) ([]model.FrequencyLink, error) {
	if len(payload)%freqLinkSize != 0 {
		return nil, fmt.Errorf("invalid frequency-link payload length %d", len(payload))
	}
	links := make([]model.FrequencyLink, 0, len(payload)/freqLinkSize)
	for offset := 0; offset < len(payload); offset += freqLinkSize {
		frequency := binary.BigEndian.Uint32(payload[offset+12 : offset+16])
		flags := binary.BigEndian.Uint16(payload[offset+18 : offset+20])
		if flags&^uint16(1) != 0 {
			return nil, fmt.Errorf("frequency link contains unknown flags 0x%x", flags)
		}
		band, channel := model.BandAndChannel(frequency)
		links = append(links, model.FrequencyLink{Source: macText(payload[offset : offset+6]), Destination: macText(payload[offset+6 : offset+12]), FrequencyMHz: frequency, Band: band, Channel: channel, SNRDB: int16(binary.BigEndian.Uint16(payload[offset+16 : offset+18])), Override: flags&1 != 0})
	}
	sort.Slice(links, func(i, j int) bool {
		return links[i].Source < links[j].Source || links[i].Source == links[j].Source && (links[i].Destination < links[j].Destination || links[i].Destination == links[j].Destination && links[i].FrequencyMHz < links[j].FrequencyMHz)
	})
	return links, nil
}

func decodeTelemetrySummary(payload []byte) (model.TelemetrySummary, error) {
	if len(payload) != telemetrySummarySize {
		return model.TelemetrySummary{}, fmt.Errorf("telemetry summary length %d, want %d", len(payload), telemetrySummarySize)
	}
	u64 := func(index int) uint64 { return binary.BigEndian.Uint64(payload[index*8 : index*8+8]) }
	s := model.TelemetrySummary{
		TelemetrySequence: u64(0), UptimeUsec: u64(1), FramesSeen: u64(2), BytesSeen: u64(3),
		ManagementFrames: u64(4), ControlFrames: u64(5), DataFrames: u64(6), OtherFrames: u64(7), EAPOLFrames: u64(8),
		UnicastFrames: u64(9), MulticastFrames: u64(10), TXAttempts: u64(11), Retries: u64(12), TXAcked: u64(13), TXNoAck: u64(14),
		RXInjected: u64(15), MulticastCandidates: u64(16), DropsOffChannel: u64(17), DropsCCA: u64(18), DropsInterference: u64(19),
		DropsPER: u64(20), DropsNoReceiver: u64(21), NetlinkCloneEINVAL: u64(22), NetlinkOtherErrors: u64(23), ActiveLinkEvictions: u64(24),
		EventOverruns: u64(25), QueueDelayUsecMax: u64(26), QueueDelayUsecLast: u64(27),
	}
	offset := 28 * 8
	s.QueueDepth = binary.BigEndian.Uint32(payload[offset : offset+4])
	s.QueueDepthMax = binary.BigEndian.Uint32(payload[offset+4 : offset+8])
	s.ActiveLinks = binary.BigEndian.Uint32(payload[offset+8 : offset+12])
	s.RadioFrequencies = binary.BigEndian.Uint32(payload[offset+12 : offset+16])
	s.VIFs = binary.BigEndian.Uint32(payload[offset+16 : offset+20])
	s.EventCapacity = binary.BigEndian.Uint32(payload[offset+20 : offset+24])
	return s, nil
}

func decodeRadioFrequencies(payload []byte) ([]model.RadioFrequency, error) {
	if len(payload)%radioFrequencySize != 0 {
		return nil, fmt.Errorf("invalid radio-frequency payload length %d", len(payload))
	}
	result := make([]model.RadioFrequency, 0, len(payload)/radioFrequencySize)
	for o := 0; o < len(payload); o += radioFrequencySize {
		p := payload[o : o+radioFrequencySize]
		f := binary.BigEndian.Uint32(p[8:12])
		band, channel := model.BandAndChannel(f)
		u := func(at int) uint64 { return binary.BigEndian.Uint64(p[at : at+8]) }
		result = append(result, model.RadioFrequency{Radio: macText(p[0:6]), FrequencyMHz: f, Band: band, Channel: channel,
			LastUpdateSequence: u(16), LastSeenUsec: u(24), Frames: u(32), Bytes: u(40), ManagementFrames: u(48), ControlFrames: u(56), DataFrames: u(64), EAPOLFrames: u(72), UnicastFrames: u(80), MulticastFrames: u(88), Attempts: u(96), Retries: u(104), RXInjected: u(112), Drops: u(120), QueueDepthMax: binary.BigEndian.Uint32(p[128:132]), LastType: p[132], LastSubtype: p[133], LastAccessCategory: p[134]})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Radio < result[j].Radio || result[i].Radio == result[j].Radio && result[i].FrequencyMHz < result[j].FrequencyMHz
	})
	return result, nil
}

func decodeActiveLinks(payload []byte) ([]model.ActiveLink, error) {
	if len(payload)%activeLinkSize != 0 {
		return nil, fmt.Errorf("invalid active-link payload length %d", len(payload))
	}
	result := make([]model.ActiveLink, 0, len(payload)/activeLinkSize)
	for o := 0; o < len(payload); o += activeLinkSize {
		p := payload[o : o+activeLinkSize]
		f := binary.BigEndian.Uint32(p[12:16])
		band, channel := model.BandAndChannel(f)
		u := func(at int) uint64 { return binary.BigEndian.Uint64(p[at : at+8]) }
		result = append(result, model.ActiveLink{Source: macText(p[0:6]), Destination: macText(p[6:12]), FrequencyMHz: f, Band: band, Channel: channel, Multicast: binary.BigEndian.Uint32(p[16:20])&1 != 0,
			LastUpdateSequence: u(20), FirstSeenUsec: u(28), LastSeenUsec: u(36), Frames: u(44), Bytes: u(52), Attempts: u(60), Retries: u(68), Acked: u(76), NoAck: u(84), RXInjected: u(92), DropsOffChannel: u(100), DropsCCA: u(108), DropsInterference: u(116), DropsPER: u(124), DropsNoReceiver: u(132), NetlinkRejections: u(140), LastSignalDBM: int32(binary.BigEndian.Uint32(p[148:152])), LastSNRDB: int32(binary.BigEndian.Uint32(p[152:156])), LastPERMillion: binary.BigEndian.Uint32(p[156:160]), LastType: p[160], LastSubtype: p[161], LastAccessCategory: p[162]})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].LastSeenUsec > result[j].LastSeenUsec })
	return result, nil
}

func decodeAssociation(payload []byte) (model.Association, error) {
	if len(payload) != associationSize {
		return model.Association{}, fmt.Errorf("invalid association payload length %d", len(payload))
	}
	frequency := binary.BigEndian.Uint32(payload[20:24])
	flags := binary.BigEndian.Uint32(payload[24:28])
	band, channel := model.BandAndChannel(frequency)
	evidence := "unknown"
	if flags&1 != 0 && flags&2 != 0 {
		evidence = "association response and data"
	} else if flags&1 != 0 {
		evidence = "association response"
	} else if flags&2 != 0 {
		evidence = "infrastructure data"
	}
	return model.Association{
		Endpoint: macText(payload[0:6]), Station: macText(payload[6:12]),
		Owner: macText(payload[12:18]), FrequencyMHz: frequency,
		Band: band, Channel: channel, Flags: flags, Evidence: evidence,
	}, nil
}

func decodeVIFs(payload []byte) ([]model.VIF, error) {
	if len(payload)%vifSize != 0 {
		return nil, fmt.Errorf("invalid VIF payload length %d", len(payload))
	}
	result := make([]model.VIF, 0, len(payload)/vifSize)
	for o := 0; o < len(payload); o += vifSize {
		p := payload[o : o+vifSize]
		f := binary.BigEndian.Uint32(p[12:16])
		band, channel := model.BandAndChannel(f)
		result = append(result, model.VIF{MAC: macText(p[0:6]), Radio: macText(p[6:12]), FrequencyMHz: f, Band: band, Channel: channel, LastUpdateSequence: binary.BigEndian.Uint64(p[16:24])})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].MAC < result[j].MAC })
	return result, nil
}

func decodeEvents(payload []byte) ([]model.TelemetryEvent, error) {
	if len(payload)%eventSize != 0 {
		return nil, fmt.Errorf("invalid event payload length %d", len(payload))
	}
	result := make([]model.TelemetryEvent, 0, len(payload)/eventSize)
	for o := 0; o < len(payload); o += eventSize {
		p := payload[o : o+eventSize]
		typ := binary.BigEndian.Uint32(p[16:20])
		f := binary.BigEndian.Uint32(p[36:40])
		band, channel := model.BandAndChannel(f)
		e := model.TelemetryEvent{Sequence: binary.BigEndian.Uint64(p[0:8]), TimeUsec: binary.BigEndian.Uint64(p[8:16]), TypeID: typ, Type: model.EventTypeName(typ), Value: int32(binary.BigEndian.Uint32(p[20:24])), FrequencyMHz: f, Band: band, Channel: channel, Auxiliary: binary.BigEndian.Uint32(p[40:44])}
		if !zeroMAC(p[24:30]) {
			e.Source = macText(p[24:30])
		}
		if !zeroMAC(p[30:36]) {
			e.Destination = macText(p[30:36])
		}
		result = append(result, e)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Sequence < result[j].Sequence })
	return result, nil
}

func mergeEvents(existing, incoming []model.TelemetryEvent, capacity int) []model.TelemetryEvent {
	if capacity <= 0 {
		capacity = 256
	}
	bySequence := make(map[uint64]model.TelemetryEvent, len(existing)+len(incoming))
	for _, event := range existing {
		bySequence[event.Sequence] = event
	}
	for _, event := range incoming {
		bySequence[event.Sequence] = event
	}
	sequences := make([]uint64, 0, len(bySequence))
	for sequence := range bySequence {
		sequences = append(sequences, sequence)
	}
	sort.Slice(sequences, func(i, j int) bool { return sequences[i] < sequences[j] })
	if len(sequences) > capacity {
		sequences = sequences[len(sequences)-capacity:]
	}
	result := make([]model.TelemetryEvent, 0, len(sequences))
	for _, sequence := range sequences {
		result = append(result, bySequence[sequence])
	}
	return result
}

func zeroMAC(value []byte) bool {
	for _, octet := range value {
		if octet != 0 {
			return false
		}
	}
	return true
}
func macText(mac []byte) string {
	parts := make([]string, len(mac))
	for i, value := range mac {
		parts[i] = fmt.Sprintf("%02x", value)
	}
	return strings.Join(parts, ":")
}
func capabilityList(mask uint32) []string {
	result := make([]string, 0, len(capabilityNames))
	for _, capability := range capabilityNames {
		if mask&capability.bit != 0 {
			result = append(result, capability.name)
		}
	}
	return result
}
func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
func assessHealth(summary model.TelemetrySummary, eventHistoryGap bool) (string, []string) {
	state := "ok"
	reasons := make([]string, 0, 3)
	if eventHistoryGap {
		state = "degraded"
		reasons = append(reasons, "event history gap occurred after observer startup")
	}
	if summary.EventOverruns > 0 && !eventHistoryGap {
		reasons = append(reasons, fmt.Sprintf("bounded daemon event history has overwritten %d older record(s); observer reports no gap", summary.EventOverruns))
	}
	if summary.QueueDepth > 0 {
		if state == "ok" {
			state = "busy"
		}
		reasons = append(reasons, fmt.Sprintf("queue currently contains %d frame(s)", summary.QueueDepth))
	}
	if summary.NetlinkOtherErrors > 0 {
		state = "degraded"
		reasons = append(reasons, "non-EINVAL netlink errors have been observed")
	}
	if len(reasons) == 0 {
		reasons = []string{"no current queue or event-integrity warning"}
	}
	return state, reasons
}
func max64(a, b uint64) uint64 {
	if a > b {
		return a
	}
	return b
}
