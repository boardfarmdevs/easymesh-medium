#!/bin/sh
set -eu

mode="${1:---check}"
case "$mode" in
    --check|--write) ;;
    *) echo "usage: $0 [--check|--write]" >&2; exit 2 ;;
esac

world_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
configurator_root=$(dirname -- "$world_root")
work_dir=$(mktemp -d)
trap 'rm -rf -- "$work_dir"' EXIT HUP INT TERM

emit()
{
    layout=$1
    mobility=$2
    output=$3
    generated="$work_dir/$output"
    (
        cd "$configurator_root"
        python3 -m wmdcfg.cli world-compile \
            --layout "worlds/layouts/$layout" \
            "worlds/mobility/$mobility" \
            -o "$generated.pretty"
    )
    jq -c . "$generated.pretty" > "$generated"
    if [ "$mode" = "--write" ]; then
        mv "$generated" "$world_root/golden/$output"
    elif ! cmp -s "$generated" "$world_root/golden/$output"; then
        echo "stale golden: $output" >&2
        return 1
    fi
}

emit home-five-agent.json stationary.json home-a-stationary.world.json
emit home-five-agent.json slow-walk-ten.json home-a-slow-walk-ten.world.json
emit home-five-agent-shifted.json slow-walk-ten.json home-b-slow-walk-ten.world.json
emit home-five-agent.json border-hover.json home-a-border-hover.world.json
emit home-five-agent.json flash-crowd.json home-a-flash-crowd.world.json
emit home-five-agent.json disappear-reappear.json home-a-disappear-reappear.world.json
emit home-five-agent.json fast-transit.json home-a-fast-transit.world.json
emit home-five-agent.json extender-loss-recovery.json home-a-extender-loss-recovery.world.json
emit home-five-agent.json asymmetric-link.json home-a-asymmetric-link.world.json
emit home-five-agent.json band-walk-small.json home-a-band-walk-small.world.json
emit home-five-agent.json private-client-room-walk.json home-a-private-client-room-walk.world.json

echo "golden RF sequences: ${mode#--} passed"
