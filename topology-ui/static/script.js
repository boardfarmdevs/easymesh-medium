/*
 
  If not stated otherwise in this file or this component's LICENSE file the
  following copyright and licenses apply:
 
  Copyright 2023 RDK Management
 
  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at
 
  http://www.apache.org/licenses/LICENSE-2.0
 
  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

/**
 * EasyMesh R6 Pro Controller - Advanced JavaScript Application
 * Professional mesh network management interface
 * Supports Wi-Fi 7, Multi-AP R6, real-time monitoring
 */

const signalMeter = typeof module !== 'undefined' && module.exports
  ? require('./signal-meter.js') : window.EasyMeshSignalMeter;
const roomTopology = typeof module !== 'undefined' && module.exports
  ? require('./room-topology.js') : window.RoomTopology;
const steeringCues = typeof module !== 'undefined' && module.exports
  ? require('./steering-cues.js') : window.SteeringCues;

class EasyMeshController {
  constructor() {
    this.apiBase = '/api/v1';
    this.wsConnection = null;
    // The stack's profile (static/ui-profile.js, one per stack: topology-ui/profiles):
    // its default tab, the tabs its backend serves (null: all), charts, the WebSocket.
    this.profile = (typeof window !== 'undefined' && window.EASYMESH_UI_PROFILE) || {};
    this.applyProfileBranding();
    this.currentTab = this.profile.defaultTab || 'dashboard';
    this.supportedTabs = Array.isArray(this.profile.tabs) ? new Set(this.profile.tabs) : null;
    this.devices = [];
    this.devicesRefreshInFlight = false;
    this.clients = [];
    this.clientsRefreshInFlight = false;
    this.topology = {};
    this.staPositionCache = new Map();
    this.staMoveEffects = new Map();
    this.topologyResizeFrame = null;
    this.topologyResizeObserver = null;
    this.charts = {};
    this.refreshIntervals = {};
    this.policyByDeviceId = {};
    this.updatedPolicySettings = [];
    this.isConnected = false;

    // Chart.js configuration
    this.chartDefaults = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { usePointStyle: true, padding: 20 }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(0,0,0,0.05)' } },
        y: { grid: { color: 'rgba(0,0,0,0.05)' }, beginAtZero: true }
      }
    };

    // Notification system
    this.notifications = [];
    this.maxNotifications = 50;

    // Performance monitoring
    this.performanceMetrics = {
      throughput: [],
      latency: [],
      utilization: [],
      clients: []
    };

    // Security monitoring
    this.securityEvents = [];
    this.threatLevel = 'low';

    // Settings cache
    this.systemConfig = {};
  }

  /**
   * Initialize the application
   */
  async init() {
    console.log('🚀 Initializing EasyMesh R6 Pro Controller');
    this.roomLayout = new roomTopology.Follower(this);

    try {
      // Setup event handlers
      this.setupEventHandlers();

      // Initialize WebSocket connection
      this.initializeWebSocket();

      // Load initial data
      await this.loadInitialData();

      // Start refresh timers
      this.startRefreshTimers();

      // Initialize charts (the dashboard's), where the backend serves them
      if (this.profile.charts !== false) this.initializeCharts();

      // Show the profile's default tab
      this.showTab(this.currentTab);

      console.log('✅ EasyMesh Controller initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize controller:', error);
      this.showNotification('Failed to initialize controller', 'error');
    }
  }

  /**
   * Setup all event handlers
   */
  setupEventHandlers() {
    // Navigation
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = e.currentTarget.dataset.tab;
        this.showTab(tab);
      });
    });

    // Global search
    const globalSearch = document.getElementById('global-search');
    if (globalSearch) {
      globalSearch.addEventListener('input', (e) => {
        this.handleGlobalSearch?.(e.target.value);
      });
    }

    // Notifications
    const notificationsBtn = document.getElementById('notifications-btn');
    if (notificationsBtn) {
      notificationsBtn.addEventListener('click', () => {
        this.toggleNotificationPanel?.();
      });
    }

    const closeNotifications = document.getElementById('close-notifications');
    if (closeNotifications) {
      closeNotifications.addEventListener('click', () => {
        this.closeNotificationPanel?.();
      });
    }

    // user-avatar
    const avatar = document.getElementById('user-avatar');
    const dialog = document.getElementById('ipPortDialog');
    const ipInput = document.getElementById('ip');
    const portInput = document.getElementById('port');
    avatar.addEventListener('click', () => {
      // Fetch existing configuration from backend
      fetch('/api/v1/controllerIPConfig', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      })
      .then(response => {
        if (!response.ok) {
          throw new Error('Failed to fetch current configuration');
        }
        return response.json();
      })
      .then(data => {
        // Populate fields with existing values
        ipInput.value = data.ip || '';
        portInput.value = data.port || '';
        dialog.style.display = 'flex';
      })
      .catch(error => {
        alert(`Error fetching configuration: ${error.message}`);
        dialog.style.display = 'flex'; // Still show dialog even if fetch fails
      });
    });

    const closeBtn = document.getElementById('closeBtn');
    closeBtn.addEventListener('click', () => {
      dialog.style.display = 'none';
    });

    const saveBtn = document.getElementById('saveBtn');
    saveBtn.addEventListener('click', () => {
      const ip = ipInput.value;
      const port = portInput.value;

      if (!ip || !port) {
        alert('Please enter both IP and Port.');
        return;
      }

      // Send data to Go backend
      fetch('/api/v1/controllerIPConfig', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ip, port })
      })
      .then(response => {
        if (!response.ok) {
          throw new Error('Failed to configure IP and Port');
        }
        return response.json();
      })
      .then(data => {
        alert(`Configuration successful: ${data.message}`);
        dialog.style.display = 'none';
      })
      .catch(error => {
        alert(`Error: ${error.message}`);
      });
    });

    // Dashboard actions
    document.getElementById('refresh-dashboard')?.addEventListener('click', () => {
      this.refreshDashboard();
    });

    document.getElementById('optimize-network')?.addEventListener('click', () => {
      this.optimizeNetwork();
    });

    document.getElementById('optimize-topology')?.addEventListener('click', () => {
      this.optimizeTopologyLayout();
    });

    const exportTopologyButton = document.getElementById('export-topology');
    const exportTopologyMenu = document.getElementById('topology-export-menu');
    exportTopologyButton?.addEventListener('click', (event) => {
      event.stopPropagation();
      const opening = exportTopologyMenu.hidden;
      exportTopologyMenu.hidden = !opening;
      exportTopologyButton.setAttribute('aria-expanded', String(opening));
      if (opening) exportTopologyMenu.querySelector('button')?.focus();
    });

    exportTopologyMenu?.addEventListener('click', (event) => {
      const item = event.target.closest('[data-topology-export]');
      if (!item) return;
      exportTopologyMenu.hidden = true;
      exportTopologyButton?.setAttribute('aria-expanded', 'false');
      this.exportTopology(item.dataset.topologyExport);
    });

    document.addEventListener('click', () => {
      if (!exportTopologyMenu?.hidden) {
        exportTopologyMenu.hidden = true;
        exportTopologyButton?.setAttribute('aria-expanded', 'false');
      }
    });
     
    // Performance tab refresh
    document.getElementById('refresh-performance')?.addEventListener('click', () => {
      this.loadPerformanceData();
      this.showNotification('Performance data refreshed', 'success');
    });

    // Time range selectors
    document.querySelectorAll('[data-range]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.setTimeRange(e.target.dataset.range);
      });
    });

    // Band selectors for RF analysis
    document.querySelectorAll('.band-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.setBand(e.target.dataset.band);
      });
    });

    // Settings navigation
    document.querySelectorAll('.settings-nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.showSettingsSection(e.target.getAttribute('href').substring(1));
      });
    });

    // Modal handlers
    window.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-overlay')) {
        this.closeAllModals();
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      this.handleKeyboardShortcuts(e);
    });

    // Wifi reset
    document.getElementById('reset-btn')?.addEventListener('click', () => {
      this.handleWifiResetApply();
    });

    document.addEventListener("change", (e) => {
      if (e.target && e.target.id === "device-selector") {
        const deviceId = e.target.value;
        const policy = this.policyByDeviceId[deviceId];
        populatePolicyUI(policy);
      }
    });

    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".apply-section");
      if (!btn) return;

      // Section key from the Save button
      const sectionKey = btn.getAttribute("data-section");
      if (!sectionKey) return;

      const section = btn.closest(".policy-card");
      if (!section) return;

      const scope = section.querySelector('input[type="radio"]:checked')?.value || "selected";

      // Collect the section's values from the form/table
      this.savePolicySettings(sectionKey, scope);

    });

    document.querySelector("#report-unassoc-sta")?.addEventListener("change", toggleMaxRateField);
    const applyPolicyBtn = document.getElementById('apply-policy-settings');
    if (applyPolicyBtn) {
      applyPolicyBtn.addEventListener('click', () => this.handlePolicySettingApply());
    }
    document.getElementById('enable-all-metrics')?.addEventListener('click', () => {
      this.enableAllMetricsReporting();
    });

    // Local Steering disallowed mac: + / - buttons
    (() => {
      const localBody = document.querySelector("#localMacBody");
      const localAdd  = document.getElementById("add-mac-inline");
      const localRem  = document.getElementById("remove-selected-inline");
      const localAll  = document.getElementById("select-all-local");

      // Select-all behavior
      if (localAll && localBody) {
        localAll.addEventListener("change", () => {
          localBody.querySelectorAll('input.row-select').forEach(cb => cb.checked = localAll.checked);
          this.updateSelectAllState(localBody, localAll);
        });
        localBody.addEventListener("change", (e) => {
          if (e.target && e.target.matches('input.row-select')) {
            this.updateSelectAllState(localBody, localAll);
          }
        });
      }
      // + button: Add inline row for user to type MAC
      localAdd?.addEventListener("click", () =>
        this.addDisallowedMacRow(localBody, localAll)
      );

      // - button: Remove selected rows
      localRem?.addEventListener("click", () => {
        const removed = this.removeSelectedRows(localBody, localAll);
        if (removed > 0) this.showNotification?.(`${removed} MAC${removed > 1 ? "s" : ""} removed`, "success");
      });

      // Refresh select-all state afterward.
      document.addEventListener("change", (e) => {
        if (e.target && e.target.id === "device-selector") {
          setTimeout(() => {
            this.updateSelectAllState(localBody, localAll);
          }, 0);
        }
      });
    })();

    // BTM Steering disallowed mac: + / - buttons
    (() => {
      const tbody = document.querySelector("#btmMacBody");
      const addBtn = document.getElementById("add-btm-inline");
      const remBtn = document.getElementById("remove-btm-inline");
      const selectAll = document.getElementById("select-all-btm");

      if (tbody && selectAll) {
        selectAll.addEventListener("change", () => {
          tbody.querySelectorAll('input.row-select').forEach(cb => cb.checked = selectAll.checked);
          this.updateSelectAllState(tbody, selectAll);
        });
        tbody.addEventListener("change", (e) => {
          if (e.target && e.target.matches('input.row-select')) {
            this.updateSelectAllState(tbody, selectAll);
          }
        });
      }
      addBtn?.addEventListener("click", () => this.addDisallowedMacRow(tbody, selectAll));
      remBtn?.addEventListener("click", () => {
        const removed = this.removeSelectedRows(tbody, selectAll);
        if (removed > 0) this.showNotification?.(`${removed} MAC${removed > 1 ? "s" : ""} removed`, "success");
      });
    })();

    // QoS Management Policy: + / - buttons
    (() => {
      // MSCS Disallowed STA List
      const mscsBody = document.querySelector("#mscs-body");
      const mscsAdd  = document.getElementById("add-mscs");
      const mscsRem  = document.getElementById("remove-mscs");
      const mscsAll  = document.getElementById("select-all-mscs");

      if (mscsAll && mscsBody) {
        mscsAll.addEventListener("change", () => {
          mscsBody.querySelectorAll('input.row-select')
          .forEach(cb => cb.checked = mscsAll.checked);
          this.updateSelectAllState(mscsBody, mscsAll);
        });

        mscsBody.addEventListener("change", (e) => {
          if (e.target && e.target.matches('input.row-select')) {
            this.updateSelectAllState(mscsBody, mscsAll);
          }
        });
      }
      mscsAdd?.addEventListener("click", () =>this.addDisallowedMacRow(mscsBody, mscsAll));
      mscsRem?.addEventListener("click", () => {
        const removed = this.removeSelectedRows(mscsBody, mscsAll);
        if (removed > 0) {
          this.showNotification?.(`${removed} MAC${removed > 1 ? "s" : ""} removed`,"success");
        }
      });

      // SCS Disallowed STA List
      const scsBody = document.querySelector("#scs-body");
      const scsAdd  = document.getElementById("add-scs");
      const scsRem  = document.getElementById("remove-scs");
      const scsAll  = document.getElementById("select-all-scs");

      if (scsAll && scsBody) {
        scsAll.addEventListener("change", () => {
          scsBody.querySelectorAll('input.row-select')
          .forEach(cb => cb.checked = scsAll.checked);
          this.updateSelectAllState(scsBody, scsAll);
        });

        scsBody.addEventListener("change", (e) => {
          if (e.target && e.target.matches('input.row-select')) {
            this.updateSelectAllState(scsBody, scsAll);
          }
        });
      }

      scsAdd?.addEventListener("click", () =>
        this.addDisallowedMacRow(scsBody, scsAll)
      );

      scsRem?.addEventListener("click", () => {
        const removed = this.removeSelectedRows(scsBody, scsAll);
        if (removed > 0) {
          this.showNotification?.(`${removed} MAC${removed > 1 ? "s" : ""} removed`,"success");
        }
      });
    })();

    // Keep fixed-pixel SVG dimensions synchronized with the responsive pane.
    // ResizeObserver also covers layout changes that do not resize the window.
    window.addEventListener('resize', () => {
      this.resizeCharts();
      this.scheduleTopologyViewportResize();
    });
    this.observeTopologyViewport();
  }

  /**
   * Initialize WebSocket connection for real-time updates
   */
  initializeWebSocket() {
  if (this.profile.websocket === false) {
    // a backend without the RDK websocket: the two-second topology refresh contract
    this.isConnected = true;
    this.updateConnectionStatus(true);
    return;
  }
  // prevent duplicate connections
  if (this.wsConnection && (this.wsConnection.readyState === WebSocket.OPEN || this.wsConnection.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const scheme = (location.protocol === 'https:') ? 'wss' : 'ws';
  const wsUrl = `${scheme}://${location.host}${this.apiBase}/ws`;
  console.log('🔌 Connecting to WebSocket:', wsUrl);

  try {
    this.wsConnection = new WebSocket(wsUrl);

    this.wsConnection.onopen = () => {
      console.log('✅ WebSocket connected');
      this.isConnected = true;
      this.updateConnectionStatus(true);
    };

    this.wsConnection.onmessage = async (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      await this.handleWebSocketMessage(data);
    };

    this.wsConnection.onerror = (err) => {
      console.warn('WebSocket error:', err);
      this.updateConnectionStatus(false);
    };

    this.wsConnection.onclose = () => {
      console.log('🔌 WebSocket disconnected');
      this.isConnected = false;
      this.updateConnectionStatus(false);
      // small backoff
      setTimeout(() => this.initializeWebSocket(), 2000);
    };
  } catch (e) {
    console.error('Failed to initialize WebSocket:', e);
    this.updateConnectionStatus(false);
  }
}

async handleWifiResetApply() {
  // Prevent re-entry
  if (this._wifiResetInProgress) return;
  this._wifiResetInProgress = true;

  const resetBtn = document.getElementById('reset-btn');
  const originalBtnText = resetBtn?.textContent;

  // Confirmation dialog box
  const confirmed = window.confirm(
    "Resetting the Wi-Fi configuration may require the controller to restart.\nDo you want to continue?"
  );
  if (!confirmed) {
    this._wifiResetInProgress = false;
    return;
  }

  // Prepare UI state
  try {
    // payload
    const payload = collectResetPayload();
    // Disable button and show progress state
    if (resetBtn) {
      resetBtn.disabled = true;
      resetBtn.textContent = "Applying reset...";
      resetBtn.classList.add("is-loading");
      resetBtn.setAttribute("aria-busy", "true");
    }

    // block navigation or keyboard shortcuts while in progress
    this._blockShortcutsDuringReset?.(true);

    // Send payload
    const response = await sendResetPayload(payload);

    // Success case
    if (handleResetSuccess) {
      try { await handleResetSuccess(response); } catch (noop) {}
    }

    if (typeof this.loadWifiResetConfig === 'function') {
      console.log("Reloading Wi-Fi Reset config after reset");
      await this.loadWifiResetConfig();
    }
  } catch (error) {
    // Call custom error handler if provided
    if (handleResetError) {
      try { await handleResetError(error); } catch (noop) {}
    }
  } finally {
    // Restore UI state
    if (resetBtn) {
      resetBtn.disabled = false;
      resetBtn.textContent = originalBtnText ?? "Apply Reset";
      resetBtn.classList.remove("is-loading");
      resetBtn.removeAttribute("aria-busy");
    }
    this._blockShortcutsDuringReset?.(false);
    this._wifiResetInProgress = false;
  }
}

savePolicySettings(sectionKey, scope = "selected") {
  if (!Array.isArray(this.updatedPolicySettings)) {
    console.warn("updatedPolicySettings is not initialized or not an array.");
    return;
  }
  const deviceSelect = document.querySelector("#device-selector");
  const selectedDeviceId = deviceSelect?.value || null;

  let indicesToUpdate = [];
  if (scope === "all") {
    indicesToUpdate = this.updatedPolicySettings.map((_, i) => i);
  } else {
    if (!selectedDeviceId) {
      console.warn("No device selected in #device-selector.");
      return;
    }
    const idx = this.updatedPolicySettings.findIndex(p => p.id === selectedDeviceId);
    if (idx === -1) {
      console.warn("Selected device not found in updatedPolicySettings:", selectedDeviceId);
      return;
    }
    indicesToUpdate = [idx];
  }

  // Read DOM values per section
  switch (sectionKey) {
    case "ap-metrics": {
      const intervalVal = document.querySelector("#ap-interval")?.value ?? "";
      const managedClientMarker = document.querySelector("#managed-client-marker")?.value ?? "";

      let interval = intervalVal;
      if (intervalVal !== "" && !Number.isNaN(Number(intervalVal))) {
        interval = Number(intervalVal);
      }

      // Apply to the chosen indices
      indicesToUpdate.forEach(i => {
        const policy = this.updatedPolicySettings[i];
        policy.apMetricReportingPolicy ||= {};
        policy.apMetricReportingPolicy.interval = interval;
        policy.apMetricReportingPolicy.managedClientMarker = managedClientMarker;
      });

      this.showNotification('AP metrics policy saved successfully', 'success');
      break;
    }
    case "steering-policy": {

      // Fetch all steering policies
      const localList = getMacList("#localMacBody") || [];
      const btmList = getMacList("#btmMacBody") || [];
      const radioRows = RSP.getAll();

      if (!Array.isArray(radioRows) || radioRows.length === 0) {
        this.showNotification('At least one Radio Steering row with a valid ID (Station MAC) is required.', 'error');
        return;
      }

      const norm = v => PolicyUtil.normalizeId(v);

      // Build lookup map from UI updates
      const updateMap = new Map();
      radioRows.forEach(r => {
        const key = norm(r.id);
        if (key) updateMap.set(key, { ...r, id: key });
      });
      const selectedIdx = this.updatedPolicySettings.findIndex(
        p => p.id === selectedDeviceId
      );

      indicesToUpdate.forEach(i => {
        const d = this.updatedPolicySettings[i];
        d.localSteeringDisallowed = [...localList];
        d.btmSteeringDisallowed = [...btmList];

        const existing = d.radioSteeringParametersPolicy || [];

        const existingMap = new Map();
        existing.forEach(r => {
          const key = norm(r.id);
          if (key) existingMap.set(key, r);
        });

        const uiKeys = new Set(updateMap.keys());

        if (uiKeys.size === 1 && uiKeys.has(PolicyUtil.MAC_ALL)) {
          d.radioSteeringParametersPolicy = [updateMap.get(PolicyUtil.MAC_ALL)];
          return;
        }

        let updated;

        if (i === selectedIdx) {
          updated = existing
            .filter(r => uiKeys.has(norm(r.id)))
            .map(r => {
              const key = norm(r.id);
              const match = updateMap.get(key);
              return match ? { ...r, ...match } : r;
            });
        } else {
          updated = existing.map(r => {
            const key = norm(r.id);
            const match = updateMap.get(key);
            return match ? { ...r, ...match } : r;
          });
        }

        if (i === selectedIdx) {
          updateMap.forEach((uiRow, key) => {
            if (!existingMap.has(key)) {
              updated.push(uiRow);
            }
          });
        }
        d.radioSteeringParametersPolicy = updated;
      });
      this.showNotification('Steering Policy saved successfully', 'success')
      break;
    }
    case "channel-scan": {
      const val = document.querySelector("#report-independent-scans")?.value ?? "0";
      const num = Number(val);
      indicesToUpdate.forEach(i => {
        const d = this.updatedPolicySettings[i];
        d.reportIndependentChannelScans = Number.isNaN(num) ? 0 : num;
      });
      this.showNotification('Channel Scan Reporting Policy saved successfully', 'success');
      break;
    }
    case "dot1q-defaults": {
      const vlan = document.querySelector("#primary-vlan-id")?.value ?? "";
      const pcp  = document.querySelector("#default-pcp")?.value ?? "";

      const vlanNum = Number(vlan);
      const pcpNum  = Number(pcp);

      indicesToUpdate.forEach(i => {
        const d = this.updatedPolicySettings[i];
        d.default802_1Q_SettingsPolicy ||= {};

        if (!Number.isNaN(vlanNum)) d.default802_1Q_SettingsPolicy.primaryVLANID = vlanNum;
        if (!Number.isNaN(pcpNum))  d.default802_1Q_SettingsPolicy.defaultPCP   = pcpNum;
      });
      this.showNotification('Default 802.1Q Settings Policy saved successfully', 'success');
      break;
    }
    case "unsuccessful-assoc": {
      const reportVal = document.querySelector("#report-unassoc-sta")?.value ?? "0";
      const rateVal   = document.querySelector("#max-reporting-rate")?.value ?? "0";

      // Convert values
      const reportBool = reportVal === "1";
      const rateNum = rateVal === "" ? 0 : Number(rateVal);
      const rateNumValid = Number.isNaN(rateNum) ? 0 : rateNum;

      indicesToUpdate.forEach(i => {
        const d = this.updatedPolicySettings[i];
        d.unsuccessfulAssocPolicy ||= {};
        d.unsuccessfulAssocPolicy.reportUnsuccessAssoc = reportBool;
        d.unsuccessfulAssocPolicy.maxReportingRate = reportBool ? rateNumValid : 0;
      });
      this.showNotification('Unsuccessful Association Policy saved successfully', 'success');
      break;
    }
    case "backhaul-bss": {
      const rows = document.querySelectorAll("#backhaul-bss-rows tr");
      if (!rows || rows.length === 0) {
        this.showNotification('No Backhaul BSS entries found', 'error');
        return;
      }
      const uiRows = Array.from(rows).map(row => ({
        bssid: row.querySelector("input[name='bssid']")?.value || "",
        profile1bSTADisallowed:row.querySelector("select[name='profile1']")?.value === "1",
        profile2bSTADisallowed:row.querySelector("select[name='profile2']")?.value === "1"
      })).filter(r => r.bssid);

      // Build lookup map
      const updateMap = new Map();
      uiRows.forEach(r => {
        updateMap.set(r.bssid, r);
      });

      indicesToUpdate.forEach(i => {
        const d = this.updatedPolicySettings[i];
        const existing = d.backhaulBssConfigPolicy || [];

        // Update only matching BSSIDs
        const updated = existing.map(entry => {
          const match = updateMap.get(entry.bssid);
          return match ? { ...entry, ...match } : entry;
        });
        d.backhaulBssConfigPolicy = updated;
      });
      this.showNotification('Backhaul BSS Config Policy saved successfully', 'success');
      break;
    }

    case "qos-mgt": {
      const mscsList = getMacList("#mscs-body") || [];
      const scsList  = getMacList("#scs-body") || [];

      indicesToUpdate.forEach(i => {
        const d = this.updatedPolicySettings[i];
        d.qosManagementPolicy ||= {};
        d.qosManagementPolicy.mscsDisallowedSTAList = [...mscsList];
        d.qosManagementPolicy.scsDisallowedSTAList  = [...scsList];
      });
      this.showNotification('QoS Management Policy saved successfully', 'success');
      break;
    }
    case "radio-metrics": {
      const rows = RMP.getAll();
      if (!Array.isArray(rows) || rows.length === 0) {
        this.showNotification('At least one Radio specific Metrics row with a valid ID (Station MAC") is required.', 'error');
        return;
      }

      const norm = v => PolicyUtil.normalizeId(v)

      // Build lookup map using ID
      const updateMap = new Map();
      rows.forEach(r => {
        const key = norm(r.id);
        if (key) updateMap.set(key, { ...r, id: key });
      });

      const selectedIdx = this.updatedPolicySettings.findIndex(
        p => p.id === selectedDeviceId
      );


      indicesToUpdate.forEach(i => {
        const d = this.updatedPolicySettings[i];
        const existing = d.radioSpecificMetricsPolicy || [];

        // Build existing map
        const existingMap = new Map();
        existing.forEach(r => {
          const key = norm(r.id);
          if (key) existingMap.set(key, r);
        });
        const uiKeys = new Set(updateMap.keys());
        if (uiKeys.size === 1 && uiKeys.has(PolicyUtil.MAC_ALL)) {
          d.radioSpecificMetricsPolicy = [updateMap.get(PolicyUtil.MAC_ALL)];
          return;
        }
        let updated;
        if (i === selectedIdx) {
          updated = existing
          .filter(r => uiKeys.has(norm(r.id)))   // remove deleted rows
          .map(r => {
            const key = norm(r.id);
            const match = updateMap.get(key);
            return match ? { ...r, ...match } : r;
          });
        } else {
          updated = existing.map(r => {
            const key = norm(r.id);
            const match = updateMap.get(key);
            return match ? { ...r, ...match } : r;
          });
        }
        if (i === selectedIdx) {
          updateMap.forEach((uiRow, key) => {
            if (!existingMap.has(key)) {
              updated.push(uiRow);
            }
          });
        }
        d.radioSpecificMetricsPolicy = updated;
      });
      this.showNotification('Radio Specific Metrics Policy saved successfully', 'success');
      break;
    }

    default:
      console.warn("Unknown sectionKey:", sectionKey);
  }
}


async enableAllMetricsReporting() {
  const button = document.getElementById('enable-all-metrics');
  if (button?.disabled) return;

  if (button) {
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enabling Metrics...';
  }
  this.showNotification('Applying metrics reporting to every live radio…', 'info');

  try {
    const response = await fetch('/api/v1/metricsreporting/enable', { method: 'POST' });
    const text = await response.text();
    let result = {};
    try {
      result = text ? JSON.parse(text) : {};
    } catch (_) {
      result = {};
    }
    if (!response.ok) {
      throw new Error(result.message || text || `HTTP ${response.status}`);
    }

    await this.loadWifiPolicyConfig();

    let reporting = 0;
    let total = 0;
    const deadline = Date.now() + 30000;
    do {
      const clientsResponse = await fetch('/api/v1/clients');
      if (clientsResponse.ok) {
        const clientsResult = await clientsResponse.json();
        const clients = Array.isArray(clientsResult.clients) ? clientsResult.clients : [];
        total = clients.length;
        reporting = clients.filter(client => Number(client.client_metrics?.rcpi) > 0).length;
        if (total > 0 && reporting === total) break;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    } while (Date.now() < deadline);

    const policySummary = `${result.devices || 0} devices / ${result.radios || 0} radios`;
    if (total > 0 && reporting === total) {
      this.showNotification(`Metrics enabled: ${policySummary}, ${reporting}/${total} clients reporting signal`, 'success');
    } else {
      this.showNotification(`Metrics enabled: ${policySummary}; signal pending for ${total - reporting}/${total} clients`, 'warning');
    }
  } catch (error) {
    console.error('Failed to enable metrics reporting:', error);
    this.showNotification(`Failed to enable metrics reporting: ${error.message}`, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = '<i class="fas fa-signal"></i> Enable All Metrics';
    }
  }
}

async handlePolicySettingApply() {
  const saveBtn = document.getElementById('apply-policy-settings');

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
  }

  try {
    const settings = this.updatedPolicySettings;
    console.log('updated policy on apply: ', settings);
    const res = await fetch("api/v1/wifipolicy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(settings)
    });

    if (res.ok) {
      this.showNotification('Wireless Policy saved successfully', 'success');
      await this.loadWifiPolicyConfig();
      this.updateAllDisplays();
    } else {
      const errorText = await res.text();
      throw new Error(errorText);
    }

  } catch (error) {
    console.error('Failed to save network Policy settings:', error);
    this.showNotification('Failed to save network Policy settings', 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="fas fa-save"></i> Apply Policy Settings';
    }
  }
}

async addDisallowedMacRow(tbody, selectAll) {
  if (!tbody) return;

  const existing = tbody.querySelector("tr.inline-input-row");
  if (existing) {
    existing.querySelector('input[type="text"]')?.focus();
    return;
  }

  const tr = document.createElement("tr");
  tr.className = "inline-input-row";

  const td1 = document.createElement("td");
  td1.innerHTML = "&nbsp;";

  const td2 = document.createElement("td");
  const wrap = document.createElement("div");
  wrap.className = "mac-input-wrapper";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "xx:xx:xx:xx:xx:xx";
  input.className = "mac-inline-input";
  input.pattern = this.MAC_REGEX.source;
  input.setAttribute("aria-label", "Enter MAC address");

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "mac-add-btn";
  addBtn.textContent = "Add";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "mac-cancel-btn";
  cancelBtn.textContent = "Cancel";

  const err = document.createElement("div");
  err.className = "mac-inline-error";
  err.role = "alert";
  err.style.display = "none";

  const showError = (msg) => {
    err.textContent = msg;
    err.style.display = "block";
  };
  const clearError = () => {
    err.textContent = "";
    err.style.display = "none";
  };

  const submit = () => {
    clearError();
    const mac = this.normalizeMac(input.value);

    if (!this.isValidMac(mac)) {
      showError("Invalid MAC address format");
      input.focus();
      return;
    }
    // Check for duplicate entries
    const exists = !!tbody.querySelector(`tr[data-mac="${mac}"]`);
    if (exists) {
      showError("MAC address is already present.");
      input.focus();
      return;
    }

    // Create and replace inline row with a normal data row
    const row = this.createMacRow(mac);
    tbody.replaceChild(row, tr);
    this.updateSelectAllState(tbody, selectAll);
  };

  addBtn.addEventListener("click", submit);
  cancelBtn.addEventListener("click", () => {
    tr.remove();
    this.updateSelectAllState(tbody, selectAll);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      tr.remove();
      this.updateSelectAllState(tbody, selectAll);
    }
  });

  wrap.appendChild(input);
  wrap.appendChild(addBtn);
  wrap.appendChild(cancelBtn);
  td2.appendChild(wrap);
  td2.appendChild(err);

  tr.appendChild(td1);
  tr.appendChild(td2);
  tbody.appendChild(tr);

  setTimeout(() => input.focus(), 0);
}

