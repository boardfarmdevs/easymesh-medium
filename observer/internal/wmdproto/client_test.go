package wmdproto

import (
	"context"
	"encoding/binary"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/model"
)

var testMACs = [][6]byte{
	{0x42, 0, 0, 0, 1, 0},
	{0x42, 0, 0, 0, 2, 0},
	{0x42, 0, 0, 0, 3, 0},
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func TestReadOnlySnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "metrics.sock")
	listener := listenUnixPacket(t, path)
	defer listener.Close()
	go serveSnapshot(t, listener, capRadioPairSNR|capAtomicGenerations|capReadback|capDump|capFrequencyQualifiedSNR|capReadOnly, 7, false)

	client := NewClient(path)
	snapshot, err := client.Snapshot(context.Background())
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if snapshot.Daemon.Generation != 7 || snapshot.Daemon.NumStations != 3 {
		t.Fatalf("unexpected daemon state: %+v", snapshot.Daemon)
	}
	if len(snapshot.PairLinks) != 6 {
		t.Fatalf("got %d pair links, want 6", len(snapshot.PairLinks))
	}
	if len(snapshot.FrequencyOverrides) != 1 {
		t.Fatalf("got %d frequency overrides, want 1", len(snapshot.FrequencyOverrides))
	}
	override := snapshot.FrequencyOverrides[0]
	if override.FrequencyMHz != 5180 || override.Band != "5GHz" || override.Channel != 36 || override.SNRDB != 44 {
		t.Fatalf("unexpected override: %+v", override)
	}
	if snapshot.PacketMetrics.Available {
		t.Fatal("Phase 1 packet metrics incorrectly marked available")
	}
}

func TestRejectsWritableEndpoint(t *testing.T) {
	path := filepath.Join(t.TempDir(), "control.sock")
	listener := listenUnixPacket(t, path)
	defer listener.Close()
	go serveSnapshot(t, listener, capRadioPairSNR|capReadback|capDump, 0, false)

	client := NewClient(path)
	if _, err := client.Snapshot(context.Background()); err == nil {
		t.Fatal("writable/non-read-only endpoint was accepted")
	}
}

func TestRetriesGenerationChange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "metrics.sock")
	listener := listenUnixPacket(t, path)
	defer listener.Close()
	go func() {
		serveOneConnection(t, listener, capRadioPairSNR|capReadback|capDump|capReadOnly, 1, true)
		serveOneConnection(t, listener, capRadioPairSNR|capReadback|capDump|capReadOnly, 2, false)
	}()

	client := NewClient(path)
	client.MaxRetries = 2
	snapshot, err := client.Snapshot(context.Background())
	if err != nil {
		t.Fatalf("Snapshot did not retry: %v", err)
	}
	if snapshot.Daemon.Generation != 2 {
		t.Fatalf("generation = %d, want 2", snapshot.Daemon.Generation)
	}
}

