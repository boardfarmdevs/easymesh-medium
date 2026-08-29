package model

import "testing"

func TestBandAndChannel(t *testing.T) {
	tests := []struct {
		frequency uint32
		band      string
		channel   int
	}{
		{2437, "2.4GHz", 6},
		{2484, "2.4GHz", 14},
		{5180, "5GHz", 36},
		{5955, "6GHz", 1},
		{6135, "6GHz", 37},
		{9000, "unknown", 0},
	}
	for _, test := range tests {
		band, channel := BandAndChannel(test.frequency)
		if band != test.band || channel != test.channel {
			t.Errorf("BandAndChannel(%d) = %s/%d, want %s/%d", test.frequency, band, channel, test.band, test.channel)
		}
	}
}

func TestSnapshotValidation(t *testing.T) {
	snapshot := NewSnapshot()
	snapshot.Daemon = Daemon{InstanceID: "abc", NumStations: 2}
	snapshot.PairLinks = []Link{
		{Source: "42:00:00:00:01:00", Destination: "42:00:00:00:02:00"},
		{Source: "42:00:00:00:02:00", Destination: "42:00:00:00:01:00"},
	}
	snapshot.Stations = StationsFromLinks(snapshot.PairLinks)
	if err := snapshot.Validate(); err != nil {
		t.Fatalf("valid snapshot rejected: %v", err)
	}
	snapshot.PairLinks = snapshot.PairLinks[:1]
	if err := snapshot.Validate(); err == nil {
		t.Fatal("incomplete pair dump was accepted")
	}
}
