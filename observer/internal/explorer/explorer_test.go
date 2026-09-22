package explorer

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/model"
)

func TestIntegerPrecision(tester *testing.T) {
	encoded := safeJSON(map[string]any{"counter": uint64(18446744073709551615), "frequency": 5180, "rate": 1.25, "present": false})
	var result map[string]any
	if err := json.Unmarshal(encoded, &result); err != nil {
		tester.Fatal(err)
	}
	if result["counter"] != "18446744073709551615" || result["frequency"] != "5180" || result["rate"] != 1.25 || result["present"] != false {
		tester.Fatalf("precision/typing lost: %s", encoded)
	}
}

func TestRFCatalogDoesNotStartCollection(tester *testing.T) {
	runtime, _ := New(Config{}, nil)
	catalog := `{"schema":"easymesh.rf-properties.v1"}`
	handler := NewHandler(runtime, fstest.MapFS{"ng/rf-catalog.json": &fstest.MapFile{Data: []byte(catalog)}}, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/v2/rf-catalog", nil))
	if response.Code != 200 || response.Body.String() != catalog || len(runtime.interests) != 0 {
		tester.Fatal("catalog must be available without live collection or viewer interest")
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "/api/v2/rf-catalog", nil))
	if response.Code != 405 {
		tester.Fatal("catalog must remain read-only")
	}
}

