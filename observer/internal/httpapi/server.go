package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/model"
	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/state"
	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/wmdproto"
)

const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type Server struct {
	store      *state.Store
	assets     fs.FS
	controller ControlBackend
	csrfToken  string
}

type ControlBackend interface {
	Status() model.UndoStatus
	SetPairs(context.Context, model.PairControlRequest) (model.ControlResult, error)
	SetFrequencies(context.Context, model.FrequencyControlRequest) (model.ControlResult, error)
	ClearFrequencies(context.Context, model.FrequencyClearRequest) (model.ControlResult, error)
	Undo(context.Context, model.ControlRequest) (model.ControlResult, error)
}

type Option func(*Server)

func WithController(controller ControlBackend) Option {
	return func(server *Server) { server.controller = controller }
}

func New(store *state.Store, assets fs.FS, options ...Option) http.Handler {
	server := &Server{store: store, assets: assets}
	for _, option := range options {
		option(server)
	}
	if server.controller != nil {
		var token [32]byte
		if _, err := rand.Read(token[:]); err != nil {
			panic(fmt.Sprintf("create CSRF token: %v", err))
		}
		server.csrfToken = base64.RawURLEncoding.EncodeToString(token[:])
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/status", server.status)
	mux.HandleFunc("/api/v1/snapshot", server.snapshot)
	mux.HandleFunc("/api/v1/stations", server.stations)
	mux.HandleFunc("/api/v1/identities", server.identities)
	mux.HandleFunc("/api/v1/links", server.links)
	mux.HandleFunc("/api/v1/artifacts", server.artifacts)
	mux.HandleFunc("/api/v1/controls", server.controls)
	mux.HandleFunc("/api/v1/controls/pairs/set", server.setPairs)
	mux.HandleFunc("/api/v1/controls/frequencies/set", server.setFrequencies)
	mux.HandleFunc("/api/v1/controls/frequencies/clear", server.clearFrequencies)
	mux.HandleFunc("/api/v1/controls/undo", server.undo)
	mux.HandleFunc("/api/v1/telemetry", server.telemetry)
	mux.HandleFunc("/api/v1/radio-frequencies", server.radioFrequencies)
	mux.HandleFunc("/api/v1/active-links", server.activeLinks)
	mux.HandleFunc("/api/v1/vifs", server.vifs)
	mux.HandleFunc("/api/v1/events", server.events)
	mux.HandleFunc("/api/v1/health", server.health)
	mux.HandleFunc("/api/v1/stream", server.stream)
	mux.HandleFunc("/metrics", server.metrics)
	mux.HandleFunc("/", server.static)
	return server.headers(server.methodBoundary(mux))
}

func (s *Server) methodBoundary(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodPost && s.controller != nil && isTypedControlPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		{
			w.Header().Set("Allow", "GET, HEAD")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{
				"error": "mutation is disabled or is not a typed wmediumd Console operation",
			})
		}
	})
}

func isTypedControlPath(path string) bool {
	switch path {
	case "/api/v1/controls/pairs/set", "/api/v1/controls/frequencies/set", "/api/v1/controls/frequencies/clear", "/api/v1/controls/undo":
		return true
	default:
		return false
	}
}

func (s *Server) headers(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/metrics" {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) status(w http.ResponseWriter, _ *http.Request) {
	view := s.store.View()
	status := http.StatusOK
	response := map[string]any{
		"application":     "wmediumd Console",
		"read_only":       s.controller == nil,
		"last_attempt_at": view.LastAttemptAt,
		"last_success_at": view.LastSuccessAt,
		"collector_error": view.Error,
	}
	if view.Snapshot == nil {
		status = http.StatusServiceUnavailable
		response["ready"] = false
	} else {
		response["ready"] = true
		response["sequence"] = view.Snapshot.Sequence
		response["captured_at"] = view.Snapshot.CapturedAt
		response["daemon"] = view.Snapshot.Daemon
		response["pair_links"] = len(view.Snapshot.PairLinks)
		response["frequency_overrides"] = len(view.Snapshot.FrequencyOverrides)
		response["packet_metrics"] = view.Snapshot.PacketMetrics
		response["active_links"] = len(view.Snapshot.ActiveLinks)
		response["vifs"] = len(view.Snapshot.VIFs)
		response["health"] = view.Snapshot.Health
		response["identity_inventory"] = view.Snapshot.IdentityInventory
	}
	writeJSON(w, status, response)
}

func (s *Server) snapshot(w http.ResponseWriter, _ *http.Request) {
	view := s.store.View()
	if view.Snapshot == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": unavailableError(view)})
		return
	}
	writeJSON(w, http.StatusOK, view.Snapshot)
}

