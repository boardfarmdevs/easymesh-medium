package explorer

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/model"
)

type Handler struct {
	runtime  *Runtime
	fallback http.Handler
	assets   http.Handler
	mu       sync.Mutex
	exports  map[string]pageCache
	streams  int
	wire     map[string]wireCache
}

type wireCache struct {
	source  any
	pointer uintptr
	length  int
	encoded []byte
}

type pageCache struct {
	rows     []map[string]any
	created  time.Time
	topic    string
	filter   string
	coverage Coverage
}

func NewHandler(runtime *Runtime, assets fs.FS, fallback http.Handler) http.Handler {
	return &Handler{runtime: runtime, fallback: fallback, assets: http.FileServer(http.FS(assets)), exports: map[string]pageCache{}, wire: map[string]wireCache{}}
}

func (handler *Handler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Referrer-Policy", "same-origin")
	writer.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.Header().Set("Allow", "GET, HEAD")
		respond(writer, http.StatusMethodNotAllowed, map[string]any{"error": "Console NG is read-only"})
		return
	}
	if request.URL.Path == "/classic" || request.URL.Path == "/classic/" {
		writer.Header().Set("Deprecation", "true")
		http.Redirect(writer, request, "/", http.StatusPermanentRedirect)
		return
	}
	if request.URL.Path == "/" {
		copyRequest := request.Clone(request.Context())
		copyRequest.URL.Path = "/ng/"
		handler.assets.ServeHTTP(writer, copyRequest)
		return
	}
	if strings.HasPrefix(request.URL.Path, "/ng/") {
		handler.assets.ServeHTTP(writer, request)
		return
	}
	if request.URL.Path == "/api/v2/rf-catalog" {
		copyRequest := request.Clone(request.Context())
		copyRequest.URL.Path = "/ng/rf-catalog.json"
		handler.assets.ServeHTTP(writer, copyRequest)
		return
	}
	if !strings.HasPrefix(request.URL.Path, "/api/v2/") {
		if !strings.HasPrefix(request.URL.Path, "/api/v1/") && request.URL.Path != "/metrics" {
			http.NotFound(writer, request)
			return
		}
		if strings.HasPrefix(request.URL.Path, "/api/v1/") {
			writer.Header().Set("Deprecation", "true")
			writer.Header().Set("Link", "</api/v2/overview>; rel=\"successor-version\"")
			if request.URL.Path != "/api/v1/status" && request.URL.Path != "/api/v1/health" {
				_ = handler.runtime.Interest("compatibility", Interest{Topics: []string{"pairs", "frequencies", "paths", "radios", "vifs", "events", "ownership"}})
			}
		}
		if request.URL.Path == "/api/v1/stream" {
			done := make(chan struct{})
			defer close(done)
			go func() {
				ticker := time.NewTicker(5 * time.Second)
				defer ticker.Stop()
				for {
					select {
					case <-done:
						return
					case <-ticker.C:
						_ = handler.runtime.Interest("classic", Interest{Topics: []string{"pairs", "frequencies", "paths", "radios", "vifs", "events", "ownership"}})
					}
				}
			}()
		}
		handler.fallback.ServeHTTP(writer, request)
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	if request.URL.Path == "/api/v2/stream" {
		handler.stream(writer, request)
		return
	}
	view := handler.runtime.View()
	if view == nil {
		respond(writer, http.StatusServiceUnavailable, map[string]any{"state": "warming_up", "error": "Waiting for the first observer sample"})
		return
	}
	topic := strings.TrimPrefix(request.URL.Path, "/api/v2/")
	switch topic {
	case "health":
		ready := view.Error == "" && time.Since(view.LastSuccess) < 10*time.Second &&
			view.Snapshot.PacketMetrics.Available && view.Snapshot.IdentityInventory.Matched > 0 &&
			has(view.Snapshot.Daemon.Capabilities, "explorer_details")
		status := http.StatusOK
		if !ready {
			status = http.StatusServiceUnavailable
		}
		respond(writer, status, map[string]any{"schema": view.Schema, "ready": ready, "read_only": true,
			"telemetry_extension": has(view.Snapshot.Daemon.Capabilities, "explorer_details"),
			"last_success":        view.LastSuccess, "error": view.Error, "identity_inventory": view.Snapshot.IdentityInventory})
	case "overview", "services":
		interest := Interest{Topics: []string{"services", "room", "survey"}}
		_ = handler.runtime.Interest("rest-"+topic, interest)
		respond(writer, 200, envelope(view, interest))
	case "radios", "paths", "pairs", "events":
		handler.page(writer, request, view, topic)
	case "pair":
		rawFrequency := request.URL.Query().Get("frequency_mhz")
		if rawFrequency == "" {
			rawFrequency = "0"
		}
		frequency, frequencyErr := strconv.ParseUint(rawFrequency, 10, 32)
		if frequencyErr != nil {
			respond(writer, 400, map[string]any{"error": "invalid frequency_mhz"})
			return
		}
		interest := Interest{Topics: []string{"detail"}, Source: request.URL.Query().Get("source"), Destination: request.URL.Query().Get("destination"), Frequency: uint32(frequency)}
		if net.ParseIP(interest.Source) != nil || interest.Source == "" || interest.Destination == "" {
			respond(writer, 400, map[string]any{"error": "source and destination radio MACs are required"})
			return
		}
		for _, address := range []string{interest.Source, interest.Destination} {
			if parsed, err := net.ParseMAC(address); err != nil || len(parsed) != 6 {
				respond(writer, 400, map[string]any{"error": "invalid radio MAC"})
				return
			}
		}
		if err := handler.runtime.Interest("rest-pair", interest); err != nil {
			respond(writer, 400, map[string]any{"error": err.Error()})
			return
		}
		respond(writer, 200, envelope(view, interest))
	case "export":
		if !coherent(view) {
			respond(writer, 409, map[string]any{"error": "Complete current-generation RF collection is required; open Configured RF and wait for coverage to complete", "coverage": view.Coverage})
			return
		}
		writer.Header().Set("Content-Disposition", "attachment; filename=wmediumd-console-ng.json")
		respond(writer, 200, view)
	default:
		respond(writer, 404, map[string]any{"error": "unknown Console NG route"})
	}
}

