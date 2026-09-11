# wmediumd configurator

[Subsystem index](README.md)

## Purpose and boundary

`wmdcfg` creates deterministic RF conditions for steering experiments. It does
not select an AP, deploy an EasyMesh policy or issue a steering request.

```text
scenario source -> compiler -> frozen event plan -> runner
                                                    |
                                                    v
                                             wmediumd SNR matrix
                                                    |
                                                    v
                                         hwsim frames/measurements
                                                    |
                           policy or explicit command decides whether to steer
```

Keeping stimulus and decision independent lets the same RF scenario test a
passive control, commanded steering, a controller optimizer or future
agent-initiated steering.

Implementation: `gen/wmediumd/configurator/`, Python 3.8+, no external parser
dependency.

## Geometry front end and golden sequences

The phase language remains the final, auditable input to the existing runner.
For larger experiments, `world-compile` first calculates that input from two
separate JSON documents:

```text
layout: space + fixed Agents + fixed clients + walls + propagation
mobility: duration + tick + paths + presence intervals + seed
                             |
                             v
world plan: positions + presence + directed SNR by band at every tick
                             |
                    world-export --band 5
                             |
                             v
auditable v1 .wmd phase source -> normal bind/compile/run path
```

The checked-in home is 20 by 14 metres with five fixed Agents, ten fixed
clients and four simple walls. Mobility variants add ten slow walkers, clients
hovering around borders, a flash crowd, disappearance/reappearance, fast
transit, an asymmetric transmitter and extender loss/recovery. A second layout
moves the Agents while leaving the space and client paths unchanged.

For band `b`, directed link SNR at time `t` is:

```text
clamp(reference[b]
      - 10 * path_loss_exponent * log10(distance / reference_distance)
      - sum(crossed wall losses)
      + source transmit adjustment[b]
      + deterministic seeded shadowing)
```

Every proper wall intersection adds its configured loss; the present home uses
5 dB per wall. This is a reproducible stress model, not a ray tracer or claim
about a real building. An absent node is represented by minimum SNR on all its
links. Positions and presence are keyed to physical roles and never to current
association.

Regenerate or verify all golden world timelines with:

```sh
cd gen/wmediumd/configurator
worlds/build-goldens.sh --check
# Intentional source change only:
worlds/build-goldens.sh --write
```

Each world plan contains hashes of its layout and mobility inputs plus a
canonical `golden_sha256`. Exact JSON numbers hash identically whether a JSON
writer emits `5` or `5.0`. Tests reject any content change without a matching
regeneration.

Compile and inspect one world directly:

```sh
python3 -m wmdcfg.cli world-compile \
  --layout worlds/layouts/home-five-agent.json \
  worlds/mobility/slow-walk-ten.json \
  -o /tmp/home.world.json
python3 -m wmdcfg.cli world-export /tmp/home.world.json \
  --band 5 -o /tmp/home-5.wmd
python3 -m wmdcfg.cli validate /tmp/home-5.wmd
```

`--band 2.4`, `5` or `6` retains the backward-compatible radio-pair
projection. `--band all` emits all three values at once using band-qualified
links. Binding resolves each band through the target Agent's live private-SSID
frequency. Discover those frequencies in the current inventory rather than
assuming one common 6 GHz channel or copying another deployment's values.

The world plan calculates fronthaul and Agent-to-Agent backhaul values for
2.4, 5 and 6 GHz. The current exporter deliberately emits fronthaul only and
retains `protect backhaul`.

## Scenario model

The first language version describes named roles and time phases. A two-AP
crossover is:

```text
time                 0 s          10 s          40 s          60 s
client <-> AP-A      42 dB --------+ 42 -> 10 ---- 10 dB -------+
client <-> AP-B      10 dB --------+ 10 -> 42 ---- 42 dB -------+
phase                baseline        crossover      hold
```

Source:

```text
scenario two_ap_crossover {
    language 1
    tick 1s
    require radio_pair_snr
    require atomic_generations
    require readback
    protect backhaul
    restore captured

    role client : station
    role ap_a : fronthaul_ap
    role ap_b : fronthaul_ap

    phase baseline for 10s {
        parallel {
            link client <-> ap_a snr = 42dB
            link client <-> ap_b snr = 10dB
        }
    }
    phase crossover for 30s {
        parallel {
            link client <-> ap_a snr 42dB -> 10dB linear
            link client <-> ap_b snr 10dB -> 42dB linear
        }
    }
    phase destination_hold for 20s { hold }
}
```

Supported constructs:

| Construct | Meaning |
| --- | --- |
| `tick` | ramp sample interval, 100 ms to 60 s |
| `role` | station or fronthaul AP binding |
| `phase ... for` | fixed monotonic duration |
| `parallel` | one atomic generation at a timestamp |
| `link ->`, `<-`, `<->` | directed or symmetric radio-pair SNR |
| `snr =` | constant integer dB value |
| `snr A -> B linear` | inclusive sampled ramp |
| `hold` | retain the previous matrix |
| `protect backhaul` | reject unsafe backhaul mutations |
| `restore captured` | capture, restore and verify touched links |

SNR is restricted to `[-20, 60]` dB. Unknown units, incomplete initial link
coverage, conflicting same-generation updates, unsafe role pairs or missing
bindings fail compilation.

## Why roles do not follow association

AP-A and AP-B are physical radio identities for the entire run. A roam changes
which AP receives client traffic; it does not change either link function.

An association-relative rule such as “current AP strong” becomes wrong after a
roam and couples RF input to the decision under test. Association is therefore
observed and recorded but does not rewrite the matrix.