func (s *Server) stations(w http.ResponseWriter, _ *http.Request) {
	view := s.store.View()
	if view.Snapshot == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": unavailableError(view)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sequence":   view.Snapshot.Sequence,
		"generation": view.Snapshot.Daemon.Generation,
		"stations":   view.Snapshot.Stations,
	})
}

func (s *Server) identities(w http.ResponseWriter, _ *http.Request) {
	view := s.store.View()
	if view.Snapshot == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": unavailableError(view)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sequence":  view.Snapshot.Sequence,
		"inventory": view.Snapshot.IdentityInventory,
		"stations":  view.Snapshot.Stations,
	})
}

func (s *Server) links(w http.ResponseWriter, r *http.Request) {
	view := s.store.View()
	if view.Snapshot == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": unavailableError(view)})
		return
	}
	query := r.URL.Query()
	source := strings.ToLower(strings.TrimSpace(query.Get("source")))
	destination := strings.ToLower(strings.TrimSpace(query.Get("destination")))
	kind := query.Get("kind")
	if kind == "" {
		kind = "all"
	}
	if kind != "all" && kind != "pair" && kind != "frequency" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "kind must be all, pair or frequency"})
		return
	}
	frequency := uint64(0)
	if raw := query.Get("frequency_mhz"); raw != "" {
		value, err := strconv.ParseUint(raw, 10, 32)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "frequency_mhz must be an unsigned integer"})
			return
		}
		frequency = value
	}
	pairs := make([]model.Link, 0)
	if kind == "all" || kind == "pair" {
		for _, link := range view.Snapshot.PairLinks {
			if matches(link.Source, link.Destination, source, destination) {
				pairs = append(pairs, link)
			}
		}
	}
	frequencyLinks := make([]model.FrequencyLink, 0)
	if kind == "all" || kind == "frequency" {
		for _, link := range view.Snapshot.FrequencyOverrides {
			if matches(link.Source, link.Destination, source, destination) &&
				(frequency == 0 || uint64(link.FrequencyMHz) == frequency) {
				frequencyLinks = append(frequencyLinks, link)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sequence":            view.Snapshot.Sequence,
		"generation":          view.Snapshot.Daemon.Generation,
		"pair_links":          pairs,
		"frequency_overrides": frequencyLinks,
	})
}

func (s *Server) artifacts(w http.ResponseWriter, _ *http.Request) {
	view := s.store.View()
	if view.Snapshot == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": unavailableError(view)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sequence":           view.Snapshot.Sequence,
		"daemon_instance_id": view.Snapshot.Daemon.InstanceID,
		"artifacts":          view.Snapshot.Artifacts,
	})
}

func (s *Server) controls(w http.ResponseWriter, _ *http.Request) {
	status := model.ControlStatus{
		Enabled: s.controller != nil, Mode: "read-only",
		Reason:     "start with --enable-control to open the dedicated writable socket",
		Operations: []string{"pair_set", "frequency_set", "frequency_clear", "undo_last_transaction"},
		Prohibited: []string{"shell_execution", "generic_socket_proxy", "arbitrary_command"},
	}
	if s.controller != nil {
		status.Mode = "typed-control"
		status.Reason = "controls are explicitly enabled; every mutation requires instance and generation checks"
		status.CSRFToken = s.csrfToken
		status.Undo = s.controller.Status()
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) setPairs(w http.ResponseWriter, r *http.Request) {
	var request model.PairControlRequest
	if !s.authorizeControl(w, r) || !decodeControlJSON(w, r, &request) {
		return
	}
	result, err := s.controller.SetPairs(r.Context(), request)
	s.writeControlResult(w, result, err)
}

func (s *Server) setFrequencies(w http.ResponseWriter, r *http.Request) {
	var request model.FrequencyControlRequest
	if !s.authorizeControl(w, r) || !decodeControlJSON(w, r, &request) {
		return
	}
	result, err := s.controller.SetFrequencies(r.Context(), request)
	s.writeControlResult(w, result, err)
}

func (s *Server) clearFrequencies(w http.ResponseWriter, r *http.Request) {
	var request model.FrequencyClearRequest
	if !s.authorizeControl(w, r) || !decodeControlJSON(w, r, &request) {
		return
	}
	result, err := s.controller.ClearFrequencies(r.Context(), request)
	s.writeControlResult(w, result, err)
}

func (s *Server) undo(w http.ResponseWriter, r *http.Request) {
	var request model.ControlRequest
	if !s.authorizeControl(w, r) || !decodeControlJSON(w, r, &request) {
		return
	}
	result, err := s.controller.Undo(r.Context(), request)
	s.writeControlResult(w, result, err)
}

func (s *Server) authorizeControl(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "typed control endpoint requires POST"})
		return false
	}
	if s.controller == nil {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "controls are disabled"})
		return false
	}
	if !sameOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "Origin does not match Host"})
		return false
	}
	if r.Header.Get("X-Wmediumd-CSRF") != s.csrfToken {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "missing or invalid X-Wmediumd-CSRF token"})
		return false
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
	if mediaType != "application/json" {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]any{"error": "Content-Type must be application/json"})
		return false
	}
	return true
}

func decodeControlJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid control request: " + err.Error()})
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "control request must contain one JSON value"})
		return false
	}
	return true
}

func (s *Server) writeControlResult(w http.ResponseWriter, result model.ControlResult, err error) {
	if err == nil {
		writeJSON(w, http.StatusOK, result)
		return
	}
	status := http.StatusBadRequest
	response := map[string]any{"error": err.Error()}
	var conflict *wmdproto.ConflictError
	if errors.As(err, &conflict) {
		status = http.StatusConflict
		response["current_generation"] = conflict.CurrentGeneration
	} else {
		var protocol *wmdproto.ProtocolError
		var network net.Error
		switch {
		case errors.As(err, &protocol) && protocol.Status == 8:
			status = http.StatusForbidden
		case errors.As(err, &protocol) && protocol.Status == 6:
			status = http.StatusBadGateway
		case errors.As(err, &network):
			status = http.StatusServiceUnavailable
		}
	}
	writeJSON(w, status, response)
}

func (s *Server) telemetry(w http.ResponseWriter, _ *http.Request) {
	snapshot, ok := s.requireSnapshot(w)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sequence": snapshot.Sequence, "packet_metrics": snapshot.PacketMetrics})
}

func (s *Server) radioFrequencies(w http.ResponseWriter, _ *http.Request) {
	snapshot, ok := s.requireSnapshot(w)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sequence": snapshot.Sequence, "radio_frequencies": snapshot.RadioFrequencies})
}

func (s *Server) activeLinks(w http.ResponseWriter, _ *http.Request) {
	snapshot, ok := s.requireSnapshot(w)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sequence": snapshot.Sequence, "active_links": snapshot.ActiveLinks})
}

func (s *Server) vifs(w http.ResponseWriter, _ *http.Request) {
	snapshot, ok := s.requireSnapshot(w)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sequence": snapshot.Sequence, "vifs": snapshot.VIFs})
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	snapshot, ok := s.requireSnapshot(w)
	if !ok {
		return
	}
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 1000 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "limit must be 1..1000"})
			return
		}
		limit = value
	}
	events := snapshot.Events
	if len(events) > limit {
		events = events[len(events)-limit:]
	}
	writeJSON(w, http.StatusOK, map[string]any{"sequence": snapshot.Sequence, "events": events, "event_history_gap": snapshot.Health.EventHistoryGap})
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	snapshot, ok := s.requireSnapshot(w)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sequence": snapshot.Sequence, "health": snapshot.Health})
}

func (s *Server) requireSnapshot(w http.ResponseWriter) (*model.Snapshot, bool) {
	view := s.store.View()
	if view.Snapshot == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": unavailableError(view)})
		return nil, false
	}
	return view.Snapshot, true
}