func coherent(view *View) bool {
	for _, topic := range []string{"pairs", "frequencies"} {
		coverage := view.Coverage[topic]
		if topic == "frequencies" && !has(view.Snapshot.Daemon.Capabilities, "frequency_qualified_snr") {
			continue
		}
		if coverage.State != "complete" || coverage.Generation != view.Snapshot.Daemon.Generation {
			return false
		}
	}
	return time.Since(view.LastSuccess) < 5*time.Second && view.Error == ""
}

func envelope(view *View, interest Interest) map[string]any {
	snapshot := view.Snapshot
	result := map[string]any{"schema": view.Schema, "sequence": snapshot.Sequence, "captured_at": snapshot.CapturedAt, "last_success": view.LastSuccess, "error": view.Error, "daemon": snapshot.Daemon, "summary": snapshot.PacketMetrics, "health": snapshot.Health, "coverage": view.Coverage, "collector": view.Collector, "identity_inventory": snapshot.IdentityInventory, "radios": snapshot.Stations}
	for _, topic := range interest.Topics {
		switch topic {
		case "paths":
			result["paths"] = snapshot.ActiveLinks
		case "radios":
			result["radio_frequencies"] = snapshot.RadioFrequencies
		case "vifs":
			result["vifs"] = snapshot.VIFs
		case "pairs":
			result["pairs"] = snapshot.PairLinks
			result["frequencies"] = snapshot.FrequencyOverrides
		case "frequencies":
			result["frequencies"] = snapshot.FrequencyOverrides
		case "events":
			result["events"] = snapshot.Events
		case "ownership":
			result["ownership"] = view.Associations
		case "room":
			result["room"] = view.Room
		case "survey":
			result["survey"] = view.Survey
		case "services":
			result["service"] = view.Service
			result["artifacts"] = snapshot.Artifacts
		}
	}
	if interest.Source != "" && interest.Destination != "" {
		selected := map[string]Rule{}
		details := map[string]Report{}
		for _, direction := range [][2]string{{interest.Source, interest.Destination}, {interest.Destination, interest.Source}} {
			for _, frequency := range []uint32{0, interest.Frequency} {
				key := Key(direction[0], direction[1], frequency)
				if value, ok := view.Selected[key]; ok {
					selected[key] = value
				}
				if value, ok := view.Details[key]; ok {
					details[key] = value
				}
			}
		}
		result["selected"], result["details"] = selected, details
	}
	return result
}

