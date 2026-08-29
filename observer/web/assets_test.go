package web

import (
	"io/fs"
	"strings"
	"testing"
)

func TestEmbeddedConsoleContainsPhase2ViewsAndTypedControls(t *testing.T) {
	html, err := fs.ReadFile(Assets, "index.html")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"wmediumd Console", "Current associations", "Packet paths (debug)", "Radio / frequency counters", "VIF → hwsim radio mapping", "not association", "Event timeline", "Radio identities", "Set pair SNR", "Clear frequency override", "Undo last"} {
		if !strings.Contains(string(html), want) {
			t.Errorf("index.html missing %q", want)
		}
	}
	javascript, err := fs.ReadFile(Assets, "app.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"/api/v1/controls/pairs/set", "/api/v1/controls/frequencies/set", "/api/v1/controls/frequencies/clear", "/api/v1/controls/undo", "X-Wmediumd-CSRF", "active_links", "radio_frequencies", "identity_inventory", "station.label", "WMediumdGraph.layoutStations", "WMediumdGraph.edgeRoute", "WMediumdGraph.associationsForSelected", "WMediumdGraph.labelFontSize"} {
		if !strings.Contains(string(javascript), want) {
			t.Errorf("app.js missing %q", want)
		}
	}
	if strings.Contains(string(javascript), "innerHTML") {
		t.Fatal("UI uses innerHTML with live protocol data")
	}
	layout, err := fs.ReadFile(Assets, "graph-layout.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"layoutStations", "edgePath", "labelFontSize", "quadraticCollisionFree"} {
		if !strings.Contains(string(layout), want) {
			t.Errorf("graph-layout.js missing %q", want)
		}
	}
}
