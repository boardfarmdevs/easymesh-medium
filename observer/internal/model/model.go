package model

import (
	"fmt"
	"sort"
	"time"
)

// PacketMetrics keeps availability explicit so configured medium state can
// never be mistaken for observed traffic when an older -R endpoint is used.
type PacketMetrics struct {
	Available bool              `json:"available"`
	Reason    string            `json:"reason,omitempty"`
	Summary   *TelemetrySummary `json:"summary,omitempty"`
	Rates     TelemetryRates    `json:"rates"`
}

type Daemon struct {
	InstanceID   string   `json:"instance_id"`
	Generation   uint64   `json:"generation"`
	Capabilities []string `json:"capabilities"`
	MaxUpdates   uint32   `json:"max_updates"`
	NumStations  uint32   `json:"num_stations"`
}

type Station struct {
	Index     int    `json:"index"`
	MAC       string `json:"mac"`
	Label     string `json:"label,omitempty"`
	Role      string `json:"role,omitempty"`
	Owner     string `json:"owner,omitempty"`
	Interface string `json:"interface,omitempty"`
}

type IdentityInventory struct {
	Available   bool      `json:"available"`
	Path        string    `json:"path,omitempty"`
	GeneratedAt time.Time `json:"generated_at,omitempty"`
	Entries     int       `json:"entries"`
	Matched     int       `json:"matched"`
	Error       string    `json:"error,omitempty"`
}

type Link struct {
	Source      string `json:"source"`
	Destination string `json:"destination"`
	SNRDB       int16  `json:"snr_db"`
}

type FrequencyLink struct {
	Source       string `json:"source"`
	Destination  string `json:"destination"`
	FrequencyMHz uint32 `json:"frequency_mhz"`
	Band         string `json:"band"`
	Channel      int    `json:"channel"`
	SNRDB        int16  `json:"snr_db"`
	Override     bool   `json:"override"`
}

type TelemetrySummary struct {
	TelemetrySequence   uint64 `json:"telemetry_sequence"`
	UptimeUsec          uint64 `json:"uptime_usec"`
	FramesSeen          uint64 `json:"frames_seen"`
	BytesSeen           uint64 `json:"bytes_seen"`
	ManagementFrames    uint64 `json:"management_frames"`
	ControlFrames       uint64 `json:"control_frames"`
	DataFrames          uint64 `json:"data_frames"`
	OtherFrames         uint64 `json:"other_frames"`
	EAPOLFrames         uint64 `json:"eapol_frames"`
	UnicastFrames       uint64 `json:"unicast_frames"`
	MulticastFrames     uint64 `json:"multicast_frames"`
	TXAttempts          uint64 `json:"tx_attempts"`
	Retries             uint64 `json:"retries"`
	TXAcked             uint64 `json:"tx_acked"`
	TXNoAck             uint64 `json:"tx_no_ack"`
	RXInjected          uint64 `json:"rx_injected"`
	MulticastCandidates uint64 `json:"multicast_candidates"`
	DropsOffChannel     uint64 `json:"drops_offchannel"`
	DropsCCA            uint64 `json:"drops_cca"`
	DropsInterference   uint64 `json:"drops_interference"`
	DropsPER            uint64 `json:"drops_per"`
	DropsNoReceiver     uint64 `json:"drops_no_receiver"`
	NetlinkCloneEINVAL  uint64 `json:"netlink_clone_einval"`
	NetlinkOtherErrors  uint64 `json:"netlink_other_errors"`
	ActiveLinkEvictions uint64 `json:"active_link_evictions"`
	EventOverruns       uint64 `json:"event_overruns"`
	QueueDelayUsecMax   uint64 `json:"queue_delay_usec_max"`
	QueueDelayUsecLast  uint64 `json:"queue_delay_usec_last"`
	QueueDepth          uint32 `json:"queue_depth"`
	QueueDepthMax       uint32 `json:"queue_depth_max"`
	ActiveLinks         uint32 `json:"active_links"`
	RadioFrequencies    uint32 `json:"radio_frequencies"`
	VIFs                uint32 `json:"vifs"`
	EventCapacity       uint32 `json:"event_capacity"`
}

type TelemetryRates struct {
	WindowSeconds     float64 `json:"window_seconds"`
	FramesPerSecond   float64 `json:"frames_per_second"`
	BytesPerSecond    float64 `json:"bytes_per_second"`
	AttemptsPerSecond float64 `json:"attempts_per_second"`
	RetriesPerSecond  float64 `json:"retries_per_second"`
	InjectedPerSecond float64 `json:"injected_per_second"`
	DropsPerSecond    float64 `json:"drops_per_second"`
}