func (handler *Handler) page(writer http.ResponseWriter, request *http.Request, view *View, topic string) {
	query := request.URL.Query()
	limit := 128
	if raw := query.Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 512 {
			respond(writer, 400, map[string]any{"error": "limit must be 1..512"})
			return
		}
		limit = value
	}
	offset := 0
	if raw := query.Get("cursor"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 0 {
			respond(writer, 400, map[string]any{"error": "invalid cursor"})
			return
		}
		offset = value
	}
	_ = handler.runtime.Interest("rest-"+topic, Interest{Topics: []string{topic}})
	filter := request.URL.Query()
	filter.Del("cursor")
	filter.Del("token")
	filter.Del("limit")
	token := query.Get("token")
	handler.mu.Lock()
	defer handler.mu.Unlock()
	for key, entry := range handler.exports {
		if time.Since(entry.created) > 30*time.Second {
			delete(handler.exports, key)
		}
	}
	entry, exists := handler.exports[token]
	if token != "" && (!exists || entry.topic != topic || entry.filter != filter.Encode()) {
		respond(writer, 409, map[string]any{"error": "snapshot token expired or filters changed; restart from the first page"})
		return
	}
	if token == "" {
		if offset != 0 {
			respond(writer, 400, map[string]any{"error": "a cursor requires a snapshot token"})
			return
		}
		if len(handler.exports) >= 8 {
			var oldest string
			var when time.Time
			for key, item := range handler.exports {
				if when.IsZero() || item.created.Before(when) {
					oldest, when = key, item.created
				}
			}
			delete(handler.exports, oldest)
		}
		rows := collection(view, topic)
		rows = filterRows(rows, view, query)
		sortKey := query.Get("sort")
		if sortKey == "" {
			sortKey = "source"
		}
		sort.SliceStable(rows, func(left, right int) bool {
			comparison := compare(rows[left][sortKey], rows[right][sortKey])
			if comparison == 0 {
				comparison = strings.Compare(fmt.Sprint(rows[left]["key"]), fmt.Sprint(rows[right]["key"]))
			}
			if query.Get("direction") == "desc" {
				return comparison > 0
			}
			return comparison < 0
		})
		token = randomID()
		entry = pageCache{rows: rows, topic: topic, created: time.Now(), filter: filter.Encode(), coverage: view.Coverage[topic]}
		handler.exports[token] = entry
	}
	if offset > len(entry.rows) {
		respond(writer, 400, map[string]any{"error": "cursor exceeds collection"})
		return
	}
	end := offset + limit
	if end > len(entry.rows) {
		end = len(entry.rows)
	}
	var next any
	if end < len(entry.rows) {
		next = end
	}
	respond(writer, 200, map[string]any{"rows": entry.rows[offset:end], "total": len(entry.rows), "token": token, "next_cursor": next, "coverage": entry.coverage, "captured_at": entry.created})
}