func TestTelemetrySnapshotPagedGolden(t *testing.T) {
	path := filepath.Join(t.TempDir(), "observer.sock")
	listener := listenUnixPacket(t, path)
	defer listener.Close()
	capabilities := capRadioPairSNR | capAtomicGenerations | capReadback | capDump |
		capFrequencyQualifiedSNR | capReadOnly | capTelemetry | capPagedDumps |
		capVIFOwnership | capEventRing | capPagedLinkDumps
	go serveTelemetryConnection(t, listener, capabilities, 12)

	client := NewClient(path)
	snapshot, err := client.Snapshot(context.Background())
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if !snapshot.PacketMetrics.Available || snapshot.PacketMetrics.Summary == nil {
		t.Fatalf("telemetry not available: %+v", snapshot.PacketMetrics)
	}
	if !contains(snapshot.Daemon.Capabilities, "paged_link_dumps") {
		t.Fatalf("paged link-dump capability missing: %v", snapshot.Daemon.Capabilities)
	}
	summary := snapshot.PacketMetrics.Summary
	if summary.FramesSeen != 102 || summary.EventCapacity != 8 || summary.QueueDepth != 2 {
		t.Fatalf("summary decoded incorrectly: %+v", summary)
	}
	if len(snapshot.RadioFrequencies) != 2 || snapshot.RadioFrequencies[1].FrequencyMHz != 5955 || snapshot.RadioFrequencies[1].Channel != 1 {
		t.Fatalf("radio pages decoded incorrectly: %+v", snapshot.RadioFrequencies)
	}
	if len(snapshot.ActiveLinks) != 1 {
		t.Fatalf("active links = %d, want 1", len(snapshot.ActiveLinks))
	}
	active := snapshot.ActiveLinks[0]
	if active.LastSignalDBM != -54 || active.LastSNRDB != 31 || active.LastPERMillion != 125000 || !active.Multicast || active.DropsPER != 4 {
		t.Fatalf("active link decoded incorrectly: %+v", active)
	}
	if len(snapshot.VIFs) != 1 || snapshot.VIFs[0].Radio != "42:00:00:00:01:00" {
		t.Fatalf("VIF ownership decoded incorrectly: %+v", snapshot.VIFs)
	}
	if len(snapshot.Events) != 2 || snapshot.Events[0].Type != "vif_learned" || snapshot.Events[1].Type != "generation_applied" {
		t.Fatalf("events decoded incorrectly: %+v", snapshot.Events)
	}
	if !snapshot.Health.EventHistoryGap || snapshot.Health.State != "degraded" || snapshot.Health.TelemetrySequenceFrom != 1000 || snapshot.Health.TelemetrySequenceTo != 1002 {
		t.Fatalf("health decoded incorrectly: %+v", snapshot.Health)
	}
}

func TestGoldenDecoderSizes(t *testing.T) {
	if _, err := decodeTelemetrySummary(make([]byte, telemetrySummarySize-1)); err == nil {
		t.Fatal("short summary accepted")
	}
	if _, err := decodeRadioFrequencies(make([]byte, radioFrequencySize+1)); err == nil {
		t.Fatal("misaligned radio payload accepted")
	}
	if _, err := decodeActiveLinks(make([]byte, activeLinkSize-1)); err == nil {
		t.Fatal("short active link accepted")
	}
	if _, err := decodeVIFs(make([]byte, vifSize+1)); err == nil {
		t.Fatal("misaligned VIF payload accepted")
	}
	if _, err := decodeEvents(make([]byte, eventSize-1)); err == nil {
		t.Fatal("short event accepted")
	}
	if _, err := decodeAssociation(make([]byte, associationSize-1)); err == nil {
		t.Fatal("short association accepted")
	}
}

func TestResolveAuthoritativeAssociations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "observer.sock")
	listener := listenUnixPacket(t, path)
	defer listener.Close()
	go serveAssociationConnection(t, listener, 17)

	client := NewClient(path)
	snapshot := model.Snapshot{
		Daemon: model.Daemon{
			InstanceID:   "0123456789abcdeffedcba9876543210",
			Generation:   17,
			Capabilities: []string{"association_ownership"},
		},
		Stations: []model.Station{
			{MAC: "42:00:00:00:01:00", Role: "wlan-client"},
			{MAC: "42:00:00:00:02:00", Role: "iot-client"},
			{MAC: "42:00:00:00:03:00", Role: "extender"},
		},
	}
	if err := client.ResolveAssociations(context.Background(), &snapshot); err != nil {
		t.Fatalf("ResolveAssociations: %v", err)
	}
	if len(snapshot.Associations) != 1 {
		t.Fatalf("associations = %d, want 1: %+v", len(snapshot.Associations), snapshot.Associations)
	}
	association := snapshot.Associations[0]
	if association.Station != "42:00:00:00:01:00" || association.Owner != "42:00:00:00:03:00" ||
		association.FrequencyMHz != 5180 || association.Band != "5GHz" || association.Channel != 36 ||
		association.Evidence != "association response and data" {
		t.Fatalf("association decoded incorrectly: %+v", association)
	}
}

func TestEventRingOverwriteIsInformationalWithoutHistoryGap(t *testing.T) {
	state, reasons := assessHealth(model.TelemetrySummary{EventOverruns: 42}, false)
	if state != "ok" || len(reasons) != 1 || !strings.Contains(reasons[0], "observer reports no gap") {
		t.Fatalf("ring overwrite incorrectly classified: state=%s reasons=%v", state, reasons)
	}
	state, _ = assessHealth(model.TelemetrySummary{EventOverruns: 42}, true)
	if state != "degraded" {
		t.Fatalf("actual history gap classified as %s, want degraded", state)
	}
}