type RadioFrequency struct {
	Radio              string `json:"radio"`
	FrequencyMHz       uint32 `json:"frequency_mhz"`
	Band               string `json:"band"`
	Channel            int    `json:"channel"`
	LastUpdateSequence uint64 `json:"last_update_sequence"`
	LastSeenUsec       uint64 `json:"last_seen_usec"`
	Frames             uint64 `json:"frames"`
	Bytes              uint64 `json:"bytes"`
	ManagementFrames   uint64 `json:"management_frames"`
	ControlFrames      uint64 `json:"control_frames"`
	DataFrames         uint64 `json:"data_frames"`
	EAPOLFrames        uint64 `json:"eapol_frames"`
	UnicastFrames      uint64 `json:"unicast_frames"`
	MulticastFrames    uint64 `json:"multicast_frames"`
	Attempts           uint64 `json:"attempts"`
	Retries            uint64 `json:"retries"`
	RXInjected         uint64 `json:"rx_injected"`
	Drops              uint64 `json:"drops"`
	QueueDepthMax      uint32 `json:"queue_depth_max"`
	LastType           uint8  `json:"last_type"`
	LastSubtype        uint8  `json:"last_subtype"`
	LastAccessCategory uint8  `json:"last_access_category"`
}

type ActiveLink struct {
	Source             string `json:"source"`
	Destination        string `json:"destination"`
	FrequencyMHz       uint32 `json:"frequency_mhz"`
	Band               string `json:"band"`
	Channel            int    `json:"channel"`
	Multicast          bool   `json:"multicast"`
	LastUpdateSequence uint64 `json:"last_update_sequence"`
	FirstSeenUsec      uint64 `json:"first_seen_usec"`
	LastSeenUsec       uint64 `json:"last_seen_usec"`
	Frames             uint64 `json:"frames"`
	Bytes              uint64 `json:"bytes"`
	Attempts           uint64 `json:"attempts"`
	Retries            uint64 `json:"retries"`
	Acked              uint64 `json:"acked"`
	NoAck              uint64 `json:"no_ack"`
	RXInjected         uint64 `json:"rx_injected"`
	DropsOffChannel    uint64 `json:"drops_offchannel"`
	DropsCCA           uint64 `json:"drops_cca"`
	DropsInterference  uint64 `json:"drops_interference"`
	DropsPER           uint64 `json:"drops_per"`
	DropsNoReceiver    uint64 `json:"drops_no_receiver"`
	NetlinkRejections  uint64 `json:"netlink_rejections"`
	LastSignalDBM      int32  `json:"last_signal_dbm"`
	LastSNRDB          int32  `json:"last_snr_db"`
	LastPERMillion     uint32 `json:"last_per_million"`
	LastType           uint8  `json:"last_type"`
	LastSubtype        uint8  `json:"last_subtype"`
	LastAccessCategory uint8  `json:"last_access_category"`
}

// Association is protocol-positive station ownership reported by wmediumd.
// Station and Owner are provisioned base-radio identities, not transient VIFs.
type Association struct {
	Endpoint     string `json:"endpoint"`
	Station      string `json:"station"`
	Owner        string `json:"owner"`
	FrequencyMHz uint32 `json:"frequency_mhz"`
	Band         string `json:"band"`
	Channel      int    `json:"channel"`
	Flags        uint32 `json:"flags"`
	Evidence     string `json:"evidence"`
}

func (l ActiveLink) TotalDrops() uint64 {
	return l.DropsOffChannel + l.DropsCCA + l.DropsInterference + l.DropsPER + l.DropsNoReceiver
}

type VIF struct {
	MAC                string `json:"mac"`
	Radio              string `json:"radio"`
	FrequencyMHz       uint32 `json:"frequency_mhz"`
	Band               string `json:"band"`
	Channel            int    `json:"channel"`
	LastUpdateSequence uint64 `json:"last_update_sequence"`
}

type TelemetryEvent struct {
	Sequence     uint64 `json:"sequence"`
	TimeUsec     uint64 `json:"time_usec"`
	TypeID       uint32 `json:"type_id"`
	Type         string `json:"type"`
	Value        int32  `json:"value"`
	Source       string `json:"source,omitempty"`
	Destination  string `json:"destination,omitempty"`
	FrequencyMHz uint32 `json:"frequency_mhz,omitempty"`
	Band         string `json:"band,omitempty"`
	Channel      int    `json:"channel,omitempty"`
	Auxiliary    uint32 `json:"auxiliary"`
}

type Health struct {
	State                 string   `json:"state"`
	Reasons               []string `json:"reasons"`
	EventHistoryGap       bool     `json:"event_history_gap"`
	OldestEventSequence   uint64   `json:"oldest_event_sequence"`
	LatestEventSequence   uint64   `json:"latest_event_sequence"`
	TelemetrySequenceFrom uint64   `json:"telemetry_sequence_from"`
	TelemetrySequenceTo   uint64   `json:"telemetry_sequence_to"`
}

type Artifact struct {
	Path         string `json:"path,omitempty"`
	ResolvedPath string `json:"resolved_path,omitempty"`
	SHA256       string `json:"sha256,omitempty"`
	Available    bool   `json:"available"`
	Error        string `json:"error,omitempty"`
}

