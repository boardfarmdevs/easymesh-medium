package identity

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/gen/wmediumd/observer/internal/model"
)

func TestOperatorGeneratorUsesHWSIMTransmitterIdentityAndLXCIntent(t *testing.T) {
	generator, err := filepath.Abs("../../generate-identity-inventory.sh")
	if err != nil {
		t.Fatal(err)
	}
	fakeLXC, err := filepath.Abs("testdata/fake-lxc.sh")
	if err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(t.TempDir(), "identity-inventory.json")
	topology := filepath.Join(t.TempDir(), "topology.json")
	if err := os.WriteFile(topology, []byte(`{"nodes":[{"id":"02:00:00:00:02:20","name":"Extender-7"},{"id":"02:00:00:00:03:20","name":"Extender-2"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(generator, "--output", output)
	command.Env = append(os.Environ(), "LXC="+fakeLXC, "WMEDIUMD_EASYMESH_TOPOLOGY_FILE="+topology)
	if result, err := command.CombinedOutput(); err != nil {
		t.Fatalf("generator: %v\n%s", err, result)
	}
	inventory, err := load(output)
	if err != nil {
		t.Fatalf("generated schema: %v", err)
	}
	if len(inventory.Stations) != 5 {
		t.Fatalf("generated %d stations, want 5", len(inventory.Stations))
	}
	want := map[string][3]string{
		"42:00:00:00:01:00": {"Agent-1", "controller-agent", ""},
		"42:00:00:00:02:00": {"Extender-7", "extender", ""},
		"42:00:00:00:03:00": {"Extender-2", "extender", ""},
		"42:00:00:00:04:00": {"sta-04", "wlan-client", "wlan0"},
		"42:00:00:00:05:00": {"iot-05", "iot-client", "wlan0"},
	}
	for _, identity := range inventory.Stations {
		expected, ok := want[identity.MAC]
		if !ok {
			t.Errorf("unexpected transmitter MAC %s", identity.MAC)
			continue
		}
		if identity.Label != expected[0] || identity.Role != expected[1] || identity.Owner == "" || identity.Interface != expected[2] {
			t.Errorf("identity = %+v, want %v", identity, expected)
		}
	}
	info, err := os.Stat(output)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0644 {
		t.Errorf("inventory mode = %o, want 644", info.Mode().Perm())
	}
}

func TestApplyEnrichesOnlyMatchingStations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identities.json")
	writeInventory(t, path, `{"schema_version":1,"generated_at":"2026-08-23T12:00:00Z","stations":[{"mac":"42-00-00-00-01-00","label":"gateway-5g","role":"controller-radio","owner":"bpibroadband","interface":"virt-wlan0"},{"mac":"42:00:00:00:09:00","label":"unused"}]}`)
	snapshot := model.Snapshot{Stations: []model.Station{{MAC: "42:00:00:00:01:00"}, {MAC: "42:00:00:00:02:00"}}}
	Loader{Path: path}.Apply(&snapshot)
	if !snapshot.IdentityInventory.Available || snapshot.IdentityInventory.Entries != 2 || snapshot.IdentityInventory.Matched != 1 {
		t.Fatalf("inventory status: %+v", snapshot.IdentityInventory)
	}
	got := snapshot.Stations[0]
	if got.Label != "gateway-5g" || got.Role != "controller-radio" || got.Owner != "bpibroadband" || got.Interface != "virt-wlan0" {
		t.Fatalf("identity not applied: %+v", got)
	}
	if snapshot.Stations[1].Label != "" {
		t.Fatalf("unmatched station changed: %+v", snapshot.Stations[1])
	}
}

func TestInvalidInventoryIsNonFatalAndBounded(t *testing.T) {
	tests := []struct{ name, content, want string }{
		{"unknown field", `{"schema_version":1,"generated_at":"2026-08-23T12:00:00Z","stations":[],"command":"lxc list"}`, "unknown field"},
		{"duplicate", `{"schema_version":1,"generated_at":"2026-08-23T12:00:00Z","stations":[{"mac":"42:00:00:00:01:00","label":"a"},{"mac":"42:00:00:00:01:00","label":"b"}]}`, "duplicate identity"},
		{"bad mac", `{"schema_version":1,"generated_at":"2026-08-23T12:00:00Z","stations":[{"mac":"bad","label":"a"}]}`, "six-octet"},
		{"control character", `{"schema_version":1,"generated_at":"2026-08-23T12:00:00Z","stations":[{"mac":"42:00:00:00:01:00","label":"a\nb"}]}`, "control character"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "inventory.json")
			writeInventory(t, path, test.content)
			snapshot := model.Snapshot{}
			Loader{Path: path}.Apply(&snapshot)
			if snapshot.IdentityInventory.Available || !strings.Contains(snapshot.IdentityInventory.Error, test.want) {
				t.Fatalf("status = %+v", snapshot.IdentityInventory)
			}
		})
	}
	t.Run("oversize", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "inventory.json")
		writeInventory(t, path, strings.Repeat("x", maxInventoryBytes+1))
		snapshot := model.Snapshot{}
		Loader{Path: path}.Apply(&snapshot)
		if !strings.Contains(snapshot.IdentityInventory.Error, "limit") {
			t.Fatalf("status = %+v", snapshot.IdentityInventory)
		}
	})
}

func TestMissingInventoryDoesNotChangeTelemetry(t *testing.T) {
	snapshot := model.Snapshot{Stations: []model.Station{{MAC: "42:00:00:00:01:00"}}}
	Loader{Path: filepath.Join(t.TempDir(), "missing.json")}.Apply(&snapshot)
	if snapshot.IdentityInventory.Available || snapshot.IdentityInventory.Error == "" || snapshot.Stations[0].MAC == "" {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
}
func writeInventory(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}