func collection(view *View, topic string) []map[string]any {
	var values any
	switch topic {
	case "paths":
		values = view.Snapshot.ActiveLinks
	case "pairs":
		values = view.Snapshot.PairLinks
	case "events":
		values = view.Snapshot.Events
	case "radios":
		values = view.Snapshot.Stations
	}
	encoded, _ := json.Marshal(values)
	decoder := json.NewDecoder(strings.NewReader(string(encoded)))
	decoder.UseNumber()
	rows := []map[string]any{}
	_ = decoder.Decode(&rows)
	for _, row := range rows {
		row["key"] = fmt.Sprint(row["source"], ">", row["destination"], "@", row["frequency_mhz"], row["mac"], row["sequence"])
	}
	return rows
}

func filterRows(rows []map[string]any, view *View, query url.Values) []map[string]any {
	labels := map[string]string{}
	for _, station := range view.Snapshot.Stations {
		labels[station.MAC] = station.Label
	}
	result := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		matches := true
		for _, field := range []string{"source", "destination", "frequency_mhz", "band"} {
			if value := query.Get(field); value != "" && fmt.Sprint(row[field]) != value {
				matches = false
			}
		}
		needle := strings.ToLower(query.Get("q"))
		text := strings.ToLower(fmt.Sprint(row) + labels[fmt.Sprint(row["source"])] + labels[fmt.Sprint(row["destination"])])
		if needle != "" && !strings.Contains(text, needle) {
			matches = false
		}
		if matches {
			result = append(result, row)
		}
	}
	return result
}

func compare(left, right any) int {
	if left == nil && right == nil {
		return 0
	}
	if left == nil {
		return 1
	}
	if right == nil {
		return -1
	}
	first, firstOK := new(big.Rat).SetString(fmt.Sprint(left))
	second, secondOK := new(big.Rat).SetString(fmt.Sprint(right))
	if firstOK && secondOK {
		return first.Cmp(second)
	}
	return strings.Compare(strings.ToLower(fmt.Sprint(left)), strings.ToLower(fmt.Sprint(right)))
}

func safeJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte(`{"error":"JSON encoding failed"}`)
	}
	decoder := json.NewDecoder(strings.NewReader(string(encoded)))
	decoder.UseNumber()
	var document any
	if decoder.Decode(&document) != nil {
		return encoded
	}
	var convert func(any) any
	convert = func(item any) any {
		switch typed := item.(type) {
		case json.Number:
			if !strings.ContainsAny(string(typed), ".eE") {
				return string(typed)
			}
			return typed
		case map[string]any:
			for key, value := range typed {
				typed[key] = convert(value)
			}
		case []any:
			for index, value := range typed {
				typed[index] = convert(value)
			}
		}
		return item
	}
	encoded, _ = json.Marshal(convert(document))
	return encoded
}

func respond(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write(safeJSON(value))
}
func randomID() string {
	var value [16]byte
	_, _ = rand.Read(value[:])
	return hex.EncodeToString(value[:])
}

