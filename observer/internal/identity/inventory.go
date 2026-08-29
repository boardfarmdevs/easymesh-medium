package identity

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/model"
)

const (
	maxInventoryBytes = 1024 * 1024
	maxIdentities     = 512
)

type Inventory struct {
	SchemaVersion int        `json:"schema_version"`
	GeneratedAt   time.Time  `json:"generated_at"`
	Stations      []Identity `json:"stations"`
}

type Identity struct {
	MAC       string `json:"mac"`
	Label     string `json:"label,omitempty"`
	Role      string `json:"role,omitempty"`
	Owner     string `json:"owner,omitempty"`
	Interface string `json:"interface,omitempty"`
}

type Loader struct{ Path string }

// Apply reads a bounded, unprivileged handoff file and enriches known radios.
// Absence or invalid input is visible in the snapshot but never hides medium
// telemetry. Discovery and privileged LXD calls intentionally remain outside
// this process.
func (l Loader) Apply(snapshot *model.Snapshot) {
	status := model.IdentityInventory{Path: filepath.Clean(l.Path)}
	if l.Path == "" {
		status.Path = ""
		status.Error = "identity inventory is not configured"
		snapshot.IdentityInventory = status
		return
	}
	inventory, err := load(l.Path)
	if err != nil {
		status.Error = err.Error()
		snapshot.IdentityInventory = status
		return
	}
	identities := make(map[string]Identity, len(inventory.Stations))
	for _, identity := range inventory.Stations {
		identities[identity.MAC] = identity
	}
	matched := 0
	for index := range snapshot.Stations {
		identity, ok := identities[snapshot.Stations[index].MAC]
		if !ok {
			continue
		}
		snapshot.Stations[index].Label = identity.Label
		snapshot.Stations[index].Role = identity.Role
		snapshot.Stations[index].Owner = identity.Owner
		snapshot.Stations[index].Interface = identity.Interface
		matched++
	}
	snapshot.IdentityInventory = model.IdentityInventory{Available: true, Path: filepath.Clean(l.Path), GeneratedAt: inventory.GeneratedAt, Entries: len(inventory.Stations), Matched: matched}
}

func load(path string) (Inventory, error) {
	info, err := os.Stat(path)
	if err != nil {
		return Inventory{}, err
	}
	if !info.Mode().IsRegular() {
		return Inventory{}, fmt.Errorf("inventory is not a regular file")
	}
	if info.Size() > maxInventoryBytes {
		return Inventory{}, fmt.Errorf("inventory is %d bytes; limit is %d", info.Size(), maxInventoryBytes)
	}
	file, err := os.Open(path)
	if err != nil {
		return Inventory{}, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxInventoryBytes+1))
	if err != nil {
		return Inventory{}, err
	}
	if len(data) > maxInventoryBytes {
		return Inventory{}, fmt.Errorf("inventory grew beyond %d-byte limit while reading", maxInventoryBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var inventory Inventory
	if err := decoder.Decode(&inventory); err != nil {
		return Inventory{}, fmt.Errorf("decode inventory: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return Inventory{}, fmt.Errorf("inventory must contain one JSON object")
	}
	if inventory.SchemaVersion != 1 {
		return Inventory{}, fmt.Errorf("unsupported identity inventory schema %d", inventory.SchemaVersion)
	}
	if inventory.GeneratedAt.IsZero() {
		return Inventory{}, fmt.Errorf("generated_at is required")
	}
	if len(inventory.Stations) > maxIdentities {
		return Inventory{}, fmt.Errorf("inventory has %d identities; limit is %d", len(inventory.Stations), maxIdentities)
	}
	seen := make(map[string]struct{}, len(inventory.Stations))
	for index := range inventory.Stations {
		identity := &inventory.Stations[index]
		parsed, err := net.ParseMAC(identity.MAC)
		if err != nil || len(parsed) != 6 {
			return Inventory{}, fmt.Errorf("stations[%d].mac is not a six-octet MAC address", index)
		}
		identity.MAC = strings.ToLower(parsed.String())
		if _, exists := seen[identity.MAC]; exists {
			return Inventory{}, fmt.Errorf("duplicate identity %s", identity.MAC)
		}
		seen[identity.MAC] = struct{}{}
		if err := validText("label", identity.Label, 64); err != nil {
			return Inventory{}, fmt.Errorf("stations[%d]: %w", index, err)
		}
		if err := validText("role", identity.Role, 40); err != nil {
			return Inventory{}, fmt.Errorf("stations[%d]: %w", index, err)
		}
		if err := validText("owner", identity.Owner, 64); err != nil {
			return Inventory{}, fmt.Errorf("stations[%d]: %w", index, err)
		}
		if err := validText("interface", identity.Interface, 32); err != nil {
			return Inventory{}, fmt.Errorf("stations[%d]: %w", index, err)
		}
		if identity.Label == "" && identity.Role == "" && identity.Owner == "" && identity.Interface == "" {
			return Inventory{}, fmt.Errorf("stations[%d] has no identity fields", index)
		}
	}
	return inventory, nil
}

func validText(name, value string, limit int) error {
	if len(value) > limit {
		return fmt.Errorf("%s exceeds %d bytes", name, limit)
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return fmt.Errorf("%s contains a control character", name)
		}
	}
	return nil
}
