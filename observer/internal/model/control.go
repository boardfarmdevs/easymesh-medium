package model

import "time"

type PairUpdate struct {
	Source      string `json:"source"`
	Destination string `json:"destination"`
	SNRDB       int16  `json:"snr_db"`
}

type FrequencyTarget struct {
	Source       string `json:"source"`
	Destination  string `json:"destination"`
	FrequencyMHz uint32 `json:"frequency_mhz"`
}

type FrequencyUpdate struct {
	Source       string `json:"source"`
	Destination  string `json:"destination"`
	FrequencyMHz uint32 `json:"frequency_mhz"`
	SNRDB        int16  `json:"snr_db"`
}

type ControlRequest struct {
	ExpectedInstanceID string `json:"expected_instance_id"`
	ExpectedGeneration uint64 `json:"expected_generation"`
}

type PairControlRequest struct {
	ControlRequest
	Updates []PairUpdate `json:"updates"`
}

type FrequencyControlRequest struct {
	ControlRequest
	Updates []FrequencyUpdate `json:"updates"`
}

type FrequencyClearRequest struct {
	ControlRequest
	Targets []FrequencyTarget `json:"targets"`
}

type ControlResult struct {
	TransactionID string    `json:"transaction_id"`
	Operation     string    `json:"operation"`
	InstanceID    string    `json:"instance_id"`
	Generation    uint64    `json:"generation"`
	Updates       int       `json:"updates"`
	UndoAvailable bool      `json:"undo_available"`
	AppliedAt     time.Time `json:"applied_at"`
}

type UndoStatus struct {
	Available  bool   `json:"available"`
	Operation  string `json:"operation,omitempty"`
	Generation uint64 `json:"generation,omitempty"`
}

type ControlStatus struct {
	Enabled    bool       `json:"enabled"`
	Mode       string     `json:"mode"`
	Reason     string     `json:"reason,omitempty"`
	CSRFToken  string     `json:"csrf_token,omitempty"`
	Operations []string   `json:"operations"`
	Undo       UndoStatus `json:"undo"`
	Prohibited []string   `json:"prohibited"`
}
