package explorer

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/artifacts"
	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/identity"
	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/model"
	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/state"
	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/wmdproto"
)

type Config struct {
	Socket    string
	Inventory string
	Survey    string
	RoomURL   string
	Timeout   time.Duration
	Poll      time.Duration
	Inspector *artifacts.Inspector
}

type Interest struct {
	Topics      []string  `json:"topics"`
	Source      string    `json:"source,omitempty"`
	Destination string    `json:"destination,omitempty"`
	Frequency   uint32    `json:"frequency_mhz,omitempty"`
	Expires     time.Time `json:"-"`
}

type Coverage struct {
	State        string    `json:"state"`
	Rows         int       `json:"rows"`
	Total        uint32    `json:"total"`
	Generation   uint64    `json:"generation"`
	Sequence     uint64    `json:"sequence"`
	SequenceFrom uint64    `json:"sequence_from"`
	ObservedAt   time.Time `json:"observed_at"`
	Error        string    `json:"error,omitempty"`
}

type Report struct {
	Available  bool           `json:"available"`
	ObservedAt time.Time      `json:"observed_at"`
	Data       map[string]any `json:"data,omitempty"`
	Error      string         `json:"error,omitempty"`
}

type Rule struct {
	model.FrequencyLink
	Generation uint64    `json:"generation"`
	ObservedAt time.Time `json:"observed_at"`
	Error      string    `json:"error,omitempty"`
}

type View struct {
	Schema       string              `json:"schema"`
	Snapshot     model.Snapshot      `json:"snapshot"`
	Coverage     map[string]Coverage `json:"coverage"`
	Selected     map[string]Rule     `json:"selected"`
	Details      map[string]Report   `json:"details"`
	Associations map[string]Report   `json:"ownership"`
	Room         Report              `json:"room"`
	Survey       Report              `json:"survey"`
	Service      Report              `json:"service"`
	Error        string              `json:"error,omitempty"`
	LastSuccess  time.Time           `json:"last_success"`
	Collector    map[string]any      `json:"collector"`
}

type scan struct {
	cursor        uint32
	generation    uint64
	sequence      uint64
	firstSequence uint64
	total         uint32
	rows          int
	completed     time.Time
	page          wmdproto.Page
}

type Runtime struct {
	config    Config
	legacy    *state.Store
	mu        sync.RWMutex
	view      *View
	interests map[string]Interest
	auxMu     sync.RWMutex
	room      Report
	survey    Report
}

func New(config Config, legacy *state.Store) (*Runtime, error) {
	if config.Poll < time.Second {
		config.Poll = 2 * time.Second
	}
	if config.Timeout <= 0 {
		config.Timeout = time.Second
	}
	if config.RoomURL != "" {
		parsed, err := url.Parse(config.RoomURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
			return nil, fmt.Errorf("invalid configured room URL")
		}
	}
	return &Runtime{config: config, legacy: legacy, interests: map[string]Interest{}}, nil
}

