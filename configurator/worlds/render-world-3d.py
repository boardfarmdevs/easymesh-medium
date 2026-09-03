#!/usr/bin/env python3
"""Render a golden world plan (wmdcfg.world-plan.v1) as a 3D picture.

The picture shows the floor plan as a ground slab, fixed-loss walls as
vertical panels, access points as tall posts, stations as markers on the
floor, mobile station paths as trails, and the best serving fronthaul link
per station at one generation, coloured by SNR on the selected band.

    python3 worlds/render-world-3d.py worlds/golden/home-a-slow-walk-ten.world.json \
        --time-ms 30000 --band 5 --format svg -o /tmp/home-a-slow-walk-ten.svg

    python3 worlds/render-world-3d.py worlds/golden/*.world.json --outdir /tmp/pictures

    python3 worlds/render-world-3d.py worlds/golden/*.world.json \
        --format both --outdir /tmp/pictures

Only matplotlib and numpy are needed; no display is required.
"""
import argparse
import json
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from mpl_toolkits.mplot3d.art3d import Poly3DCollection  # noqa: E402

AP_HEIGHT = 2.2
STA_HEIGHT = 0.9
WALL_HEIGHT = 2.6
FLOOR = "#e9e4d8"
WALL = "#b8ad9a"
GATEWAY = "#c0392b"
EXTENDER = "#1f5f8b"
STATIC_STA = "#3b3b3b"
MOBILE_STA = "#7a4b9c"
ABSENT = "#c9c9c9"


def snr_colour(snr, lo=5.0, hi=45.0):
    """Map SNR dB onto a red-amber-green ramp."""
    t = max(0.0, min(1.0, (snr - lo) / (hi - lo)))
    return plt.get_cmap("RdYlGn")(t)


