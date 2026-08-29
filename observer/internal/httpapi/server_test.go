package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/model"
	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/state"
)

func TestRESTIsReadOnlyAndExposesState(t *testing.T) {
	store := populatedStore()
	handler := New(store, testAssets())

	request := httptest.NewRequest(http.MethodGet, "/api/v1/snapshot", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("GET snapshot = %d: %s", response.Code, response.Body.String())
	}
	var snapshot model.Snapshot
	if err := json.Unmarshal(response.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Daemon.Generation != 9 || snapshot.PacketMetrics.Available {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}

	request = httptest.NewRequest(http.MethodPost, "/api/v1/controls", strings.NewReader("{}"))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("POST controls = %d Allow=%q", response.Code, response.Header().Get("Allow"))
	}

	request = httptest.NewRequest(http.MethodGet, "/api/v1/controls", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if !strings.Contains(response.Body.String(), `"enabled":false`) || !strings.Contains(response.Body.String(), `"pair_set"`) {
		t.Fatalf("disabled control contract missing: %s", response.Body.String())
	}
}

func TestLinkFiltersAndStaticUI(t *testing.T) {
	handler := New(populatedStore(), testAssets())
	request := httptest.NewRequest(http.MethodGet, "/api/v1/links?kind=frequency&frequency_mhz=5180", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"frequency_mhz":5180`) || strings.Contains(response.Body.String(), `"pair_links":[{`) {
		t.Fatalf("filtered links response: %d %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "wmediumd Console") {
		t.Fatalf("UI response: %d %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("Content-Security-Policy is absent")
	}
	request = httptest.NewRequest(http.MethodGet, "/graph-layout.js", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "layoutStations") {
		t.Fatalf("graph layout asset response: %d %s", response.Code, response.Body.String())
	}
}

func TestWebSocketInitialSnapshot(t *testing.T) {
	httpServer := httptest.NewServer(New(populatedStore(), testAssets()))
	defer httpServer.Close()
	parsed, err := url.Parse(httpServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := net.Dial("tcp", parsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(3 * time.Second))
	key := "dGhlIHNhbXBsZSBub25jZQ=="
	request := "GET /api/v1/stream HTTP/1.1\r\nHost: " + parsed.Host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n"
	if _, err := io.WriteString(connection, request); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade status = %d", response.StatusCode)
	}
	payload, err := readServerTextFrame(reader)
	if err != nil {
		t.Fatal(err)
	}
	var event state.Event
	if err := json.Unmarshal(payload, &event); err != nil {
		t.Fatal(err)
	}
	if event.Type != "snapshot" || event.Snapshot == nil || event.Snapshot.Daemon.Generation != 9 {
		t.Fatalf("unexpected WebSocket event: %+v", event)
	}
}

func TestUnavailableReturnsServiceUnavailable(t *testing.T) {
	store := state.New()
	store.UpdateError(context.DeadlineExceeded)
	handler := New(store, testAssets())
	request := httptest.NewRequest(http.MethodGet, "/api/v1/snapshot", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "deadline exceeded") {
		t.Fatalf("unavailable response: %d %s", response.Code, response.Body.String())
	}
}

func TestTypedControlsRequireExplicitBackendAndCSRF(t *testing.T) {
	backend := &fakeControlBackend{}
	handler := New(populatedStore(), testAssets(), WithController(backend))
	request := httptest.NewRequest(http.MethodGet, "/api/v1/controls", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var status model.ControlStatus
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.Enabled || status.CSRFToken == "" || status.Mode != "typed-control" {
		t.Fatalf("unexpected controls status: %+v", status)
	}

	body := `{"expected_instance_id":"0123456789abcdeffedcba9876543210","expected_generation":9,"updates":[{"source":"42:00:00:00:01:00","destination":"42:00:00:00:02:00","snr_db":45}]}`
	request = httptest.NewRequest(http.MethodPost, "/api/v1/controls/pairs/set", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("missing CSRF = %d: %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/api/v1/controls/pairs/set", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Wmediumd-CSRF", status.CSRFToken)
	request.Header.Set("Origin", "http://example.com")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || backend.pairCalls != 1 || !strings.Contains(response.Body.String(), `"generation":10`) {
		t.Fatalf("typed pair control = %d calls=%d: %s", response.Code, backend.pairCalls, response.Body.String())
	}
	controlCases := []struct {
		path, body string
		calls      *int
	}{
		{"/api/v1/controls/frequencies/set", `{"expected_instance_id":"0123456789abcdeffedcba9876543210","expected_generation":10,"updates":[{"source":"42:00:00:00:01:00","destination":"42:00:00:00:02:00","frequency_mhz":5180,"snr_db":35}]}`, &backend.frequencyCalls},
		{"/api/v1/controls/frequencies/clear", `{"expected_instance_id":"0123456789abcdeffedcba9876543210","expected_generation":11,"targets":[{"source":"42:00:00:00:01:00","destination":"42:00:00:00:02:00","frequency_mhz":5180}]}`, &backend.clearCalls},
		{"/api/v1/controls/undo", `{"expected_instance_id":"0123456789abcdeffedcba9876543210","expected_generation":12}`, &backend.undoCalls},
	}
	for _, test := range controlCases {
		request = httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Wmediumd-CSRF", status.CSRFToken)
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK || *test.calls != 1 {
			t.Fatalf("POST %s = %d calls=%d: %s", test.path, response.Code, *test.calls, response.Body.String())
		}
	}

	request = httptest.NewRequest(http.MethodPost, "/api/v1/controls/frequencies/clear", strings.NewReader(`{"expected_instance_id":"0123456789abcdeffedcba9876543210","expected_generation":10,"targets":[{"source":"42:00:00:00:01:00","destination":"42:00:00:00:02:00","frequency_mhz":5180}],"arbitrary_opcode":99}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Wmediumd-CSRF", status.CSRFToken)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || backend.clearCalls != 1 {
		t.Fatalf("unknown control field accepted: %d %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/api/v1/proxy", strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Wmediumd-CSRF", status.CSRFToken)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("generic path = %d", response.Code)
	}
}

func TestPhase2RESTEndpointsAndMetrics(t *testing.T) {
	store := populatedStore()
	view := store.View()
	snapshot := *view.Snapshot
	summary := model.TelemetrySummary{FramesSeen: 100, BytesSeen: 2048, TXAttempts: 80, Retries: 4, RXInjected: 70, DropsPER: 2, QueueDepth: 1}
	snapshot.PacketMetrics = model.PacketMetrics{Available: true, Summary: &summary}
	snapshot.ActiveLinks = []model.ActiveLink{{Source: snapshot.Stations[0].MAC, Destination: snapshot.Stations[1].MAC, FrequencyMHz: 5180}}
	snapshot.VIFs = []model.VIF{{MAC: "02:00:00:00:00:01", Radio: snapshot.Stations[0].MAC, FrequencyMHz: 5180}}
	snapshot.Events = []model.TelemetryEvent{{Sequence: 1, Type: "link_active"}}
	snapshot.Health = model.Health{State: "ok", LatestEventSequence: 1}
	store.Update(snapshot)
	handler := New(store, testAssets())
	for _, path := range []string{"/api/v1/telemetry", "/api/v1/radio-frequencies", "/api/v1/active-links", "/api/v1/vifs", "/api/v1/events", "/api/v1/health", "/api/v1/identities"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Errorf("GET %s = %d: %s", path, response.Code, response.Body.String())
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	for _, want := range []string{"wmediumd_console_packet_metrics_available 1", "wmediumd_console_frames_total 100", "wmediumd_console_active_links 1", "wmediumd_console_queue_depth 1"} {
		if !strings.Contains(response.Body.String(), want) {
			t.Errorf("metrics missing %q", want)
		}
	}
}

func TestWebSocketLargeFrameAndShortWrites(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), 70_000)
	writer := &shortWriter{maximum: 17}
	if err := writeWebSocketText(writer, payload); err != nil {
		t.Fatal(err)
	}
	frame := writer.Bytes()
	if len(frame) != 10+len(payload) || frame[0] != 0x81 || frame[1] != 127 {
		t.Fatalf("unexpected large frame header/length: %x length=%d", frame[:2], len(frame))
	}
	if got := binary.BigEndian.Uint64(frame[2:10]); got != uint64(len(payload)) {
		t.Fatalf("encoded length = %d, want %d", got, len(payload))
	}
	if !bytes.Equal(frame[10:], payload) {
		t.Fatal("large WebSocket payload changed")
	}
}

func populatedStore() *state.Store {
	store := state.New()
	snapshot := model.NewSnapshot()
	snapshot.CapturedAt = time.Unix(100, 0).UTC()
	snapshot.Daemon = model.Daemon{
		InstanceID: "0123456789abcdeffedcba9876543210", Generation: 9,
		Capabilities: []string{"radio_pair_snr", "readback", "dump_links", "frequency_qualified_snr", "read_only"},
		NumStations:  2,
	}
	snapshot.PairLinks = []model.Link{
		{Source: "42:00:00:00:01:00", Destination: "42:00:00:00:02:00", SNRDB: 40},
		{Source: "42:00:00:00:02:00", Destination: "42:00:00:00:01:00", SNRDB: 39},
	}
	snapshot.Stations = model.StationsFromLinks(snapshot.PairLinks)
	snapshot.FrequencyOverrides = []model.FrequencyLink{
		{Source: snapshot.Stations[0].MAC, Destination: snapshot.Stations[1].MAC, FrequencyMHz: 5180, Band: "5GHz", Channel: 36, SNRDB: 24, Override: true},
	}
	store.Update(snapshot)
	return store
}

func testAssets() fs.FS {
	return fstest.MapFS{
		"index.html":      &fstest.MapFile{Data: []byte("<!doctype html><title>wmediumd Console</title>")},
		"app.js":          &fstest.MapFile{Data: []byte("'use strict';")},
		"graph-layout.js": &fstest.MapFile{Data: []byte("function layoutStations() {}")},
		"style.css":       &fstest.MapFile{Data: []byte("body{}")},
	}
}

func readServerTextFrame(reader *bufio.Reader) ([]byte, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(reader, header); err != nil {
		return nil, err
	}
	if header[0] != 0x81 || header[1]&0x80 != 0 {
		return nil, io.ErrUnexpectedEOF
	}
	length := uint64(header[1] & 0x7f)
	switch length {
	case 126:
		extended := make([]byte, 2)
		if _, err := io.ReadFull(reader, extended); err != nil {
			return nil, err
		}
		length = uint64(binary.BigEndian.Uint16(extended))
	case 127:
		extended := make([]byte, 8)
		if _, err := io.ReadFull(reader, extended); err != nil {
			return nil, err
		}
		length = binary.BigEndian.Uint64(extended)
	}
	payload := make([]byte, length)
	_, err := io.ReadFull(reader, payload)
	return payload, err
}

type shortWriter struct {
	bytes.Buffer
	maximum int
}

type fakeControlBackend struct{ pairCalls, frequencyCalls, clearCalls, undoCalls int }

func (f *fakeControlBackend) Status() model.UndoStatus {
	return model.UndoStatus{Available: f.pairCalls+f.frequencyCalls+f.clearCalls > 0, Generation: 10}
}
func (f *fakeControlBackend) SetPairs(_ context.Context, request model.PairControlRequest) (model.ControlResult, error) {
	f.pairCalls++
	return model.ControlResult{Operation: "pair_set", InstanceID: request.ExpectedInstanceID, Generation: request.ExpectedGeneration + 1, Updates: len(request.Updates), UndoAvailable: true}, nil
}
func (f *fakeControlBackend) SetFrequencies(_ context.Context, request model.FrequencyControlRequest) (model.ControlResult, error) {
	f.frequencyCalls++
	return model.ControlResult{Operation: "frequency_set", Generation: request.ExpectedGeneration + 1}, nil
}
func (f *fakeControlBackend) ClearFrequencies(_ context.Context, request model.FrequencyClearRequest) (model.ControlResult, error) {
	f.clearCalls++
	return model.ControlResult{Operation: "frequency_clear", Generation: request.ExpectedGeneration + 1}, nil
}
func (f *fakeControlBackend) Undo(_ context.Context, request model.ControlRequest) (model.ControlResult, error) {
	f.undoCalls++
	return model.ControlResult{Operation: "undo", Generation: request.ExpectedGeneration + 1}, nil
}

func (w *shortWriter) Write(payload []byte) (int, error) {
	if len(payload) > w.maximum {
		payload = payload[:w.maximum]
	}
	return w.Buffer.Write(payload)
}
