# RF simulation and closed-loop experimentation

Audience: Wi-Fi experts who need to understand how an RF scenario becomes an
observable EasyMesh or optimizer result.

Purpose: explain component ownership. Detailed commands and protocols live in
the linked guide and reference documents.

## One closed loop, separate responsibilities

```text
scenario definition
       |
       v
Python wmediumd configurator ---- typed SNR/frequency changes -----+
       ^                                                          |
       | readback                                                  v
experiment runner                                         patched wmediumd
       |                                                   /      |       \
       | expected phase                                  / 802.11 frames    \
       |                                                 v        v          v
       |                                        hwsim APs/bSTAs/WLAN clients
       |                                                 |
       |                                      association and traffic
       |                                                 v
       +---- result verification <--- EasyMesh agents/controller/WebUI
                                           |
                                           v
                                  external optimizer
                             observe -> decide -> act -> verify

wmediumd Console observes the medium path, counters, active links, events,
configuration identity, and bounded typed controls. It does not replace the
scenario runner or optimizer.
```

The separation is deliberate:

- wmediumd applies RF conditions and handles frames;
- the configurator describes deterministic time-based RF worlds;
- hwsim stations and APs react through normal Linux Wi-Fi behavior;
- EasyMesh observes the resulting topology and metrics and can issue steering;
- the optimizer is an external consumer of observations and producer of
  bounded actions; and
- the Console explains what the medium actually applied.

## Why association does not redefine the RF world

A moving station has a signal relationship to every candidate AP. Its current
association does not define those relationships. A scenario therefore assigns
SNR by stable radio identity and role, not by statements such as "current AP"
or "target AP."

For example, a crossover phase can continuously weaken the STA-to-Extender-1
links while strengthening the STA-to-Extender-2 links. If the station roams,
the RF matrix remains correct because both relationships were already defined.
No feedback rewrite is needed merely because the association changed.

Feedback is still required to evaluate behavior: the experiment must correlate
the applied RF phase with the station link, EasyMesh parent, telemetry, steering
decision, traffic, and restoration result.

## Static and dynamic inputs

wmediumd still requires a startup configuration that declares the radio
identities and complete baseline link matrix. The lab generates that file from
the active hwsim radios.

Dynamic scenarios then use the control socket to change selected pair values or
frequency overrides without restarting wmediumd. Atomic generations and
readback prevent a half-applied phase from being mistaken for a valid test.

The scenario language supports deterministic phases, role binding, geometry,
movement, walls, appearance/disappearance, and precomputed golden sequences.
Scenario cleanup restores the captured baseline rather than assuming a default
value.

## Observation surfaces

Use the surfaces for different questions:

| Surface | Answers |
| --- | --- |
| Station `iw link` | Which BSSID/channel is the client actually using? |
| EasyMesh APIs/WebUI | What parent, topology, metrics, and policy state does the controller know? |
| wmediumd Console | Which radios and pairs exist, what RF value is active, and what happened to frames? |
| Scenario journal | Which phase and intended world were active? |
| Optimizer journal | Which inputs, decision, action, and verification result occurred? |
| Packet capture | What protocol exchange crossed the selected boundary? |

No single surface is sufficient for an optimizer claim.

## Safe experiment progression

1. Validate the unchanged baseline.
2. Compile and inspect a scenario without applying it.
3. Apply it through the configurator and verify socket readback.
4. Observe station, controller, Console, and traffic behavior.
5. Restore and verify the exact baseline.
6. Replay the recorded observation through the optimizer.
7. Run the optimizer live in observe mode.
8. Run recommend mode and review decisions.
9. Permit one explicit action with bounded verification and backoff.

## Detailed documentation

- [wmediumd internals](../reference/wmediumd-internals.md)
- [wmediumd configurator](../reference/wmediumd-configurator.md)
- [wmediumd Console](../reference/wmediumd-console.md)
- [Experiment catalog](../experiments/README.md)
- [Optimizer](optimizer.md)
- [Metrics](../reference/metrics.md)
