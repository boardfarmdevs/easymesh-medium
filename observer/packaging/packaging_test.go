package packaging

import (
	"os"
	"strings"
	"testing"
)

func TestManagedServiceIsUnprivilegedAndReadOnlyByDefault(t *testing.T) {
	unit, err := os.ReadFile("wmediumd-console.service")
	if err != nil {
		t.Fatal(err)
	}
	text := string(unit)
	for _, want := range []string{"User=wmediumd-console", "Group=wmediumd-console", "SupplementaryGroups=lxd", "NoNewPrivileges=true", "CapabilityBoundingSet=", "ProtectSystem=strict", "InaccessiblePaths=-/var/snap/lxd/common/lxd/unix.socket", "--socket=${WMEDIUMD_CONSOLE_SOCKET}", "--identity-inventory=${WMEDIUMD_CONSOLE_IDENTITY_INVENTORY}"} {
		if !strings.Contains(text, want) {
			t.Errorf("service missing %q", want)
		}
	}
	execLine := ""
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "ExecStart=") {
			execLine = line
		}
	}
	if execLine == "" || strings.Contains(execLine, "--enable-control") || strings.Contains(execLine, "/bin/sh") {
		t.Fatalf("unsafe ExecStart: %q", execLine)
	}
	defaults, err := os.ReadFile("wmediumd-console.default")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(defaults), "WMEDIUMD_CONSOLE_EXTRA_ARGS=\n") {
		t.Fatal("default configuration does not leave controls disabled")
	}
}

func TestInstallerConsumesPrebuiltBinaryWithoutDiscovery(t *testing.T) {
	installer, err := os.ReadFile("../install.sh")
	if err != nil {
		t.Fatal(err)
	}
	text := string(installer)
	for _, forbidden := range []string{"go build", "lxc list", "lxc exec", "/var/snap/lxd", "docker ", "eval ", "sh -c"} {
		if strings.Contains(text, forbidden) {
			t.Errorf("installer contains forbidden runtime/discovery operation %q", forbidden)
		}
	}
	info, err := os.Stat("../install.sh")
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&0111 == 0 {
		t.Fatal("install.sh is not executable")
	}
}

func TestMediumStartupPublishesIdentityInventory(t *testing.T) {
	startup, err := os.ReadFile("../../wmediumd-up.sh")
	if err != nil {
		t.Fatal(err)
	}
	text := string(startup)
	for _, want := range []string{
		"IDENTITY=${WMEDIUMD_IDENTITY_INVENTORY:-$RUNTIME/identity-inventory.json}",
		"IDENTITY_GENERATOR=${WMEDIUMD_IDENTITY_GENERATOR:-$HERE/observer/generate-identity-inventory.sh}",
		`"$IDENTITY_GENERATOR" --output "$IDENTITY"`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("wmediumd-up.sh missing identity handoff %q", want)
		}
	}
}