func (handler *Handler) stream(writer http.ResponseWriter, request *http.Request) {
	handler.mu.Lock()
	if handler.streams >= 16 {
		handler.mu.Unlock()
		http.Error(writer, "observer connection capacity reached", 503)
		return
	}
	handler.streams++
	handler.mu.Unlock()
	defer func() { handler.mu.Lock(); handler.streams--; handler.mu.Unlock() }()
	if origin := request.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || !strings.EqualFold(parsed.Host, request.Host) {
			http.Error(writer, "cross-origin observer subscription refused", 403)
			return
		}
	}
	key, err := base64.StdEncoding.DecodeString(request.Header.Get("Sec-WebSocket-Key"))
	connectionUpgrade := false
	for _, token := range strings.Split(request.Header.Get("Connection"), ",") {
		if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
			connectionUpgrade = true
		}
	}
	if err != nil || len(key) != 16 || !connectionUpgrade || request.Header.Get("Sec-WebSocket-Version") != "13" || !strings.EqualFold(request.Header.Get("Upgrade"), "websocket") {
		http.Error(writer, "WebSocket upgrade required", 400)
		return
	}
	hijacker, ok := writer.(http.Hijacker)
	if !ok {
		http.Error(writer, "WebSocket unavailable", 500)
		return
	}
	connection, buffer, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer connection.Close()
	digest := sha1.Sum([]byte(request.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	_, err = fmt.Fprintf(buffer, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(digest[:]))
	if err != nil {
		return
	}
	if buffer.Flush() != nil {
		return
	}
	id := randomID()
	defer handler.runtime.RemoveInterest(id)
	type subscription struct {
		Type string `json:"type"`
		Interest
		Ping []byte `json:"-"`
	}
	updates := make(chan subscription, 1)
	done := make(chan struct{})
	defer close(done)
	go func() {
		defer close(updates)
		for {
			_ = connection.SetReadDeadline(time.Now().Add(16 * time.Second))
			payload, readErr := readFrame(buffer.Reader)
			if ping, ok := readErr.(*pingFrame); ok {
				select {
				case updates <- subscription{Type: "ping", Ping: ping.payload}:
				case <-done:
					return
				}
				continue
			}
			if readErr != nil {
				return
			}
			var message subscription
			if json.Unmarshal(payload, &message) != nil {
				return
			}
			if message.Type == "unsubscribe" {
				message.Topics = nil
			}
			if message.Type != "subscribe" && message.Type != "unsubscribe" && message.Type != "resync" {
				return
			}
			if err := handler.runtime.Interest(id, message.Interest); err != nil {
				return
			}
			select {
			case updates <- message:
			case <-done:
				return
			}
		}
	}()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	interest := Interest{}
	previous := map[string]string{}
	baseline := uint64(0)
	pathDelivery := newPathDelivery()
	pathInstance := ""
	for {
		select {
		case update, open := <-updates:
			if !open {
				return
			}
			if update.Type == "ping" {
				_ = connection.SetWriteDeadline(time.Now().Add(2 * time.Second))
				if writeOpcode(connection, update.Ping, 0x8a) != nil {
					return
				}
				continue
			}
			if !reflect.DeepEqual(interest, update.Interest) || update.Type == "resync" {
				previous = map[string]string{}
				baseline = 0
			}
			if update.Type == "resync" {
				pathInstance = ""
			}
			interest = update.Interest
		case <-ticker.C:
		}
		if len(interest.Topics) == 0 {
			continue
		}
		view := handler.runtime.View()
		if view == nil {
			continue
		}
		document := envelope(view, interest)
		if has(interest.Topics, "paths") {
			reset := pathInstance != view.Snapshot.Daemon.InstanceID
			if reset {
				pathDelivery = newPathDelivery()
				pathInstance = view.Snapshot.Daemon.InstanceID
			}
			updated, removed := pathDelivery.next(view.Snapshot.ActiveLinks)
			delete(document, "paths")
			document["paths_reset"] = reset
			document["path_updates"], document["path_removed"] = updated, removed
			document["paths_delivered"] = len(pathDelivery.sent)
			document["paths_cached"] = len(view.Snapshot.ActiveLinks)
		}
		changed := map[string]json.RawMessage{}
		for topic, value := range document {
			encoded := handler.encodeTopic(topic, value)
			if topic == "path_updates" || topic == "path_removed" || topic == "paths_reset" || previous[topic] != string(encoded) {
				changed[topic] = encoded
				previous[topic] = string(encoded)
			}
		}
		if len(changed) == 0 {
			continue
		}
		kind := "delta"
		if baseline == 0 {
			kind = "snapshot"
		}
		payload, _ := json.Marshal(map[string]any{"type": kind, "sequence": strconv.FormatUint(view.Snapshot.Sequence, 10), "baseline": strconv.FormatUint(baseline, 10), "data": changed})
		_ = connection.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if writeFrame(connection, payload) != nil {
			return
		}
		baseline = view.Snapshot.Sequence
	}
}

type pathDelivery struct {
	sent   map[string]time.Time
	cursor int
}

func newPathDelivery() *pathDelivery {
	return &pathDelivery{sent: map[string]time.Time{}}
}

func (delivery *pathDelivery) next(rows []model.ActiveLink) ([]model.ActiveLink, []string) {
	updated := make([]model.ActiveLink, 0, 512)
	removed := []string{}
	present := make(map[string]bool, len(rows))
	for _, row := range rows {
		present[Key(row.Source, row.Destination, row.FrequencyMHz)] = true
	}
	for key := range delivery.sent {
		if !present[key] && len(removed) < 512 {
			removed = append(removed, key)
			delete(delivery.sent, key)
		}
	}
	for visited := 0; visited < len(rows) && len(updated) < 512; visited++ {
		row := rows[delivery.cursor%len(rows)]
		delivery.cursor = (delivery.cursor + 1) % len(rows)
		key := Key(row.Source, row.Destination, row.FrequencyMHz)
		if stamp, exists := delivery.sent[key]; !exists || !stamp.Equal(row.SampledAt) {
			updated = append(updated, row)
			delivery.sent[key] = row.SampledAt
		}
	}
	return updated, removed
}

func (handler *Handler) encodeTopic(topic string, value any) []byte {
	reflected := reflect.ValueOf(value)
	if !reflected.IsValid() || reflected.Kind() != reflect.Slice {
		return safeJSON(value)
	}
	handler.mu.Lock()
	defer handler.mu.Unlock()
	entry, exists := handler.wire[topic]
	if exists && entry.pointer == reflected.Pointer() && entry.length == reflected.Len() && reflect.TypeOf(entry.source) == reflected.Type() {
		return entry.encoded
	}
	encoded := safeJSON(value)
	handler.wire[topic] = wireCache{source: value, pointer: reflected.Pointer(), length: reflected.Len(), encoded: encoded}
	return encoded
}

type pingFrame struct{ payload []byte }

func (frame *pingFrame) Error() string { return "websocket ping" }

func readFrame(reader *bufio.Reader) ([]byte, error) {
	var header [2]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return nil, err
	}
	if (header[0] != 0x81 && header[0] != 0x88 && header[0] != 0x89 && header[0] != 0x8a) || header[1]&0x80 == 0 {
		return nil, fmt.Errorf("only masked final text frames accepted")
	}
	length := int(header[1] & 127)
	if length == 127 || header[0] != 0x81 && length > 125 {
		return nil, fmt.Errorf("oversized websocket frame")
	}
	if length == 126 {
		var size [2]byte
		if _, err := io.ReadFull(reader, size[:]); err != nil {
			return nil, err
		}
		length = int(binary.BigEndian.Uint16(size[:]))
	}
	if length > 4096 {
		return nil, fmt.Errorf("subscription exceeds 4096 bytes")
	}
	var mask [4]byte
	if _, err := io.ReadFull(reader, mask[:]); err != nil {
		return nil, err
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, err
	}
	for index := range payload {
		payload[index] ^= mask[index%4]
	}
	if header[0] == 0x88 {
		return nil, io.EOF
	}
	if header[0] == 0x89 {
		return nil, &pingFrame{payload: payload}
	}
	if header[0] == 0x8a {
		return nil, fmt.Errorf("unsolicited pong")
	}
	return payload, nil
}

func writeFrame(writer io.Writer, payload []byte) error {
	return writeOpcode(writer, payload, 0x81)
}

func writeOpcode(writer io.Writer, payload []byte, opcode byte) error {
	if len(payload) > 8*1024*1024 {
		return fmt.Errorf("observer frame exceeds limit")
	}
	header := []byte{opcode}
	switch {
	case len(payload) < 126:
		header = append(header, byte(len(payload)))
	case len(payload) < 65536:
		header = append(header, 126, byte(len(payload)>>8), byte(len(payload)))
	default:
		header = append(header, 127, 0, 0, 0, 0, byte(len(payload)>>24), byte(len(payload)>>16), byte(len(payload)>>8), byte(len(payload)))
	}
	frame := append(header, payload...)
	for len(frame) > 0 {
		written, err := writer.Write(frame)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		frame = frame[written:]
	}
	return nil
}