updateSelectAllState(tbody, selectAll) {
  if (!tbody || !selectAll) return;
  const checks = tbody.querySelectorAll('input.row-select');
  const total = checks.length;
  const checked = [...checks].filter(cb => cb.checked).length;
  selectAll.indeterminate = checked > 0 && checked < total;
  selectAll.checked = total > 0 && checked === total;
}

createMacRow(mac) {
  const tr = document.createElement("tr");
  tr.dataset.mac = mac;

  const tdCheckbox = document.createElement("td");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "row-select";
  cb.setAttribute("aria-label", `Select ${mac}`);
  tdCheckbox.appendChild(cb);

  const tdMac = document.createElement("td");
  tdMac.textContent = mac;

  tr.appendChild(tdCheckbox);
  tr.appendChild(tdMac);
  return tr;
}

// Remove all selected rows from a table. Returns count removed.
removeSelectedRows(tbody, selectAll) {
  if (!tbody) return 0;
  let removed = 0;
  [...tbody.querySelectorAll("tr")].forEach(tr => {
    const cb = tr.querySelector('input.row-select');
    if (cb && cb.checked) {
      tr.remove();
      removed++;
    }
  });
  // Remove any inline row, if present
  tbody.querySelector("tr.inline-input-row")?.remove();
  this.updateSelectAllState(tbody, selectAll);
  return removed;
}

/** Minimal MAC helpers (as methods or move to module scope if you prefer) */
MAC_REGEX = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

normalizeMac(v) {
  return (v ?? "").trim().toLowerCase();
}
isValidMac(v) {
  return this.MAC_REGEX.test(v);
}