type Artifacts struct {
	StartupConfig Artifact `json:"startup_config"`
	DaemonBinary  Artifact `json:"daemon_binary"`
}

type Snapshot struct {
	SchemaVersion      int               `json:"schema_version"`
	Sequence           uint64            `json:"sequence"`
	CapturedAt         time.Time         `json:"captured_at"`
	Daemon             Daemon            `json:"daemon"`
	Stations           []Station         `json:"stations"`
	PairLinks          []Link            `json:"pair_links"`
	FrequencyOverrides []FrequencyLink   `json:"frequency_overrides"`
	PacketMetrics      PacketMetrics     `json:"packet_metrics"`
	RadioFrequencies   []RadioFrequency  `json:"radio_frequencies"`
	ActiveLinks        []ActiveLink      `json:"active_links"`
	Associations       []Association     `json:"associations"`
	VIFs               []VIF             `json:"vifs"`
	Events             []TelemetryEvent  `json:"events"`
	Health             Health            `json:"health"`
	IdentityInventory  IdentityInventory `json:"identity_inventory"`
	Artifacts          Artifacts         `json:"artifacts"`
}

func NewSnapshot() Snapshot {
	return Snapshot{
		SchemaVersion: 2,
		PacketMetrics: PacketMetrics{
			Available: false,
			Reason:    "endpoint does not advertise paged telemetry counters",
		},
		Health: Health{State: "unavailable", Reasons: []string{"telemetry unavailable"}},
	}
}

func BandAndChannel(frequencyMHz uint32) (string, int) {
	switch {
	case frequencyMHz == 2484:
		return "2.4GHz", 14
	case frequencyMHz >= 2412 && frequencyMHz <= 2472:
		return "2.4GHz", int((frequencyMHz - 2407) / 5)
	case frequencyMHz >= 5000 && frequencyMHz <= 5895:
		return "5GHz", int((frequencyMHz - 5000) / 5)
	case frequencyMHz >= 5955 && frequencyMHz <= 7115:
		return "6GHz", int((frequencyMHz - 5950) / 5)
	default:
		return "unknown", 0
	}
}

func EventTypeName(value uint32) string {
	switch value {
	case 1:
		return "vif_learned"
	case 2:
		return "vif_changed"
	case 3:
		return "link_active"
	case 4:
		return "generation_applied"
	case 5:
		return "netlink_rejection"
	case 6:
		return "active_link_evicted"
	default:
		return fmt.Sprintf("unknown_%d", value)
	}
}

func StationsFromLinks(links []Link) []Station {
	set := make(map[string]struct{})
	for _, link := range links {
		set[link.Source] = struct{}{}
		set[link.Destination] = struct{}{}
	}
	macs := make([]string, 0, len(set))
	for mac := range set {
		macs = append(macs, mac)
	}
	sort.Strings(macs)
	stations := make([]Station, len(macs))
	for index, mac := range macs {
		stations[index] = Station{Index: index, MAC: mac}
	}
	return stations
}

func (s Snapshot) Validate() error {
	if s.Daemon.InstanceID == "" {
		return fmt.Errorf("daemon instance ID is empty")
	}
	if len(s.Stations) != int(s.Daemon.NumStations) {
		return fmt.Errorf("daemon reports %d stations, dump identifies %d", s.Daemon.NumStations, len(s.Stations))
	}
	wantLinks := int(s.Daemon.NumStations) * (int(s.Daemon.NumStations) - 1)
	if len(s.PairLinks) != wantLinks {
		return fmt.Errorf("daemon reports %d stations, got %d pair links, want %d", s.Daemon.NumStations, len(s.PairLinks), wantLinks)
	}
	stations := make(map[string]struct{}, len(s.Stations))
	for _, station := range s.Stations {
		stations[station.MAC] = struct{}{}
	}
	pairs := make(map[string]struct{}, len(s.PairLinks))
	for _, link := range s.PairLinks {
		if link.Source == link.Destination {
			return fmt.Errorf("pair dump contains self link %s", link.Source)
		}
		if _, ok := stations[link.Source]; !ok {
			return fmt.Errorf("pair dump contains unknown source %s", link.Source)
		}
		if _, ok := stations[link.Destination]; !ok {
			return fmt.Errorf("pair dump contains unknown destination %s", link.Destination)
		}
		key := link.Source + ">" + link.Destination
		if _, exists := pairs[key]; exists {
			return fmt.Errorf("pair dump contains duplicate %s", key)
		}
		pairs[key] = struct{}{}
	}
	for _, link := range s.FrequencyOverrides {
		if _, ok := stations[link.Source]; !ok {
			return fmt.Errorf("frequency dump contains unknown source %s", link.Source)
		}
		if _, ok := stations[link.Destination]; !ok {
			return fmt.Errorf("frequency dump contains unknown destination %s", link.Destination)
		}
		if !link.Override {
			return fmt.Errorf("frequency dump contains inactive override %s>%s@%d", link.Source, link.Destination, link.FrequencyMHz)
		}
	}
	return nil
}