func (runtime *Runtime) Interest(id string, interest Interest) error {
	allowed := map[string]bool{"radios": true, "paths": true, "pairs": true, "frequencies": true, "vifs": true, "events": true, "room": true, "survey": true, "services": true, "ownership": true, "detail": true}
	if len(interest.Topics) > 12 {
		return fmt.Errorf("too many topics")
	}
	for _, topic := range interest.Topics {
		if !allowed[topic] {
			return fmt.Errorf("unknown topic %q", topic)
		}
	}
	if len(interest.Source) > 17 || len(interest.Destination) > 17 || (interest.Frequency != 0 && (interest.Frequency < 2300 || interest.Frequency > 7125)) {
		return fmt.Errorf("invalid selected identity or frequency")
	}
	for _, address := range []string{interest.Source, interest.Destination} {
		if address != "" {
			parsed, err := net.ParseMAC(address)
			if err != nil || len(parsed) != 6 || address != strings.ToLower(parsed.String()) {
				return fmt.Errorf("selected identities must be canonical lowercase radio MACs")
			}
		}
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(interest.Topics) == 0 {
		delete(runtime.interests, id)
		return nil
	}
	if _, exists := runtime.interests[id]; !exists && len(runtime.interests) >= 64 {
		return fmt.Errorf("observer subscription capacity reached")
	}
	interest.Expires = time.Now().Add(15 * time.Second)
	runtime.interests[id] = interest
	return nil
}

func (runtime *Runtime) RemoveInterest(id string) {
	runtime.mu.Lock()
	delete(runtime.interests, id)
	runtime.mu.Unlock()
}

func (runtime *Runtime) demand() (map[string]bool, []Interest, int) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	topics := map[string]bool{}
	selected := map[string]Interest{}
	for id, interest := range runtime.interests {
		if time.Now().After(interest.Expires) {
			delete(runtime.interests, id)
			continue
		}
		for _, topic := range interest.Topics {
			topics[topic] = true
		}
		if interest.Source != "" && interest.Destination != "" {
			selected[Key(interest.Source, interest.Destination, interest.Frequency)] = interest
		}
	}
	keys := make([]string, 0, len(selected))
	for key := range selected {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	selections := make([]Interest, 0, len(keys))
	for _, key := range keys {
		selections = append(selections, selected[key])
	}
	return topics, selections, len(runtime.interests)
}

func (runtime *Runtime) View() *View {
	runtime.mu.RLock()
	defer runtime.mu.RUnlock()
	return runtime.view
}

func Key(source, destination string, frequency uint32) string {
	return source + ">" + destination + "@" + strconv.FormatUint(uint64(frequency), 10)
}

func has(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func (runtime *Runtime) Run(ctx context.Context) {
	go runtime.sources(ctx)
	reader := &wmdproto.Reader{Path: runtime.config.Socket, Timeout: runtime.config.Timeout}
	defer reader.Close()
	ticker := time.NewTicker(110 * time.Millisecond)
	defer ticker.Stop()
	snapshot := model.NewSnapshot()
	scans := map[string]*scan{}
	coverage := map[string]Coverage{}
	selected := map[string]Rule{}
	details := map[string]Report{}
	ownership := map[string]Report{}
	paths := map[string]model.ActiveLink{}
	pathsChanged := false
	var lastInfo, lastSummary, lastPublish, lastInventory, lastService, byteWindow time.Time
	var lastSuccess time.Time
	var collectorError string
	var initialBytes uint64
	var sequence uint64
	var jobIndex, selectionIndex, detailIndex, associationIndex int
	loader := identity.Loader{Path: runtime.config.Inventory}
	service := Report{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		now := time.Now()
		topics, selections, subscribers := runtime.demand()
		interval := runtime.config.Poll
		if subscribers == 0 {
			interval = 5 * time.Second
		}
		if now.Sub(byteWindow) >= time.Second {
			byteWindow = now
			initialBytes = reader.Bytes
		}
		if reader.Bytes-initialBytes > 256*1024-65584 {
			continue
		}
		var operationError error
		criticalOperation := false
		switch {
		case now.Sub(lastInfo) >= interval:
			criticalOperation = true
			lastInfo = now
			var daemon model.Daemon
			daemon, operationError = reader.Info(ctx)
			if operationError == nil {
				if daemon.InstanceID != snapshot.Daemon.InstanceID {
					snapshot = model.NewSnapshot()
					scans = map[string]*scan{}
					coverage = map[string]Coverage{}
					selected = map[string]Rule{}
					details = map[string]Report{}
					ownership = map[string]Report{}
					paths = map[string]model.ActiveLink{}
					pathsChanged = false
					service = Report{}
					lastInventory = time.Time{}
				}
				if daemon.Generation != snapshot.Daemon.Generation {
					for _, topic := range []string{"pairs", "frequencies"} {
						delete(scans, topic)
						entry := coverage[topic]
						entry.State = "unverified"
						coverage[topic] = entry
					}
				}
				snapshot.Daemon = daemon
				lastSuccess = now
				if snapshot.PacketMetrics.Available || !has(daemon.Capabilities, "telemetry") {
					collectorError = ""
				}
			}
		case snapshot.Daemon.InstanceID != "" && has(snapshot.Daemon.Capabilities, "telemetry") && now.Sub(lastSummary) >= interval:
			criticalOperation = true
			lastSummary = now
			var summary model.TelemetrySummary
			summary, operationError = reader.Summary(ctx)
			if operationError == nil {
				snapshot.PacketMetrics = model.PacketMetrics{Available: true, Summary: &summary}
				snapshot.CapturedAt = now
				lastSuccess = now
				collectorError = ""
				snapshot.Health.State = "ok"
				snapshot.Health.Reasons = nil
				if summary.QueueDepth > 0 {
					snapshot.Health.State = "busy"
				}
				if snapshot.Health.EventHistoryGap {
					snapshot.Health.State = "degraded"
				}
			} else {
				snapshot.PacketMetrics.Available = false
				snapshot.PacketMetrics.Reason = operationError.Error()
				snapshot.Health.State = "unavailable"
			}
		case subscribers > 0 && snapshot.Daemon.InstanceID != "":
			jobs := []string{}
			for _, topic := range []string{"paths", "radios", "vifs", "events", "pairs", "frequencies"} {
				if topics[topic] || (topic == "frequencies" && topics["pairs"]) || (topic == "vifs" && topics["radios"]) {
					jobs = append(jobs, topic)
				}
			}
			if len(selections) > 0 {
				jobs = append(jobs, "selected")
			}
			if topics["ownership"] && len(snapshot.Stations) > 0 && has(snapshot.Daemon.Capabilities, "association_ownership") {
				jobs = append(jobs, "ownership")
			}
			if has(snapshot.Daemon.Capabilities, "explorer_details") {
				if topics["services"] {
					jobs = append(jobs, "services")
				}
				if topics["detail"] && len(selections) > 0 {
					jobs = append(jobs, "detail")
				}
			}
			if len(jobs) == 0 {
				break
			}
			job := jobs[jobIndex%len(jobs)]
			jobIndex++
			switch job {
			case "services":
				if now.Sub(lastService) < 2*time.Second {
					break
				}
				lastService = now
				data, err := reader.Detail(ctx, "", "", 0)
				operationError = err
				service = report(data, err, now)
			case "detail", "selected":
				index := selectionIndex
				if job == "detail" {
					index = detailIndex
					detailIndex++
				} else {
					selectionIndex++
				}
				interest := selections[(index/4)%len(selections)]
				source, destination, frequency := interest.Source, interest.Destination, interest.Frequency
				if index%4 >= 2 {
					source, destination = destination, source
				}
				if index%2 == 1 {
					frequency = 0
				}
				key := Key(source, destination, frequency)
				if job == "detail" {
					if now.Sub(details[key].ObservedAt) < time.Second {
						break
					}
					data, err := reader.Detail(ctx, source, destination, frequency)
					operationError = err
					details[key] = report(data, err, now)
				} else {
					if now.Sub(selected[key].ObservedAt) < time.Second {
						break
					}
					value, generation, err := reader.Pair(ctx, source, destination, frequency)
					operationError = err
					if err == nil {
						selected[key] = Rule{FrequencyLink: value, Generation: generation, ObservedAt: now}
					} else {
						selected[key] = Rule{FrequencyLink: model.FrequencyLink{Source: source, Destination: destination, FrequencyMHz: frequency}, Generation: generation, ObservedAt: now, Error: err.Error()}
					}
				}
			case "ownership":
				station := snapshot.Stations[associationIndex%len(snapshot.Stations)]
				if len(selections) > 0 && associationIndex%2 == 0 {
					selection := selections[(associationIndex/2)%len(selections)]
					for _, candidate := range snapshot.Stations {
						if candidate.MAC == selection.Source || candidate.MAC == selection.Destination {
							if candidate.Role == "wlan-client" || candidate.Role == "iot-client" {
								station = candidate
								break
							}
						}
					}
				}
				associationIndex++
				if station.Role != "wlan-client" && station.Role != "iot-client" {
					break
				}
				if now.Sub(ownership[station.MAC].ObservedAt) < 5*time.Second {
					break
				}
				value, err := reader.Association(ctx, station.MAC)
				data := map[string]any{"station": station.MAC, "evidence": "no ownership reported"}
				if err == nil {
					data = object(value)
				}
				ownership[station.MAC] = report(data, nil, now)
				if err != nil {
					ownership[station.MAC] = report(data, err, now)
				}
			default:
				telemetry := job != "pairs" && job != "frequencies"
				if telemetry && !has(snapshot.Daemon.Capabilities, "telemetry") {
					coverage[job] = Coverage{State: "unsupported"}
					break
				}
				if job == "frequencies" && !has(snapshot.Daemon.Capabilities, "frequency_qualified_snr") {
					coverage[job] = Coverage{State: "unsupported"}
					break
				}
				current := scans[job]
				if current == nil {
					current = &scan{generation: snapshot.Daemon.Generation}
					scans[job] = current
				}
				if !current.completed.IsZero() {
					if !telemetry || now.Sub(current.completed) < runtime.config.Poll {
						break
					}
					current = &scan{generation: snapshot.Daemon.Generation}
					scans[job] = current
				}
				paged := telemetry || has(snapshot.Daemon.Capabilities, "paged_link_dumps")
				page, err := reader.Page(ctx, job, current.cursor, 0, paged)
				operationError = err
				if err != nil {
					coverage[job] = Coverage{State: "unavailable", Error: err.Error()}
					break
				}
				if !telemetry && page.Generation != current.generation {
					delete(scans, job)
					coverage[job] = Coverage{State: "changing", Error: "RF generation changed during collection"}
					break
				}
				current.cursor = page.Next
				current.total = page.Total
				current.sequence = page.Sequence
				if current.firstSequence == 0 {
					current.firstSequence = page.Sequence
				}
				current.page.Pairs = append(current.page.Pairs, page.Pairs...)
				current.page.Frequencies = append(current.page.Frequencies, page.Frequencies...)
				for index := range page.Paths {
					page.Paths[index].SampledAt = now
					row := page.Paths[index]
					key := Key(row.Source, row.Destination, row.FrequencyMHz)
					if _, exists := paths[key]; exists || len(paths) < 65536 {
						paths[key] = row
						pathsChanged = true
					}
				}
				current.page.Paths = append(current.page.Paths, page.Paths...)
				current.page.Radios = append(current.page.Radios, page.Radios...)
				current.page.VIFs = append(current.page.VIFs, page.VIFs...)
				current.page.Events = append(current.page.Events, page.Events...)
				current.rows = len(current.page.Pairs) + len(current.page.Frequencies) + len(current.page.Paths) + len(current.page.Radios) + len(current.page.VIFs) + len(current.page.Events)
				if current.rows > 65536 {
					delete(scans, job)
					operationError = fmt.Errorf("%s exceeds bounded collection size", job)
					break
				}
				coverage[job] = Coverage{State: "collecting", Rows: current.rows, Total: page.Total, Generation: current.generation, Sequence: page.Sequence, SequenceFrom: current.firstSequence, ObservedAt: now}
				if page.Gap {
					snapshot.Health.EventHistoryGap = true
				}
				if page.Next == ^uint32(0) {
					current.completed = now
					entry := coverage[job]
					entry.State = "complete"
					coverage[job] = entry
					switch job {
					case "pairs":
						snapshot.PairLinks = current.page.Pairs
					case "frequencies":
						snapshot.FrequencyOverrides = current.page.Frequencies
					case "paths":
						paths = map[string]model.ActiveLink{}
						for _, row := range current.page.Paths {
							paths[Key(row.Source, row.Destination, row.FrequencyMHz)] = row
						}
						pathsChanged = true
					case "radios":
						snapshot.RadioFrequencies = current.page.Radios
					case "vifs":
						snapshot.VIFs = current.page.VIFs
					case "events":
						if len(snapshot.Events) > 0 && len(current.page.Events) > 0 && current.page.Events[0].Sequence > snapshot.Events[len(snapshot.Events)-1].Sequence+1 {
							snapshot.Health.EventHistoryGap = true
						}
						snapshot.Events = current.page.Events
					}
				}
			}
		}
		if operationError != nil && criticalOperation {
			collectorError = operationError.Error()
		}
		if now.Sub(lastInventory) > 10*time.Second {
			lastInventory = now
			inventory, err := loader.Read()
			stations := map[string]model.Station{}
			for _, pair := range snapshot.PairLinks {
				stations[pair.Source] = model.Station{MAC: pair.Source}
				stations[pair.Destination] = model.Station{MAC: pair.Destination}
			}
			for _, path := range snapshot.ActiveLinks {
				stations[path.Source] = model.Station{MAC: path.Source}
				stations[path.Destination] = model.Station{MAC: path.Destination}
			}
			if err == nil {
				for _, entry := range inventory.Stations {
					if entry.Role != "spare" {
						stations[entry.MAC] = model.Station{MAC: entry.MAC}
					}
				}
			}
			snapshot.Stations = make([]model.Station, 0, len(stations))
			for _, station := range stations {
				snapshot.Stations = append(snapshot.Stations, station)
			}
			sort.Slice(snapshot.Stations, func(left, right int) bool { return snapshot.Stations[left].MAC < snapshot.Stations[right].MAC })
			loader.Apply(&snapshot)
			if runtime.config.Inspector != nil {
				snapshot.Artifacts = runtime.config.Inspector.Inspect()
			}
		}
		if now.Sub(lastPublish) < time.Second {
			continue
		}
		lastPublish = now
		sequence++
		if pathsChanged {
			keys := make([]string, 0, len(paths))
			for key := range paths {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			snapshot.ActiveLinks = make([]model.ActiveLink, 0, len(keys))
			for _, key := range keys {
				snapshot.ActiveLinks = append(snapshot.ActiveLinks, paths[key])
			}
			pathsChanged = false
		}
		for key, value := range selected {
			if now.Sub(value.ObservedAt) > time.Minute {
				delete(selected, key)
			}
		}
		for key, value := range details {
			if now.Sub(value.ObservedAt) > time.Minute {
				delete(details, key)
			}
		}
		snapshot.Sequence = sequence
		if runtime.legacy != nil && snapshot.Daemon.InstanceID != "" {
			if collectorError != "" {
				runtime.legacy.UpdateError(fmt.Errorf("%s", collectorError))
			} else {
				runtime.legacy.Update(snapshot)
			}
		}
		published := &View{Schema: "wmediumd.console-ng.v2", Snapshot: snapshot, Coverage: clone(coverage), Selected: clone(selected), Details: clone(details), Associations: clone(ownership), Service: service, Error: collectorError, LastSuccess: lastSuccess,
			Collector: map[string]any{"requests": reader.Requests, "bytes": reader.Bytes, "subscriptions": subscribers, "request_budget_per_second": 10, "byte_budget_per_second": 262144, "read_only": true, "updated_at": now}}
		if runtime.legacy != nil {
			if stored := runtime.legacy.View().Snapshot; stored != nil {
				published.Snapshot.PacketMetrics.Rates = stored.PacketMetrics.Rates
				snapshot.PacketMetrics.Rates = stored.PacketMetrics.Rates
			}
		}
		runtime.auxMu.RLock()
		published.Room, published.Survey = runtime.room, runtime.survey
		runtime.auxMu.RUnlock()
		runtime.mu.Lock()
		runtime.view = published
		runtime.mu.Unlock()
	}
}

func clone[Value any](source map[string]Value) map[string]Value {
	target := make(map[string]Value, len(source))
	for key, value := range source {
		target[key] = value
	}
	return target
}
func report(data map[string]any, err error, now time.Time) Report {
	result := Report{Available: err == nil, ObservedAt: now, Data: data}
	if err != nil {
		result.Error = err.Error()
	}
	return result
}
func object(value any) map[string]any {
	encoded, _ := json.Marshal(value)
	var result map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(encoded)))
	decoder.UseNumber()
	_ = decoder.Decode(&result)
	return result
}

func readJSON(reader io.Reader) (map[string]any, error) {
	data, err := io.ReadAll(io.LimitReader(reader, 2*1024*1024+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 2*1024*1024 {
		return nil, fmt.Errorf("source exceeds 2 MiB")
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	var result map[string]any
	if err := decoder.Decode(&result); err != nil {
		return nil, err
	}
	return result, nil
}

func (runtime *Runtime) sources(ctx context.Context) {
	client := &http.Client{Timeout: runtime.config.Timeout, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		topics, _, subscribers := runtime.demand()
		if subscribers == 0 {
			continue
		}
		if topics["room"] && runtime.config.RoomURL != "" {
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(runtime.config.RoomURL, "/")+"/api/demo/observer", nil)
			var data map[string]any
			if err == nil {
				response, requestErr := client.Do(request)
				err = requestErr
				if err == nil {
					if response.StatusCode == http.StatusOK {
						data, err = readJSON(response.Body)
					} else {
						err = fmt.Errorf("room observer HTTP %d; matching room integration is required", response.StatusCode)
					}
					response.Body.Close()
					if err == nil && data["schema"] != "easymesh.room-observer.v1" {
						err = fmt.Errorf("room observer schema is not supported")
					}
				}
			}
			runtime.auxMu.Lock()
			runtime.room = report(data, err, time.Now())
			runtime.auxMu.Unlock()
		}
		if topics["survey"] && runtime.config.Survey != "" {
			file, err := os.Open(runtime.config.Survey)
			var data map[string]any
			if err == nil {
				data, err = readJSON(file)
				file.Close()
			}
			if err == nil {
				data["reader_monotonic_ns"] = monotonicNS()
			}
			runtime.auxMu.Lock()
			runtime.survey = report(data, err, time.Now())
			runtime.auxMu.Unlock()
		}
	}
}

func monotonicNS() int64 {
	var stamp syscall.Timespec
	_, _, failure := syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 1, uintptr(unsafe.Pointer(&stamp)), 0)
	if failure != 0 {
		return 0
	}
	return stamp.Nano()
}