async handleWebSocketMessage(data) {
  switch (data.type) {
    case 'initial':
      this.devices = data.devices || [];
      this.clients = data.clients || [];
      this.updateAllDisplays();
      break;
    case 'metrics_update':
      this.updateMetrics(data.metrics || {});
      break;
    case 'device_update':
      this.updateDevice(data.device);
      break;
    case 'client_update':
      this.updateClient(data.client);
      break;
    case 'topology_change':
      await this.refreshTopologyData();
      break;
    case 'security_event':
      this.handleSecurityEvent(data.event);
      break;
    case 'notification':
      this.showNotification(data.message, data.level);
      break;
    case 'heartbeat':                              // ✅ handle it
      // optionally track connected_clients or update a “last seen”
      // console.debug('WS heartbeat', data.connected_clients);
      break;
    default:
      // noop
      break;
  }
}

  /**
   * Load initial data from API
   */
  async loadInitialData() {
    this.showLoading(true);

    try {
      // Load devices
      const devicesResponse = await this.apiCall('/devices');
      this.devices = devicesResponse.devices || [];

      // Load clients
      const clientsResponse = await this.apiCall('/clients');
      this.clients = clientsResponse.clients || [];

      // Load system config
      this.systemConfig = await this.apiCall('/config');

      // Update displays
      this.updateAllDisplays();
    } catch (error) {
      console.error('Failed to load initial data:', error);
      this.showNotification('Failed to load initial data', 'error');
    } finally {
      this.showLoading(false);
    }
  }

  /**
   * Make API calls with error handling
   */
  async apiCall(endpoint, options = {}) {
    const url = `${this.apiBase}${endpoint}`;

    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        },
        body: options.body ? JSON.stringify(options.body) : null
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`API call failed for ${endpoint}:`, error);
      throw error;
    }
  }

  /**
   * Update all displays with current data
   */
  updateAllDisplays() {
    this.updateDashboard();
    this.updateDevicesList();
    this.updateClientsList();
    this.updateTopologyVisualization();
    this.updatePerformanceCharts();
    this.updateSecurityCenter();
    this.updateCountBadges();
  }

  /**
   * Update dashboard metrics and displays
   */
  updateDashboard() {
    // Update key metrics
    const totalNodes = this.devices.length;
    const onlineNodes = this.devices.filter(d => d.status === 'Online').length;
    const activeClients = this.clients.filter(c => this.isClientActive(c)).length;

    this.updateElement('total-nodes', totalNodes);
    this.updateElement('active-clients', activeClients);

    // Calculate network health score
    const healthScore = this.calculateNetworkHealth();
    this.updateElement('health-score-display', Math.round(healthScore));

    // Update health indicators
    this.updateHealthIndicators();

    // Update optimization suggestions
    this.updateOptimizationSuggestions();

    // Update quick status cards
    this.updateQuickStatusCards();

    // Update traffic chart
    if (this.charts.traffic) this.updateTrafficChart();
  }

  /**
   * Calculate network health score
   */
  calculateNetworkHealth() {
    let score = 100;
    const totalDevices = this.devices.length;
    const onlineDevices = this.devices.filter(d => d.status === 'Online').length;

    if (totalDevices === 0) return 0;

    // Device availability (40% weight)
    const deviceHealth = (onlineDevices / totalDevices) * 40;

    // Performance metrics (30% weight)
    const avgThroughput = this.getAverageThroughput();
    const performanceHealth = Math.min((avgThroughput / 1000) * 30, 30);

    // Interference levels (20% weight)
    const interferenceLevel = this.getAverageInterference();
    const interferenceHealth = Math.max(0, (1 - interferenceLevel) * 20);

    // Security status (10% weight)
    const securityHealth = this.getSecurityHealth();

    return deviceHealth + performanceHealth + interferenceHealth + securityHealth;
  }

  /**
   * Update devices list display
   */
  updateDevicesList() {
    const devicesGrid = document.getElementById('devices-grid');
    if (!devicesGrid) return;

    devicesGrid.innerHTML = '';

    this.devices.forEach(device => {
      const deviceCard = this.createDeviceCard(device);
      devicesGrid.appendChild(deviceCard);
    });
  }

  /**
   * Create device card element
   */
   /**
   * Update devices list (for Mesh Devices tab - keep original)
   */
  updateDevicesList() {
    const devicesGrid = document.getElementById('devices-grid');
    if (!devicesGrid) return;

    devicesGrid.innerHTML = '';

    if (this.devices.length === 0) {
      devicesGrid.innerHTML = '<div class="loading-message">No devices found</div>';
      return;
    }

    this.devices.forEach(device => {
      const card = this.createDeviceCard(device);
      devicesGrid.appendChild(card);
    });
  }

  /**
   * Update performance devices section (P2/P3 design in Performance tab)
   */
  updatePerformanceDevices() {
    const devicesContainer = document.getElementById('performance-devices-list');
    if (!devicesContainer) return;

    devicesContainer.innerHTML = '';

    if (this.devices.length === 0) {
      devicesContainer.innerHTML = '<div class="loading-message">No devices found</div>';
      return;
    }

    this.devices.forEach(device => {
      const deviceSection = this.createDeviceSection(device);
      devicesContainer.appendChild(deviceSection);
    });
  }

  /**
   * Create expandable device section (like P2/P3 design)
   */
  createDeviceSection(device) {
    const section = document.createElement('div');
    section.className = 'device-section';
    section.id = `device-section-${device.mac.replace(/:/g, '')}`;

    const statusClass = device.status === 'Online' ? 'online' : 'offline';
    const clientCount = this.getDeviceClientCount(device.mac);

    section.innerHTML = `
      <div class="device-section-header">
        <div class="device-section-info">
          <i class="fas fa-network-wired"></i>
          <h3>${device.vendor} ${device.model}</h3>
        </div>
        <div class="device-section-badges">
          <span class="badge badge-${device.role.toLowerCase()}">${device.role}</span>
          <span class="badge badge-${statusClass}">${device.status}</span>
          <span class="badge badge-clients"><i class="fas fa-users"></i> ${clientCount} clients</span>
        </div>
        <button class="device-toggle-btn" onclick="window.EasyMeshController.toggleDeviceSection('${device.mac}')">
          <i class="fas fa-chevron-down"></i>
        </button>
      </div>

      <div class="device-section-content" id="device-content-${device.mac.replace(/:/g, '')}">
        <!-- Individual charts will be populated here for each client -->
        <div class="individual-client-charts" id="client-charts-${device.mac.replace(/:/g, '')}">
          ${clientCount > 0 ? '<div class="loading-message">Loading client charts...</div>' : '<p class="no-clients">No clients connected</p>'}
        </div>

        <!-- Connected Clients Section -->
        <div class="device-clients-section">
          <h4><i class="fas fa-users"></i> Connected Clients</h4>
          <div class="device-clients-list" id="device-clients-${device.mac.replace(/:/g, '')}">
            ${clientCount > 0 ? 'Loading clients...' : 'No clients connected'}
          </div>
        </div>
      </div>
    `;

    return section;
  }

  /**
   * Toggle device section expand/collapse
   */
  toggleDeviceSection(deviceMAC) {
    const contentId = `device-content-${deviceMAC.replace(/:/g, '')}`;
    const content = document.getElementById(contentId);
    const section = document.getElementById(`device-section-${deviceMAC.replace(/:/g, '')}`);
    
    if (!content || !section) return;

    const isExpanded = content.style.display === 'block';
    content.style.display = isExpanded ? 'none' : 'block';
    
    const toggleBtn = section.querySelector('.device-toggle-btn i');
    if (toggleBtn) {
      toggleBtn.className = isExpanded ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
    }

    // Load client list and individual charts if expanding for the first time
    if (!isExpanded) {
      this.loadDeviceClients(deviceMAC);
      this.createIndividualClientCharts(deviceMAC);
    }
  }

  /**
   * Load and display clients for a device
   */
  loadDeviceClients(deviceMAC) {
    const clientsContainer = document.getElementById(`device-clients-${deviceMAC.replace(/:/g, '')}`);
    if (!clientsContainer) return;

    const connectedClients = this.clients.filter(c => c.connected_ap_mac === deviceMAC);

    if (connectedClients.length === 0) {
      clientsContainer.innerHTML = '<p class="no-clients">No clients connected</p>';
      return;
    }

    clientsContainer.innerHTML = connectedClients.map(client => {
      const metrics = client.client_metrics || {};
      const performance = this.calculateClientPerformanceMetrics(metrics);
      
      return `
        <div class="device-client-item">
          <div class="client-item-icon">
            <i class="fas fa-${this.getDeviceTypeIcon(client.device_type)}"></i>
          </div>
          <div class="client-item-info">
            <h5>${client.hostname}</h5>
            <span class="client-mac">${client.mac.substring(0, 17)}</span>
          </div>
          <div class="client-item-status">
            <span class="status-badge ${this.getPerformanceClass(performance.score)}">${this.getPerformanceRating(performance.score)}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  /**
   * Handle client selection for device chart
   */
  /**
   * Create individual performance charts for each client on a device
   */
  createIndividualClientCharts(deviceMAC) {
    const chartsContainer = document.getElementById(`client-charts-${deviceMAC.replace(/:/g, '')}`);
    if (!chartsContainer) return;

    const connectedClients = this.clients.filter(c => c.connected_ap_mac === deviceMAC);
    
    if (connectedClients.length === 0) {
      chartsContainer.innerHTML = '<p class="no-clients">No clients connected</p>';
      return;
    }

    // Clear container
    chartsContainer.innerHTML = '';

    // Create individual chart for each client
    connectedClients.forEach((client, index) => {
      const clientId = client.mac.replace(/:/g, '');
      const chartDiv = document.createElement('div');
      chartDiv.className = 'individual-client-chart-card';
      chartDiv.innerHTML = `
        <div class="client-chart-header">
          <h4>${client.hostname} - Performance Metrics</h4>
          <span class="client-mac-label">${client.mac.substring(0, 17)}</span>
        </div>
        <div class="client-chart-canvas-wrapper">
          <canvas id="client-individual-chart-${clientId}"></canvas>
        </div>
      `;
      chartsContainer.appendChild(chartDiv);

      // Create the chart
      this.createSingleClientChart(client, `client-individual-chart-${clientId}`, deviceMAC);
    });
  }

  /**
   * Create chart for a single client showing all 5 metrics
   */
  createSingleClientChart(client, canvasId, deviceMAC) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const metrics = client.client_metrics || {};
    const performance = this.calculateClientPerformanceMetrics(metrics);

    // Destroy existing chart if any
    const chartKey = `${deviceMAC}-${client.mac}`;
    if (this.charts[chartKey]) {
      this.charts[chartKey].destroy();
    }

    // Generate time series data
    const timeLabels = this.generateTimeLabels(13);
    
    // Create datasets for all 5 metrics
    const datasets = [
      {
        label: 'Score',
        data: this.generateVariedData(performance.score, 13, 8),
        borderColor: '#6366f1',
        backgroundColor: '#6366f1' + '30',
        borderWidth: 3,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      },
      {
        label: 'SNR (dB)',
        data: this.generateVariedData(performance.snr, 13, 4),
        borderColor: '#10b981',
        backgroundColor: '#10b981' + '30',
        borderWidth: 3,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      },
      {
        label: 'PR (Mbps/10)',
        data: this.generateVariedData(performance.pr / 10, 13, 20),
        borderColor: '#f59e0b',
        backgroundColor: '#f59e0b' + '30',
        borderWidth: 3,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      },
      {
        label: 'PER (% × 20)',
        data: this.generateVariedData(performance.per * 20, 13, 2),
        borderColor: '#ef4444',
        backgroundColor: '#ef4444' + '30',
        borderWidth: 3,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      },
      {
        label: 'PSY',
        data: this.generateVariedData(performance.psy, 13, 6),
        borderColor: '#8b5cf6',
        backgroundColor: '#8b5cf6' + '30',
        borderWidth: 3,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      }
    ];

    this.charts[chartKey] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: timeLabels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: {
              usePointStyle: true,
              padding: 15,
              font: { size: 11 }
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                let label = context.dataset.label || '';
                let value = context.parsed.y;
                
                // Denormalize for display
                if (label.includes('PR')) {
                  value = value * 10;
                  label = 'PR (Mbps)';
                } else if (label.includes('PER')) {
                  value = value / 20;
                  label = 'PER (%)';
                }
                
                return label + ': ' + value.toFixed(2);
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(0, 0, 0, 0.05)' },
            ticks: { font: { size: 10 } }
          },
          y: {
            beginAtZero: true,
            min: 0,
            max: 100,
            grid: { color: 'rgba(0, 0, 0, 0.05)' },
            title: {
              display: true,
              text: 'Normalized Values (0-100)',
              font: { size: 12, weight: 'bold' }
            }
          }
        }
      }
    });
  }

  // Deprecated functions - kept for compatibility
  createAllClientsChart(deviceMAC) {
    const canvasId = `client-chart-${deviceMAC.replace(/:/g, '')}`;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const connectedClients = this.clients.filter(c => c.connected_ap_mac === deviceMAC);
    
    if (connectedClients.length === 0) {
      return;
    }

    // Destroy existing chart if any
    const chartKey = `device-chart-${deviceMAC}`;
    if (this.charts[chartKey]) {
      this.charts[chartKey].destroy();
    }

    // Generate time series data
    const timeLabels = this.generateTimeLabels(13);
    
    // Define colors for the 5 metrics
    const metricColors = {
      score: '#6366f1',
      snr: '#10b981',
      pr: '#f59e0b',
      per: '#ef4444',
      psy: '#8b5cf6'
    };
    
    // Create datasets for each client - all 5 metrics per client
    const datasets = [];
    
    connectedClients.forEach((client, clientIndex) => {
      const metrics = client.client_metrics || {};
      const performance = this.calculateClientPerformanceMetrics(metrics);
      
      // For each metric, create a dataset with client name
      const clientLabel = client.hostname || `Client ${clientIndex + 1}`;
      
      // Score
      datasets.push({
        label: `${clientLabel} - Score`,
        data: this.generateVariedData(performance.score, 13, 8),
        borderColor: metricColors.score,
        backgroundColor: metricColors.score + '30',
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 2,
        pointHoverRadius: 5,
        borderDash: clientIndex === 0 ? [] : [5, 5]
      });
      
      // SNR
      datasets.push({
        label: `${clientLabel} - SNR`,
        data: this.generateVariedData(performance.snr, 13, 4),
        borderColor: metricColors.snr,
        backgroundColor: metricColors.snr + '30',
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 2,
        pointHoverRadius: 5,
        borderDash: clientIndex === 0 ? [] : [5, 5]
      });
      
      // PR (normalized)
      datasets.push({
        label: `${clientLabel} - PR`,
        data: this.generateVariedData(performance.pr / 10, 13, 20),
        borderColor: metricColors.pr,
        backgroundColor: metricColors.pr + '30',
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 2,
        pointHoverRadius: 5,
        borderDash: clientIndex === 0 ? [] : [5, 5]
      });
      
      // PER (normalized)
      datasets.push({
        label: `${clientLabel} - PER`,
        data: this.generateVariedData(performance.per * 20, 13, 2),
        borderColor: metricColors.per,
        backgroundColor: metricColors.per + '30',
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 2,
        pointHoverRadius: 5,
        borderDash: clientIndex === 0 ? [] : [5, 5]
      });
      
      // PSY
      datasets.push({
        label: `${clientLabel} - PSY`,
        data: this.generateVariedData(performance.psy, 13, 6),
        borderColor: metricColors.psy,
        backgroundColor: metricColors.psy + '30',
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 2,
        pointHoverRadius: 5,
        borderDash: clientIndex === 0 ? [] : [5, 5]
      });
    });

    this.charts[chartKey] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: timeLabels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: {
              usePointStyle: true,
              padding: 8,
              font: { size: 10 },
              boxWidth: 20,
              boxHeight: 2
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                let label = context.dataset.label || '';
                let value = context.parsed.y;
                
                // Denormalize for display
                if (label.includes('PR')) {
                  value = value * 10;
                } else if (label.includes('PER')) {
                  value = value / 20;
                }
                
                return label + ': ' + value.toFixed(2);
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(0, 0, 0, 0.05)' },
            ticks: { font: { size: 10 } }
          },
          y: {
            beginAtZero: true,
            min: 0,
            max: 100,
            grid: { color: 'rgba(0, 0, 0, 0.05)' },
            title: {
              display: true,
              text: 'Normalized Values (0-100)',
              font: { size: 12, weight: 'bold' }
            }
          }
        }
      }
    });
  }

  // Keep old function for compatibility (not used anymore)
  onClientSelect(deviceMAC, clientMAC) {
    // Deprecated - now showing all clients automatically
  }

  /**
   * Create combined performance chart for selected client (deprecated)
   */
  createDeviceClientChart(deviceMAC, client) {
    const canvasId = `client-chart-${deviceMAC.replace(/:/g, '')}`;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const metrics = client.client_metrics || {};
    const performance = this.calculateClientPerformanceMetrics(metrics);

    // Destroy existing chart if any
    const chartKey = `device-chart-${deviceMAC}`;
    if (this.charts[chartKey]) {
      this.charts[chartKey].destroy();
    }

    // Generate time series data
    const timeLabels = this.generateTimeLabels(13);
    
    // Create datasets for all 5 metrics (normalized to 0-100)
    const datasets = [
      {
        label: 'Score',
        data: this.generateVariedData(performance.score, 13, 8),
        borderColor: '#6366f1',
        backgroundColor: '#6366f1' + '30',
        borderWidth: 3,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      },
      {
        label: 'SNR (dB)',
        data: this.generateVariedData(performance.snr, 13, 4),
        borderColor: '#10b981',
        backgroundColor: '#10b981' + '30',
        borderWidth: 3,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      },
      {
        label: 'PR (Mbps/10)',
        data: this.generateVariedData(performance.pr / 10, 13, 20),
        borderColor: '#f59e0b',
        backgroundColor: '#f59e0b' + '30',
        borderWidth: 3,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      },
      {
        label: 'PER (% × 20)',
        data: this.generateVariedData(performance.per * 20, 13, 2),
        borderColor: '#ef4444',
        backgroundColor: '#ef4444' + '30',
        borderWidth: 3,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      },
      {
        label: 'PSY',
        data: this.generateVariedData(performance.psy, 13, 6),
        borderColor: '#8b5cf6',
        backgroundColor: '#8b5cf6' + '30',
        borderWidth: 3,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      }
    ];

    this.charts[chartKey] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: timeLabels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: {
              usePointStyle: true,
              padding: 15,
              font: { size: 12 }
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                let label = context.dataset.label || '';
                let value = context.parsed.y;
                
                // Denormalize for display
                if (label.includes('PR')) {
                  value = value * 10;
                  label = 'PR (Mbps)';
                } else if (label.includes('PER')) {
                  value = value / 20;
                  label = 'PER (%)';
                }
                
                return label + ': ' + value.toFixed(2);
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(0, 0, 0, 0.05)' },
            ticks: { font: { size: 10 } }
          },
          y: {
            beginAtZero: true,
            min: 0,
            max: 100,
            grid: { color: 'rgba(0, 0, 0, 0.05)' },
            title: {
              display: true,
              text: 'Normalized Values (0-100)',
              font: { size: 12, weight: 'bold' }
            }
          }
        }
      }
    });
  }

  /**
   * Calculate performance metrics from client metrics
   */
  calculateClientPerformanceMetrics(metrics) {
    // Score
    const rssiScore = this.normalizeRSSI(metrics.rssi_dbm || -70);
    const snrScore = (metrics.snr_db || 0) / 60 * 100;
    const rateScore = Math.min((Math.max(metrics.tx_rate_mbps || 0, metrics.rx_rate_mbps || 0)) / 2000 * 100, 100);
    const lossScore = Math.max(100 - (metrics.packet_loss_percent || 0) * 100, 0);
    const score = Math.round(rssiScore * 0.3 + snrScore * 0.3 + rateScore * 0.2 + lossScore * 0.2);
    
    // SNR
    const snr = metrics.snr_db || 0;
    
    // Physical Rate
    const pr = Math.max(metrics.tx_rate_mbps || 0, metrics.rx_rate_mbps || 0);
    
    // Packet Error Rate
    const per = metrics.packet_loss_percent || 0;
    
    // PSY
    const snrComponent = (metrics.snr_db || 0) / 60 * 50;
    const spatialStreams = (metrics.spatial_streams || 1) / 2 * 25;
    const channelWidth = (metrics.channel_width_mhz || 20) / 160 * 25;
    const psy = Math.round(Math.min(snrComponent + spatialStreams + channelWidth, 100));
    
    return { score, snr, pr, per, psy };
  }

  normalizeRSSI(rssi) {
    const min = -90;
    const max = -30;
    return Math.max(0, Math.min(100, ((rssi - min) / (max - min)) * 100));
  }

  /**
   * Generate varied time series data
   */
  generateVariedData(baseValue, points, variation) {
    const data = [];
    for (let i = 0; i < points; i++) {
      const vary = (Math.random() - 0.5) * variation;
      data.push(Math.max(0, Math.min(100, baseValue + vary)));
    }
    return data;
  }

  /**
   * Generate time labels
   */
  generateTimeLabels(count) {
    const labels = [];
    const now = new Date();
    const interval = 60 / count;
    
    for (let i = count - 1; i >= 0; i--) {
      const time = new Date(now.getTime() - i * interval * 60000);
      labels.push(time.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      }));
    }
    
    return labels;
  }

  getPerformanceClass(score) {
    if (score >= 80) return 'excellent';
    if (score >= 60) return 'good';
    if (score >= 40) return 'fair';
    return 'poor';
  }

  getPerformanceRating(score) {
    if (score >= 80) return 'EXCELLENT';
    if (score >= 60) return 'GOOD';
    if (score >= 40) return 'FAIR';
    return 'POOR';
  }

  deviceBackhaulSignal(device) {
    return this.topologyBackhaulSignal({
      signal: device?.backhaul_signal,
      rssi: device?.signal
    });
  }

  deviceBackhaulSignalDisplay(device) {
    if (device?.role === 'Controller' || device?.role?.startsWith('Agent-') ||
        String(device?.backhaul_type || '').toLowerCase() === 'ethernet') {
      return 'Local / Ethernet';
    }
    const signal = this.deviceBackhaulSignal(device);
    if (signal.available) {
      return `${this.getSignalStrengthIcon(signal.rssi)} ${signal.rssi} dBm ` +
        `(RCPI ${signal.rcpi}, ${signal.ageSeconds}s old)`;
    }
    if (signal.stale) {
      return `Stale — last ${signal.rssi} dBm ` +
        `(RCPI ${signal.rcpi}, ${signal.ageSeconds}s old)`;
    }
    return 'Unknown — no fresh link metric';
  }

  createDeviceCard(device) {
    const card = document.createElement('div');
    card.className = 'device-card';
    card.onclick = () => this.showDeviceDetails(device);

    const statusClass = device.status === 'Online' ? 'online' : 'offline';
    const signalStrength = this.deviceBackhaulSignalDisplay(device);
    const uptime = device.uptime || 'Not reported';

    card.innerHTML = `
      <div class="device-header">
        <div class="device-info">
          <h3>${device.vendor} ${device.model}</h3>
          <div class="device-model">${device.mac}</div>
        </div>
        <div class="device-status ${statusClass}">
          <i class="fas fa-circle"></i>
          ${device.status}
        </div>
      </div>

      <div class="device-metrics">
        <div class="metric-item">
          <div class="label">Role</div>
          <div class="value">${device.role}</div>
        </div>
        <div class="metric-item">
          <div class="label">Backhaul signal</div>
          <div class="value">${signalStrength}</div>
        </div>
        <div class="metric-item">
          <div class="label">Uptime</div>
          <div class="value">${uptime}</div>
        </div>
        <div class="metric-item">
          <div class="label">Clients</div>
          <div class="value">${this.getDeviceClientCount(device.mac)}</div>
        </div>
      </div>

      <div class="device-actions">
        <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); window.EasyMeshController.rebootDevice('${device.mac}')">
          <i class="fas fa-power-off"></i> Reboot
        </button>
        <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); window.EasyMeshController.configureDevice('${device.mac}')">
          <i class="fas fa-cog"></i> Configure
        </button>
      </div>
    `;

    return card;
  }

  /**
   * Update clients list
   */
  updateClientsList() {
    const clientsTable = document.getElementById('clients-tbody');
    if (!clientsTable) return;

    clientsTable.innerHTML = '';

    this.clients.forEach(client => {
      const row = this.createClientRow(client);
      clientsTable.appendChild(row);
    });
  }

  /**
   * Create client table row
   */
  createClientRow(client) {
    const row = document.createElement('tr');

    const deviceIcon = this.getDeviceTypeIcon(client.device_type);
    const metrics = client.client_metrics || {};
    const hasRSSI = Number.isFinite(metrics.rssi_dbm) && metrics.rssi_dbm !== 0;
    const hasRCPI = Number.isInteger(metrics.rcpi) && metrics.rcpi > 0;
    const hasTxRate = Number.isFinite(metrics.tx_rate_mbps) && metrics.tx_rate_mbps > 0;
    const hasRxRate = Number.isFinite(metrics.rx_rate_mbps) && metrics.rx_rate_mbps > 0;
    const hasUsage = Number.isFinite(metrics.data_usage_bytes) && metrics.data_usage_bytes > 0;
    const signalDisplay = hasRSSI
      ? `${this.createSignalBars(metrics.rssi_dbm)}<span>${metrics.rssi_dbm} dBm${hasRCPI ? ` (RCPI ${metrics.rcpi})` : ''}</span>`
      : '<span>N/A</span>';
    const connectionInfo = this.getClientConnectionInfo(client);
    const channelDisplay = Number(client.channel) > 0
      ? `${this.topologyBandLabel(client.band)} ch ${client.channel}`
      : 'N/A';
    const associationUptime = Number.isFinite(metrics.association_uptime_seconds) &&
      metrics.association_uptime_seconds > 0
      ? this.formatUptime(metrics.association_uptime_seconds)
      : 'Not reported';

    row.innerHTML = `
      <td>
        <div class="client-info">
          <div class="client-icon">
            <i class="fas fa-${deviceIcon}"></i>
          </div>
          <div class="client-details">
            <h4>${client.hostname || 'Unknown Device'}</h4>
            <div class="client-mac">${client.mac}</div>
          </div>
        </div>
      </td>
      <td>
        <div class="connection-info">
          <div class="connection-ap">${connectionInfo.ap}</div>
          <div class="connection-band">${connectionInfo.band}</div>
        </div>
      </td>
      <td>${channelDisplay}</td>
      <td>${associationUptime}</td>
      <td>
        <div class="signal-strength">
          ${signalDisplay}
        </div>
      </td>
      <td>
        <div class="speed-info">
          ↑${hasTxRate ? this.formatSpeed(metrics.tx_rate_mbps) : 'N/A'}<br>
          ↓${hasRxRate ? this.formatSpeed(metrics.rx_rate_mbps) : 'N/A'}
        </div>
      </td>
      <td>
        <div class="usage-info">
          ${hasUsage ? this.formatBytes(metrics.data_usage_bytes) : 'N/A'}
        </div>
      </td>
      <td>
        <div class="client-actions">
          <button class="action-btn" onclick="window.EasyMeshController.showClientDetails('${client.mac}')" title="Details">
            <i class="fas fa-info"></i>
          </button>
          <button class="action-btn" onclick="window.EasyMeshController.disconnectClient('${client.mac}')" title="Disconnect">
            <i class="fas fa-unlink"></i>
          </button>
          <button class="action-btn" onclick="window.EasyMeshController.blockClient('${client.mac}')" title="Block">
            <i class="fas fa-ban"></i>
          </button>
        </div>
      </td>
    `;

    return row;
  }

  formatUptime(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m ${secs}s`;
  }

  /**
   * Initialize all charts
   */
  initializeCharts() {
    // Check if Chart.js is loaded
    if (typeof Chart === 'undefined') {
      console.warn('Chart.js not loaded, loading from CDN...');
      this.loadChartJS().then(() => {
        this.createCharts();
      }).catch(() => console.error('Failed to load Chart.js'));
    } else {
      this.createCharts();
    }
  }

  /**
   * Load Chart.js dynamically
   */
  async loadChartJS() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  /**
   * Create all charts
   */
  createCharts() {
    try {
      this.createTrafficChart();
      this.createThroughputChart();
      this.createUtilizationChart();
      this.createClientDistributionChart();
      this.createLatencyChart?.();
      this.createSpectrumChart();
    } catch (error) {
      console.error('Error creating charts:', error);
    }
  }

  /**
   * Create traffic chart
   */
  createTrafficChart() {
    const canvas = document.getElementById('traffic-chart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    this.charts.traffic = new Chart(ctx, {
      type: 'line',
      data: {
        labels: this.generateTimeLabels(12),
        datasets: [
          {
            label: 'Upload',
            data: this.generateTrafficData(12),
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            fill: true,
            tension: 0.4
          },
          {
            label: 'Download',
            data: this.generateTrafficData(12, 2),
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            fill: true,
            tension: 0.4
          }
        ]
      },
      options: {
        ...this.chartDefaults,
        scales: {
          ...this.chartDefaults.scales,
          y: {
            ...this.chartDefaults.scales.y,
            title: { display: true, text: 'Mbps' }
          }
        },
        plugins: {
          ...this.chartDefaults.plugins,
          tooltip: {
            callbacks: {
              label: (context) => `${context.dataset.label}: ${context.parsed.y} Mbps`
            }
          }
        }
      }
    });
  }

  /**
   * Create throughput chart
   */
  createThroughputChart() {
    const canvas = document.getElementById('throughput-chart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    this.charts.throughput = new Chart(ctx, {
      type: 'line',
      data: {
        labels: this.generateTimeLabels(24),
        datasets: [
          {
            label: '2.4GHz',
            data: this.generateRandomData(24, 50, 200),
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245, 158, 11, 0.1)',
            fill: false
          },
          {
            label: '5GHz',
            data: this.generateRandomData(24, 200, 800),
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            fill: false
          },
          {
            label: '6GHz',
            data: this.generateRandomData(24, 500, 1200),
            borderColor: '#8b5cf6',
            backgroundColor: 'rgba(139, 92, 246, 0.1)',
            fill: false
          }
        ]
      },
      options: {
        ...this.chartDefaults,
        scales: {
          ...this.chartDefaults.scales,
          y: {
            ...this.chartDefaults.scales.y,
            title: { display: true, text: 'Throughput (Mbps)' }
          }
        }
      }
    });
  }

  /**
   * Create utilization chart
   */
  createUtilizationChart() {
    const canvas = document.getElementById('utilization-chart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    this.charts.utilization = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['2.4GHz', '5GHz', '6GHz', 'Available'],
        datasets: [{
          data: [35, 45, 15, 5],
          backgroundColor: ['#f59e0b', '#3b82f6', '#8b5cf6', '#e5e7eb'],
          borderWidth: 0
        }]
      },
      options: {
        ...this.chartDefaults,
        cutout: '60%',
        plugins: {
          ...this.chartDefaults.plugins,
          tooltip: {
            callbacks: { label: (context) => `${context.label}: ${context.parsed}%` }
          }
        }
      }
    });
  }

  /**
   * Create client distribution chart
   */
  createClientDistributionChart() {
    const canvas = document.getElementById('client-distribution-chart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    const deviceData = this.devices.map(device => ({
      label: device.model,
      clients: this.getDeviceClientCount(device.mac)
    }));

    this.charts.clientDistribution = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: deviceData.map(d => d.label),
        datasets: [{
          label: 'Connected Clients',
          data: deviceData.map(d => d.clients),
          backgroundColor: '#3b82f6',
          borderColor: '#2563eb',
          borderWidth: 1
        }]
      },
      options: {
        ...this.chartDefaults,
        scales: {
          ...this.chartDefaults.scales,
          y: {
            ...this.chartDefaults.scales.y,
            title: { display: true, text: 'Number of Clients' },
            ticks: { stepSize: 1 }
          }
        }
      }
    });
  }

  /**
   * Create spectrum analyzer chart
   */
  createSpectrumChart() {
    const canvas = document.getElementById('spectrum-chart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    this.charts.spectrum = new Chart(ctx, {
      type: 'line',
      data: {
        labels: this.generate24GHzChannels(),
        datasets: [{
          label: 'Signal Strength (dBm)',
          data: this.generateSpectrumData(),
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          fill: true,
          pointRadius: 0,
          tension: 0.1
        }]
      },
      options: {
        ...this.chartDefaults,
        scales: {
          x: { title: { display: true, text: 'Frequency (MHz)' } },
          y: { title: { display: true, text: 'Signal Strength (dBm)' }, min: -100, max: -20 }
        },
        plugins: { legend: { display: false } }
      }
    });
  }

  topologyStarLayout(nodes, edges) {
    const rendered = Array.isArray(nodes) ? nodes : [];
    const agent = rendered.find(node => /^agent-1$/i.test(String(node?.name || '')));
    if (!agent) return null;
    const controller = rendered.find(node => /^controller$/i.test(String(node?.name || '')));
    const satellites = rendered.filter(node => node !== agent && node !== controller)
      .sort((left, right) => String(left.name || left.id)
        .localeCompare(String(right.name || right.id), undefined, {numeric: true}));
    if (satellites.length < 2) return null;

    const endpointId = endpoint => String(
      endpoint && typeof endpoint === 'object' ? endpoint.id : endpoint
    );
    const expected = new Set(satellites.map(node =>
      JSON.stringify([String(agent.id), String(node.id)])));
    if (controller) expected.add(JSON.stringify([String(controller.id), String(agent.id)]));
    const actual = new Set((Array.isArray(edges) ? edges : []).map(edge =>
      JSON.stringify([endpointId(edge?.from ?? edge?.source), endpointId(edge?.to ?? edge?.target)])));
    if (actual.size !== expected.size || [...actual].some(edge => !expected.has(edge))) return null;

    return this.topologyMeshLayout(rendered);
  }

  topologyMeshLayout(nodes) {
    const rendered = Array.isArray(nodes) ? nodes : [];
    const agent = rendered.find(node => /^agent-1$/i.test(String(node?.name || '')));
    if (!agent) return null;
    const controller = rendered.find(node => /^controller$/i.test(String(node?.name || '')));
    const satellites = rendered.filter(node => node !== agent && node !== controller)
      .sort((left, right) => String(left.name || left.id)
        .localeCompare(String(right.name || right.id), undefined, {numeric: true}));
    if (satellites.length < 2) return null;

    const extentFor = node => Math.max(80, Number(this.topologyNodeExtent(node)) || 80);
    const gap = 32;
    const agentExtent = extentFor(agent);
    const satelliteExtent = Math.max(...satellites.map(extentFor));
    const rows = Math.ceil(satellites.length / 2);
    const rowSpacing = satelliteExtent * 2 + gap;
    const nearestRow = rows % 2 === 0 ? rowSpacing / 2 : 0;
    const separation = agentExtent + satelliteExtent + gap;
    const columnOffset = Math.max(satelliteExtent + gap / 2,
      Math.sqrt(Math.max(0, separation * separation - nearestRow * nearestRow)));
    const positions = new Map([[String(agent.id), {x: 0, y: 0}]]);
    satellites.forEach((node, index) => {
      positions.set(String(node.id), {
        x: index % 2 === 0 ? -columnOffset : columnOffset,
        y: (Math.floor(index / 2) - (rows - 1) / 2) * rowSpacing
      });
    });
    if (controller) {
      positions.set(String(controller.id), {
        x: 0, y: -(agentExtent + extentFor(controller) + gap)
      });
    }
    return positions;
  }

  /**
   * Build a deterministic left-to-right hierarchy for a landscape viewport.
   * Dense levels wrap into additional columns so a four-extender star uses a
   * two-row grid instead of one tall column. Node extents include the SSID
   * bubbles and their clients, which keeps the fitted result inside the pane.
   */
  topologyLandscapeLayout(nodes, edges, width = 1600, height = 900) {
    const star = this.topologyStarLayout(nodes, edges);
    if (star) return star;
    const rendered = Array.isArray(nodes) ? nodes : [];
    const byId = new Map(rendered.map(node => [String(node.id), node]));
    const children = new Map(rendered.map(node => [String(node.id), new Set()]));
    const indegree = new Map(rendered.map(node => [String(node.id), 0]));
    let edgeCount = 0;
    const endpointId = endpoint => String(
      endpoint && typeof endpoint === 'object' ? endpoint.id : endpoint
    );

    for (const edge of Array.isArray(edges) ? edges : []) {
      const from = endpointId(edge?.from ?? edge?.source);
      const to = endpointId(edge?.to ?? edge?.target);
      if (!byId.has(from) || !byId.has(to) || from === to || children.get(from).has(to)) continue;
      children.get(from).add(to);
      indegree.set(to, (indegree.get(to) || 0) + 1);
      edgeCount += 1;
    }

    const nodeOrder = (left, right) => {
      const leftController = /^controller$/i.test(String(left?.name || '')) ? 0 : 1;
      const rightController = /^controller$/i.test(String(right?.name || '')) ? 0 : 1;
      return leftController - rightController ||
        String(left?.name || left?.id).localeCompare(String(right?.name || right?.id));
    };
    const roots = rendered.filter(node => (indegree.get(String(node.id)) || 0) === 0)
      .sort(nodeOrder);
    if (roots.length === 0 && rendered.length > 0) {
      roots.push([...rendered].sort(nodeOrder)[0]);
    }

    const extentFor = node => Math.max(80,
      Number(this.topologyNodeExtent?.(node)) || 80);
    const isFullChain = rendered.length >= 3 && roots.length === 1 &&
      edgeCount === rendered.length - 1 &&
      rendered.every(node => (children.get(String(node.id))?.size || 0) <= 1 &&
        (indegree.get(String(node.id)) || 0) <= 1);
    if (isFullChain) {
      const ordered = [];
      let id = String(roots[0].id);
      while (id && ordered.length < rendered.length) {
        ordered.push(byId.get(id));
        id = [...(children.get(id) || [])][0] || '';
      }
      const extent = Math.max(...ordered.map(extentFor));
      const columns = Math.ceil(ordered.length / 2);
      const horizontalGap = 2 * extent + 105;
      const rowOffset = extent + 70;
      const positions = new Map();
      ordered.forEach((node, index) => {
        const upper = index < columns;
        const column = upper ? index : (columns - 1 - (index - columns));
        positions.set(String(node.id), {
          x: column * horizontalGap,
          y: upper ? -rowOffset : rowOffset
        });
      });
      return positions;
    }

    const depth = new Map();
    const queue = [];
    for (const root of roots) {
      const id = String(root.id);
      if (!depth.has(id)) { depth.set(id, 0); queue.push(id); }
    }
    while (queue.length > 0) {
      const parent = queue.shift();
      const parentDepth = depth.get(parent) || 0;
      for (const child of children.get(parent) || []) {
        if (depth.has(child)) continue;
        depth.set(child, parentDepth + 1);
        queue.push(child);
      }
    }
    const agent = rendered.find(node => /^agent-1$/i.test(String(node?.name || '')));
    const agentDepth = agent && depth.get(String(agent.id));
    if (Number.isFinite(agentDepth) && rendered.every(node =>
      node === agent || /^controller$/i.test(String(node?.name || '')) ||
      depth.get(String(node.id)) > agentDepth)) {
      const mesh = this.topologyMeshLayout(rendered);
      if (mesh) return mesh;
    }
    let orphanDepth = Math.max(0, ...depth.values()) + 1;
    for (const node of [...rendered].sort(nodeOrder)) {
      const id = String(node.id);
      if (!depth.has(id)) depth.set(id, orphanDepth++);
    }

    const levels = new Map();
    for (const node of rendered) {
      const level = depth.get(String(node.id)) || 0;
      if (!levels.has(level)) levels.set(level, []);
      levels.get(level).push(node);
    }
    const aspect = Math.max(1, Number(width) || 1) / Math.max(1, Number(height) || 1);
    const targetColumns = Math.max(1, Math.ceil(Math.sqrt(rendered.length * aspect)));
    const targetRows = Math.max(1, Math.ceil(rendered.length / targetColumns));
    const columns = [];
    for (const level of [...levels.keys()].sort((left, right) => left - right)) {
      const items = levels.get(level).sort(nodeOrder);
      for (let start = 0; start < items.length; start += targetRows) {
        columns.push(items.slice(start, start + targetRows));
      }
    }

    const horizontalGap = 100;
    const verticalGap = 70;
    const positions = new Map();
    let cursorX = 0;
    for (const column of columns) {
      const columnExtent = Math.max(...column.map(extentFor));
      const centerX = cursorX + columnExtent;
      const columnHeight = column.reduce((total, node) => total + 2 * extentFor(node), 0) +
        verticalGap * Math.max(0, column.length - 1);
      let cursorY = -columnHeight / 2;
      for (const node of column) {
        const extent = extentFor(node);
        positions.set(String(node.id), {
          x: centerX,
          y: cursorY + extent
        });
        cursorY += 2 * extent + verticalGap;
      }
      cursorX += 2 * columnExtent + horizontalGap;
    }
    return positions;
  }

  separateTopologyNodes(nodes) {
    const ordered = [...nodes].sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const anchor = ordered.find(node => /^agent-1$/i.test(String(node?.name || ''))) || ordered[0];
    const extents = new Map(ordered.map(node => [node.id, this.topologyNodeExtent(node)]));
    for (const node of ordered) {
      node.x = Number.isFinite(node.fx) ? node.fx : Number.isFinite(node.x) ? node.x : 0;
      node.y = Number.isFinite(node.fy) ? node.fy : Number.isFinite(node.y) ? node.y : 0;
    }
    for (let pass = 0; pass < 80; pass += 1) {
      let moved = false;
      for (let index = 0; index < ordered.length; index += 1) {
        const left = ordered[index];
        for (const right of ordered.slice(index + 1)) {
          const deltaX = right.x - left.x;
          const deltaY = right.y - left.y;
          const distance = Math.hypot(deltaX, deltaY);
          const minimum = extents.get(left.id) + extents.get(right.id) + 24;
          if (distance >= minimum - 0.01) continue;
          const directionX = distance > 0.01 ? deltaX / distance : 1;
          const directionY = distance > 0.01 ? deltaY / distance : 0;
          const correction = minimum - distance + 0.02;
          const leftShare = left === anchor ? 0 : right === anchor ? 1 : 0.5;
          left.x -= directionX * correction * leftShare;
          left.y -= directionY * correction * leftShare;
          right.x += directionX * correction * (1 - leftShare);
          right.y += directionY * correction * (1 - leftShare);
          moved = true;
        }
      }
      if (!moved) break;
    }
    for (const node of ordered) {
      node.fx = node.x;
      node.fy = node.y;
      node.vx = 0;
      node.vy = 0;
      this.nodePositionCache.set(node.id, {x: node.x, y: node.y});
    }
  }

  /**
   * Separate overlapping groups without replacing the operator arrangement,
   * then fit the graph. No EasyMesh command or network change is involved.
   */
  optimizeTopologyLayout() {
    const simulation = this.topologySimulation;
    const nodes = this.topologySimulationNodes(simulation);
    if (!simulation || !Array.isArray(nodes) || nodes.length === 0) {
      this.showNotification('No topology is available to lay out', 'warning');
      return;
    }

    const button = document.getElementById('optimize-topology');
    this.topologyLayoutGeneration = (this.topologyLayoutGeneration || 0) + 1;
    this.topologyLayoutInProgress = true;
    this.topologyRenderPending = false;
    if (button) button.disabled = true;

    this.showNotification('Separating overlapping groups and fitting the topology…', 'info');
    const paint = simulation.on('tick');
    simulation.stop();
    if (!this.roomLayout?.prepare(nodes)) this.tightenTopologyNodes(nodes);
    if (typeof paint === 'function') paint();
    this.layoutTopologyLabels();

    this.topologyLayoutInProgress = false;
    this.topologyRenderPending = false;
    this.fitTopologyToView();
    if (button) button.disabled = false;
    this.showNotification('Topology spaced and fitted; your arrangement is retained', 'success');
  }

  /**
   * Fit the rendered graph into the current topology viewport.
   */
  fitTopologyToView() {
    if ((this.topologyInteractionDepth || 0) > 0) {
      this.topologyFitPending = true;
      return;
    }
    this.topologyFitPending = false;
    const view = this.topologyView;
    const group = view?.group?.node();
    if (!group || !view.svg || !view.zoom) return;

    let bounds;
    try {
      bounds = group.getBBox();
    } catch (error) {
      console.warn('Unable to measure topology for fit-to-view:', error);
      return;
    }

    if (![bounds.x, bounds.y, bounds.width, bounds.height, view.width, view.height].every(Number.isFinite) ||
        bounds.width <= 0 || bounds.height <= 0 || view.width <= 0 || view.height <= 0) return;
    const padding = 6;
    const availableWidth = Math.max(1, view.width - padding * 2);
    const availableHeight = Math.max(1, view.height - padding * 2);
    const scale = Math.min(
      availableWidth / bounds.width,
      availableHeight / bounds.height);
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const transform = d3.zoomIdentity
      .translate(view.width / 2 - scale * centerX,
                 view.height / 2 - scale * centerY)
      .scale(scale);

    // Apply synchronously so a refresh or export immediately after layout
    // cannot capture a half-finished transition or stale zoom cache.
    view.svg.call(view.zoom.transform, transform);
  }

  /** Observe the responsive topology pane without rebuilding its D3 graph. */
  observeTopologyViewport() {
    const container = document.getElementById('topology-visualization');
    if (!container || typeof ResizeObserver !== 'function') return false;

    this.topologyResizeObserver?.disconnect?.();
    this.topologyResizeObserver = new ResizeObserver(() => {
      this.scheduleTopologyViewportResize();
    });
    this.topologyResizeObserver.observe(container);
    return true;
  }

  /** Coalesce window and element resize notifications into one paint frame. */
  scheduleTopologyViewportResize() {
    if (this.topologyResizeFrame != null) return;
    const schedule = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : callback => setTimeout(callback, 0);
    this.topologyResizeFrame = schedule(() => {
      this.topologyResizeFrame = null;
      this.resizeTopologyViewport();
    });
  }

  resizeTopologyViewport() {
    const container = document.getElementById('topology-visualization');
    const view = this.topologyView;
    if (!container || !view?.svg) return false;

    const width = Math.floor(container.clientWidth);
    const height = Math.floor(container.clientHeight);
    if (width <= 0 || height <= 0 ||
        (width === view.width && height === view.height)) return false;

    view.svg.attr('width', width).attr('height', height);
    view.width = width;
    view.height = height;

    const center = this.topologySimulation?.force?.('center');
    if (center?.x && center?.y) center.x(width / 2).y(height / 2);
    this.fitTopologyToView();
    return true;
  }

  /**
   * Export the current topology as structured data or as the visible diagram.
   */
  async exportTopology(format) {
    const supported = new Set(['json', 'png', 'svg']);
    if (!supported.has(format)) {
      this.showNotification(`Unsupported topology export format: ${format}`, 'error');
      return;
    }
    if (!this.topology?.nodes?.length) {
      this.showNotification('No topology is available to export', 'warning');
      return;
    }

    const exportButton = document.getElementById('export-topology');
    if (exportButton) exportButton.disabled = true;

    try {
      const baseName = `easymesh-topology-${this.topologyExportTimestamp()}`;
      if (format === 'json') {
        const payload = this.topologyExportPayload();
        const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
          type: 'application/json;charset=utf-8'
        });
        this.downloadBlob(blob, `${baseName}.json`);
      } else {
        const svgBlob = await this.topologySvgBlob();
        if (format === 'svg') {
          this.downloadBlob(svgBlob, `${baseName}.svg`);
        } else {
          const pngBlob = await this.topologyPngBlob(svgBlob);
          this.downloadBlob(pngBlob, `${baseName}.png`);
        }
      }
      this.showNotification(`Topology exported as ${format.toUpperCase()}`, 'success');
    } catch (error) {
      console.error(`Topology ${format} export failed:`, error);
      this.showNotification(`Topology export failed: ${error.message}`, 'error');
    } finally {
      if (exportButton) exportButton.disabled = false;
    }
  }

  topologyExportTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  topologyExportPayload() {
    const transientFields = new Set(['index', 'vx', 'vy', 'fx', 'fy']);
    const topology = JSON.parse(JSON.stringify(this.topology));
    topology.nodes = this.topology.nodes.map(node => {
      const exportedNode = {};
      Object.entries(node).forEach(([key, value]) => {
        if (!transientFields.has(key)) exportedNode[key] = value;
      });
      return JSON.parse(JSON.stringify(exportedNode));
    });

    return {
      schema: 'rdk-easymesh-topology-export/v1',
      exportedAt: new Date().toISOString(),
      source: window.location.origin,
      topology
    };
  }

  async topologySvgBlob() {
    const sourceSvg = this.topologyView?.svg?.node()
      || document.querySelector('#topology-visualization svg');
    if (!sourceSvg) throw new Error('topology diagram is not rendered');

    const clone = sourceSvg.cloneNode(true);
    const width = Number(sourceSvg.getAttribute('width')) || sourceSvg.clientWidth;
    const height = Number(sourceSvg.getAttribute('height')) || sourceSvg.clientHeight;
    if (!width || !height) throw new Error('topology diagram has no drawable size');

    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
    clone.setAttribute('width', width);
    clone.setAttribute('height', height);

    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.setAttribute('x', '0');
    background.setAttribute('y', '0');
    background.setAttribute('width', '100%');
    background.setAttribute('height', '100%');
    background.setAttribute('fill', '#ffffff');
    clone.insertBefore(background, clone.firstChild);

    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = 'text { font-family: Arial, Helvetica, sans-serif; }';
    clone.insertBefore(style, background.nextSibling);

    await Promise.all(Array.from(clone.querySelectorAll('image')).map(async image => {
      const href = image.getAttribute('href')
        || image.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
        || image.getAttribute('xlink:href');
      if (!href || href.startsWith('data:')) return;

      const response = await fetch(new URL(href, window.location.href));
      if (!response.ok) throw new Error(`could not embed image ${href}`);
      const dataUrl = await this.blobToDataUrl(await response.blob());
      image.setAttribute('href', dataUrl);
      image.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', dataUrl);
    }));

    const xml = new XMLSerializer().serializeToString(clone);
    return new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${xml}\n`], {
      type: 'image/svg+xml;charset=utf-8'
    });
  }

  blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('failed to read image'));
      reader.readAsDataURL(blob);
    });
  }

  topologyPngBlob(svgBlob) {
    return new Promise((resolve, reject) => {
      const sourceSvg = this.topologyView?.svg?.node();
      const width = Number(sourceSvg?.getAttribute('width')) || sourceSvg?.clientWidth;
      const height = Number(sourceSvg?.getAttribute('height')) || sourceSvg?.clientHeight;
      if (!width || !height) {
        reject(new Error('topology diagram has no drawable size'));
        return;
      }

      const url = URL.createObjectURL(svgBlob);
      const image = new Image();
      image.onload = () => {
        try {
          const pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(width * pixelRatio);
          canvas.height = Math.round(height * pixelRatio);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('browser does not provide a canvas context');
          context.scale(pixelRatio, pixelRatio);
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          canvas.toBlob(blob => {
            URL.revokeObjectURL(url);
            if (blob) resolve(blob);
            else reject(new Error('browser could not encode PNG data'));
          }, 'image/png');
        } catch (error) {
          URL.revokeObjectURL(url);
          reject(error);
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('browser could not render the SVG export'));
      };
      image.src = url;
    });
  }

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  topologyBssIEEELabel(bss) {
    if (bss?.IEEE) return bss.IEEE;
    return bss?.Band === 0 || bss?.Band === 1
      ? '802.11ax'
      : '802.11be';
  }

  topologyRenderSnapshot(value) {
    // The topology API is a JSON model.  D3 owns and mutates this disposable
    // copy; polling continues to compare the untouched controller snapshot.
    return JSON.parse(JSON.stringify(value || { nodes: [], edges: [] }));
  }

  topologySimulationNodes(simulation) {
    const nodes = simulation?.nodes?.();
    return Array.isArray(nodes) ? nodes : [];
  }

  topologySignature(value) {
    return JSON.stringify(value || {}, (key, item) =>
      ['x', 'y', 'vx', 'vy', 'fx', 'fy', 'index', 'fixed',
        'signal', 'rcpi', 'rssi', 'signalObservedAt', 'steeringActions'].includes(key)
        ? undefined : item
    );
  }

  topologyBackhaulEdgeKey(edge) {
    return [edge?.from, edge?.to, this.normalizeMac(edge?.upstreamBSSID)]
      .map(value => String(value || '')).join('@');
  }

  topologyIsWirelessBackhaul(edge) {
    const bssid = this.normalizeMac(edge?.upstreamBSSID);
    return Boolean(bssid) && bssid !== '00:00:00:00:00:00' &&
      String(edge?.mediaType || '').toLowerCase() !== 'ethernet';
  }

  topologyBackhaulSignal(edge) {
    const metric = edge?.signal || {};
    let status = String(metric.status || '').toLowerCase();
    const rawRCPI = metric.rcpi ?? edge?.rcpi;
    const rawRSSI = metric.rssi_dbm ?? edge?.rssi;
    const rcpi = Number(rawRCPI);
    const rssi = Number(rawRSSI);
    const hasRCPI = rawRCPI !== null && rawRCPI !== undefined &&
      Number.isInteger(rcpi) && rcpi >= 0 && rcpi <= 220;
    const hasRSSI = rawRSSI !== null && rawRSSI !== undefined &&
      Number.isInteger(rssi) && rssi >= -110 && rssi <= 0;
    const observedAt = metric.observed_at || edge?.signalObservedAt || '';
    const observedMillis = Date.parse(observedAt);
    const future = Number.isFinite(observedMillis) && observedMillis - Date.now() > 5000;
    const ageSeconds = Number.isFinite(observedMillis)
      ? Math.max(0, Math.floor((Date.now() - observedMillis) / 1000))
      : null;

    if (!['fresh', 'stale', 'unknown'].includes(status)) {
      status = hasRCPI && hasRSSI && ageSeconds !== null
        ? (ageSeconds > 20 ? 'stale' : 'fresh') : 'unknown';
    } else if (status === 'fresh' && ageSeconds !== null && ageSeconds > 20) {
      status = 'stale';
    }
    if (!hasRCPI || !hasRSSI || ageSeconds === null || future) status = 'unknown';

    return {
      status,
      available: status === 'fresh',
      stale: status === 'stale',
      rcpi: status === 'unknown' ? null : rcpi,
      rssi: status === 'unknown' ? null : rssi,
      observedAt: status === 'unknown' ? null : observedAt,
      ageSeconds: status === 'unknown' ? null : ageSeconds
    };
  }

  topologyBackhaulSignalSignature(topology = this.topology) {
    return JSON.stringify((topology?.edges || []).map(edge => {
      const signal = this.topologyBackhaulSignal(edge);
      return [this.topologyBackhaulEdgeKey(edge), signal.status,
        signal.rcpi, signal.rssi, signal.observedAt];
    }).sort((left, right) => left[0].localeCompare(right[0])));
  }

  topologyBackhaulSignalHTML(edge) {
    const signal = this.topologyBackhaulSignal(edge);
    if (signal.available) {
      return `<br>Signal: ${signal.rssi} dBm (RCPI ${signal.rcpi}, ${signal.ageSeconds}s old)`;
    }
    if (signal.stale) {
      return `<br>Signal: stale — last ${signal.rssi} dBm (RCPI ${signal.rcpi}, ${signal.ageSeconds}s old)`;
    }
    return '<br>Signal: unknown — no fresh link metric';
  }

  topologyBackhaulLinkLabel(edge) {
    const channel = Number(edge?.channel) > 0 ? edge.channel : '?';
    const signal = this.topologyBackhaulSignal(edge);
    const signalLabel = signal.available ? `${signal.rssi} dBm` :
      (signal.stale ? 'stale' : 'signal ?');
    return `${this.topologyBandLabel(edge?.band)} · ch ${channel} · ${signalLabel}`;
  }

  refreshTopologyBackhaulSignalVisuals() {
    const group = this.topologyView?.group;
    if (!group?.selectAll) return false;
    const liveEdges = new Map((this.topology?.edges || []).map(edge =>
      [this.topologyBackhaulEdgeKey(edge), edge]));
    const self = this;
    const updateDatum = datum => {
      const live = liveEdges.get(self.topologyBackhaulEdgeKey(datum));
      if (!live) return;
      for (const key of ['signal', 'rcpi', 'rssi', 'signalObservedAt']) {
        if (Object.prototype.hasOwnProperty.call(live, key)) datum[key] = live[key];
        else delete datum[key];
      }
    };
    group.selectAll('path.backhaul-link').each(function(edge) {
      updateDatum(edge);
      const signal = self.topologyBackhaulSignal(edge);
      d3.select(this)
        .attr('stroke-dasharray', null)
        .attr('opacity', !self.topologyIsWirelessBackhaul(edge) ? 1 :
          (signal.stale ? 0.7 : (signal.available ? 1 : 0.5)));
    });
    group.selectAll('g.channel-label').each(function(edge) {
      updateDatum(edge);
      d3.select(this).select('text').text(self.topologyBackhaulLinkLabel(edge));
    });
    group.selectAll('g.backhaul-signal-bars').each(function(edge) {
      updateDatum(edge);
      self.updateTopologyBackhaulMeter(d3.select(this), edge);
    });
    return true;
  }

  updateTopologyBackhaulMeter(selection, edge) {
    const signal = this.topologyBackhaulSignal(edge);
    signal.color = signal.available ? signalMeter.rssiColor(signal.rssi) : signalMeter.colors.grey;
    const parentX = Number(edge?.source?.x);
    const nodeX = Number(edge?.target?.x);
    const direction = Number.isFinite(parentX) && Number.isFinite(nodeX) ? parentX - nodeX : -1;
    this.updateTopologySignalMeter(selection, {
      signal, iconSize: 35,
      from: {x: -2.5 + direction, y: -2.5}, to: {x: -2.5, y: -2.5}
    }, 'backhaul-signal-segment');
    const description = signal.available ? `${signal.rssi} dBm` :
      signal.stale ? `stale, last ${signal.rssi} dBm` : 'unknown';
    const label = `Uplink to ${edge?.source?.name || edge?.from || 'parent AP'}: ${description}`;
    selection.attr('data-signal-status', signal.status).attr('aria-label', label);
    selection.select('title').text(label);
  }

  topologyClientMetricsSignature(clients = this.clients) {
    return JSON.stringify((Array.isArray(clients) ? clients : []).map(client => {
      const metrics = client?.client_metrics || {};
      const rssi = Number(metrics.rssi_dbm);
      const rcpi = Number(metrics.rcpi);
      const updatedAt = Date.parse(metrics.last_updated || '');
      const stale = Number.isFinite(updatedAt) && Date.now() - updatedAt > 20000;
      return [
        this.normalizeMac(client?.mac),
        Number.isFinite(rssi) ? rssi : null,
        Number.isFinite(rcpi) ? rcpi : null,
        stale
      ];
    }).sort((left, right) => left[0].localeCompare(right[0])));
  }

  topologySTAAssociations(topology) {
    const associations = new Map();
    for (const node of topology?.nodes || []) {
      for (const sta of node?.STAList || []) {
        const mac = this.normalizeMac(sta?.staMAC);
        if (!mac) continue;
        associations.set(mac, {
          ownerId: String(node?.id || ''),
          ownerName: String(node?.name || node?.id || ''),
          bssid: this.normalizeMac(sta?.bssid),
          ssid: String(sta?.ssid || '')
        });
      }
    }
    return associations;
  }

  topologyRenderedSTAPositions() {
    const positions = new Map();
    const stationNodes = this.topologyView?.group?.selectAll?.('.sta-node');
    if (!stationNodes || stationNodes.empty()) return positions;
    const self = this;
    stationNodes.each(function(data) {
      const mac = self.normalizeMac(data?.sta?.staMAC);
      if (!mac) return;
      positions.set(mac, {
        x: (data.nodeRef?.fx ?? data.nodeRef?.x ?? 0) + (data.to?.x ?? 0),
        y: (data.nodeRef?.fy ?? data.nodeRef?.y ?? 0) + (data.to?.y ?? 0)
      });
    });
    return positions;
  }

  recordTopologyAssociationChanges(previousTopology, nextTopology) {
    const previous = this.topologySTAAssociations(previousTopology);
    const next = this.topologySTAAssociations(nextTopology);
    const renderedPositions = this.topologyRenderedSTAPositions();
    const announced = nextTopology?.steeringEvent || this.topology?.steeringEvent;
    const now = Date.now();
    for (const [mac, after] of next) {
      const before = previous.get(mac);
      if (!before || before.ownerId === after.ownerId && before.bssid === after.bssid) continue;
      const origin = renderedPositions.get(mac);
      const sourcePosition = this.nodePositionCache?.get(before.ownerId);
      this.staMoveEffects.set(mac, {
        staMAC: mac, fromBSSID: before.bssid, toBSSID: after.bssid,
        sourceOffsetX: origin && sourcePosition ? origin.x - sourcePosition.x : 0,
        sourceOffsetY: origin && sourcePosition ? origin.y - sourcePosition.y : 0,
        fromOwnerId: before.ownerId,
        fromOwnerName: before.ownerName,
        toOwnerId: after.ownerId,
        toOwnerName: after.ownerName,
        ssid: after.ssid,
        changedAt: now,
        fromX: renderedPositions.get(mac)?.x,
        fromY: renderedPositions.get(mac)?.y,
        clientName: this.normalizeMac(announced?.sta_mac) === mac
          ? String(announced?.client_name || '') : '',
        rendered: false
      });
    }
    for (const [mac, effect] of this.staMoveEffects) {
      if (now - effect.changedAt > 8000 || !next.has(mac)) {
        this.staMoveEffects.delete(mac);
      }
    }
  }

  topologyMoveEffectForSTA(sta, nodeId) {
    const effect = this.staMoveEffects.get(this.normalizeMac(sta?.staMAC));
    if (!effect || effect.toOwnerId !== String(nodeId || '')) return null;
    const ageMs = Math.max(0, Date.now() - effect.changedAt);
    if (ageMs >= 6000) return null;
    effect.rendered = true;
    return { ...effect, ageMs, remainingMs: Math.max(1, 6000 - ageMs) };
  }

  topologySteeringIntentForSTA(sta, nodeId, nodes) {
    const event = this.topology?.steeringEvent;
    if (!event || !['planned', 'moving'].includes(String(event.phase || '').toLowerCase()) ||
        this.normalizeMac(event.sta_mac) !== this.normalizeMac(sta?.staMAC)) return null;
    const targetName = String(event.target_name || '');
    const targetNode = (nodes || []).find(node =>
      String(node?.name || '').toLowerCase() === targetName.toLowerCase());
    if (!targetNode || String(targetNode.id) === String(nodeId || '')) return null;
    return { ...event, targetName: String(targetNode.name || targetName), targetNode };
  }

  topologyBandLabel(band) {
    if (Number(band) === 0) return '2.4G';
    if (Number(band) === 1) return '5G';
    if (Number(band) === 2 || Number(band) === 3) return '6G';
    return '?G';
  }

  topologySignalForSTA(sta) {
    const mac = this.normalizeMac(sta?.staMAC);
    const client = this.clients.find(item => this.normalizeMac(item?.mac) === mac);
    const servingBSSID = this.normalizeMac(sta?.bssid);
    const sameAssociation = !servingBSSID || servingBSSID === this.normalizeMac(client?.connected_bssid);
    const metrics = sameAssociation ? client?.client_metrics || {} : {};
    const rawRSSI = Number(metrics.rssi_dbm);
    const rcpi = Number(metrics.rcpi);
    const hasRSSI = Number.isFinite(rawRSSI) && rawRSSI < 0 && rawRSSI >= -110;
    const hasRCPI = Number.isInteger(rcpi) && rcpi > 0 && rcpi <= 220;
    const rssi = hasRSSI ? Math.round(rawRSSI) :
      (hasRCPI ? Math.round(rcpi / 2 - 110) : null);
    const updatedAt = Date.parse(metrics.last_updated || '');
    const ageMs = Number.isFinite(updatedAt) ? Math.max(0, Date.now() - updatedAt) : null;
    const stale = rssi !== null && ageMs !== null && ageMs > 20000;
    const available = rssi !== null && ageMs !== null && !stale && updatedAt - Date.now() <= 5000;

    let quality = 'unknown';
    const color = available ? signalMeter.rssiColor(rssi) : signalMeter.colors.grey;
    if (available && rssi >= -55) {
      quality = 'strong';
    } else if (available && rssi >= -67) {
      quality = 'good';
    } else if (available && rssi >= -75) {
      quality = 'fair';
    } else if (available) {
      quality = 'weak';
    }

    return {
      available,
      stale,
      rssi,
      rcpi: hasRCPI ? rcpi : null,
      ageMs,
      quality,
      color,
      band: this.topologyBandLabel(sta?.band),
      label: available ? `${rssi} dBm` : (stale ? 'stale' : 'N/A')
    };
  }

  /** Convert a live signal snapshot into the ten-level topology meter. */
  topologySignalLevel(signal) {
    return signal?.available ? signalMeter.rssiLevel(signal.rssi) : 0;
  }

  /** Place a full-height meter on the client side away from its RF link. */
  topologySignalMeterGeometry(staData, segmentIndex = 0) {
    const width = Math.max(5, Math.min(7, staData.iconSize * 0.18));
    const gap = 1;
    const segmentHeight = Math.max(1.25, (staData.iconSize - 9 * gap) / 10);
    const away = staData.to.x - staData.from.x < -1 ? -1 : 1;
    const x = away > 0
      ? staData.to.x + staData.iconSize / 2 + 5
      : staData.to.x - staData.iconSize / 2 - 5 - width;
    const y = staData.to.y + staData.iconSize / 2 -
      (Number(segmentIndex) + 1) * segmentHeight - Number(segmentIndex) * gap;
    return { x, y, width, height: segmentHeight, side: away };
  }

  updateTopologySignalMeter(selection, staData, segmentClass = 'sta-signal-segment') {
    const level = this.topologySignalLevel(staData.signal);
    selection.selectAll(`rect.${segmentClass}`)
      .attr('x', segmentIndex => this.topologySignalMeterGeometry(staData, segmentIndex).x)
      .attr('y', segmentIndex => this.topologySignalMeterGeometry(staData, segmentIndex).y)
      .attr('width', segmentIndex => this.topologySignalMeterGeometry(staData, segmentIndex).width)
      .attr('height', segmentIndex => this.topologySignalMeterGeometry(staData, segmentIndex).height)
      .attr('rx', 1)
      .attr('fill', segmentIndex => signalMeter.segmentColor(segmentIndex, level))
      .attr('stroke', segmentIndex => segmentIndex < level ? '#ffffff' : '#94a3b8')
      .attr('stroke-width', 0.55)
      .attr('opacity', 1);
  }

  /**
   * Update signal telemetry without replacing the SVG or force simulation.
   * The clients endpoint is polled every two seconds; rebuilding the graph for
   * those metric-only changes used to undo an operator's optimized viewport.
   */
  refreshTopologySignalVisuals() {
    const stationNodes = this.topologyView?.group?.selectAll?.('.sta-node');
    if (!stationNodes || stationNodes.empty()) return false;

    const self = this;
    stationNodes.each(function(staData) {
      staData.signal = self.topologySignalForSTA(staData.sta);
      self.updateTopologySignalMeter(d3.select(this), staData);
    });
    return true;
  }

  updateTopologyClients(clients) {
    const next = Array.isArray(clients) ? clients : [];
    const changed = this.topologyClientMetricsSignature(next) !==
      this.topologyClientMetricsSignature(this.clients);
    this.clients = next;
    return changed;
  }

  async refreshTopologyData() {
    if (!this.topologySnapshotRequest) {
      this.topologySnapshotRequest = this.apiCall('/topology').then(topology => {
        const changed = this.applyTopologyRefresh(topology);
        if (!changed) this.refreshTopologySignalVisuals();
      }).finally(() => {
        this.topologySnapshotRequest = null;
      });
    }
    if (!this.topologyMetricsRequest && Date.now() >= (this.topologyMetricsNextAt || 0)) {
      this.topologyMetricsNextAt = Date.now() + 250;
      this.topologyMetricsRequest = this.apiCall('/clients').then(response => {
        this.updateTopologyClients(response.clients);
        this.refreshTopologySignalVisuals();
      }).catch(error => {
        console.warn('Keeping the previous topology signal snapshot:', error);
      }).finally(() => {
        this.topologyMetricsRequest = null;
      });
    }
    await this.topologySnapshotRequest;
  }

  /**
   * The stack's names on the page (its profile; RDK's page text is the default).
   */
  applyProfileBranding() {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
    const profile = this.profile;
    const set = (selector, value) => {
      const element = document.querySelector(selector);
      if (element && value) element.textContent = value;
    };
    if (profile.title) document.title = profile.title;
    set('.logo-text', profile.logo);
    set('.version-badge', profile.badge);
    set('.wireless-label', profile.wirelessLabel);
  }

  /**
   * The steering actions a topology shows as roam cues: the controller's, and the
   * room service's recent ones while its room layout is fresh.
   */
  topologySteeringActions(response = this.topology) {
    return [...(response?.steeringActions || []),
      ...(this.roomLayout?.fresh(false) ? this.roomLayout.snapshot.steering_actions || [] : [])].slice(-200);
  }

  refreshRoomSteeringCues(response = this.topology) {
    const actions = this.topologySteeringActions(response);
    this.topologyView?.group?.selectAll?.('.sta-roam-cue').each(function() {
      steeringCues.refresh(d3.select(this), actions);
    });
  }

  /**
   * Apply a live topology snapshot without interrupting an operator gesture.
   * A running controller must always be present, so an empty snapshot after a
   * valid one is a transient provider miss rather than a real topology.
   */
  applyTopologyRefresh(response) {
    const currentHasNodes = Array.isArray(this.topology?.nodes) && this.topology.nodes.length > 0;
    const responseHasNodes = Array.isArray(response?.nodes) && response.nodes.length > 0;

    if (currentHasNodes && !responseHasNodes) {
      console.warn('Ignoring transient empty topology refresh');
      return false;
    }

    const topologyUnchanged = this.topologySignature(response) ===
      this.topologySignature(this.topology);
    if (topologyUnchanged) {
      this.topology = response;
      this.topologyRefreshPending = null;
      // Refresh even when the wire values are identical: local age advances
      // between polls and can move a rendered link from fresh to stale.
      this.refreshTopologyBackhaulSignalVisuals();
      this.refreshRoomSteeringCues(response);
      return false;
    }

    this.recordTopologyAssociationChanges(this.topology, response);

    if ((this.topologyInteractionDepth || 0) > 0) {
      this.topologyRefreshPending = response;
      return false;
    }

    this.topology = response;
    this.updateTopologyVisualization();
    return true;
  }

  beginTopologyInteraction() {
    this.topologyInteractionDepth = (this.topologyInteractionDepth || 0) + 1;
  }

  endTopologyInteraction() {
    this.topologyInteractionDepth = Math.max(0, (this.topologyInteractionDepth || 0) - 1);
    if (this.topologyInteractionDepth > 0) return;

    const pending = this.topologyRefreshPending;
    const renderPending = this.topologyRenderPending;
    this.topologyRefreshPending = null;
    this.topologyRenderPending = false;
    const refreshed = pending ? this.applyTopologyRefresh(pending) : false;

    if (!refreshed && renderPending && !this.topologyLayoutInProgress) {
      this.updateTopologyVisualization();
    }
    if (this.topologyFitPending) this.fitTopologyToView();
  }

  /**
   * Update topology visualization
   */
  updateTopologyVisualization() {
    const container = d3.select('#topology-visualization');
    const tooltip = d3.select('#custom-tooltip');
    const width = container.node().clientWidth;
    const height = container.node().clientHeight;
    const self = this;

    // Create cache for node position and zoom which persist across refresh calls
    this.nodePositionCache = this.nodePositionCache || new Map();
    this.zoomTransformCache = this.zoomTransformCache || d3.zoomIdentity;

    if ((this.topologyInteractionDepth || 0) > 0) {
      this.topologyRenderPending = true;
      return;
    }

    // WebSocket and polling updates can arrive while the force layout is
    // running. Keep the current SVG alive until its positions are committed,
    // then render the newest topology once using that position cache.
    if (this.topologyLayoutInProgress) {
      this.topologyRenderPending = true;
      return;
    }

    // Return if container is not ready
    if (width === 0 || height === 0) {
      setTimeout(() => this.updateTopologyVisualization(), 100);
      return;
    }

    // Return if container is empty
    if (!this.topology?.nodes?.length) return;

    const renderTopology = this.topologyRenderSnapshot(this.topology);
    const initialPositions = this.topologyLandscapeLayout(renderTopology.nodes, renderTopology.edges, width, height);
    for (const [id, position] of initialPositions) {
      if (!this.nodePositionCache.has(id)) this.nodePositionCache.set(id, position);
    }
    const currentNodeIds = new Set(renderTopology.nodes.map(n => String(n.id)));
    for (const key of this.nodePositionCache.keys()) {
      if (!currentNodeIds.has(key)) {
        this.nodePositionCache.delete(key);
      }
    }
    const currentSTAKeys = new Set(renderTopology.nodes.flatMap(node =>
      (node.STAList || []).map(sta => this.normalizeMac(sta?.staMAC))
    ));
    for (const key of this.staPositionCache.keys()) {
      if (!currentSTAKeys.has(key)) this.staPositionCache.delete(key);
    }

    // Clear previous content and stop a simulation owned by the old SVG.
    if (this.topologySimulation) this.topologySimulation.stop();
    this.topologyLayoutGeneration = (this.topologyLayoutGeneration || 0) + 1;
    const optimizeButton = document.getElementById('optimize-topology');
    if (optimizeButton) optimizeButton.disabled = false;
    container.selectAll('*').remove();

    // Create SVG and zoom behavior
    const svg = container.append('svg')
    .attr('width', width)
    .attr('height', height)

    const defs = svg.append('defs');
    defs.append('marker')
      .attr('id', 'sta-steering-arrowhead')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 9).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#7c3aed');

    defs.append('marker')
      .attr('id', 'sta-steering-intent-arrowhead')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 9).attr('refY', 0)
      .attr('markerWidth', 7).attr('markerHeight', 7)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#f59e0b');

    defs.append('marker')
      .attr('id', 'backhaul-uplink-arrowhead')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 9).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6)
      .attr('orient', 'auto-start-reverse')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#334155');

    const svgGroup = svg.append('g');
    const zoom = d3.zoom()
      .on('start', (event) => {
        if (event.sourceEvent) this.beginTopologyInteraction();
      })
      .on('zoom', (event) => {
        svgGroup.attr('transform', event.transform);
        // Save zoom state
        this.zoomTransformCache = event.transform;
      })
      .on('end', (event) => {
        if (event.sourceEvent) this.endTopologyInteraction();
      });

    svg.call(zoom);
    svg.call(zoom.transform, this.zoomTransformCache);
    this.topologyView = { svg, group: svgGroup, zoom, width, height };

    // Normalize node and edge IDs to strings
    renderTopology.nodes.forEach(n => n.id = String(n.id));
    renderTopology.edges.forEach(e => {
      e.from = String(e.from);
      e.to = String(e.to);
    });

    // Validate edges
    const nodeIds = new Set(renderTopology.nodes.map(n => n.id));
    const invalidEdges = renderTopology.edges.filter(e => !nodeIds.has(e.from) || !nodeIds.has(e.to));

    if (invalidEdges.length > 0) {
      console.error('Invalid edges found:', invalidEdges);
      throw new Error('Topology contains edges with undefined nodes.');
    }

    // Transform edges to use source/target for D3
    const edges = renderTopology.edges.map(e => ({
      ...e,
      source: e.from,
      target: e.to
    }));

    // Define haulType colors
    const haulColors = {
      Fronthaul: '#c3cbf8ff',
      Backhaul: '#e68b8bff',
      Iot: '#d3ced3ff',
      Hotspot: '#9fe0c3ff',
      Configurator: '#f4d28cff'
    };

    const bandColors = {
      '-1': '#0bd476ff',
      '0': '#8B4513',
      '1': '#5a82c2ff',
      '2': '#d83131ff',
      '3': '#d83131ff',
    };

    const bandWavelengths = {
      '-1': 0,
      '0': 25,
      '1': 15,
      '2': 10,
      '3': 10,
      'default': 20
    };

    renderTopology.nodes.forEach(node => {
      const saved = this.nodePositionCache.get(node.id);
      node.x = saved?.x ?? 0;
      node.y = saved?.y ?? 0;

      // Keep nodes fixed after positioning
      node.fx = node.x;
      node.fy = node.y;
    });
    if (!this.roomLayout?.prepare(renderTopology.nodes)) this.tightenTopologyNodes(renderTopology.nodes);

    // Create simulation
    const simulation = d3.forceSimulation(renderTopology.nodes)
    .force('link', d3.forceLink(edges).id(d => d.id)
      .distance(d => String(d.band) === '-1' ? 220 : 700)
      .strength(d => String(d.band) === '-1' ? 0.45 : 0.16))
    .force('charge', d3.forceManyBody().strength(-2200))
    .force('collision', d3.forceCollide().radius(d => self.topologyNodeExtent(d) + 15).strength(1).iterations(2))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .alphaDecay(0.08).stop();
    this.topologySimulation = simulation;

    const edgeGroup = svgGroup.append('g').attr('class', 'edges');
    const steeringEffectGroup = svgGroup.append('g').attr('class', 'steering-effects');
    const nodeGroup = svgGroup.append('g').attr('class', 'nodes');
    const staGroup  = svgGroup.append('g').attr('class', 'sta-nodes');

    const node = nodeGroup.selectAll('g')
    .data(renderTopology.nodes)
    .enter()
    .append('g')
    .attr('class', 'node')
    .call(d3.drag()
      .on('start', dragstarted)
      .on('drag', dragged)
      .on('end', dragended));

    // Draw overlapping haulType circles and icon
    node.each(function(d) {
      const g = d3.select(this);
      const haulTypes = d.haulTypes || [];
      const staList = Array.isArray(d.STAList) ? d.STAList : [];
      const haulGeometry = self.topologyHaulGeometry(haulTypes, staList);

      haulGeometry.forEach(item => {
        const { haul, offset, radius: circleRadius } = item;
        // Skip invalid entries safely
        if (!haul || typeof haul !== 'object') return;

        // SSID heading inside the each circle
        const type = haul.name || 'Unknown';
        const ssid = haul?.ssid || 'SSID N/A';
        const vlanId = haul?.VlanId ?? 'N/A';
        const mldMap = new Map();

        // Extract BSS-band details
        const bssDetails = haul.BSSList
        .filter(bss => bss.vapMode !== 1)
        .map(bss => {
          const bandLabel = bss.Band === 0 ? '2.4GHz' :
            bss.Band === 1 ? '5GHz' :
            bss.Band === 3 ? '6GHz' : 'Unknown';

            if (bss.MLDAddr && bss.MLDAddr !== "") {
              if (!mldMap.has(bss.MLDAddr)) {
                mldMap.set(bss.MLDAddr, new Set());
              }
              mldMap.get(bss.MLDAddr).add(bandLabel);
            }

            const ieee = self.topologyBssIEEELabel(bss);
            return `${bss.BSSID} - (${bandLabel}) - ${ieee}`;
          });

          const mldSummary = Array.from(mldMap.entries()).map(([addr, bands]) => {
            return `${addr} - ${bands.size} - ${Array.from(bands).join(', ')}`;
          });

        const hasMLD = haul.BSSList.some(bss => bss.MLDAddr && bss.MLDAddr !== "");

        // Draw haultype overlapping circle
        g.append('circle')
          .attr('r', circleRadius)
          .attr('cx', offset.x)
          .attr('cy', offset.y)
          .attr('fill', haulColors[type] || '#ccc')
          .attr('opacity', 0.6)
          .attr('stroke', hasMLD ? '#45f88aff': 'none')
          .attr('stroke-width', hasMLD ? 3: 0)
          .style('pointer-events', 'visiblePainted')
          .on('mouseover', function(event) {
            let mldInfo = '';
            if (mldSummary.length > 0) {
              mldInfo = `<br><b>MLD Summary:</b><br>${mldSummary.join('<br>')}`;
            }
            tooltip.style('display', 'block')
           .html(`<b>SSID: ${ssid}</b><br>${bssDetails.join('<br>')}<br>VLAN ID: ${vlanId}<br>${mldInfo}`);
          })
          .on('mousemove', function(event) {
            self.positionTooltip(event, tooltip);
          })
          .on('mouseout', function() {
            tooltip.style('display', 'none');
          });

        const label = self.topologySSIDLabel(item);
        g.append('text')
          .attr('class', 'ssid-label')
          .attr('data-ssid', ssid)
          .attr('aria-label', ssid)
          .attr('x', label.x)
          .attr('y', label.y)
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'middle')
          .attr('font-size', `${label.fontSize}px`)
          .attr('fill', label.color)
          .attr('font-weight', 'bold')
          .attr('stroke', '#fff').attr('stroke-width', 2).attr('paint-order', 'stroke')
          .style('pointer-events', 'none')
          .text(label.text);
      });

      // STA Placement
      if (Array.isArray(d.STAList) && d.STAList.length > 0) {
        staList.forEach(sta => {
          const staElement = staGroup
          .append('g')
          .attr('class', 'sta-node')
          .datum(() => {
            return {
              nodeRef: d,
              sta,
              signal: self.topologySignalForSTA(sta),
              ...self.topologySTAPlacement(sta, staList, haulGeometry, d.id)
            };
          })
          .style('cursor', 'grab')
          .call(d3.drag()
            .subject((_event, dragData) => ({
              x: (dragData.nodeRef.fx ?? dragData.nodeRef.x ?? 0) + dragData.to.x,
              y: (dragData.nodeRef.fy ?? dragData.nodeRef.y ?? 0) + dragData.to.y
            }))
            .on('start', staDragStarted)
            .on('drag', staDragged)
            .on('end', staDragEnded));

          const data = staElement.datum();
          const moveEffect = self.topologyMoveEffectForSTA(sta, d.id);
          const steeringIntent = self.topologySteeringIntentForSTA(sta, d.id, renderTopology.nodes);

          const from = data.from;
          const to = data.to;
          const staWaveLength = bandWavelengths[sta.band] || bandWavelengths['default'];
          data.waveLength = staWaveLength;
          const sinePathData = self.generateSineWavePath(from, to, {
            amplitude: 5,
            wavelength: staWaveLength
          });

          staElement.append('path')
            .attr('class', 'sta-link')
            .attr('d', sinePathData.path)
            .attr('fill', 'none')
            .attr('stroke', '#141313ff')
            .attr('stroke-width', 1)
            .attr('stroke', d => bandColors[sta.band] || '#000');

          // Draw STA node
          const iconUrl = self.getClientIcon(sta.clientType, sta.ssid);
          const staIdentity = self.getSTAIdentity(sta);

          const signalGlyph = staElement.append('g')
            .attr('class', 'sta-signal-bars')
            .attr('opacity', 1)
            .style('pointer-events', 'none');
          signalGlyph.selectAll('rect.sta-signal-segment')
            .data([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
            .enter()
            .append('rect')
            .attr('class', 'sta-signal-segment');
          self.updateTopologySignalMeter(staElement, data);

          if (steeringIntent) {
            const phaseLabel = steeringIntent.phase === 'moving' ? 'MOVING' : 'NEXT';
            const halo = staElement.append('circle')
              .attr('class', 'sta-steer-intent-halo')
              .attr('cx', to.x).attr('cy', to.y)
              .attr('r', data.iconSize / 2 + 8)
              .attr('fill', '#fef3c7')
              .attr('fill-opacity', 0.72)
              .attr('stroke', '#f59e0b')
              .attr('stroke-width', 5)
              .style('pointer-events', 'none');
            halo.append('animate')
              .attr('attributeName', 'stroke-width')
              .attr('values', '5;9;5').attr('dur', '0.8s').attr('repeatCount', 'indefinite');
            halo.append('animate')
              .attr('attributeName', 'opacity')
              .attr('values', '1;0.45;1').attr('dur', '0.8s').attr('repeatCount', 'indefinite');

            const badge = staElement.append('g')
              .attr('class', 'sta-steer-intent-badge')
              .attr('transform', `translate(${to.x},${to.y - data.iconSize / 2 - 22})`)
              .style('pointer-events', 'none');
            const displayIdentity = steeringIntent.client_name || staIdentity;
            const badgeText = `${phaseLabel}: ${displayIdentity} → ${steeringIntent.targetName}`;
            const badgeWidth = Math.max(190, badgeText.length * 10.5 + 28);
            badge.append('rect')
              .attr('x', -badgeWidth / 2).attr('y', -17)
              .attr('width', badgeWidth).attr('height', 34).attr('rx', 17)
              .attr('fill', '#fff7ed').attr('stroke', '#f59e0b').attr('stroke-width', 4);
            badge.append('text')
              .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
              .attr('font-size', '18px').attr('font-weight', '800').attr('fill', '#9a3412')
              .text(badgeText);

            steeringEffectGroup.append('path')
              .datum({ sourceNode: d, targetNode: steeringIntent.targetNode, staData: data })
              .attr('class', 'sta-steering-intent-path')
              .attr('fill', 'none').attr('stroke', '#f59e0b').attr('stroke-width', 5)
              .attr('stroke-dasharray', '12 8')
              .attr('marker-end', 'url(#sta-steering-intent-arrowhead)')
              .attr('opacity', 0.9).style('pointer-events', 'none');
          }

          if (moveEffect) {
            const sourceNode = renderTopology.nodes.find(nodeItem => String(nodeItem.id) === moveEffect.fromOwnerId);
            steeringCues.draw(steeringEffectGroup, moveEffect, sourceNode, d, data,
              moveEffect.clientName || staIdentity, self.topologySteeringActions(), self.zoomTransformCache?.k || 1);
          }

          staElement.append('image')
           .attr('class', 'sta-icon')
           .attr('xlink:href', iconUrl)
           .attr('x', to.x - data.iconSize / 2)
           .attr('y', to.y - data.iconSize / 2)
           .attr('width', data.iconSize)
           .attr('height', data.iconSize)
           .attr('opacity', 1)
           .on('mouseover', function(event) {
              let mldInfo = '';
              if (sta.MLDAddr && sta.MLDAddr !== '') {
                mldInfo = `<br>MLD Address: ${sta.MLDAddr}`;
              }
              const freshnessInfo = data.signal.ageMs !== null
                ? `, ${Math.round(data.signal.ageMs / 1000)}s old`
                : '';
              const signalInfo = data.signal.available
                ? `${data.signal.rssi} dBm${data.signal.rcpi !== null ? ` (RCPI ${data.signal.rcpi})` : ''}${freshnessInfo}`
                : (data.signal.stale ? 'Stale metrics' : 'N/A');
              const channelInfo = Number(sta.channel) > 0
                ? `${self.topologyBandLabel(sta.band)} channel ${sta.channel}`
                : 'N/A';
              tooltip.style('display', 'block')
              .html(`<b>${staIdentity}</b><br>Type: ${sta.ssid === 'iot_ssid' ?
                'IoT device' : (sta.clientType || 'Unknown')}<br>MAC: ${sta.staMAC}${mldInfo}<br>SSID: ${sta.ssid}<br>Band: ${data.signal.band}<br>Channel: ${channelInfo}<br>BSSID: ${sta.bssid || 'N/A'}<br>Signal: ${signalInfo}`);
            })
           .on('mousemove', function(event) {
              self.positionTooltip(event, tooltip);
            })
            .on('mouseout', function() {
              tooltip.style('display', 'none');
            });

          staElement.append('text')
            .attr('class', 'sta-identity-label')
            .attr('x', to.x)
            .attr('y', to.y + data.iconSize / 2 + 24)
            .attr('text-anchor', 'middle')
            .attr('font-size', '22px')
            .attr('font-weight', '600')
            .attr('fill', '#333')
            .attr('stroke', '#fff')
            .attr('stroke-width', 3)
            .attr('paint-order', 'stroke')
            .style('pointer-events', 'none')
            .attr('opacity', 1)
            .text(staIdentity);


        });

      }

      const nodeIconUrl = self.getNodeIcon(d.name, d.kind);
      let isController = false;
      if (d.name?.toLowerCase().includes('controller')) {
        isController = true;
      }

      const uplink = edges.find(item => String(item.to) === String(d.id));
      if (uplink && self.topologyIsWirelessBackhaul(uplink)) {
        const meter = g.append('g').attr('class', 'backhaul-signal-bars')
          .attr('role', 'img').style('pointer-events', 'none').datum(uplink);
        meter.append('title');
        meter.selectAll('rect').data(Array.from({length: 10}, (_value, index) => index))
          .enter().append('rect').attr('class', 'backhaul-signal-segment');
        self.updateTopologyBackhaulMeter(meter, uplink);
      }

      g.append('image')
        .attr('xlink:href', nodeIconUrl)
        .attr('x', isController ? -25 : -20)
        .attr('y', isController ? -25 : -20)
        .attr('width', isController ? 50 : 35)
        .attr('height', isController ? 50 : 35)
        .on('mouseover', function(event) {
          const incoming = edges.find(item => String(item.to) === String(d.id));
          const parent = incoming?.source?.name || incoming?.source?.id || '';
          const upstreamBSSID = d.upstreamBSSID || incoming?.upstreamBSSID || '';
          const wireless = incoming && self.topologyIsWirelessBackhaul(incoming);
          const signal = incoming && wireless
            ? self.topologyBackhaulSignalHTML(incoming) : '';
          const backhaul = incoming
            ? `<br><b>Backhaul parent:</b> ${parent}` +
              `<br>Media: ${d.backhaulMedia || incoming.mediaType || 'Unknown'}` +
              (wireless ? `<br>Upstream BSSID: ${upstreamBSSID}` : '') +
              (String(incoming.band) !== '-1'
                ? `<br>Link: ${self.topologyBandLabel(incoming.band)} · ch ${Number(incoming.channel) > 0 ? incoming.channel : '?'}`
                : '') + signal
            : '';
          self.topologyRFHoverEvent = event;
          self.topologyRFHover = () => {
            if (!this.isConnected) {
              self.topologyRFHover = null;
              tooltip.style('display', 'none');
              return;
            }
            // an adapter-onboarded OpenSync pod: its M1 identity, which the agent
            // chose, so it is escaped before it becomes HTML
            const text = value => String(value ?? '').replace(/[&<>"']/g,
              c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
            const identity = d.kind === 'opensync-pod'
              ? `<br><b>${text(d.model || 'OpenSync pod')}</b> · ${text(d.manufacturer)}` : '';
            const html = `<b>${d.name || d.id}</b>${identity}<br>AL MAC: ${d.id}${backhaul}` +
              (self.roomLayout?.rfHTML(d) || '');
            tooltip.style('display', 'block');
            if (tooltip.html() !== html) tooltip.html(html);
            self.positionTooltip(self.topologyRFHoverEvent, tooltip);
          };
          self.topologyRFHover();
        })
        .on('mousemove', function(event) {
          self.topologyRFHoverEvent = event;
          self.positionTooltip(event, tooltip);
        })
        .on('mouseout', function() {
          self.topologyRFHover = null;
          tooltip.style('display', 'none');
        });

      g.append('text')
        .attr('class', 'mesh-identity-label')
        .attr('x', 0)
        .attr('y', isController ? 48 : 42)
        .attr('text-anchor', 'middle')
        .attr('font-size', '22px')
        .attr('fill', '#333')
        .attr('font-weight', 'bold')
        .attr('stroke', '#fff')
        .attr('stroke-width', 3)
        .attr('paint-order', 'stroke')
        .style('pointer-events', 'none')
        .text(d.name);
    });

    const edge = edgeGroup.selectAll('path')
    .data(edges)
    .enter()
    .append('path')
    .attr('class', 'backhaul-link')
    .attr('fill', 'none')
    .attr('stroke-width', 2)
    .attr('stroke', d => bandColors[d.band] || '#000')
    .attr('stroke-dasharray', null)
    .attr('opacity', d => {
      if (!self.topologyIsWirelessBackhaul(d)) return 1;
      const signal = self.topologyBackhaulSignal(d);
      return signal.stale ? 0.7 : (signal.available ? 1 : 0.5);
    })
    // Paths are encoded parent -> child; marker-start with auto-start-reverse
    // points from the child back toward its actual upstream parent.
    .attr('marker-start', d => self.topologyIsWirelessBackhaul(d)
      ? 'url(#backhaul-uplink-arrowhead)' : null)
    .style('pointer-events', 'stroke')
    .style('cursor', 'help')
    .on('mouseover', function(event, d) {
      const parent = d.source?.name || d.source?.id || d.from;
      const child = d.target?.name || d.target?.id || d.to;
      const bssid = d.upstreamBSSID && d.upstreamBSSID !== '00:00:00:00:00:00'
        ? `<br>Upstream BSSID: ${d.upstreamBSSID}` : '';
      const signal = self.topologyIsWirelessBackhaul(d)
        ? self.topologyBackhaulSignalHTML(d) : '';
      tooltip.style('display', 'block')
        .html(`<b>${child} uplink &rarr; ${parent}</b><br>${self.topologyBandLabel(d.band)} · ch ${Number(d.channel) > 0 ? d.channel : '?'}${bssid}${signal}`);
      self.positionTooltip(event, tooltip);
    })
    .on('mousemove', event => self.positionTooltip(event, tooltip))
    .on('mouseout', () => tooltip.style('display', 'none'));

    const channelLabels = edgeGroup.selectAll('g.channel-label')
    .data(edges.filter(d => self.topologyIsWirelessBackhaul(d)))
    .enter()
    .append('g')
    .attr('class', 'channel-label');

    channelLabels.append('rect')
    .attr('x', -72)
    .attr('y', -12)
    .attr('width', 144)
    .attr('height', 24)
    .attr('rx', 12)
    .attr('fill', '#fff')
    .attr('stroke-width', 2)
    .attr('stroke', d => bandColors[d.band] || '#000');

    channelLabels.append('text')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'middle')
    .attr('font-size', '10px')
    .attr('font-weight', 'bold')
    .text(d => self.topologyBackhaulLinkLabel(d));

    simulation.on('tick', () => {
      node.attr('transform', d => `translate(${d.x},${d.y})`);
      node.selectAll('g.backhaul-signal-bars').each(function(uplink) {
        self.updateTopologyBackhaulMeter(d3.select(this), uplink);
      });

      edge.attr('d', d => {
        const from = d.source;
        const to = d.target;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        const ux = dx / length;
        const uy = dy / length;

        const edgeOffset = 25;
        const adjustedFrom = {
          x: from.x + ux * edgeOffset,
          y: from.y + uy * edgeOffset
        };
        const adjustedTo = {
          x: to.x - ux * edgeOffset,
          y: to.y - uy * edgeOffset
        };

        const band = String(d.band);
        if (band === '-1') {
          d._midpoint = [(adjustedFrom.x + adjustedTo.x) / 2, (adjustedFrom.y + adjustedTo.y) / 2];
          return `M${adjustedFrom.x},${adjustedFrom.y} L${adjustedTo.x},${adjustedTo.y}`;
        }

        const wavelength = bandWavelengths[band] || bandWavelengths['default'];
        const amplitude = 7;
        const { path, midpoint } = self.generateSineWavePath(adjustedFrom, adjustedTo, { amplitude, wavelength });
        d._midpoint = midpoint;
        return path;
      });

      channelLabels
      .attr('transform', d => {
        const mid = d._midpoint || [(d.source.x + d.target.x) / 2, (d.source.y + d.target.y) / 2];
        return `translate(${mid[0]},${mid[1]})`;
      });

      staGroup.selectAll('.sta-node')
       .attr('transform', d => `translate(${d.nodeRef.fx ?? d.nodeRef.x}, ${d.nodeRef.fy ?? d.nodeRef.y})`);

      steeringEffectGroup.selectAll('.sta-roam-cue').each(function() {
        steeringCues.position(d3.select(this));
      });

      steeringEffectGroup.selectAll('.sta-steering-intent-path')
        .attr('d', effect => {
          const sourceX = (effect.sourceNode.fx ?? effect.sourceNode.x) + effect.staData.to.x;
          const sourceY = (effect.sourceNode.fy ?? effect.sourceNode.y) + effect.staData.to.y;
          const targetX = effect.targetNode.fx ?? effect.targetNode.x;
          const targetY = effect.targetNode.fy ?? effect.targetNode.y;
          const midX = (sourceX + targetX) / 2;
          const midY = (sourceY + targetY) / 2 - 30;
          return `M${sourceX},${sourceY} Q${midX},${midY} ${targetX},${targetY}`;
        });
      steeringCues.layout(steeringEffectGroup);
    });

    simulation.on('tick')();
    this.layoutTopologyLabels();
    this.fitTopologyToView();

    function dragstarted(event, d) {
      if (self.roomLayout?.enabled) self.roomLayout.setEnabled(false);
      self.beginTopologyInteraction();
    }

    function updateSTAVisual(selection, d) {
      const sinePathData = self.generateSineWavePath(d.from, d.to, {
        amplitude: 5,
        wavelength: d.waveLength
      });
      selection.select('path.sta-link').attr('d', sinePathData.path);
      self.updateTopologySignalMeter(selection, d);
      selection.select('circle.sta-steer-pulse')
        .attr('cx', d.to.x).attr('cy', d.to.y);
      selection.select('image.sta-icon')
        .attr('x', d.to.x - d.iconSize / 2)
        .attr('y', d.to.y - d.iconSize / 2);
      selection.select('text.sta-identity-label')
        .attr('x', d.to.x)
        .attr('y', d.to.y + d.iconSize / 2 + 24);
    }

    function staDragStarted(event) {
      self.beginTopologyInteraction();
      if (event.sourceEvent) event.sourceEvent.stopPropagation();
      d3.select(this).raise().style('cursor', 'grabbing');
    }

    function staDragged(event, d) {
      const nodeX = d.nodeRef.fx ?? d.nodeRef.x ?? 0;
      const nodeY = d.nodeRef.fy ?? d.nodeRef.y ?? 0;
      d.to = {
        x: event.x - nodeX,
        y: event.y - nodeY
      };
      updateSTAVisual(d3.select(this), d);
      simulation.on('tick')();
    }

    function staDragEnded(_event, d) {
      self.staPositionCache.set(d.cacheKey, {
        ownerId: d.ownerId,
        ssid: d.ssid,
        x: d.to.x,
        y: d.to.y
      });
      d3.select(this).style('cursor', 'grab');
      self.layoutTopologyLabels();
      self.endTopologyInteraction();
      self.fitTopologyToView();
    }

    function dragged(event, d) {
      d.x = d.fx = event.x;
      d.y = d.fy = event.y;
      simulation.on('tick')();
    }

    function dragended(event, d) {
      simulation.stop();
      self.nodePositionCache.set(d.id, {
        x: d.fx,
        y: d.fy
      });

      // Lock at new position
      d.x = d.fx;
      d.y = d.fy;
      simulation.on('tick')();
      self.layoutTopologyLabels();
      self.endTopologyInteraction();
      self.fitTopologyToView();
    }
  }

  /**
   * Return the local center and radius of each SSID bubble. Private and IoT
   * groups are deliberately larger than infrastructure-only haul groups.
   */
  topologyHaulGeometry(haulTypes, staList = []) {
    const items = Array.isArray(haulTypes) ? haulTypes : [];
    const stations = Array.isArray(staList) ? staList : [];
    const layoutRadius = items.length > 1 ? 150 : 0;

    return items.map((haul, index) => {
      const ssid = String(haul?.ssid || '');
      const stationCount = stations.filter(sta => String(sta?.ssid || '') === ssid).length;
      const isClientCohort = ssid === 'private_ssid' || ssid === 'iot_ssid';
      // Preserve a clear current-lab minimum and grow gently for denser future
      // cohorts without letting one group consume the entire graph.
      const radius = isClientCohort
        ? Math.min(155, Math.max(120, 110 + stationCount * 2))
        : 80;
      const angle = items.length > 0 ? (2 * Math.PI / items.length) * index : 0;
      return {
        haul,
        ssid,
        radius,
        offset: {
          x: layoutRadius * Math.cos(angle),
          y: layoutRadius * Math.sin(angle)
        }
      };
    });
  }

  topologyNodeExtent(node) {
    const geometry = this.topologyHaulGeometry(node?.haulTypes, node?.STAList);
    return geometry.reduce((extent, item) => Math.max(
      extent,
      Math.hypot(item.offset.x, item.offset.y) + item.radius
    ), 80);
  }

  topologyNodeFootprint(node) {
    const geometry = this.topologyHaulGeometry(node?.haulTypes, node?.STAList);
    const shapes = [{x: 0, y: 0, radius: 80}, ...geometry.map(item => ({
      x: item.offset.x, y: item.offset.y, radius: item.radius + 28
    }))];
    for (const station of node?.STAList || []) {
      const saved = this.staPositionCache.get(this.normalizeMac(station?.staMAC));
      if (!saved || saved.ownerId !== String(node.id) || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) continue;
      const cohort = geometry.find(item => item.ssid === String(station.ssid || ''));
      if (!cohort || Math.hypot(saved.x - cohort.offset.x, saved.y - cohort.offset.y) + 64 > cohort.radius + 28) {
        shapes.push({x: saved.x, y: saved.y, radius: 64});
      }
    }
    return shapes;
  }

  tightenTopologyNodes(nodes) {
    if (!nodes.length) return;
    this.nodePositionCache = this.nodePositionCache || new Map();
    const coincident = nodes.some((node, index) => nodes.slice(index + 1).some(peer => Math.hypot(node.x - peer.x, node.y - peer.y) < 0.1));
    if (coincident) this.separateTopologyNodes(nodes);
    const anchor = nodes.find(node => /^agent-1$/i.test(node.name || '')) || nodes[0];
    const packed = roomTopology.compact(nodes, node => this.topologyNodeFootprint(node), anchor.id);
    for (const node of nodes) {
      const point = packed.get(String(node.id));
      node.x = node.fx = point.x;
      node.y = node.fy = point.y;
      this.nodePositionCache.set(String(node.id), point);
    }
  }

  topologySSIDLabel(geometry) {
    const cohort = geometry.ssid === 'private_ssid' ? 'private'
      : geometry.ssid === 'iot_ssid' ? 'iot' : null;
    const backhaul = geometry.ssid === 'mesh_backhaul';
    return {
      x: geometry.offset.x + geometry.radius * (cohort === 'private' ? 0.48 : cohort === 'iot' ? 0.38 : 0),
      y: geometry.offset.y,
      text: cohort ? `"${cohort}"` : backhaul ? '"backhaul"' : geometry.ssid,
      fontSize: cohort ? 26 : 22,
      color: cohort === 'private' ? '#1e3a8a' : cohort === 'iot' ? '#374151' : backhaul ? '#8b1e24' : '#9b9a9aff'
    };
  }

  /** Place one station on the inner edge of its authoritative SSID bubble. */
  topologySTAPlacement(sta, staList, haulGeometry, nodeId = '') {
    const ssid = String(sta?.ssid || '');
    const stations = (Array.isArray(staList) ? staList : [])
      .filter(item => String(item?.ssid || '') === ssid)
      .sort((left, right) => this.normalizeMac(left?.staMAC)
        .localeCompare(this.normalizeMac(right?.staMAC)));
    const cohortIndex = Math.max(0, stations.indexOf(sta));
    const cohortCount = Math.max(1, stations.length);
    const target = (Array.isArray(haulGeometry) ? haulGeometry : [])
      .find(item => item.ssid === ssid) || {
        offset: { x: 0, y: 0 }, radius: 80
      };
    const iconSize = Math.max(26, 44 - Math.max(0, cohortCount - 8));
    const edgeRadius = Math.max(0, target.radius - iconSize / 2 - 5);
    const cacheKey = this.normalizeMac(sta?.staMAC);
    const ownerId = String(nodeId || '');
    const cached = this.staPositionCache.get(cacheKey);
    const titledCohort = ssid === 'private_ssid' || ssid === 'iot_ssid';
    const angle = titledCohort && cohortCount > 1
      ? 2 * Math.PI / 5 + (6 * Math.PI / 5) * cohortIndex / (cohortCount - 1)
      : -Math.PI / 2 + (2 * Math.PI * cohortIndex) / cohortCount;
    let to = {
      x: target.offset.x + edgeRadius * Math.cos(angle),
      y: target.offset.y + edgeRadius * Math.sin(angle)
    };
    if (cached && cached.ownerId === ownerId && cached.ssid === ssid &&
        Number.isFinite(cached.x) && Number.isFinite(cached.y)) {
      to = { x: cached.x, y: cached.y };
    } else if (cached) {
      this.staPositionCache.delete(cacheKey);
    }

    return {
      iconSize,
      cacheKey,
      ownerId,
      ssid,
      edgeRadius,
      from: { x: target.offset.x - (titledCohort ? target.radius * 0.2 : 0), y: target.offset.y },
      to
    };
  }

  topologyClientLabelPosition(center, iconSize, size, obstacles) {
    let best = null;
    let bestScore = Infinity;
    for (const gap of [6, 18, 36, 60, 96]) {
      const horizontal = iconSize / 2 + gap + size.width / 2;
      const vertical = iconSize / 2 + gap + size.height / 2;
      for (const [offsetX, offsetY] of [[0, vertical], [0, -vertical],
        [horizontal, 0], [-horizontal, 0], [horizontal, vertical],
        [-horizontal, vertical], [horizontal, -vertical], [-horizontal, -vertical]]) {
        const candidate = {x: center.x + offsetX - size.width / 2,
          y: center.y + offsetY - size.height / 2, ...size};
        const overlap = obstacles.reduce((total, box) => total +
          Math.max(0, Math.min(candidate.x + candidate.width + 4, box.x + box.width) - Math.max(candidate.x - 4, box.x)) *
          Math.max(0, Math.min(candidate.y + candidate.height + 4, box.y + box.height) - Math.max(candidate.y - 4, box.y)), 0);
        const score = overlap * 10000 + Math.hypot(offsetX, offsetY);
        if (score < bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
    }
    return best;
  }

  layoutTopologyLabels() {
    const root = this.topologyView?.group?.node();
    const matrix = root?.getScreenCTM();
    if (!matrix || matrix.a <= 0 || matrix.d <= 0) return;
    const localBox = element => {
      const box = element.getBoundingClientRect();
      return {x: (box.left - matrix.e) / matrix.a, y: (box.top - matrix.f) / matrix.d,
        width: box.width / matrix.a, height: box.height / matrix.d};
    };
    const obstacles = Array.from(root.querySelectorAll(
      '.node image, .ssid-label, .sta-icon, .sta-signal-bars, .backhaul-signal-bars, .channel-label'
    ), localBox);
    for (const label of root.querySelectorAll('.mesh-identity-label, .sta-identity-label')) {
      const data = d3.select(label.parentNode).datum();
      const isClient = label.classList.contains('sta-identity-label');
      const nodeRef = isClient ? data.nodeRef : data;
      const nodeX = nodeRef.fx ?? nodeRef.x ?? 0;
      const nodeY = nodeRef.fy ?? nodeRef.y ?? 0;
      const center = {x: nodeX + (isClient ? data.to.x : 0), y: nodeY + (isClient ? data.to.y : 0)};
      const iconSize = isClient ? data.iconSize : Number(label.parentNode.querySelector('image').getAttribute('width'));
      const bounds = label.getBBox();
      const baseline = Number(label.getAttribute('y')) - bounds.y;
      const placement = this.topologyClientLabelPosition(
        center, iconSize, {width: bounds.width, height: bounds.height}, obstacles);
      label.setAttribute('x', placement.x + placement.width / 2 - nodeX);
      label.setAttribute('y', placement.y + baseline - nodeY);
      obstacles.push(placement);
    }
    steeringCues.layout(this.topologyView.group.select('.steering-effects'));
  }

  /**
   * generate the sign wave connecting to node and STA
   */
  generateSineWavePath(from, to, options = {}) {
    const amplitude = options.amplitude || 7;
    const wavelength = options.wavelength || 20;
    const edgeOffset = options.edgeOffset || 0;
    const minSteps = 100;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length === 0) return { path: '', midpoint: [from.x, from.y], points: [] };

    const ux = dx / length;
    const uy = dy / length;

    const adjustedFrom = {
      x: from.x + ux * edgeOffset,
      y: from.y + uy * edgeOffset
    };
    const adjustedTo = {
      x: to.x - ux * edgeOffset,
      y: to.y - uy * edgeOffset
    };

    const newDx = adjustedTo.x - adjustedFrom.x;
    const newDy = adjustedTo.y - adjustedFrom.y;
    const newLength = Math.sqrt(newDx * newDx + newDy * newDy);

    const cycles = Math.max(1, Math.floor(newLength / wavelength));
    const steps = Math.max(minSteps, cycles * 50);
    const angle = Math.atan2(newDy, newDx);
    const perpendicularAngle = angle + Math.PI / 2;

    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = adjustedFrom.x + newDx * t;
      const y = adjustedFrom.y + newDy * t;
      const sineOffset = Math.sin(t * cycles * 2 * Math.PI) * amplitude;
      const offsetX = Math.cos(perpendicularAngle) * sineOffset;
      const offsetY = Math.sin(perpendicularAngle) * sineOffset;
      points.push([x + offsetX, y + offsetY]);
    }

    const midpoint = points[Math.floor(points.length / 2)];

    const lineGenerator = d3.line()
      .x(d => d[0])
      .y(d => d[1])
      .curve(d3.curveLinear);

    const path = lineGenerator(points);

    return { path, midpoint, points };
  }

  /**
   * tooltip position for hoover
   */
  positionTooltip(event, tooltip) {
    const tooltipNode = tooltip.node();
    const offsetParent = tooltipNode.offsetParent || document.documentElement;
    const parentRect = offsetParent.getBoundingClientRect();
    const tooltipWidth = tooltipNode.offsetWidth;
    const tooltipHeight = tooltipNode.offsetHeight;
    const margin = 8;
    const offset = 8;
    const clientX = Number.isFinite(event.clientX)
      ? event.clientX : event.pageX - window.scrollX;
    const clientY = Number.isFinite(event.clientY)
      ? event.clientY : event.pageY - window.scrollY;
    const targetX = clientX - parentRect.left;
    const targetY = clientY - parentRect.top;

    let left = targetX + offset;
    let top = targetY + offset;
    if (left + tooltipWidth + margin > parentRect.width) {
      left = targetX - tooltipWidth - offset;
    }
    if (top + tooltipHeight + margin > parentRect.height) {
      top = targetY - tooltipHeight - offset;
    }
    left = Math.max(margin, Math.min(left, parentRect.width - tooltipWidth - margin));
    top = Math.max(margin, Math.min(top, parentRect.height - tooltipHeight - margin));

    tooltip.style('left', `${left}px`).style('top', `${top}px`);
  }

  /**
   * Return a stable, compact identity for a STA even when no client type is
   * reported. Lab client MACs encode their number in the fifth octet.
   */
  getSTAIdentity(sta) {
    const reportedName = String(sta?.name || '').trim();
    if (reportedName) return reportedName;
    const mac = String(sta?.staMAC || '').trim().toUpperCase();
    const octets = mac.split(':');
    const validMac = octets.length === 6 && octets.every(octet => /^[0-9A-F]{2}$/.test(octet));

    if (!validMac) return 'STA';

    const prefix = sta?.ssid === 'iot_ssid' ? 'IOT' : 'STA';
    const isLabClient = octets[0] === '02' && octets[1] === '00' &&
      octets[2] === '00' && octets[3] === '00' && octets[5] === '00';
    if (isLabClient) return `${prefix}-${octets[4]}`;

    return `${prefix}-${octets.slice(-3).join(':')}`;
  }

  /**
   * get the icon for STA based on STA types
   */
  getClientIcon(clientType, ssid = '') {
    const type = clientType?.toLowerCase() || '';

    if (ssid === 'iot_ssid') return 'static/icons/iot-device.svg';
    if (type.includes('ipad')) return'static/icons/ipad.png';
    if (type.includes('iphone')) return 'static/icons/iphone.png';
    if (type.includes('android')) return 'static/icons/android.png';
    if (type.includes('laptop')) return 'static/icons/laptop.png';
    return 'static/icons/android.png';
  }

  /**
   * get the icon for nodes based on node name
   */
  getNodeIcon(nodeName, kind) {
    const type = nodeName?.toLowerCase() || '';

    // an OpenSync pod onboarded through an adapter (its M1 manufacturer)
    if (kind === 'opensync-pod') return 'static/icons/opensync-pod.svg';
    if (type.includes('controller') || type.includes('agent')) return'static/icons/controller.png';
    return 'static/icons/extender.png';
  }

  seededRandom(seed) {
    let x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }

  /**
   * Show tab content
   */
  showTab(tabName) {
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));

    // Remove active class from nav links
    document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));

    // Show selected tab
    const targetTab = document.getElementById(tabName);
    if (targetTab && this.supportedTabs && !this.supportedTabs.has(tabName)) {
      const title = tabName.replace(/(^|-)\w/g, value => value.toUpperCase());
      targetTab.innerHTML = `
        <div class="page-header"><div><h1>${title}</h1>
          <p>This page is not served by this controller's backend.</p></div></div>
        <div class="settings-card"><h3>Not implemented</h3>
          <p>Network Topology, Mesh Devices, Connected Clients and Networks use the live API. This feature belongs to another backend.</p>
        </div>`;
    }
    if (targetTab) targetTab.classList.add('active');

    // Add active class to nav link
    const navLink = document.querySelector(`[data-tab="${tabName}"]`);
    if (navLink) navLink.classList.add('active');

    this.currentTab = tabName;
    this.roomLayout?.refresh();

    // Load tab-specific data
    this.loadTabData(tabName);
  }

  /**
   * Load data specific to each tab
   */
  async loadTabData(tabName) {
    if (this.supportedTabs && !this.supportedTabs.has(tabName)) return;
    switch (tabName) {
      case 'clients':
        await this.refreshClients();
        break;
      case 'topology':
        await this.refreshTopologyData();
        break;
      case 'performance':
        await this.loadPerformanceData();
        break;
      case 'interference':
        await this.loadInterferenceData();
        break;
      case 'security':
        await this.loadSecurityData();
        break;
      case 'firmware':
        await this.loadFirmwareStatus();
        break;
      case 'reports':
        await this.loadReportsData();
        break;
      case 'settings':
        await this.loadSystemSettings();
        break;
      case 'wireless':
        // hydrate wireless tab when it’s opened
        if (window.WirelessSettings) {
          try {
            await window.WirelessSettings.loadWirelessSettings();
            window.WirelessSettings.updateAllDisplays();
          } catch (e) {
            this.showNotification('Failed to load wireless settings', 'error');
          }
        }
        break;
      case 'policy':
        await this.loadPolicySettings();
        break;
      case 'coverage':
  	if (!window.CoverageMapInstance) {
    	// First time: create the map
    	window.CoverageMapInstance = new CoverageMap();
  	} else {
    	// Next times: refresh data/analysis
    	window.CoverageMapInstance.refreshCoverage();
  	}
  	break;
      default:
        break;
    }
  }

  /**
   * Show device details modal
   */
  showDeviceDetails(device) {
    const modal = document.getElementById('device-modal');
    const title = document.getElementById('device-modal-title');
    const content = document.getElementById('device-modal-content');

    if (!modal || !title || !content) return;

    title.textContent = `${device.vendor} ${device.model}`;
    content.innerHTML = this.generateDeviceDetailsHTML(device);
    modal.classList.add('active');
  }

  /**
   * Generate device details HTML
   */
  generateDeviceDetailsHTML(device) {
    const capabilities = device.capabilities || {};
    const metrics = device.metrics || {};

    return `
      <div class="device-details">
        <div class="detail-section">
          <h3>Basic Information</h3>
          <div class="detail-grid">
            <div class="detail-item"><label>MAC Address:</label><span>${device.mac}</span></div>
            <div class="detail-item"><label>IP Address:</label><span>${device.ip_address}</span></div>
            <div class="detail-item"><label>Role:</label><span>${device.role}</span></div>
            <div class="detail-item"><label>Status:</label><span class="status ${device.status?.toLowerCase?.() || ''}">${device.status}</span></div>
            <div class="detail-item"><label>Uptime:</label><span>${device.uptime}</span></div>
            <div class="detail-item"><label>Firmware:</label><span>${capabilities.firmware || 'Unknown'}</span></div>
          </div>
        </div>

        <div class="detail-section">
          <h3>Performance Metrics</h3>
          <div class="metrics-grid">
            <div class="metric-box"><label>CPU Usage</label><span>${metrics.cpu_usage_percent || 0}%</span></div>
            <div class="metric-box"><label>Memory Usage</label><span>${metrics.memory_usage_percent || 0}%</span></div>
            <div class="metric-box"><label>Temperature</label><span>${metrics.temperature_celsius || 0}°C</span></div>
            <div class="metric-box"><label>Power Usage</label><span>${metrics.power_consumption_watts || 0}W</span></div>
          </div>
        </div>

        <div class="detail-section">
          <h3>Radio Information</h3>
          <div class="radios-list">
            ${this.generateRadioInfoHTML(capabilities.radios || [])}
          </div>
        </div>

        <div class="detail-section">
          <h3>Capabilities</h3>
          <div class="capabilities-grid">
            <div class="capability-item">
              <label>Wi-Fi 7 Support:</label>
              <span class="capability ${capabilities.wifi7_support ? 'supported' : 'not-supported'}">${capabilities.wifi7_support ? 'Yes' : 'No'}</span>
            </div>
            <div class="capability-item">
              <label>Max Mesh Links:</label>
              <span>${capabilities.max_mesh_links || 'Unknown'}</span>
            </div>
            <div class="capability-item">
              <label>Band Steering:</label>
              <span class="capability ${capabilities.steering_capability?.band_steering ? 'supported' : 'not-supported'}">
                ${capabilities.steering_capability?.band_steering ? 'Supported' : 'Not Supported'}
              </span>
            </div>
            <div class="capability-item">
              <label>WPA3 Support:</label>
              <span class="capability ${capabilities.security_capability?.wpa3_sae ? 'supported' : 'not-supported'}">
                ${capabilities.security_capability?.wpa3_sae ? 'Supported' : 'Not Supported'}
              </span>
            </div>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn btn-secondary" onclick="closeModal('device-modal')">
            <i class="fas fa-times"></i> Close
          </button>
          <button class="btn btn-warning" onclick="window.EasyMeshController.rebootDevice('${device.mac}')">
            <i class="fas fa-power-off"></i> Reboot Device
          </button>
          <button class="btn btn-primary" onclick="window.EasyMeshController.configureDevice('${device.mac}')">
            <i class="fas fa-cog"></i> Configure
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Generate radio information HTML
   */
  generateRadioInfoHTML(radios) {
    return radios.map(radio => `
      <div class="radio-info">
        <div class="radio-header">
          <h4>${radio.band} - ${radio.standard}</h4>
          <span class="channel-info">Ch ${radio.current_channel} (${radio.channel_width}MHz)</span>
        </div>
        <div class="radio-metrics">
          <div class="radio-metric"><label>Max PHY Rate:</label><span>${radio.max_phy_rate_mbps} Mbps</span></div>
          <div class="radio-metric"><label>Spatial Streams:</label><span>${radio.max_spatial_streams}</span></div>
          <div class="radio-metric"><label>TX Power:</label><span>${radio.power_settings?.tx_power_dbm || 0} dBm</span></div>
          <div class="radio-metric"><label>Connected Clients:</label><span>${radio.radio_metrics?.connected_clients || 0}</span></div>
        </div>
      </div>
    `).join('');
  }

  /**
   * Update count badges in navigation
   */
  updateCountBadges() {
    const deviceCount = document.getElementById('device-count');
    const clientCount = document.getElementById('client-count');

    if (deviceCount) deviceCount.textContent = this.devices.length;
    if (clientCount) clientCount.textContent = this.clients.length;
  }

  /**
   * Show/hide loading overlay
   */
  showLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.toggle('active', show);
  }

  /**
   * Update connection status indicator
   */
  updateConnectionStatus(connected) {
    const indicator = document.getElementById('connection-status');
    if (indicator) {
      const statusText = indicator.querySelector('.status-text');
      if (connected) {
        indicator.className = 'indicator connected';
        if (statusText) statusText.textContent = 'Connected';
      } else {
        indicator.className = 'indicator disconnected';
        if (statusText) statusText.textContent = 'Disconnected';
      }
    }
  }

  /**
   * Show notification
   */
  showNotification(message, type = 'info', duration = 5000) {
    const notification = {
      id: Date.now(),
      message,
      type,
      timestamp: new Date(),
      read: false
    };

    this.notifications.unshift(notification);

    // Limit notifications
    if (this.notifications.length > this.maxNotifications) {
      this.notifications = this.notifications.slice(0, this.maxNotifications);
    }

    this.updateNotificationBadge();
    this.updateNotificationList();

    // Show toast notification
    this.showToastNotification(notification, duration);
  }

  /**
   * Show toast notification
   */
  showToastNotification(notification, duration) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${notification.type}`;
    toast.innerHTML = `
      <div class="toast-content">
        <i class="fas fa-${this.getNotificationIcon(notification.type)}"></i>
        <span>${notification.message}</span>
      </div>
      <button class="toast-close" onclick="window.EasyMeshController.removeToast(this)">
        <i class="fas fa-times"></i>
      </button>
    `;

    // Add to DOM
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'toast-container';
      toastContainer.className = 'toast-container';
      document.body.appendChild(toastContainer);
    }

    toastContainer.appendChild(toast);

    // Auto remove
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, duration);
  }

  /**
   * Get notification icon based on type
   */
  getNotificationIcon(type) {
    const icons = {
      success: 'check-circle',
      warning: 'exclamation-triangle',
      error: 'exclamation-circle',
      info: 'info-circle'
    };
    return icons[type] || icons.info;
  }

  /**
   * Update notification badge
   */
  updateNotificationBadge() {
    const badge = document.querySelector('.notification-badge');
    const unreadCount = this.notifications.filter(n => !n.read).length;

    if (badge) {
      badge.textContent = unreadCount;
      badge.style.display = unreadCount > 0 ? 'flex' : 'none';
    }
  }

  /**
   * Update notification list
   */
  updateNotificationList() {
    const list = document.getElementById('notification-list');
    if (!list) return;

    list.innerHTML = '';

    this.notifications.forEach(notification => {
      const item = document.createElement('div');
      item.className = `notification-item ${notification.type} ${notification.read ? 'read' : 'unread'}`;
      item.innerHTML = `
        <div class="notification-icon">
          <i class="fas fa-${this.getNotificationIcon(notification.type)}"></i>
        </div>
        <div class="notification-content">
          <div class="notification-message">${notification.message}</div>
          <div class="notification-time">${this.formatTimestamp(notification.timestamp)}</div>
        </div>
        <button class="notification-close" onclick="window.EasyMeshController.removeNotification(${notification.id})">
          <i class="fas fa-times"></i>
        </button>
      `;

      item.addEventListener('click', () => {
        this.markNotificationAsRead(notification.id);
      });

      list.appendChild(item);
    });
  }

  // ---------- Utility functions ----------

  updateElement(id, content) {
    const element = document.getElementById(id);
    if (element) element.textContent = content;
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  formatSpeed(mbps) {
    if (mbps >= 1000) return (mbps / 1000).toFixed(1) + ' Gbps';
    return mbps + ' Mbps';
  }

  formatTimestamp(timestamp) {
    const now = new Date();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  generateTimeLabels(count) {
    const labels = [];
    const now = new Date();

    for (let i = count - 1; i >= 0; i--) {
      const time = new Date(now - i * 5 * 60 * 1000); // 5 minute intervals
      labels.push(time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }));
    }
    return labels;
  }

  generateRandomData(count, min = 0, max = 100) {
    return Array.from({ length: count }, () =>
      Math.floor(Math.random() * (max - min + 1)) + min
    );
  }

  generateTrafficData(count, multiplier = 1) {
    const baseData = this.generateRandomData(count, 100, 500);
    return baseData.map(value => value * multiplier);
  }

  generateSpectrumData() {
    // Simulate spectrum data for 2.4GHz band
    return Array.from({ length: 83 }, (_, i) => {
      const frequency = 2400 + i;
      let signal = -90 + Math.random() * 20;

      // Simulate peaks at common channels
      if ([2412, 2437, 2462].includes(frequency)) {
        signal += 20 + Math.random() * 15;
      }
      return Math.max(-100, Math.min(-20, signal));
    });
  }

  generate24GHzChannels() {
    const channels = [];
    for (let i = 2400; i <= 2483; i++) channels.push(i);
    return channels;
  }

  getDeviceClientCount(deviceMac) {
    return this.clients.filter(client =>
      client.connected_ap_mac === deviceMac
    ).length;
  }

  isClientActive(client) {
    if (!client.last_activity) return false;
    const lastActivity = new Date(client.last_activity);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    return lastActivity > fiveMinutesAgo;
  }

  getSignalStrengthIcon(rssi) {
    if (rssi >= -50) return '📶📶📶📶';
    if (rssi >= -60) return '📶📶📶';
    if (rssi >= -70) return '📶📶';
    return '📶';
  }

  createSignalBars(rssi) {
    const bars = [];
    const strength = Math.max(0, Math.min(4, Math.floor((rssi + 100) / 12.5)));
    for (let i = 0; i < 4; i++) {
      bars.push(`<div class="signal-bar ${i < strength ? 'active' : ''}"></div>`);
    }
    return `<div class="signal-bars">${bars.join('')}</div>`;
  }

  getDeviceTypeIcon(deviceType) {
    const icons = {
      smartphone: 'mobile-alt',
      laptop: 'laptop',
      tablet: 'tablet-alt',
      'smart-tv': 'tv',
      'gaming-console': 'gamepad',
      'iot-device': 'home',
      default: 'device'
    };
    return icons[deviceType] || icons.default;
  }

  getClientConnectionInfo(client) {
    // Standardize on connected_ap_mac
    const device = this.devices.find(d => d.mac === client.connected_ap_mac);
    return {
      ap: device ? device.model : 'Unknown AP',
      band: client.connected_bssid ? this.getBandFromBSSID(client.connected_bssid) : 'Unknown'
    };
  }

  getBandFromBSSID(bssid) {
    // Simple heuristic; replace with real mapping as needed
    const lastOctet = parseInt(bssid.split(':').pop(), 16);
    if (Number.isNaN(lastOctet)) return 'Unknown';
    if (lastOctet % 3 === 0) return '2.4GHz';
    if (lastOctet % 3 === 1) return '5GHz';
    return '6GHz';
  }

  // ---------- Timers & lifecycle ----------

  async refreshClients() {
    if (this.clientsRefreshInFlight) return;
    this.clientsRefreshInFlight = true;
    try {
      const response = await this.apiCall('/clients');
      this.clients = response.clients || [];
      this.updateClientsList();
      this.updateCountBadges();
    } catch (error) {
      console.error('Failed to refresh connected clients:', error);
    } finally {
      this.clientsRefreshInFlight = false;
    }
  }

  async refreshDevices() {
    if (this.devicesRefreshInFlight) return;
    this.devicesRefreshInFlight = true;
    try {
      const response = await this.apiCall('/devices');
      this.devices = response.devices || [];
      this.updateDevicesList();
      this.updateCountBadges();
    } catch (error) {
      console.error('Failed to refresh mesh devices:', error);
    } finally {
      this.devicesRefreshInFlight = false;
    }
  }

  startRefreshTimers() {
    // Refresh dashboard every 10 seconds
    this.refreshIntervals.dashboard = setInterval(() => {
      if (this.currentTab === 'dashboard') this.updateDashboard();
    }, 10000);

    // Refresh charts every 30 seconds
    this.refreshIntervals.charts = setInterval(() => {
      this.updateAllCharts();
    }, 30000);

    // Client signal comes from periodic EasyMesh AP Metrics Responses. Poll
    // only while the Connected Clients tab is visible and prevent overlap if
    // a native controller query takes longer than the two-second interval.
    this.refreshIntervals.clients = setInterval(() => {
      if (this.currentTab === 'clients') this.refreshClients();
    }, 2000);

    // Backhaul link metrics have the same 20-second freshness contract as the
    // topology view. Refresh the visible Mesh Devices cards without waiting
    // for a page reload, while preventing overlapping native controller calls.
    this.refreshIntervals.devices = setInterval(() => {
      if (this.currentTab === 'devices') this.refreshDevices();
    }, 2000);

    // Keep steering and RF-loss experiments visible without a page reload.
    // Do not overlap native/API requests and redraw only on a real change.
    this.refreshIntervals.topology = setInterval(async () => {
      if (this.currentTab === 'topology' && !this.topologyRefreshInFlight) {
        this.topologyRefreshInFlight = true;
        try {
          await this.refreshTopologyData();
        } catch (error) {
          console.error('Failed to refresh topology:', error);
          this.showNotification('Failed to refresh topology', 'error');
        } finally {
          this.topologyRefreshInFlight = false;
        }
      }
    }, 250);
  }

  cleanup() {
    this.roomLayout?.close();
    // Clear intervals
    Object.values(this.refreshIntervals).forEach(interval => clearInterval(interval));

    // Close WebSocket
    if (this.wsConnection) this.wsConnection.close();

    // Destroy charts
    Object.values(this.charts).forEach(chart => {
      if (chart && typeof chart.destroy === 'function') chart.destroy();
    });
  }

  // ---------- SAFETY STUBS & CORE HELPERS (added) ----------

  // Keyboard shortcuts example
  handleKeyboardShortcuts(e) {
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      document.getElementById('global-search')?.focus();
    }
  }

  // WebSocket metrics handler: store & refresh charts/dashboard
  updateMetrics(metrics = {}) {
    const m = this.performanceMetrics;
    const push = (arr, v, max = 200) => { arr.push(v); if (arr.length > max) arr.shift(); };

    if (typeof metrics.throughput === 'number') push(m.throughput, metrics.throughput);
    if (typeof metrics.latency === 'number') push(m.latency, metrics.latency);
    if (typeof metrics.utilization === 'number') push(m.utilization, metrics.utilization);
    if (typeof metrics.clients === 'number') push(m.clients, metrics.clients);

    this.updatePerformanceCharts?.();
    if (this.currentTab === 'dashboard') this.updateDashboard();
  }

  // Network health helpers
  getAverageThroughput() {
    const t = this.performanceMetrics.throughput;
    if (!t.length) return 0;
    return t.reduce((a, b) => a + b, 0) / t.length; // Mbps
  }

  getAverageInterference() {
    const u = this.performanceMetrics.utilization;
    if (!u.length) return 0.2; // mild default
    const avgU = u.reduce((a, b) => a + b, 0) / u.length; // 0-100
    return Math.max(0, Math.min(1, avgU / 100)); // normalize
  }

  getSecurityHealth() {
    const recent = this.securityEvents.slice(0, 5);
    const penalty = recent.length * 1.5; // 1.5 points per recent event
    return Math.max(0, 10 - penalty);
  }

  // Dashboard helpers
  updateHealthIndicators() {
    const scoreEl = document.getElementById('health-score-display');
    const ring = document.getElementById('health-score-ring'); // optional ring element
    if (!scoreEl) return;
    const score = parseInt(scoreEl.textContent || '0', 10);
    const cls = score >= 80 ? 'good' : score >= 60 ? 'fair' : 'poor';
    scoreEl.parentElement?.classList?.remove('good', 'fair', 'poor');
    scoreEl.parentElement?.classList?.add(cls);
    if (ring) ring.style.setProperty('--progress', `${score}`);
  }

  updateOptimizationSuggestions() {
    const box = document.getElementById('optimization-suggestions');
    if (!box) return;
    const suggestions = [];
    if (this.getAverageThroughput() < 200) suggestions.push('Enable band steering for congested APs.');
    if (this.getAverageInterference() > 0.6) suggestions.push('High interference — try auto channel optimization.');
    if (!suggestions.length) suggestions.push('Network looks good. No action needed.');
    box.innerHTML = suggestions.map(s => `<li>${s}</li>`).join('');
  }

  updateQuickStatusCards() {
    // implement as needed
  }

  updateTrafficChart() {
    const chart = this.charts?.traffic;
    if (!chart) return;
    chart.data.labels = this.generateTimeLabels(12);
    chart.data.datasets[0].data = this.generateTrafficData(12);
    chart.data.datasets[1].data = this.generateTrafficData(12, 2);
    chart.update();
  }

  resizeCharts() {
    Object.values(this.charts).forEach(ch => ch?.resize?.());
  }

  updateAllCharts() {
    this.updateTrafficChart();
    Object.entries(this.charts).forEach(([k, ch]) => { if (k !== 'traffic') ch?.update?.(); });
  }

  refreshDashboard() { this.updateAllDisplays(); }
  optimizeNetwork() {
    this.showNotification('Running optimization…', 'info');
    setTimeout(() => this.showNotification('Optimization complete', 'success'), 1000);
  }

  setTimeRange(_range) { /* hook up filtering if needed */ }
  setBand(_band) { /* hook up band switch if needed */ }
  showSettingsSection(_id) { /* show a sub-section in settings */ }
  closeAllModals() { document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active')); }

  updateDevice(device) {
    if (!device?.mac) return;
    const i = this.devices.findIndex(d => d.mac === device.mac);
    if (i >= 0) this.devices[i] = { ...this.devices[i], ...device };
    else this.devices.push(device);
    this.updateAllDisplays();
  }

  updateClient(client) {
    if (!client?.mac) return;
    const i = this.clients.findIndex(c => c.mac === client.mac);
    if (i >= 0) this.clients[i] = { ...this.clients[i], ...client };
    else this.clients.push(client);
    this.updateAllDisplays();
  }

  handleSecurityEvent(event) {
    this.securityEvents.unshift(event);
    this.showNotification(event?.message || 'Security event', 'warning');
    this.updateSecurityCenter?.();
  }

  async updateTopology(newTopo) {
    console.log('Fetching fresh topology from backend...');
    this.topology = newTopo || {};
    if (this.currentTab === 'topology') this.updateTopologyVisualization();
  }

  markNotificationAsRead(id) {
    const n = this.notifications.find(n => n.id === id);
    if (n) n.read = true;
    this.updateNotificationBadge();
    this.updateNotificationList();
  }

  removeNotification(id) {
    this.notifications = this.notifications.filter(n => n.id !== id);
    this.updateNotificationBadge();
    this.updateNotificationList();
  }

  removeToast(btnEl) {
    const toast = btnEl?.closest?.('.toast');
    toast?.remove();
  }

  updateSecurityCenter() { /* fill UI if present */ }
  updatePerformanceCharts() { /* optionally refresh specific charts */ }

  rebootDevice(mac) {
    this.showNotification(`Reboot command sent to ${mac}`, 'info');
    // Optionally: return this.apiCall(`/devices/${mac}/reboot`, { method: 'POST' })
  }
  configureDevice(mac) {
    this.showNotification(`Open configuration for ${mac}`, 'info');
  }
  showClientDetails(mac) {
    const client = this.clients.find(c => c.mac === mac);
    if (!client) {
      this.showNotification(`Client not found: ${mac}`, 'error');
      return;
    }
    
    if (!this.clientDetailsViewer) {
      this.clientDetailsViewer = new ClientDetailsViewer();
    }
    
    this.clientDetailsViewer.show(client);
  }
  disconnectClient(mac) {
    this.showNotification(`Disconnect requested for ${mac}`, 'warning');
  }
  blockClient(mac) {
    this.showNotification(`Block requested for ${mac}`, 'warning');
  }

  /**
   * Load wifi reset default config
   */
  async loadWifiResetConfig() {
    try {
      const res = await fetch("/api/v1/wifireset");

      if (!res.ok) {
        throw new Error(`HTTP error! Status: ${res.status}`);
      }

      const data = await res.json();
      if (!Array.isArray(data?.ssidHaulConfig)) {
        this.showNotification("Could not receive the wifi reset tree from controller, \nPlease check the controller or try again after sometime.");
        return;
      }

      // Populate HaulType dropdown
      const haulContainer = document.getElementById("haultype-options");
      haulContainer.innerHTML = ""; // Clear previous content

      const haulTypes = new Set();
      data.ssidHaulConfig.forEach(config => {
        const haul = config.HaulType;
        if (typeof haul === "string") {
          haulTypes.add(haul);
        }
      });

      haulTypes.forEach(ht => {
        const match = data.ssidHaulConfig.find(config => config.HaulType === ht);

        // Create a grid container for each HaulType block
        const gridWrapper = document.createElement("div");
        gridWrapper.className = "haul-block";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = `haul-${ht}`;
        checkbox.name = "haulType";
        checkbox.value = ht;

        const label = document.createElement("label");
        label.htmlFor = checkbox.id;
        label.textContent = ht;

        const checkboxWrapper = document.createElement("div");
        checkboxWrapper.className = "haul-checkbox"
        checkboxWrapper.appendChild(checkbox);
        checkboxWrapper.appendChild(label);

        gridWrapper.appendChild(checkboxWrapper);
        haulContainer.appendChild(gridWrapper);

        // Add event listener to show SSID and password fields
        checkbox.addEventListener("change", () => {
          const existingFields = document.getElementById(`ssid-fields-${ht}`);

          if (checkbox.checked) {
            if (match && !existingFields) {
              const fieldWrapper = document.createElement("div");
              fieldWrapper.id = `ssid-fields-${ht}`;
              fieldWrapper.className = "haul-fields";

              // SSID row
              const ssidRow = document.createElement("div");
              ssidRow.className = "ssid-password-row";

              const ssidLabel = document.createElement("label");
              ssidLabel.textContent = "SSID:";
              ssidLabel.setAttribute("for", `ssid-${ht}`);

              const ssidInput = document.createElement("input");
              ssidInput.type = "text";
              ssidInput.id = `ssid-${ht}`;
              ssidInput.value = match.SSID || "";
              ssidInput.placeholder = "Enter SSID";

              ssidRow.appendChild(ssidLabel);
              ssidRow.appendChild(ssidInput);

              // Password row
              const passRow = document.createElement("div");
              passRow.className = "ssid-password-row";

              const passLabel = document.createElement("label");
              passLabel.textContent = "Password:";
              passLabel.setAttribute("for", `password-${ht}`);

              const passInput = document.createElement("input");
              passInput.type = "text";
              passInput.id = `password-${ht}`;
              passInput.value = match.PassPhrase || "";
              passInput.placeholder = "Enter Password";

              passRow.appendChild(passLabel);
              passRow.appendChild(passInput);

              // Append rows to wrapper
              fieldWrapper.appendChild(ssidRow);
              fieldWrapper.appendChild(passRow);
              gridWrapper.appendChild(fieldWrapper);
            }
          } else {
            // Remove SSID/password fields if unchecked
            if (existingFields) {
              gridWrapper.removeChild(existingFields);
            }
          }
        });
      });
    } catch (err) {
      console.error("Failed to load Wi-Fi interfaces:", err);
      this.showNotification("Failed to load Wi-Fi interfaces", "error");
    }
  }

  /**
   * Load wifi policy config
   */
  async loadWifiPolicyConfig() {
    try {
      const res = await fetch("/api/v1/wifipolicy");
      if (!res.ok) {
        throw new Error(`HTTP error! Status: ${res.status}`);
      }

      const data = await res.json();
      this.policyByDeviceId = {};
      this.updatedPolicySettings = Array.isArray(data?.policyConfig) ? data.policyConfig : [];
      this.updatedPolicySettings.forEach(d => {
        if (d?.id) this.policyByDeviceId[d.id] = d;
      });

      // Populate selector UI
      populateDeviceSelectorFromPolicy(data);

      // Auto-select first device and populate
      const sel = document.querySelector("#device-selector");
      if (sel && sel.options.length > 0) {
        sel.selectedIndex = 0;
        const firstId = sel.value;
        const policy = this.policyByDeviceId[firstId];
        populatePolicyUI(policy);
        toggleMaxRateField();
      }

    } catch (err) {
      console.error("Failed to load Wi-Fi policy settings:", err);
      this.showNotification("Failed to load policy settings", "error");
    }
  }

  // ---- Tab-specific loaders (safe stubs) ----
  async loadPerformanceData() { 
    // Update statistics cards
    this.updatePerformanceStats();
    
    // Initialize client performance monitor when performance tab is shown
    if (!this.clientPerformanceMonitor) {
      this.clientPerformanceMonitor = new ClientPerformanceMonitor(this.clients, this.devices);
      await this.clientPerformanceMonitor.init();
    } else {
      this.clientPerformanceMonitor.updateClients(this.clients, this.devices);
    }
    
    // Populate device sections for client selection (P2/P3 design)
    this.updatePerformanceDevices();
  }

  /**
   * Update performance statistics cards
   */
  updatePerformanceStats() {
    // Active Devices
    const activeDevices = this.devices.filter(d => d.status === 'Online').length;
    const totalDevices = this.devices.length;
    this.updateElement('perf-active-devices', `${activeDevices}/${totalDevices}`);
    
    // Connected Clients
    const connectedClients = this.clients.length;
    this.updateElement('perf-connected-clients', connectedClients);
    
    // Active Alarms (placeholder - would need real alarm data)
    this.updateElement('perf-active-alarms', '0');
    
    // Network Health
    const healthScore = this.calculateNetworkHealth();
    this.updateElement('perf-network-health', `${Math.round(healthScore)}%`);
  }
  async loadInterferenceData() { /* fetch & update interference tab */ }
  async loadSecurityData() { /* fetch & update security tab */ }
  async loadFirmwareStatus() { /* fetch & update firmware tab */ }
  async loadReportsData() { /* fetch & update reports tab */ }
  async loadSystemSettings() {
      try {
        // Fetch and update system settings here
        console.log("🔧 Loading system settings...");

        // Load Wi-Fi AL MAC interfaces when settings tab is opened
        if (typeof this.loadWifiResetConfig === 'function') {
          console.log("Loading Wi-Fi Reset config");
          await this.loadWifiResetConfig();
        }
      } catch (err) {
        console.error("Failed to load system settings:", err);
        this.showNotification("Failed to load system settings", "error");
      }
  }
  async loadPolicySettings() {
    try {
        // Fetch and update Policy settings here
        console.log("🔧 Loading Policy settings...");

        // Load Wi-Fi AL MAC interfaces when settings tab is opened
        if (typeof this.loadWifiPolicyConfig === 'function') {
          console.log("Loading Wi-Fi policy config");
          await this.loadWifiPolicyConfig();
        }
      } catch (err) {
        console.error("Failed to load system settings:", err);
        this.showNotification("Failed to load system settings", "error");
    }

  }
}

  /**
   * Render Backhaul BSS policy
   */
function renderBackhaulBSS(rows) {
  const tbody = document.querySelector("#backhaul-bss-rows");
  if (!tbody) return;

  tbody.innerHTML = "";

  rows.forEach(row => {
    const tr = document.createElement("tr");

    // BSSID
    const tdBssid = document.createElement("td");
    const inputBssid = document.createElement("input");
    inputBssid.type = "text";
    inputBssid.name = "bssid";
    inputBssid.value = row.bssid || "";
    inputBssid.readOnly = true;
    tdBssid.appendChild(inputBssid);

    // Profile-1 bSTA Disallowed
    const tdProfile1 = document.createElement("td");
    const select1 = document.createElement("select");
    select1.name = "profile1";

    const opt1Disallowed = document.createElement("option");
    opt1Disallowed.value = "1";
    opt1Disallowed.textContent = "Disallowed";

    const opt1Allowed = document.createElement("option");
    opt1Allowed.value = "0";
    opt1Allowed.textContent = "Allowed";
    select1.appendChild(opt1Disallowed);
    select1.appendChild(opt1Allowed);

    // Set selected value
    select1.value = row.profile1bSTADisallowed ? "1" : "0";
    tdProfile1.appendChild(select1);

    // Profile-2 bSTA Disallowed
    const tdProfile2 = document.createElement("td");
    const select2 = document.createElement("select");
    select2.name = "profile2";

    const opt2Disallowed = document.createElement("option");
    opt2Disallowed.value = "1";
    opt2Disallowed.textContent = "Disallowed";

    const opt2Allowed = document.createElement("option");
    opt2Allowed.value = "0";
    opt2Allowed.textContent = "Allowed";
    select2.appendChild(opt2Disallowed);
    select2.appendChild(opt2Allowed);

    // Set selected value
    select2.value = row.profile2bSTADisallowed ? "1" : "0";
    tdProfile2.appendChild(select2);

    // Append all cells to row
    tr.appendChild(tdBssid);
    tr.appendChild(tdProfile1);
    tr.appendChild(tdProfile2);

    // Append row to tbody
    tbody.appendChild(tr);
  });

}

/**
  * show all the available device list for wifi policy config
  */
function populateDeviceSelectorFromPolicy(data) {
  const sel = document.querySelector("#device-selector");
  if (!sel) return;

  // clear existing
  sel.innerHTML = "";

  const items = Array.isArray(data?.policyConfig) ? data.policyConfig : [];

  if (items.length === 0) {
    // Add a disabled placeholder when nothing returned
    const opt = document.createElement("option");
    opt.textContent = "No devices";
    opt.disabled = true;
    opt.selected = true;
    sel.appendChild(opt);
    return;
  }

  items.forEach(({ id, mediaType }) => {
    if (!id) return;
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = mediaType ? `${id} (${mediaType})` : id;
    sel.appendChild(opt);
  });
}

/**
 * Load wifi policy config for selected device
 */
function populatePolicyUI(policy) {
  if (!policy) return;

  // AP Metrics Reporting Policy
  const ap = policy.apMetricReportingPolicy || {};
  setInputValue("#ap-interval", ap.interval);
  setInputValue("#managed-client-marker", ap.managedClientMarker);

  // Local / BTM Disallowed
  fillMacTable("#localMacBody", policy.localSteeringDisallowed);
  fillMacTable("#btmMacBody",   policy.btmSteeringDisallowed);

  // Channel Scan Reporting
  setInputValue("#report-independent-scans", policy.reportIndependentChannelScans);

  // Default 802.1Q Settings
  const dot1q = policy.default802_1Q_SettingsPolicy || {};
  setInputValue("#primary-vlan-id", dot1q.primaryVLANID);
  setInputValue("#default-pcp", dot1q.defaultPCP);

  // Unsuccessful Association Policy
  const ua = policy.unsuccessfulAssocPolicy || {};
  setInputValue("#report-unassoc-sta", ua.reportUnsuccessAssoc?1:0);
  setInputValue("#max-reporting-rate", ua.maxReportingRate);
  toggleMaxRateField();

  // Backhaul BSS Config Policy
  const backhaul = policy.backhaulBssConfigPolicy || [];
  renderBackhaulBSS(backhaul);

  // QoS Management Policy (NEW)
  const qos = policy.qosManagementPolicy || {};
  fillMacTable("#mscs-body", qos.mscsDisallowedSTAList);
  fillMacTable("#scs-body",  qos.scsDisallowedSTAList);

  // Radio Specific Metrics (table)
  const rmpEntries = getRadioMetricsEntries(policy);
  RMP.render(rmpEntries);
  RMP.bind();

  // Radio Steering Parameters (table)
  const rspEntries = getRadioSteeringEntries(policy);
  RSP.render(rspEntries);
  RSP.bind();
}

/**
 * toggle Max Rate Field based on report unassoc status
 */
function toggleMaxRateField() {
  const reportSelect = document.querySelector("#report-unassoc-sta");
  const rateInput = document.querySelector("#max-reporting-rate");

  if (!reportSelect || !rateInput) return;

  const isDisabled = reportSelect.value === "0";

  rateInput.disabled = isDisabled;

  if (isDisabled) {
    rateInput.value = "0";
  }

}

// RMP entries (array or single legacy object)
function getRadioMetricsEntries(policy) {
  const radioMetricList = policy?.radioSpecificMetricsPolicy;
  if (Array.isArray(radioMetricList) && radioMetricList.length) {
    const norm = (RMP?.normalizeRow) || (x => x);
    return radioMetricList.map(norm).filter(Boolean);
  }
  return [];
}

// RSP entries (existing logic kept)
function getRadioSteeringEntries(policy) {
  const radioSteeringlist = policy?.radioSteeringParametersPolicy;
  if (Array.isArray(radioSteeringlist) && radioSteeringlist.length) {
    const norm = (RSP?.normalizeRow) || (x => x);
    return radioSteeringlist.map(norm).filter(Boolean);
  }
  return [];
}

// utilities for policy tables
const PolicyUtil = (() => {
  const MAC_ALL = "ff:ff:ff:ff:ff:ff";

  const qs  = (s, r = document) => r.querySelector(s);
  const qsa = (s, r = document) => Array.from(r.querySelectorAll(s));

  // Validators
  const hasText = v => typeof v === "string" && v.trim() !== "";
  const hasNumber = v => Number.isFinite(Number(v));
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const numOrNull = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? clamp(n, min, max) : null;
  };

  // MAC helpers
  const normalizeId = (idLike) => {
    const raw = String(idLike || "").trim().toLowerCase();
    return raw === "all stations" ? MAC_ALL : raw;
  };
  const displayId = (id) => normalizeId(id) === MAC_ALL ? "All Stations" : String(id || "").trim().toLowerCase();

  // Presence gate (for legacy single-object policy)
  function hasAnyRadioMetrics(r) {
    if (!r) return false;
    return (
      hasText(r.id) || hasNumber(r.starCPIThreshold) ||hasNumber(r.starCPIHysteresis) ||
      hasNumber(r.apUtilizationThreshold) || hasNumber(r.apUtilization) ||
      hasNumber(r.staTrafficStats) || hasNumber(r.staLinkMetrics) || hasNumber(r.staStatus)
    );
  }

  // Binary toggle normalize
  const toBin = (v) =>
    (v === true || v === 1 || v === "1" || v === "enabled" || v === "Enabled") ? "1" : "0";

  return {
    MAC_ALL, qs, qsa, hasText, hasNumber, clamp, numOrNull,
    normalizeId, displayId, hasAnyRadioMetrics, toBin
  };
})();

// create Policy Table
function createPolicyTable({
  tbodySel,
  addBtnSel,
  maxRows = 15,
  specialId = { enabled: false,
                macAll: PolicyUtil.MAC_ALL },
  columns,
  normalizeRow,
  readonlyExistingId = true
}) {
  const { qs, qsa, displayId, normalizeId } = PolicyUtil;

  function getCurrentIds() {
    return qsa(`${tbodySel} tr`).map(tr => {
      const input = tr.querySelector('input[name="id"]');
      if (!input) return "";
      let v = (input.value || "").trim().toLowerCase();
      if (v === "all stations") v = PolicyUtil.MAC_ALL;
      return v;
    }).filter(Boolean);
  }

  function hasAllRow() {
    return specialId.enabled && getCurrentIds().includes(specialId.macAll);
  }

  function rowCount() {
    return qsa(`${tbodySel} tr`).length;
  }

  function canAddRow() {
    if (maxRows != null && rowCount() >= maxRows) return false;
    if (specialId.enabled && hasAllRow()) return false;
    return true;
  }

  function updateAddButtonState() {
    const addBtn = qs(addBtnSel);
    if (!addBtn) return;
    const allowed = canAddRow();
    addBtn.disabled = !allowed;
    addBtn.title = allowed ? "" :
      (hasAllRow()
        ? 'Cannot add more rows while "All Stations" row exists. Delete it to add new rows.'
        : `Maximum ${maxRows} rows allowed.`);
  }

  function createIdInput(value, editable) {
    const raw = normalizeId(value);
    const shown = displayId(raw);
    const attrs = [
      'type="text"',
      'name="id"',
      'inputmode="text"',
      'placeholder="MAC or All Stations"',
      // Keep pattern; since readonly for existing rows, it won't block submit
      'pattern="^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$"',
      'title="Format: 6 octets, colon-separated (e.g., AA:BB:CC:DD:EE:FF)"',
      `value="${shown}"`,
      `data-raw-id="${raw}"`,
      editable ? '' : 'readonly'
    ].filter(Boolean).join(' ');
    return `<input ${attrs} />`;
  }

  function createRow(entry, { editableId = false } = {}) {
    const e = normalizeRow(entry || {});
    const idCell = createIdInput(e.id, editableId);
    const tds = [`<td>${idCell}</td>`];

    for (const col of columns) {
      if (col.type === "number") {
        const v = (e[col.field ?? col.key] == null ? "" : String(e[col.field ?? col.key]));
        tds.push(
          `<td><input type="number" name="${col.name}" min="${col.min}" max="${col.max}" step="${col.step || 1}" placeholder="${col.min}-${col.max}" value="${v}" /></td>`
        );
      } else if (col.type === "select") {
        const v = String(e[col.field ?? col.key] ?? (col.default ?? "0"));
        const opts = col.options.map(([val, label]) =>
          `<option value="${val}" ${v === String(val) ? "selected" : ""}>${label}</option>`
        ).join("");
        tds.push(`<td><select name="${col.name}">${opts}</select></td>`);
      }
    }

    tds.push(`<td style="text-align:right;"><button type="button" class="btn btn-outline btn-sm remove-row">Delete</button></td>`);
    const tr = document.createElement("tr");
    tr.innerHTML = tds.join("");
    return tr;
  }

  // --- Ephemeral scope chooser shown only for newly added rows ---
  function attachNewEntryScopeChooser(tr) {
    const idCell = tr.querySelector('td');
    const idInput = tr.querySelector('input[name="id"]');
    if (!idCell || !idInput) return;

    // Hide the ID input until user chooses scope
    idInput.style.display = 'none';

    // Build a one-time <select>
    const sel = document.createElement('select');
    sel.className = 'new-entry-scope';
    sel.innerHTML = `
      <option value="" selected disabled>Select scope…</option>
      <option value="specific">Specific Station</option>
      <option value="all">All Stations</option>
    `;

    // Insert before the input
    idCell.insertBefore(sel, idInput);

    const finalize = (scope) => {
      if (scope === 'all') {
        // Set ALL MAC and lock field
        idInput.value = displayId(specialId.macAll);
        idInput.setAttribute('data-raw-id', specialId.macAll);
        idInput.readOnly = true;
      } else {
        // Allow editing specific MAC
        idInput.readOnly = false;
        idInput.value = '';
        idInput.setAttribute('data-raw-id', '');
        // Focus for convenience
        queueMicrotask(() => { idInput.focus(); idInput.select?.(); });
      }
      // Remove chooser and show input
      sel.remove();
      idInput.style.display = '';
      // Update add button state (ALL disables further adds)
      updateAddButtonState();
    };

    sel.addEventListener('change', () => {
      const v = sel.value;
      if (v === 'all' || v === 'specific') {
        finalize(v);
      }
    });
  }
  // --- End ephemeral chooser ---

  function render(entries = []) {
    const tbody = qs(tbodySel);
    if (!tbody) return;

    // Dedup special 'All Stations' (first wins)
    let seenAll = false;
    const safe = [];
    for (const e of entries) {
      const id = normalizeId(e?.ID ?? e?.id ?? "");
      if (specialId.enabled && id === specialId.macAll) {
        if (seenAll) continue;
        seenAll = true;
      }
      safe.push(e);
    }

    const data = safe.length ? safe : [normalizeRow({ ID: "" })];

    tbody.innerHTML = "";
    for (const e of data) {
      tbody.appendChild(createRow(e, { editableId: !readonlyExistingId }));
    }
    updateAddButtonState();
  }

  function addRow(prefill) {
    if (!canAddRow()) {
      updateAddButtonState();
      return;
    }
    const tbody = qs(tbodySel);
    if (!tbody) return;
    const tr = createRow(prefill || {}, { editableId: true });
    tbody.appendChild(tr);
    // Show one-time scope chooser for this new row
    attachNewEntryScopeChooser(tr);
    updateAddButtonState();
  }

  function getAll() {
    const rows = qsa(`${tbodySel} tr`);
    return rows.map(tr => {
      let raw = tr.querySelector('input[name="id"]')?.value || "";
      let id = normalizeId(raw)

      const out = { id };
      for (const col of columns) {
        if (col.type === "number") {
          const v = tr.querySelector(`input[name="${col.name}"]`)?.value ?? "";
          out[col.field || col.key] = v === "" ? null : Number(v);
        } else if (col.type === "select") {
          const v = tr.querySelector(`select[name="${col.name}"]`)?.value ?? (col.default ?? "0");
          out[col.field || col.key] = v === "" ? null : Number(v);
        }
      }
      return out;
    }).filter(r => r.id);
  }

  function bind() {
    const addBtn = qs(addBtnSel);
    const tbody  = qs(tbodySel);

    if (addBtn && !addBtn._boundPolicyTable) {
      addBtn.addEventListener("click", () => addRow());
      addBtn._boundPolicyTable = true;
    }

    if (tbody && !tbody._boundPolicyTable) {
      tbody.addEventListener("click", (evt) => {
        const btn = evt.target.closest(".remove-row");
        if (btn) {
          btn.closest("tr")?.remove();
          updateAddButtonState();
        }
      });

      // Keep constraints in sync when editing ID (for special "All Stations" rule)
      tbody.addEventListener("input", (evt) => {
        const input = evt.target;
        if (!(input instanceof HTMLInputElement) || input.name !== "id") return;
        let v = (input.value || "").trim().toLowerCase();
        if (v === "all stations") v = PolicyUtil.MAC_ALL;
        input.setAttribute("data-raw-id", v);
        updateAddButtonState();
      });

      tbody._boundPolicyTable = true;
    }

    updateAddButtonState();
  }

  return { render, addRow, bind, getAll };
}

// ==============================
// RSP (uses All Stations max-1 rule, max 3 rows)
// ==============================
const RSP = (() => {
  const mod = createPolicyTable({
    tbodySel: "#policy-rows",
    addBtnSel: "#add-row-btn",
    maxRows: 15,
    specialId: { enabled: true, macAll: PolicyUtil.MAC_ALL },
    readonlyExistingId: true,
    columns: [
      { type: "number", name: "steering", key: "Steering Policy", field: "steeringPolicy", min: 0, max: 2, step: 1 },
      { type: "number", name: "util",     key: "Utilization Threshold", field: "utilizationThreshold", min: 0, max: 255, step: 1 },
      { type: "number", name: "rcpi",     key: "RCPI Threshold", field: "rcpiThreshold", min: 0, max: 220, step: 1 }
    ],
    normalizeRow(e = {}) {
      const id = (e.id ?? "").trim().toLowerCase();
      return {
        id,
        steeringPolicy: e.steeringPolicy??null,
        utilizationThreshold: e.utilizationThreshold??null,
        rcpiThreshold: e.rcpiThreshold?? null

      };
    }
  });
  return mod;
})();

// ==============================
// RMP (uses All Stations max-1 rule, max 3 rows)
// ==============================
const RMP = (() => {
  const { numOrNull, toBin } = PolicyUtil;

  const mod = createPolicyTable({
    tbodySel: "#radio-metrics-rows",
    addBtnSel: "#add-radio-metrics-row",
    maxRows: 15,
    specialId: { enabled: true, macAll: PolicyUtil.MAC_ALL },
    readonlyExistingId: true,
    columns: [
      { type: "number", name: "rcpiThreshold",  key: "STA RCPI Threshold", field: "starCPIThreshold", min: 0, max: 220, step: 1 },
      { type: "number", name: "rcpiHysteresis", key: "STA RCPI Hysteresis", field: "starCPIHysteresis", min: 0, max: 100, step: 1 },
      { type: "number", name: "apUtilization", key: "AP Utilization Threshold", field: "apUtilizationThreshold", min: 0, max: 255, step: 1 },
      { type: "select", name: "staTrafficStats", key: "STA Traffic Stats", field: "staTrafficStats", options: [["0","Disabled"],["1","Enabled"]], default: "0" },
      { type: "select", name: "staLinkMetrics", key: "STA Link Metrics", field: "staLinkMetrics", options: [["0","Disabled"],["1","Enabled"]], default: "0" },
      { type: "select", name: "staStatus", key: "STA Status", field: "staStatus", options: [["0","Disabled"],["1","Enabled"]], default: "0" }
    ],
    normalizeRow(e = {}) {
      const id = PolicyUtil.normalizeId(e.ID ?? e.id ?? e.bssid ?? "");
      const rcpiThr = (e["STA RCPI Threshold"] ?? e.staRCPIThreshold ?? e.starCPIThreshold ?? null);
      const rcpiHys = (e["STA RCPI Hysteresis"] ?? e.staRCPIHysteresis ?? e.starCPIHysteresis ?? null);
      const apUtil  = (e["AP Utilization Threshold"] ?? e.apUtilizationThreshold ?? e.apUtilization ?? null);
      return {
        id: id,
        starCPIThreshold: numOrNull(rcpiThr, 0, 220),
        starCPIHysteresis: numOrNull(rcpiHys, 0, 100),
        apUtilizationThreshold: numOrNull(apUtil, 0, 255),
        staTrafficStats: toBin(e["STA Traffic Stats"] ?? e.staTrafficStats),
        staLinkMetrics: toBin(e["STA Link Metrics"] ?? e.staLinkMetrics),
        staStatus: toBin(e["STA Status"] ?? e.staStatus)
      };
    }
  });
  return mod;
})();

function setInputValue(selector, value, fallback = "") {
  const el = document.querySelector(selector);
  if (!el) return;
  const vs = String(value ?? fallback);
  const SPECIAL_MAC = PolicyUtil.MAC_ALL;
  const isBssid = el.id === "bssid" || el.name === "bssid";

  if (el.tagName === "SELECT") {
    const exists = Array.from(el.options).some(o => o.value == vs);
    el.value = exists ? vs : String(fallback);
  } else {
    if (isBssid && vs.toLowerCase() === SPECIAL_MAC) {
      el.value = "All Stations";
      el.setAttribute("data-actual-value", SPECIAL_MAC);
    } else {
      el.value = vs;
      el.removeAttribute("data-actual-value");
    }
  }
}

function fillMacTable(tbodySel, macArray) {
  const tbody = document.querySelector(tbodySel);
  if (!tbody) return;
  tbody.innerHTML = "";

  const arr = Array.isArray(macArray) && macArray.length ? macArray : [];
  arr.forEach((m) => {
    const mac = String(m || "").trim().toLowerCase();
    if (!mac) return;

    const tr = document.createElement("tr");
    tr.dataset.mac = mac;

    const tdCheckbox = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "row-select";
    cb.setAttribute("aria-label", `Select ${mac}`);
    tdCheckbox.appendChild(cb);

    const tdMac = document.createElement("td");
    tdMac.textContent = mac;

    tr.appendChild(tdCheckbox);
    tr.appendChild(tdMac);
    tbody.appendChild(tr);
  });
}

function getMacList(tbodySelector) {
  const tbody = document.querySelector(tbodySelector);
  if (!tbody) return [];
  return Array.from(tbody.querySelectorAll('tr[data-mac]'))
    .map(tr => (tr.dataset.mac || "").trim().toLowerCase())
    .filter(Boolean);
}


  function collectResetPayload() {
    const haulTypes = Array.from(document.querySelectorAll("input[name='haulType']:checked")).map(checkbox => {
      const haulType = checkbox.value;
      const ssid = document.getElementById(`ssid-${haulType}`)?.value || "";
      const password = document.getElementById(`password-${haulType}`)?.value || "";

      return {
        HaulType: haulType,
        SSID: ssid,
        PassPhrase: password
      };
    });

    return { haulTypes };
  }

  async function sendResetPayload(payload) {
    const res = await fetch("/api/v1/wifireset", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(errorText);
    }

    return await res.json();
  }

  async function handleResetSuccess(response) {
    console.log("Reset result:", response);
    alert("Wi-Fi configuration reset successfully!");
  }

  async function handleResetError(error) {
    console.error("Reset failed:", error);
    alert(`Failed to reset Wi-Fi configuration:\n${error.message}`);
  }



/**
 * Client Details Viewer Class
 * Shows detailed performance metrics for a single client in a modal
 */
class ClientDetailsViewer {
  constructor() {
    this.chart = null;
    this.currentClient = null;
    this.colors = {
      score: '#6366f1',
      snr: '#10b981',
      pr: '#f59e0b',
      per: '#ef4444',
      psy: '#8b5cf6'
    };
  }
  
  show(client) {
    this.currentClient = client;
    const modal = document.getElementById('client-details-modal');
    if (!modal) return;
    
    // Populate client header
    this.populateHeader(client);
    
    // Calculate and display performance metrics
    const metrics = this.calculatePerformanceMetrics(client);
    this.displayMetricCards(metrics);
    
    // Display additional info
    this.displayAdditionalInfo(client);
    
    // Create combined chart
    this.createCombinedChart(metrics);
    
    // Show modal
    modal.classList.add('active');
  }
  
  populateHeader(client) {
    document.getElementById('client-modal-title').textContent = 
      `${client.hostname || 'Unknown Device'} - Performance Details`;
    document.getElementById('client-detail-name').textContent = 
      client.hostname || 'Unknown Device';
    document.getElementById('client-detail-mac').textContent = client.mac;
    document.getElementById('client-detail-ip').textContent = 
      client.ip_address || 'N/A';
    document.getElementById('client-detail-status').textContent = 'Connected';
  }
  
  calculatePerformanceMetrics(client) {
    const m = client.client_metrics || {};
    
    // Score calculation
    const rssiScore = this.normalizeRSSI(m.rssi_dbm || -70);
    const snrScore = (m.snr_db || 0) / 60 * 100;
    const rateScore = Math.min((Math.max(m.tx_rate_mbps || 0, m.rx_rate_mbps || 0)) / 2000 * 100, 100);
    const lossScore = Math.max(100 - (m.packet_loss_percent || 0) * 100, 0);
    const score = Math.round(rssiScore * 0.3 + snrScore * 0.3 + rateScore * 0.2 + lossScore * 0.2);
    
    // SNR
    const snr = m.snr_db || 0;
    
    // Physical Rate (PR)
    const pr = Math.max(m.tx_rate_mbps || 0, m.rx_rate_mbps || 0);
    
    // Packet Error Rate (PER)
    const per = m.packet_loss_percent || 0;
    
    // Physical Layer Performance (PSY)
    const snrComponent = (m.snr_db || 0) / 60 * 50;
    const spatialStreams = (m.spatial_streams || 1) / 2 * 25;
    const channelWidth = (m.channel_width_mhz || 20) / 160 * 25;
    const psy = Math.round(Math.min(snrComponent + spatialStreams + channelWidth, 100));
    
    return { score, snr, pr, per, psy };
  }
  
  normalizeRSSI(rssi) {
    const min = -90;
    const max = -30;
    return Math.max(0, Math.min(100, ((rssi - min) / (max - min)) * 100));
  }
  
  displayMetricCards(metrics) {
    // Score
    document.getElementById('client-score-value').textContent = metrics.score;
    const scoreTrend = document.getElementById('client-score-trend');
    scoreTrend.textContent = this.getScoreRating(metrics.score);
    scoreTrend.className = 'metric-trend ' + (metrics.score >= 70 ? 'up' : 'down');
    
    // SNR
    document.getElementById('client-snr-value').textContent = metrics.snr.toFixed(1);
    
    // PR
    document.getElementById('client-pr-value').textContent = metrics.pr.toFixed(0);
    
    // PER
    document.getElementById('client-per-value').textContent = metrics.per.toFixed(2);
    
    // PSY
    document.getElementById('client-psy-value').textContent = metrics.psy;
    const psyTrend = document.getElementById('client-psy-trend');
    psyTrend.textContent = this.getPSYRating(metrics.psy);
    psyTrend.className = 'metric-trend ' + (metrics.psy >= 70 ? 'up' : 'down');
  }
  
  getScoreRating(score) {
    if (score >= 80) return 'Excellent';
    if (score >= 60) return 'Good';
    if (score >= 40) return 'Fair';
    return 'Poor';
  }
  
  getPSYRating(psy) {
    if (psy >= 80) return 'Excellent';
    if (psy >= 60) return 'Good';
    if (psy >= 40) return 'Fair';
    return 'Poor';
  }
  
  displayAdditionalInfo(client) {
    const m = client.client_metrics || {};
    const cap = client.capabilities || {};
    
    // Connection details
    document.getElementById('client-ap').textContent = 
      client.connected_ap_mac || 'Unknown';
    document.getElementById('client-band').textContent = 
      this.determineBand(m.channel_width_mhz);
    document.getElementById('client-channel').textContent = 
      `${m.channel_width_mhz || 'N/A'} MHz`;
    document.getElementById('client-connection-time').textContent =
      Number.isFinite(m.association_uptime_seconds) && m.association_uptime_seconds > 0
        ? this.formatUptime(m.association_uptime_seconds)
        : 'Not reported';
    
    // Capabilities
    const standards = cap.wifi_standards || [];
    document.getElementById('client-wifi-standard').textContent = 
      standards.length > 0 ? standards[0] : 'N/A';
    document.getElementById('client-streams').textContent = 
      `${m.spatial_streams || 1}x${m.spatial_streams || 1}`;
    document.getElementById('client-channel-width').textContent = 
      `${m.channel_width_mhz || 20} MHz`;
    document.getElementById('client-security').textContent = 
      client.auth_method || 'N/A';
  }
  
  determineBand(channelWidth) {
    if (channelWidth >= 160) return '6 GHz';
    if (channelWidth >= 80) return '5 GHz';
    return '2.4 GHz';
  }
  
  createCombinedChart(metrics) {
    const canvas = document.getElementById('client-detail-chart');
    if (!canvas) return;
    
    // Destroy existing chart
    if (this.chart) {
      this.chart.destroy();
    }
    
    const ctx = canvas.getContext('2d');
    
    // Generate time series data for all metrics
    const timeLabels = this.generateTimeLabels();
    const datasets = [
      {
        label: 'Score (0-100)',
        data: this.generateMetricData(metrics.score, 'score'),
        borderColor: this.colors.score,
        backgroundColor: this.colors.score + '20',
        yAxisID: 'y',
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      },
      {
        label: 'SNR (dB)',
        data: this.generateMetricData(metrics.snr, 'snr'),
        borderColor: this.colors.snr,
        backgroundColor: this.colors.snr + '20',
        yAxisID: 'y',
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      },
      {
        label: 'PR (Mbps / 10)',
        data: this.generateMetricData(metrics.pr / 10, 'pr'),
        borderColor: this.colors.pr,
        backgroundColor: this.colors.pr + '20',
        yAxisID: 'y',
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      },
      {
        label: 'PER (%) x 20',
        data: this.generateMetricData(metrics.per * 20, 'per'),
        borderColor: this.colors.per,
        backgroundColor: this.colors.per + '20',
        yAxisID: 'y',
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      },
      {
        label: 'PSY (0-100)',
        data: this.generateMetricData(metrics.psy, 'psy'),
        borderColor: this.colors.psy,
        backgroundColor: this.colors.psy + '20',
        yAxisID: 'y',
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      }
    ];
    
    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: timeLabels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: {
              usePointStyle: true,
              padding: 15,
              font: {
                size: 12
              }
            }
          },
          tooltip: {
            enabled: true,
            callbacks: {
              label: function(context) {
                let label = context.dataset.label || '';
                if (label) {
                  label += ': ';
                }
                let value = context.parsed.y;
                
                // Denormalize values for display
                if (label.includes('PR')) {
                  value = value * 10;
                  label = label.replace(' / 10', '');
                } else if (label.includes('PER')) {
                  value = value / 20;
                  label = label.replace(' x 20', '');
                }
                
                label += value.toFixed(2);
                return label;
              }
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: 'rgba(0, 0, 0, 0.05)'
            },
            ticks: {
              font: {
                size: 10
              }
            }
          },
          y: {
            beginAtZero: true,
            min: 0,
            max: 100,
            grid: {
              color: 'rgba(0, 0, 0, 0.05)'
            },
            title: {
              display: true,
              text: 'Normalized Values (0-100)',
              font: {
                size: 13,
                weight: 'bold'
              }
            }
          }
        }
      }
    });
  }
  
  generateTimeLabels() {
    const labels = [];
    const now = new Date();
    
    for (let i = 60; i >= 0; i -= 5) {
      const time = new Date(now.getTime() - i * 60000);
      labels.push(time.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      }));
    }
    
    return labels;
  }
  
  generateMetricData(baseValue, metric) {
    const data = [];
    const points = 13;
    
    for (let i = 0; i < points; i++) {
      let variation;
      
      switch(metric) {
        case 'score':
        case 'psy':
          variation = (Math.random() - 0.5) * 8;
          data.push(Math.max(0, Math.min(100, baseValue + variation)));
          break;
        case 'snr':
          variation = (Math.random() - 0.5) * 4;
          data.push(Math.max(0, Math.min(100, baseValue + variation)));
          break;
        case 'pr':
          variation = (Math.random() - 0.5) * 20;
          data.push(Math.max(0, Math.min(300, baseValue + variation)));
          break;
        case 'per':
          variation = (Math.random() - 0.5) * 2;
          data.push(Math.max(0, Math.min(100, baseValue + variation)));
          break;
        default:
          data.push(baseValue);
      }
    }
    
    return data;
  }
}

/**
 * Client Performance Monitor Class
 * Handles Score, SNR, PR, PER, PSY metrics visualization
 */
class ClientPerformanceMonitor {
  constructor(clients, devices) {
    this.chart = null;
    this.clients = clients || [];
    this.devices = devices || [];
    this.currentMetric = 'score';
    this.selectedDevice = 'all';
    this.colors = [
      '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
      '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
      '#14b8a6', '#a855f7', '#eab308', '#22c55e', '#f43f5e'
    ];
    
    // Metric configurations
    this.metricConfig = {
      score: {
        title: 'Performance Score Over Time',
        yLabel: 'Score',
        unit: '',
        min: 0,
        max: 100
      },
      snr: {
        title: 'Signal-to-Noise Ratio (SNR) Over Time',
        yLabel: 'SNR (dB)',
        unit: ' dB',
        min: 0,
        max: 80
      },
      pr: {
        title: 'Physical Rate (PR) Over Time',
        yLabel: 'Physical Rate (Mbps)',
        unit: ' Mbps',
        min: 0,
        max: 3000
      },
      per: {
        title: 'Packet Error Rate (PER) Over Time',
        yLabel: 'PER (%)',
        unit: '%',
        min: 0,
        max: 5
      },
      psy: {
        title: 'Physical Layer Performance (PSY) Over Time',
        yLabel: 'PSY',
        unit: '',
        min: 0,
        max: 100
      }
    };
  }
  
  async init() {
    // Enhance client data with performance metrics
    this.enhanceClientData();
    
    // Setup event listeners
    this.setupEventListeners();
    
    // Populate device filter
    this.populateDeviceFilter();
    
    // Initialize chart
    this.createChart();
  }
  
  updateClients(clients, devices) {
    this.clients = clients;
    this.devices = devices || this.devices;
    this.enhanceClientData();
    this.populateDeviceFilter();
    if (this.chart) {
      this.updateChart();
    }
  }
  
  enhanceClientData() {
    this.clients = this.clients.map((client, index) => ({
      ...client,
      color: this.colors[index % this.colors.length],
      performance_metrics: this.calculatePerformanceMetrics(client)
    }));
  }
  
  calculatePerformanceMetrics(client) {
    const metrics = client.client_metrics || {};
    
    // Calculate Performance Score (0-100)
    const score = this.calculateScore(metrics);
    
    // SNR already exists
    const snr = metrics.snr_db || 0;
    
    // Physical Rate (PR) - use max of tx/rx rate
    const pr = Math.max(metrics.tx_rate_mbps || 0, metrics.rx_rate_mbps || 0);
    
    // Packet Error Rate (PER) - convert packet loss to percentage
    const per = metrics.packet_loss_percent || 0;
    
    // Physical Layer Performance (PSY) - composite metric
    const psy = this.calculatePSY(metrics);
    
    return { score, snr, pr, per, psy };
  }
  
  calculateScore(metrics) {
    // Calculate overall performance score based on multiple factors
    const rssiScore = this.normalizeRSSI(metrics.rssi_dbm || -70);
    const snrScore = (metrics.snr_db || 0) / 60 * 100;
    const rateScore = Math.min((Math.max(metrics.tx_rate_mbps || 0, metrics.rx_rate_mbps || 0)) / 2000 * 100, 100);
    const lossScore = Math.max(100 - (metrics.packet_loss_percent || 0) * 100, 0);
    
    return Math.round(
      rssiScore * 0.3 +
      snrScore * 0.3 +
      rateScore * 0.2 +
      lossScore * 0.2
    );
  }
  
  normalizeRSSI(rssi) {
    const min = -90;
    const max = -30;
    return Math.max(0, Math.min(100, ((rssi - min) / (max - min)) * 100));
  }
  
  calculatePSY(metrics) {
    const snrComponent = (metrics.snr_db || 0) / 60 * 50;
    const spatialStreams = (metrics.spatial_streams || 1) / 2 * 25;
    const channelWidth = (metrics.channel_width_mhz || 20) / 160 * 25;
    
    return Math.round(Math.min(snrComponent + spatialStreams + channelWidth, 100));
  }
  
  setupEventListeners() {
    // Metric tab switching
    document.querySelectorAll('.performance-metric-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const metric = e.target.dataset.metric;
        this.switchMetric(metric);
      });
    });
    
    // Device filter
    const deviceFilter = document.getElementById('performance-device-filter');
    if (deviceFilter) {
      deviceFilter.addEventListener('change', (e) => {
        this.selectedDevice = e.target.value;
        this.updateChart();
      });
    }
  }
  
  populateDeviceFilter() {
    const select = document.getElementById('performance-device-filter');
    if (!select) return;
    
    select.innerHTML = '<option value="all">All Devices</option>';
    
    // Populate with devices (agents) instead of clients
    this.devices.forEach(device => {
      const clientCount = this.clients.filter(c => c.connected_ap_mac === device.mac).length;
      const option = document.createElement('option');
      option.value = device.mac;
      option.textContent = `${device.vendor} ${device.model} (${clientCount} clients)`;
      select.appendChild(option);
    });
  }
  
  switchMetric(metric) {
    this.currentMetric = metric;
    
    // Update active tab
    document.querySelectorAll('.performance-metric-tab').forEach(tab => {
      tab.classList.remove('active');
      if (tab.dataset.metric === metric) {
        tab.classList.add('active');
      }
    });
    
    // Update chart
    this.updateChart();
  }
  
  createChart() {
    const canvas = document.getElementById('client-performance-chart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const config = this.metricConfig[this.currentMetric];
    
    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: this.generateTimeLabels(),
        datasets: this.generateDatasets()
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            enabled: true,
            callbacks: {
              label: function(context) {
                let label = context.dataset.label || '';
                if (label) {
                  label += ': ';
                }
                const value = context.parsed.y;
                const unit = context.dataset.unit || '';
                label += value.toFixed(2) + unit;
                return label;
              }
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: 'rgba(0, 0, 0, 0.05)'
            },
            ticks: {
              font: {
                size: 11
              }
            }
          },
          y: {
            beginAtZero: true,
            min: config.min,
            max: config.max,
            grid: {
              color: 'rgba(0, 0, 0, 0.05)'
            },
            title: {
              display: true,
              text: config.yLabel,
              font: {
                size: 13,
                weight: 'bold'
              }
            }
          }
        }
      }
    });
    
    this.updateChartTitle();
    this.updateLegend();
  }
  
  updateChart() {
    if (!this.chart) return;
    
    const config = this.metricConfig[this.currentMetric];
    
    this.chart.data.datasets = this.generateDatasets();
    this.chart.options.scales.y.min = config.min;
    this.chart.options.scales.y.max = config.max;
    this.chart.options.scales.y.title.text = config.yLabel;
    
    this.chart.update();
    this.updateChartTitle();
    this.updateLegend();
  }
  
  updateChartTitle() {
    const config = this.metricConfig[this.currentMetric];
    const titleEl = document.getElementById('performance-chart-title');
    if (titleEl) {
      titleEl.textContent = config.title;
    }
  }
  
  generateTimeLabels() {
    const labels = [];
    const now = new Date();
    
    for (let i = 60; i >= 0; i -= 5) {
      const time = new Date(now.getTime() - i * 60000);
      labels.push(time.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      }));
    }
    
    return labels;
  }
  
  generateDatasets() {
    // Filter clients by selected device (agent)
    const filteredClients = this.selectedDevice === 'all' 
      ? this.clients 
      : this.clients.filter(c => c.connected_ap_mac === this.selectedDevice);
    
    const config = this.metricConfig[this.currentMetric];
    
    return filteredClients.map(client => {
      const baseValue = client.performance_metrics[this.currentMetric];
      const data = this.generateMetricData(baseValue, this.currentMetric);
      
      return {
        label: `${client.hostname} (${client.mac.substring(0, 17)}): ${baseValue.toFixed(2)}${config.unit}`,
        data: data,
        borderColor: client.color,
        backgroundColor: client.color + '20',
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 5,
        unit: config.unit
      };
    });
  }
  
  generateMetricData(baseValue, metric) {
    const data = [];
    const points = 13;
    
    for (let i = 0; i < points; i++) {
      let variation;
      
      switch(metric) {
        case 'score':
          variation = (Math.random() - 0.5) * 10;
          data.push(Math.max(0, Math.min(100, baseValue + variation)));
          break;
        case 'snr':
          variation = (Math.random() - 0.5) * 5;
          data.push(Math.max(0, baseValue + variation));
          break;
        case 'pr':
          variation = (Math.random() - 0.5) * 200;
          data.push(Math.max(0, baseValue + variation));
          break;
        case 'per':
          variation = (Math.random() - 0.5) * 0.1;
          data.push(Math.max(0, Math.min(5, baseValue + variation)));
          break;
        case 'psy':
          variation = (Math.random() - 0.5) * 8;
          data.push(Math.max(0, Math.min(100, baseValue + variation)));
          break;
        default:
          data.push(baseValue);
      }
    }
    
    return data;
  }
  
  updateLegend() {
    const legendContainer = document.getElementById('performance-legend-items');
    if (!legendContainer) return;
    
    legendContainer.innerHTML = '';
    
    const filteredClients = this.selectedDevice === 'all' 
      ? this.clients 
      : this.clients.filter(c => c.mac === this.selectedDevice);
    
    const config = this.metricConfig[this.currentMetric];
    
    filteredClients.forEach(client => {
      const item = document.createElement('div');
      item.className = 'performance-legend-item';
      
      const value = client.performance_metrics[this.currentMetric];
      
      item.innerHTML = `
        <div class="performance-legend-color" style="background: ${client.color}"></div>
        <span><strong>${client.hostname}</strong> (${client.mac.substring(0, 17)}): ${value.toFixed(2)}${config.unit}</span>
      `;
      
      legendContainer.appendChild(item);
    });
  }
}

  // -------- Global helpers for HTML onclick handlers --------
  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('active');
  }

// -------- Initialize when DOM is loaded --------
document.addEventListener('DOMContentLoaded', () => {
  window.EasyMeshController = new EasyMeshController();
  window.EasyMeshController.init();
});

// -------- Cleanup on page unload --------
window.addEventListener('beforeunload', () => {
  if (window.EasyMeshController) window.EasyMeshController.cleanup();
});

// -------- Export for CommonJS (optional) --------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = EasyMeshController;
}