## Workflow

Run inside the runtime that owns LXD/hwsim:

```sh
cd /home/easymesh/git/meta-cmf-bananapi-vcpe/gen/wmediumd/configurator

python3 -m unittest discover -s tests -v
python3 -m wmdcfg.cli inventory -o /tmp/inventory.json
python3 -m wmdcfg.cli validate scenarios/two-ap-crossover.wmd
python3 -m wmdcfg.cli compile scenarios/two-ap-crossover.wmd \
  --inventory /tmp/inventory.json \
  --bind client=wlan-client \
  --bind ap_a=bpibroadband \
  --bind ap_b=bpiap \
  -o /tmp/crossover.plan.json
python3 -m wmdcfg.cli status
python3 -m wmdcfg.cli run /tmp/crossover.plan.json \
  --output-root /tmp/wmdcfg-runs
```

Inventory resolves container, wiphy, permanent MAC, hwsim transmitter MAC,
interfaces, frequencies, SSIDs, BSSIDs and current association. Compilation
freezes those bindings; it never changes the medium.

Inspect the generated plan before execution. Recompile after a clean deploy
because `-F` changes identities and BSSIDs.

## Live actuator

```text
/run/meta-cmf-wmediumd/wmediumd.cfg -> startup radio list/default SNR

/run/wmediumd-control.sock --------> live in-memory generations
                                      HELLO / STATUS
                                      APPLY
                                      GET_LINK / DUMP_LINKS
                                      APPLY_FREQUENCY
                                      GET_FREQUENCY / DUMP_FREQUENCIES
```

The Unix socket uses `SOCK_SEQPACKET`, fixed-width network-byte-order records
and a generation counter. One writer owns the connection. wmediumd validates
protocol version, daemon instance, generation, radio identity and SNR bounds
before applying a complete generation atomically.

Editing the startup configuration does not change a running daemon. Scenario
ramps use the control socket and leave the PID unchanged.

Patch `0012` adds sparse `(source radio, destination radio, frequency MHz)`
overrides. An override applies only to frames at that exact frequency; other
frequencies fall back to the radio-pair value. Set and clear operations share
the atomic generation counter. Readback reports whether a value is an explicit
override, so the runner restores both the number and the original presence or
absence of that override.

The socket deliberately replaces the file for live scenario state, but not yet
for daemon bootstrap. The startup file supplies the initial registered-radio
set and default matrix. `HELLO`, `APPLY`, `GET_LINK` and `DUMP_LINKS` then carry
all timed SNR generations without a restart. Adding or removing an hwsim radio
still requires regenerating the bootstrap list and restarting wmediumd. Removing
that last restart would require explicit add/remove-radio and atomic
replace-matrix protocol operations; it should not be simulated as a sequence of
partially visible link updates.

## Why a WLAN client cannot emit RSSI

RSSI belongs to the receiver and to one direction of a link. A station can
change its transmit power, which changes the AP's uplink observation, but it
cannot declare the RSSI of frames it receives from an AP. Patching a client
driver or supplicant to report a synthetic value would only falsify selected
measurements; carrier sensing, loss, scanning, rate control and roaming would
still experience a different medium.

wmediumd is therefore the actuator for both directed link values:

```text
AP -> STA SNR     what the station receives
STA -> AP SNR     what the AP receives
```

The two values may be driven together for a symmetric path or independently to
model asymmetry. Association is feedback for observation and assertions, not a
reason to swap AP identities or rewrite a movement trajectory.

## Runner safety and artifacts

Preflight requires a complete topology and all expected clients active. The
runner then:

1. acquires the single writer;
2. verifies daemon identity/capabilities;
3. captures every touched directed link;
4. verifies frozen identities still exist;
5. applies and reads back each generation;
6. records deadline lateness and controller-model association/RCPI
   observations with one bounded query per generation; and
7. restores all captured values as one verified final generation.

Each run directory contains:

```text
event-plan.json        frozen inputs and timed generations
medium-events.jsonl    apply/readback/association/restore events
health-events.jsonl    preflight and postflight topology/API state
summary.json           outcome, timing, error and restoration result
```

An experiment is not complete unless `summary.json` reports `passed` and
`restored: true`.

## Acceptance

Before using a configurator build, require all of the following:

- the Python parser, compiler, world, observer and runner suites pass;
- the wmediumd multichannel/Linux-7 internal suite passes;
- pair and frequency updates reject stale generations and read back exactly;
- a passive crossover changes RF without causing an autonomous roam;
- an explicit steering action converges in the physical link, controller model
  and WebUI; and
- every run restores all touched values, leaves no unexpected override and
  preserves the complete current topology.

The runnable scenarios under [experiments](../../experiments/README.md) produce
the evidence needed to evaluate these gates.

## Limits

- Legacy SNR remains keyed by radio pair. Use `world-export --band all` and a
  daemon advertising `frequency_qualified_snr` for simultaneous same-wiphy
  band conditions; a single-band projection still applies to the whole pair.
- `SIGKILL` or host loss cannot execute Python restoration; unattended use
  needs a daemon-side lease/watchdog.
- Health is gated before/after, not continuously used to advance phases. The
  gate combines the compact WebUI node/client projection with authoritative
  controller database counts; it does not require the WebUI response to repeat
  all 50 BSS records.
- The geometry front end supports deterministic paths, presence, walls and
  seeded shadowing. Trace import, a real floor-plan propagation model and
  conditional waits are not implemented.
- The configurator is a CLI/library, not a long-running authenticated service.
