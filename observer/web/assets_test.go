package web

import (
	"encoding/json"
	"errors"
	"io/fs"
	"strings"
	"testing"
)

func TestSharedRFAssets(tester *testing.T) {
	encoded, err := fs.ReadFile(Assets, "ng/rf-catalog.json")
	if err != nil {
		tester.Fatal(err)
	}
	var catalog struct {
		Schema     string           `json:"schema"`
		Properties []map[string]any `json:"properties"`
	}
	if err := json.Unmarshal(encoded, &catalog); err != nil || catalog.Schema != "easymesh.rf-properties.v1" || len(catalog.Properties) < 20 {
		tester.Fatal("missing shared RF property catalog", err)
	}
	manual, err := fs.ReadFile(Assets, "ng/rf-properties.html")
	if err != nil || !strings.Contains(string(manual), "Shared RF observations") {
		tester.Fatal("missing shared RF operator guidance", err)
	}
}

func TestEmbeddedConsoleNGViews(tester *testing.T) {
	html, err := fs.ReadFile(Assets, "ng/index.html")
	if err != nil {
		tester.Fatal(err)
	}
	for _, want := range []string{
		"wmediumd console ng", "No RF controls are enabled", "Configuration is not an association",
		`value="observed"`, `value="configured"`, `value="matrix"`, `value="room"`,
		`id="scene"`, `role="treegrid"`, `id="search"`, `id="frequency"`, `id="presence"`,
		`id="pool"`, `id="services-toggle"`, `id="events-enabled"`, `id="timeline"`,
		`data-tab="rf"`, `data-tab="traffic"`, `data-tab="load"`, `data-tab="evidence"`,
		`id="freeze"`, `id="export"`, `href="/ng/manual.html"`, `href="/ng/rf-properties.html"`,
		`<script type="module" src="/ng/app.mjs">`,
	} {
		if !strings.Contains(string(html), want) {
			tester.Errorf("ng/index.html missing %q", want)
		}
	}
	for _, retired := range []string{"Set pair SNR", "Clear frequency override", "Undo last"} {
		if strings.Contains(string(html), retired) {
			tester.Errorf("read-only console contains retired control %q", retired)
		}
	}
}

func TestEmbeddedConsoleNGDependenciesAndRetiredAssets(tester *testing.T) {
	for _, filename := range []string{
		"ng/app.mjs", "ng/client.mjs", "ng/worker.mjs", "ng/model.mjs", "ng/scene.mjs",
		"ng/style.css", "ng/vendor/three.js", "ng/vendor/THREE-LICENSE.txt",
		"ng/manual.html", "ng/rf-properties.html", "ng/rf-catalog.json",
	} {
		contents, err := fs.ReadFile(Assets, filename)
		if err != nil || len(contents) == 0 {
			tester.Errorf("embedded dependency %s missing or empty: %v", filename, err)
		}
	}
	for _, filename := range []string{"index.html", "app.js", "graph-layout.js"} {
		if _, err := fs.Stat(Assets, filename); !errors.Is(err, fs.ErrNotExist) {
			tester.Errorf("retired asset %s must not be embedded: %v", filename, err)
		}
	}
}

func TestEmbeddedConsoleNGReadOnlyModuleWiring(tester *testing.T) {
	for filename, required := range map[string][]string{
		"ng/app.mjs": {"./client.mjs", "./scene.mjs", "./model.mjs", "new Worker('/ng/worker.mjs'",
			"/api/v2/rf-catalog", "/api/v2/export", "textContent"},
		"ng/client.mjs": {"./model.mjs", "/api/v2/stream", "subscribe", "unsubscribe"},
		"ng/worker.mjs": {"./model.mjs", "model.explore", "self.postMessage"},
		"ng/scene.mjs":  {"./vendor/three.js", "./model.mjs", "textContent"},
		"ng/model.mjs":  {"nativeLoadValue", "room-excluded"},
	} {
		tester.Run(filename, func(tester *testing.T) {
			contents, err := fs.ReadFile(Assets, filename)
			if err != nil {
				tester.Fatal(err)
			}
			for _, want := range required {
				if !strings.Contains(string(contents), want) {
					tester.Errorf("missing NG module contract %q", want)
				}
			}
			for _, forbidden := range []string{"innerHTML", "outerHTML", "insertAdjacentHTML", "/api/v1/controls/", "X-Wmediumd-CSRF"} {
				if strings.Contains(string(contents), forbidden) {
					tester.Errorf("unsafe rendering or retired RF-control wiring: %q", forbidden)
				}
			}
		})
	}
}