func TestRetiredUIAndReadiness(tester *testing.T) {
	runtime, _ := New(Config{}, nil)
	runtime.view = &View{LastSuccess: time.Now(), Snapshot: model.Snapshot{
		Daemon:            model.Daemon{Capabilities: []string{"explorer_details"}},
		IdentityInventory: model.IdentityInventory{Matched: 105},
		PacketMetrics:     model.PacketMetrics{Available: true},
	}}
	handler := NewHandler(runtime, fstest.MapFS{"ng/index.html": &fstest.MapFile{Data: []byte("console ng")}},
		http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) { writer.WriteHeader(200) }))
	for _, path := range []string{"/classic", "/classic/"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != 308 || response.Header().Get("Location") != "/" || len(runtime.interests) != 0 {
			tester.Fatal("retired UI must redirect without starting eager collection")
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/app.js", nil))
	if response.Code != 404 {
		tester.Fatal("retired UI assets are still served")
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/v1/status", nil))
	if response.Code != 200 || response.Header().Get("Deprecation") == "" || len(runtime.interests) != 0 {
		tester.Fatal("compatibility health request must not start a matrix scan")
	}
	for _, ready := range []bool{true, false} {
		runtime.view.Snapshot.PacketMetrics.Available = ready
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/v2/health", nil))
		if (response.Code == 200) != ready {
			tester.Fatal("NG readiness did not follow live telemetry availability")
		}
	}
	runtime.view.Snapshot.PacketMetrics.Available = true
	runtime.view.Snapshot.Daemon.Capabilities = nil
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/v2/health", nil))
	if response.Code != 503 {
		tester.Fatal("old daemon incorrectly passed NG readiness")
	}
}

func TestSubscriptionsValidateAndExpire(tester *testing.T) {
	runtime, err := New(Config{}, nil)
	if err != nil {
		tester.Fatal(err)
	}
	for _, interest := range []Interest{{Topics: []string{"shell"}}, {Topics: []string{"paths"}, Source: "not-a-radio"}, {Topics: []string{"pairs"}, Frequency: 999}} {
		if runtime.Interest("invalid", interest) == nil {
			tester.Fatalf("accepted invalid interest: %+v", interest)
		}
	}
	if err := runtime.Interest("one", Interest{Topics: []string{"paths"}, Source: "02:00:00:00:00:01", Destination: "02:00:00:00:00:02", Frequency: 5180}); err != nil {
		tester.Fatal(err)
	}
	if err := runtime.Interest("two", runtime.interests["one"]); err != nil {
		tester.Fatal(err)
	}
	topics, selected, count := runtime.demand()
	if !topics["paths"] || len(selected) != 1 || count != 2 {
		tester.Fatalf("interests not merged: %v %v %d", topics, selected, count)
	}
	expired := runtime.interests["one"]
	expired.Expires = time.Now().Add(-time.Second)
	runtime.interests["one"] = expired
	runtime.RemoveInterest("two")
	topics, selected, count = runtime.demand()
	if len(topics) != 0 || len(selected) != 0 || count != 0 {
		tester.Fatal("expired interest retained")
	}
}

func TestReadOnlyRoutesAndCoherentExport(tester *testing.T) {
	runtime, _ := New(Config{}, nil)
	snapshot := model.NewSnapshot()
	snapshot.Daemon = model.Daemon{InstanceID: "one", Generation: 7, Capabilities: []string{"frequency_qualified_snr"}}
	runtime.view = &View{Snapshot: snapshot, LastSuccess: time.Now(), Coverage: map[string]Coverage{"pairs": {State: "complete", Generation: 7}, "frequencies": {State: "collecting", Generation: 7}}}
	handler := NewHandler(runtime, fstest.MapFS{"ng/index.html": &fstest.MapFile{Data: []byte("console ng")}}, http.NotFoundHandler())
	for _, path := range []string{"/api/v2/pair", "/api/v1/controls/pairs/set", "/anything"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("POST", path, strings.NewReader("{}")))
		if response.Code != 405 {
			tester.Fatalf("mutation accepted: %s", path)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/v2/export", nil))
	if response.Code != 409 {
		tester.Fatalf("incomplete export accepted: %d", response.Code)
	}
	runtime.view.Coverage["frequencies"] = Coverage{State: "complete", Generation: 7}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/v2/export", nil))
	if response.Code != 200 {
		tester.Fatalf("coherent export rejected: %s", response.Body.String())
	}
	runtime.view.Snapshot.Daemon.Generation++
	if coherent(runtime.view) {
		tester.Fatal("old generation considered coherent")
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/v2/pair?source=bad&destination=bad", nil))
	if response.Code != 400 {
		tester.Fatal("invalid selected identities accepted")
	}
}

func TestProgressivePathDeliveryIsBounded(tester *testing.T) {
	delivery := newPathDelivery()
	rows := make([]model.ActiveLink, 700)
	for index := range rows {
		rows[index] = model.ActiveLink{Source: fmt.Sprint(index), Destination: "peer", SampledAt: time.Now()}
	}
	first, _ := delivery.next(rows)
	second, _ := delivery.next(rows)
	third, _ := delivery.next(rows)
	if len(first) != 512 || len(second) != 188 || len(third) != 0 {
		tester.Fatalf("unbounded or repeated path delivery: %d %d %d", len(first), len(second), len(third))
	}
	rows[0].SampledAt = rows[0].SampledAt.Add(time.Second)
	updated, removed := delivery.next(rows[:699])
	if len(updated) != 1 || len(removed) != 1 || updated[0].Source != "0" {
		tester.Fatal("fresh samples or evictions were lost")
	}
}

func TestPaginationPinsSortedSnapshot(tester *testing.T) {
	runtime, _ := New(Config{}, nil)
	runtime.view = &View{Snapshot: model.Snapshot{ActiveLinks: []model.ActiveLink{{Source: "first", Destination: "peer", Frames: 9007199254740993}, {Source: "second", Destination: "peer", Frames: 9007199254740992}}}, Coverage: map[string]Coverage{"paths": {State: "complete"}}}
	handler := NewHandler(runtime, fstest.MapFS{}, http.NotFoundHandler())
	requestPage := func(path string) map[string]any {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != 200 {
			tester.Fatalf("page rejected: %s", response.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			tester.Fatal(err)
		}
		return result
	}
	first := requestPage("/api/v2/paths?sort=frames&limit=1")
	if first["rows"].([]any)[0].(map[string]any)["source"] != "second" {
		tester.Fatal("large integer sort lost precision")
	}
	runtime.view.Snapshot.ActiveLinks = nil
	second := requestPage("/api/v2/paths?sort=frames&limit=1&cursor=1&token=" + first["token"].(string))
	if second["rows"].([]any)[0].(map[string]any)["source"] != "first" {
		tester.Fatal("page changed between requests")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/v2/paths?sort=source&token="+first["token"].(string), nil))
	if response.Code != 409 {
		tester.Fatal("snapshot reused across incompatible filters")
	}
}

func maskedFrame(payload []byte, opcode byte) []byte {
	frame := []byte{opcode}
	if len(payload) < 126 {
		frame = append(frame, byte(len(payload))|0x80)
	} else {
		frame = append(frame, 0xfe, byte(len(payload)>>8), byte(len(payload)))
	}
	mask := []byte{1, 2, 3, 4}
	frame = append(frame, mask...)
	for index, value := range payload {
		frame = append(frame, value^mask[index%4])
	}
	return frame
}

func TestSubscriptionFramesBoundedAndMasked(tester *testing.T) {
	for _, length := range []int{2, 125, 126, 127, 4096} {
		payload := bytes.Repeat([]byte("x"), length)
		decoded, err := readFrame(bufio.NewReader(bytes.NewReader(maskedFrame(payload, 0x81))))
		if err != nil || !bytes.Equal(decoded, payload) {
			tester.Fatalf("valid masked length %d rejected: %v", length, err)
		}
	}
	for _, frame := range [][]byte{{0x81, 2, 'o', 'k'}, maskedFrame(bytes.Repeat([]byte("x"), 4097), 0x81), {0x01, 0x80, 0, 0, 0, 0}, {0x81, 0xff}} {
		if _, err := readFrame(bufio.NewReader(bytes.NewReader(frame))); err == nil {
			tester.Fatal("invalid websocket frame accepted")
		}
	}
	_, err := readFrame(bufio.NewReader(bytes.NewReader(maskedFrame([]byte("heartbeat"), 0x89))))
	if ping, ok := err.(*pingFrame); !ok || string(ping.payload) != "heartbeat" {
		tester.Fatal("ping payload lost")
	}
}

func TestCrossOriginSubscriptionRefused(tester *testing.T) {
	runtime, _ := New(Config{}, nil)
	handler := NewHandler(runtime, fstest.MapFS{}, http.NotFoundHandler())
	request := httptest.NewRequest("GET", "http://lab/api/v2/stream", nil)
	request.Header.Set("Origin", "http://untrusted")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 403 {
		tester.Fatalf("cross-origin request: %d", response.Code)
	}
}