func (s *Server) metrics(w http.ResponseWriter, _ *http.Request) {
	view := s.store.View()
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	ready := 0
	stations, pairs, overrides, active, vifs := 0, 0, 0, 0, 0
	generation := uint64(0)
	metricsAvailable := 0
	frames, bytesSeen, attempts, retries, injected, drops := uint64(0), uint64(0), uint64(0), uint64(0), uint64(0), uint64(0)
	queueDepth := uint32(0)
	if view.Snapshot != nil {
		ready = 1
		stations = len(view.Snapshot.Stations)
		pairs = len(view.Snapshot.PairLinks)
		overrides = len(view.Snapshot.FrequencyOverrides)
		generation = view.Snapshot.Daemon.Generation
		active = len(view.Snapshot.ActiveLinks)
		vifs = len(view.Snapshot.VIFs)
		if summary := view.Snapshot.PacketMetrics.Summary; view.Snapshot.PacketMetrics.Available && summary != nil {
			metricsAvailable = 1
			frames = summary.FramesSeen
			bytesSeen = summary.BytesSeen
			attempts = summary.TXAttempts
			retries = summary.Retries
			injected = summary.RXInjected
			queueDepth = summary.QueueDepth
			drops = summary.DropsOffChannel + summary.DropsCCA + summary.DropsInterference + summary.DropsPER + summary.DropsNoReceiver
		}
	}
	fmt.Fprintf(w, "# HELP wmediumd_console_ready Whether a valid read-only snapshot is available.\n")
	fmt.Fprintf(w, "# TYPE wmediumd_console_ready gauge\n")
	fmt.Fprintf(w, "wmediumd_console_ready %d\n", ready)
	fmt.Fprintf(w, "# TYPE wmediumd_console_control_generation gauge\n")
	fmt.Fprintf(w, "wmediumd_console_control_generation %d\n", generation)
	fmt.Fprintf(w, "# TYPE wmediumd_console_stations gauge\n")
	fmt.Fprintf(w, "wmediumd_console_stations %d\n", stations)
	fmt.Fprintf(w, "# TYPE wmediumd_console_pair_links gauge\n")
	fmt.Fprintf(w, "wmediumd_console_pair_links %d\n", pairs)
	fmt.Fprintf(w, "# TYPE wmediumd_console_frequency_overrides gauge\n")
	fmt.Fprintf(w, "wmediumd_console_frequency_overrides %d\n", overrides)
	fmt.Fprintf(w, "# TYPE wmediumd_console_packet_metrics_available gauge\n")
	fmt.Fprintf(w, "wmediumd_console_packet_metrics_available %d\n", metricsAvailable)
	fmt.Fprintf(w, "# TYPE wmediumd_console_active_links gauge\nwmediumd_console_active_links %d\n", active)
	fmt.Fprintf(w, "# TYPE wmediumd_console_vifs gauge\nwmediumd_console_vifs %d\n", vifs)
	fmt.Fprintf(w, "# TYPE wmediumd_console_frames_total counter\nwmediumd_console_frames_total %d\n", frames)
	fmt.Fprintf(w, "# TYPE wmediumd_console_bytes_total counter\nwmediumd_console_bytes_total %d\n", bytesSeen)
	fmt.Fprintf(w, "# TYPE wmediumd_console_tx_attempts_total counter\nwmediumd_console_tx_attempts_total %d\n", attempts)
	fmt.Fprintf(w, "# TYPE wmediumd_console_retries_total counter\nwmediumd_console_retries_total %d\n", retries)
	fmt.Fprintf(w, "# TYPE wmediumd_console_rx_injected_total counter\nwmediumd_console_rx_injected_total %d\n", injected)
	fmt.Fprintf(w, "# TYPE wmediumd_console_drops_total counter\nwmediumd_console_drops_total %d\n", drops)
	fmt.Fprintf(w, "# TYPE wmediumd_console_queue_depth gauge\nwmediumd_console_queue_depth %d\n", queueDepth)
}

func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	if strings.Contains(path, "..") || (path != "index.html" && path != "app.js" && path != "graph-layout.js" && path != "style.css") {
		http.NotFound(w, r)
		return
	}
	content, err := fs.ReadFile(s.assets, path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	contentType := mime.TypeByExtension(filepath.Ext(path))
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(content)
}

func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	if !validWebSocketRequest(r) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "valid WebSocket upgrade required"})
		return
	}
	if !sameOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "WebSocket origin does not match Host"})
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "HTTP server does not support WebSocket hijacking"})
		return
	}
	connection, buffer, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer connection.Close()
	accept := websocketAccept(r.Header.Get("Sec-WebSocket-Key"))
	_, _ = fmt.Fprintf(buffer, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept)
	if err := buffer.Flush(); err != nil {
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	updates := s.store.Subscribe(ctx)
	for update := range updates {
		payload, err := json.Marshal(update)
		if err != nil {
			return
		}
		if err := connection.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
			return
		}
		if err := writeWebSocketText(connection, payload); err != nil {
			return
		}
	}
}

func unavailableError(view state.View) string {
	if view.Error != "" {
		return view.Error
	}
	return "waiting for the first read-only wmediumd snapshot"
}

func matches(actualSource, actualDestination, source, destination string) bool {
	return (source == "" || strings.EqualFold(actualSource, source)) &&
		(destination == "" || strings.EqualFold(actualDestination, destination))
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func validWebSocketRequest(r *http.Request) bool {
	if !headerContainsToken(r.Header.Get("Connection"), "upgrade") || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || r.Header.Get("Sec-WebSocket-Version") != "13" {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(r.Header.Get("Sec-WebSocket-Key"))
	return err == nil && len(decoded) == 16
}

func headerContainsToken(value, token string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	return err == nil && strings.EqualFold(parsed.Host, r.Host)
}

func websocketAccept(key string) string {
	hash := sha1.Sum([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(hash[:])
}

func writeWebSocketText(connection interface{ Write([]byte) (int, error) }, payload []byte) error {
	header := []byte{0x81}
	switch {
	case len(payload) <= 125:
		header = append(header, byte(len(payload)))
	case len(payload) <= 65535:
		header = append(header, 126, byte(len(payload)>>8), byte(len(payload)))
	default:
		header = append(header, 127, 0, 0, 0, 0, byte(uint64(len(payload))>>24), byte(uint64(len(payload))>>16), byte(uint64(len(payload))>>8), byte(len(payload)))
	}
	frame := append(header, payload...)
	for len(frame) > 0 {
		written, err := connection.Write(frame)
		if err != nil {
			return err
		}
		if written == 0 {
			return fmt.Errorf("zero-length WebSocket write")
		}
		frame = frame[written:]
	}
	return nil
}
