package web

import "embed"

// Assets is served by the observer binary; no external Web root is required.
//
//go:embed index.html app.js graph-layout.js style.css
var Assets embed.FS
