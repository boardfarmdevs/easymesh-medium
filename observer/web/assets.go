package web

import "embed"

// Assets is served by the observer binary; no external Web root is required.
//
//go:embed ng
var Assets embed.FS