func serveAssociationConnection(t *testing.T, listener *net.UnixListener, generation uint64) {
	t.Helper()
	conn, err := listener.AcceptUnix()
	if err != nil {
		return
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	for {
		frame := make([]byte, maxFrame)
		n, readErr := conn.Read(frame)
		if readErr != nil {
			return
		}
		opcode := binary.BigEndian.Uint16(frame[6:8])
		if opcode == opHello {
			if _, err := conn.Write(responseFrame(opcode, generation, infoPayload(capReadOnly|capAssociationOwnership, 3))); err != nil {
				return
			}
			continue
		}
		if opcode != opGetAssociation || n != headerSize+associationSize {
			t.Errorf("unexpected association request opcode=%d length=%d", opcode, n)
			return
		}
		endpoint := frame[headerSize : headerSize+6]
		if endpoint[4] == 2 {
			if _, err := conn.Write(responseFrameStatus(opcode, generation, 9, nil)); err != nil {
				return
			}
			continue
		}
		payload := make([]byte, associationSize)
		copy(payload[0:6], endpoint)
		copy(payload[6:12], testMACs[0][:])
		copy(payload[12:18], testMACs[2][:])
		binary.BigEndian.PutUint32(payload[20:24], 5180)
		binary.BigEndian.PutUint32(payload[24:28], 3)
		if _, err := conn.Write(responseFrame(opcode, generation, payload)); err != nil {
			return
		}
	}
}

func serveTelemetryConnection(t *testing.T, listener *net.UnixListener, capabilities uint32, generation uint64) {
	t.Helper()
	conn, err := listener.AcceptUnix()
	if err != nil {
		return
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	radioPage := 0
	for {
		frame := make([]byte, maxFrame)
		n, err := conn.Read(frame)
		if err != nil {
			return
		}
		if n < headerSize {
			t.Errorf("short request %d", n)
			return
		}
		opcode := binary.BigEndian.Uint16(frame[6:8])
		payloadLength := int(binary.BigEndian.Uint32(frame[8:12]))
		if n != headerSize+payloadLength {
			t.Errorf("request payload mismatch for opcode %d", opcode)
			return
		}
		requestPayload := frame[headerSize:n]
		var payload []byte
		switch opcode {
		case opHello, opStatus:
			payload = infoPayload(capabilities, 3)
		case opDumpLinks:
			if capabilities&capPagedLinkDumps == 0 {
				payload = pairPayload()
				break
			}
			if len(requestPayload) != pageRequestSize || binary.BigEndian.Uint64(requestPayload[0:8]) != 0 || binary.BigEndian.Uint32(requestPayload[12:16]) != 128 {
				t.Errorf("bad pair page request %x", requestPayload)
				return
			}
			pairs := pairPayload()
			switch cursor := binary.BigEndian.Uint32(requestPayload[8:12]); cursor {
			case 0:
				payload = pagePayload(generation, 0, 6, 3, pageMore, pairs[:3*linkSize])
			case 3:
				payload = pagePayload(generation, 0, 6, pageEnd, 0, pairs[3*linkSize:])
			default:
				t.Errorf("unexpected pair cursor %d", cursor)
				return
			}
		case opDumpFrequencies:
			if capabilities&capPagedLinkDumps == 0 {
				payload = frequencyPayload()
				break
			}
			if len(requestPayload) != pageRequestSize || binary.BigEndian.Uint32(requestPayload[8:12]) != 0 {
				t.Errorf("bad frequency page request %x", requestPayload)
				return
			}
			payload = pagePayload(generation, 0, 1, pageEnd, 0, frequencyPayload())
		case opTelemetrySummary:
			payload = telemetrySummaryPayload(uint64(1000 + radioPage))
		case opDumpRadioFrequencies:
			if len(requestPayload) != pageRequestSize || binary.BigEndian.Uint64(requestPayload[0:8]) != 0 || binary.BigEndian.Uint32(requestPayload[12:16]) != 128 {
				t.Errorf("bad radio page request %x", requestPayload)
				return
			}
			cursor := binary.BigEndian.Uint32(requestPayload[8:12])
			if radioPage == 0 {
				if cursor != 0 {
					t.Errorf("first cursor = %d", cursor)
					return
				}
				payload = pagePayload(1001, 40, 2, 9, pageMore, radioFrequencyPayload(testMACs[0], 5180, 11))
			} else {
				if cursor != 9 {
					t.Errorf("second cursor = %d", cursor)
					return
				}
				payload = pagePayload(1002, 40, 2, pageEnd, 0, radioFrequencyPayload(testMACs[1], 5955, 12))
			}
			radioPage++
		case opDumpActiveLinks:
			payload = pagePayload(1002, 40, 1, pageEnd, 0, activeLinkPayload())
		case opDumpVIFs:
			payload = pagePayload(1002, 40, 1, pageEnd, 0, vifPayload())
		case opDumpEvents:
			payload = pagePayload(1002, 40, 2, pageEnd, pageGap, append(eventPayload(40, 1), eventPayload(41, 4)...))
		default:
			t.Errorf("unexpected telemetry opcode %d", opcode)
			return
		}
		if _, err := conn.Write(responseFrame(opcode, generation, payload)); err != nil {
			return
		}
		if opcode == opStatus {
			return
		}
	}
}

func telemetrySummaryPayload(sequence uint64) []byte {
	payload := make([]byte, telemetrySummarySize)
	for i := 0; i < 28; i++ {
		binary.BigEndian.PutUint64(payload[i*8:i*8+8], uint64(100+i))
	}
	binary.BigEndian.PutUint64(payload[0:8], sequence)
	offset := 28 * 8
	values := []uint32{2, 7, 1, 2, 1, 8}
	for i, value := range values {
		binary.BigEndian.PutUint32(payload[offset+i*4:offset+i*4+4], value)
	}
	return payload
}

func pagePayload(sequence, oldest uint64, total, next, flags uint32, entries []byte) []byte {
	payload := make([]byte, pageHeaderSize+len(entries))
	binary.BigEndian.PutUint64(payload[0:8], sequence)
	binary.BigEndian.PutUint64(payload[8:16], oldest)
	binary.BigEndian.PutUint32(payload[16:20], total)
	binary.BigEndian.PutUint32(payload[20:24], next)
	binary.BigEndian.PutUint32(payload[24:28], flags)
	copy(payload[pageHeaderSize:], entries)
	return payload
}

func radioFrequencyPayload(radio [6]byte, frequency uint32, seed uint64) []byte {
	payload := make([]byte, radioFrequencySize)
	copy(payload[0:6], radio[:])
	binary.BigEndian.PutUint32(payload[8:12], frequency)
	for offset := 16; offset < 128; offset += 8 {
		binary.BigEndian.PutUint64(payload[offset:offset+8], seed)
		seed++
	}
	binary.BigEndian.PutUint32(payload[128:132], 3)
	payload[132] = 2
	payload[133] = 8
	payload[134] = 1
	return payload
}

func activeLinkPayload() []byte {
	payload := make([]byte, activeLinkSize)
	copy(payload[0:6], testMACs[0][:])
	copy(payload[6:12], testMACs[1][:])
	binary.BigEndian.PutUint32(payload[12:16], 5180)
	binary.BigEndian.PutUint32(payload[16:20], 1)
	values := []uint64{1002, 100, 900, 50, 5000, 60, 3, 55, 5, 55, 1, 2, 3, 4, 5, 6}
	for i, value := range values {
		binary.BigEndian.PutUint64(payload[20+i*8:28+i*8], value)
	}
	signal := int32(-54)
	binary.BigEndian.PutUint32(payload[148:152], uint32(signal))
	binary.BigEndian.PutUint32(payload[152:156], 31)
	binary.BigEndian.PutUint32(payload[156:160], 125000)
	payload[160] = 2
	payload[161] = 8
	payload[162] = 2
	return payload
}

func vifPayload() []byte {
	payload := make([]byte, vifSize)
	vif := [6]byte{0x02, 0, 0, 0, 1, 9}
	copy(payload[0:6], vif[:])
	copy(payload[6:12], testMACs[0][:])
	binary.BigEndian.PutUint32(payload[12:16], 5180)
	binary.BigEndian.PutUint64(payload[16:24], 1001)
	return payload
}

func eventPayload(sequence uint64, eventType uint32) []byte {
	payload := make([]byte, eventSize)
	binary.BigEndian.PutUint64(payload[0:8], sequence)
	binary.BigEndian.PutUint64(payload[8:16], sequence*100)
	binary.BigEndian.PutUint32(payload[16:20], eventType)
	binary.BigEndian.PutUint32(payload[20:24], 7)
	copy(payload[24:30], testMACs[0][:])
	copy(payload[30:36], testMACs[1][:])
	binary.BigEndian.PutUint32(payload[36:40], 5180)
	binary.BigEndian.PutUint32(payload[40:44], 2)
	return payload
}

func listenUnixPacket(t *testing.T, path string) *net.UnixListener {
	t.Helper()
	listener, err := net.ListenUnix("unixpacket", &net.UnixAddr{Name: path, Net: "unixpacket"})
	if err != nil {
		t.Fatal(err)
	}
	return listener
}

func serveSnapshot(t *testing.T, listener *net.UnixListener, capabilities uint32, generation uint64, change bool) {
	t.Helper()
	serveOneConnection(t, listener, capabilities, generation, change)
}

func serveOneConnection(t *testing.T, listener *net.UnixListener, capabilities uint32, generation uint64, change bool) {
	t.Helper()
	conn, err := listener.AcceptUnix()
	if err != nil {
		return
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	for requestIndex := 0; ; requestIndex++ {
		request := make([]byte, maxFrame)
		n, err := conn.Read(request)
		if err != nil {
			return
		}
		if n != headerSize {
			t.Errorf("request length %d, want %d", n, headerSize)
			return
		}
		opcode := binary.BigEndian.Uint16(request[6:8])
		responseGeneration := generation
		if change && requestIndex > 0 {
			responseGeneration++
		}
		var payload []byte
		switch opcode {
		case opHello, opStatus:
			payload = infoPayload(capabilities, 3)
		case opDumpLinks:
			payload = pairPayload()
		case opDumpFrequencies:
			payload = frequencyPayload()
		default:
			t.Errorf("unexpected opcode %d", opcode)
			return
		}
		if _, err := conn.Write(responseFrame(opcode, responseGeneration, payload)); err != nil {
			return
		}
		if change && requestIndex == 1 {
			return
		}
		if opcode == opStatus {
			return
		}
	}
}

func infoPayload(capabilities uint32, stations uint32) []byte {
	payload := make([]byte, infoSize)
	binary.BigEndian.PutUint64(payload[0:8], 0x0123456789abcdef)
	binary.BigEndian.PutUint64(payload[8:16], 0xfedcba9876543210)
	binary.BigEndian.PutUint32(payload[16:20], capabilities)
	binary.BigEndian.PutUint32(payload[20:24], 64)
	binary.BigEndian.PutUint32(payload[24:28], stations)
	return payload
}

func pairPayload() []byte {
	payload := make([]byte, 0, 6*linkSize)
	for source := range testMACs {
		for destination := range testMACs {
			if source == destination {
				continue
			}
			link := make([]byte, linkSize)
			copy(link[0:6], testMACs[source][:])
			copy(link[6:12], testMACs[destination][:])
			binary.BigEndian.PutUint16(link[12:14], uint16(30+source+destination))
			payload = append(payload, link...)
		}
	}
	return payload
}

func frequencyPayload() []byte {
	link := make([]byte, freqLinkSize)
	copy(link[0:6], testMACs[0][:])
	copy(link[6:12], testMACs[1][:])
	binary.BigEndian.PutUint32(link[12:16], 5180)
	binary.BigEndian.PutUint16(link[16:18], 44)
	binary.BigEndian.PutUint16(link[18:20], 1)
	return link
}

func responseFrame(opcode uint16, generation uint64, payload []byte) []byte {
	frame := make([]byte, headerSize+len(payload))
	binary.BigEndian.PutUint32(frame[0:4], magic)
	binary.BigEndian.PutUint16(frame[4:6], version)
	binary.BigEndian.PutUint16(frame[6:8], opcode)
	binary.BigEndian.PutUint32(frame[8:12], uint32(len(payload)))
	binary.BigEndian.PutUint64(frame[16:24], generation)
	copy(frame[headerSize:], payload)
	return frame
}