def pick_generation(world, time_ms):
    gens = world["generations"]
    if time_ms is None:
        return gens[len(gens) // 2]
    return min(gens, key=lambda g: abs(g["time_ms"] - time_ms))


def draw_floor(ax, width, height):
    slab = [[0, 0, 0], [width, 0, 0], [width, height, 0], [0, height, 0]]
    ax.add_collection3d(
        Poly3DCollection([slab], facecolors=FLOOR, edgecolors="#c9c2b3", linewidths=0.8, alpha=0.95, zorder=0)
    )
    for x in range(0, width + 1, 2):
        ax.plot([x, x], [0, height], [0, 0], color="#d8d2c4", linewidth=0.4, zorder=1)
    for y in range(0, height + 1, 2):
        ax.plot([0, width], [y, y], [0, 0], color="#d8d2c4", linewidth=0.4, zorder=1)


def draw_walls(ax, walls):
    for wall in walls:
        (x0, y0), (x1, y1) = wall["start"], wall["end"]
        panel = [[x0, y0, 0], [x1, y1, 0], [x1, y1, WALL_HEIGHT], [x0, y0, WALL_HEIGHT]]
        ax.add_collection3d(
            Poly3DCollection([panel], facecolors=WALL, edgecolors="#8d8270", linewidths=0.8, alpha=0.45, zorder=2)
        )
        ax.text(
            (x0 + x1) / 2, (y0 + y1) / 2, WALL_HEIGHT + 0.15,
            "%s (%g dB)" % (wall["name"], wall["loss_db"]),
            fontsize=6, color="#5c5344", ha="center", zorder=9,
        )


def draw_paths(ax, world):
    """Draw the ground trail of every station that moves during the world."""
    tracks = {}
    for gen in world["generations"]:
        for role, pos in gen["positions"].items():
            if world["roles"].get(role) == "station":
                tracks.setdefault(role, []).append(tuple(pos))
    for role, pts in tracks.items():
        if len(set(pts)) < 2:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        ax.plot(xs, ys, [0.02] * len(xs), color=MOBILE_STA, alpha=0.35, linewidth=1.0, linestyle="--", zorder=3)


def best_fronthaul(world, gen, band):
    """Return {station: (ap, snr)} for the strongest present fronthaul link."""
    best = {}
    present = gen["present"]
    roles = world["roles"]
    for link in gen["links"]:
        if link["link_class"] != "fronthaul":
            continue
        src, dst = link["source_role"], link["destination_role"]
        if not (present.get(src, True) and present.get(dst, True)):
            continue
        # World plans contain both directions of every RF pair.  Normalize the
        # endpoints by role so a reverse STA -> AP record cannot be mistaken
        # for an AP whose "station" is an extender.  That mistake rendered a
        # short orphan link from each AP post into empty space.
        if roles.get(src) == "station" and roles.get(dst) != "station":
            sta, ap = src, dst
        elif roles.get(dst) == "station" and roles.get(src) != "station":
            sta, ap = dst, src
        else:
            continue
        snr = link["snr_db_by_band"][band]
        if sta not in best or snr > best[sta][1]:
            best[sta] = (ap, snr)
    return best


def draw_nodes_and_links(ax, world, gen, band, show_backhaul):
    roles = world["roles"]
    positions = gen["positions"]
    present = gen["present"]

    for role, kind in roles.items():
        x, y = positions[role]
        alive = present.get(role, True)
        if kind == "station":
            colour = MOBILE_STA if "mobile" in role else STATIC_STA
            if not alive:
                colour = ABSENT
            ax.plot([x, x], [y, y], [0, STA_HEIGHT], color=colour, linewidth=0.8, alpha=0.6, zorder=6)
            ax.scatter([x], [y], [STA_HEIGHT], s=18, c=[colour], depthshade=False, zorder=7)
        else:
            colour = GATEWAY if role == "gateway" else EXTENDER
            if not alive:
                colour = ABSENT
            ax.plot([x, x], [y, y], [0, AP_HEIGHT], color=colour, linewidth=2.5, zorder=6)
            ax.scatter([x], [y], [AP_HEIGHT], s=90, c=[colour], marker="^", depthshade=False, zorder=8)
            label = role.replace("extender_", "ext ")
            if not alive:
                label += " (absent)"
            ax.text(x, y, AP_HEIGHT + 0.35, label, fontsize=7, ha="center", color=colour, weight="bold", zorder=9)

    if show_backhaul:
        seen = set()
        for link in gen["links"]:
            if link["link_class"] != "backhaul":
                continue
            a, b = link["source_role"], link["destination_role"]
            key = tuple(sorted((a, b)))
            if key in seen or not (present.get(a, True) and present.get(b, True)):
                continue
            seen.add(key)
            (x0, y0), (x1, y1) = positions[a], positions[b]
            ax.plot([x0, x1], [y0, y1], [AP_HEIGHT, AP_HEIGHT],
                    color=snr_colour(link["snr_db_by_band"][band]), linewidth=1.0, alpha=0.5, linestyle=":", zorder=4)

    for sta, (ap, snr) in best_fronthaul(world, gen, band).items():
        (x0, y0), (x1, y1) = positions[ap], positions[sta]
        ax.plot([x0, x1], [y0, y1], [AP_HEIGHT, STA_HEIGHT],
                color=snr_colour(snr), linewidth=1.4, alpha=0.9, zorder=5)


def render(world, output_paths, time_ms=None, band="5", elev=32, azim=-58, show_backhaul=True):
    gen = pick_generation(world, time_ms)
    width, height = 20, 14
    xs = [p[0] for p in gen["positions"].values()]
    ys = [p[1] for p in gen["positions"].values()]
    width = max(width, int(max(xs)) + 1)
    height = max(height, int(max(ys)) + 1)

    fig = plt.figure(figsize=(12, 7), dpi=150)
    ax = fig.add_subplot(111, projection="3d")
    ax.set_proj_type("persp")
    # Draw in explicit order: floor, walls, paths, links, nodes, labels.
    ax.computed_zorder = False

    draw_floor(ax, width, height)
    draw_walls(ax, world["walls"])
    draw_paths(ax, world)
    draw_nodes_and_links(ax, world, gen, band, show_backhaul)

    ax.set_xlim(0, width)
    ax.set_ylim(0, height)
    ax.set_zlim(0, WALL_HEIGHT + 1.2)
    ax.set_box_aspect((width, height, 5))
    ax.view_init(elev=elev, azim=azim)
    ax.set_xlabel("x (m)", fontsize=8, labelpad=6)
    ax.set_ylabel("y (m)", fontsize=8, labelpad=6)
    ax.set_zticks([])
    ax.tick_params(labelsize=7)
    ax.xaxis.pane.fill = ax.yaxis.pane.fill = ax.zaxis.pane.fill = False
    ax.grid(False)

    present_stations = sum(1 for r, k in world["roles"].items() if k == "station" and gen["present"].get(r, True))
    fig.suptitle(world["name"], fontsize=14, weight="bold", y=0.96)
    ax.set_title(
        "layout %s, mobility %s   |   t = %.0f s of %.0f s, band %s GHz, %d agents, %d/%d stations present"
        % (world["layout"], world["mobility"], gen["time_ms"] / 1000.0, world["duration_ms"] / 1000.0,
           band, world["counts"]["agents"], present_stations, world["counts"]["stations"]),
        fontsize=8, color="#555555", pad=2,
    )

    handles = [
        Line2D([], [], marker="^", linestyle="", color=GATEWAY, markersize=9, label="gateway"),
        Line2D([], [], marker="^", linestyle="", color=EXTENDER, markersize=9, label="extender"),
        Line2D([], [], marker="o", linestyle="", color=STATIC_STA, markersize=6, label="static station"),
        Line2D([], [], marker="o", linestyle="", color=MOBILE_STA, markersize=6, label="mobile station"),
        Line2D([], [], linestyle="--", color=MOBILE_STA, alpha=0.5, label="mobile path"),
        Line2D([], [], color=snr_colour(40), linewidth=1.5, label="best fronthaul, high SNR"),
        Line2D([], [], color=snr_colour(25), linewidth=1.5, label="best fronthaul, mid SNR"),
        Line2D([], [], color=snr_colour(10), linewidth=1.5, label="best fronthaul, low SNR"),
    ]
    if show_backhaul:
        handles.append(Line2D([], [], linestyle=":", color="#888888", label="backhaul"))
    ax.legend(handles=handles, loc="upper right", fontsize=7, frameon=False, bbox_to_anchor=(1.0, 0.92))

    fig.tight_layout()
    for out_path, output_format in output_paths:
        fig.savefig(
            out_path,
            format=output_format,
            bbox_inches="tight",
            facecolor="white",
        )
    plt.close(fig)
    return gen["time_ms"]


def output_formats(value):
    if value == "both":
        return ("png", "svg")
    return (value,)


def output_stem(path):
    for suffix in (".png", ".svg"):
        if path.lower().endswith(suffix):
            return path[:-len(suffix)]
    return path


def output_paths_for(world_path, args):
    formats = output_formats(args.format)
    if args.output:
        if len(formats) == 1:
            return [(args.output, formats[0])]
        stem = output_stem(args.output)
        return [(stem + "." + fmt, fmt) for fmt in formats]

    base = os.path.basename(world_path).replace(".world.json", "") + ".3d"
    directory = args.outdir or os.path.dirname(world_path) or "."
    return [(os.path.join(directory, base + "." + fmt), fmt) for fmt in formats]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("worlds", nargs="+", help="golden .world.json files")
    parser.add_argument("-o", "--output", help="output file, or basename with --format both (single input only)")
    parser.add_argument("--outdir", help="directory for generated pictures")
    parser.add_argument(
        "--format",
        choices=["png", "svg", "both"],
        default="png",
        help="output format (default: png)",
    )
    parser.add_argument("--time-ms", type=int, default=None, help="generation to render (default: middle)")
    parser.add_argument("--band", default="5", choices=["2.4", "5", "6"], help="band used for SNR colours")
    parser.add_argument("--elev", type=float, default=32)
    parser.add_argument("--azim", type=float, default=-58)
    parser.add_argument("--no-backhaul", action="store_true", help="hide AP-to-AP backhaul links")
    args = parser.parse_args(argv)

    if args.output and len(args.worlds) != 1:
        parser.error("-o/--output needs exactly one input world; use --outdir for several")
    if args.outdir:
        os.makedirs(args.outdir, exist_ok=True)

    for path in args.worlds:
        with open(path) as handle:
            world = json.load(handle)
        if world.get("schema") != "wmdcfg.world-plan.v1":
            print("skipping %s: not a wmdcfg.world-plan.v1 file" % path, file=sys.stderr)
            continue
        outputs = output_paths_for(path, args)
        t = render(world, outputs, args.time_ms, args.band, args.elev, args.azim, not args.no_backhaul)
        print("%s -> %s (t=%d ms, band %s)" %
              (path, ", ".join(out for out, _ in outputs), t, args.band))


if __name__ == "__main__":
    main()
