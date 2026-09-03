# Rendering the RF worlds in 3D

The files in `golden/` are deterministic `wmdcfg.world-plan.v1` RF plans. The
`render-world-3d.py` helper turns any generation of a plan into a static PNG,
a scalable SVG, or both. PNG is convenient for GitHub and reports; SVG is
useful for presentations and lossless resizing.

The drawing represents:

- the floor plan and fixed-loss walls;
- the gateway, extenders, and static or mobile stations;
- the complete path followed by each mobile station;
- one direction-independent best serving fronthaul link for every present
  station; and
- optional AP-to-AP backhaul links.

Link colours use the selected band's SNR: red is weak, amber is intermediate,
and green is strong. The renderer is a visualization of a compiled world; it
does not modify or execute the scenario.

## Install the renderer dependencies

Run this once in a Python virtual environment:

```sh
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install matplotlib numpy
```

No desktop or X server is required. The script selects Matplotlib's headless
`Agg` backend.

## Render all golden worlds

Run from `gen/wmediumd/configurator`:

```sh
python3 worlds/render-world-3d.py \
  worlds/golden/*.world.json \
  --outdir worlds/pictures
```

The default picture uses the generation closest to the middle of each world
and displays 5 GHz SNR. Existing files with the same names are replaced. Use
`--format svg` to generate only SVG files, or generate both formats together:

```sh
python3 worlds/render-world-3d.py \
  worlds/golden/*.world.json \
  --format both \
  --outdir worlds/pictures
```

Before rendering, the checked-in worlds can be verified against their layout
and mobility sources:

```sh
./worlds/build-goldens.sh --check
```

Use `--write` instead of `--check` only when intentionally regenerating the
golden plans after changing a source layout or mobility definition.

## Render one time and band

For example, render the generation nearest 30 seconds using 6 GHz link SNR:

```sh
python3 worlds/render-world-3d.py \
  worlds/golden/home-a-slow-walk-ten.world.json \
  --time-ms 30000 \
  --band 6 \
  -o /tmp/home-a-slow-walk-ten-30s-6ghz.png
```

Useful options are:

- `--format png|svg|both`: select raster, vector, or both output formats;
- `--time-ms N`: use the generation nearest `N` milliseconds;
- `--band 2.4|5|6`: select the SNR values used to colour links;
- `--elev DEGREES` and `--azim DEGREES`: change the camera position; and
- `--no-backhaul`: hide AP-to-AP links.

With one input, `-o` names the output directly for `png` or `svg`. With
`--format both`, it is treated as a basename: for example,
`-o /tmp/world-picture` creates `/tmp/world-picture.png` and
`/tmp/world-picture.svg`.

## Golden-world gallery

### Stationary baseline

![Stationary baseline](pictures/home-a-stationary.3d.png)

### Ten slow-moving stations

![Ten slow-moving stations](pictures/home-a-slow-walk-ten.3d.png)

### Shifted-agent slow walk

![Shifted-agent slow walk](pictures/home-b-slow-walk-ten.3d.png)

### Border hover

![Border hover](pictures/home-a-border-hover.3d.png)

### Fast transit

![Fast transit](pictures/home-a-fast-transit.3d.png)

### Disappear and reappear

![Disappear and reappear](pictures/home-a-disappear-reappear.3d.png)

### Extender loss and recovery

![Extender loss and recovery](pictures/home-a-extender-loss-recovery.3d.png)

### Flash crowd

![Flash crowd](pictures/home-a-flash-crowd.3d.png)

### Asymmetric link

![Asymmetric link](pictures/home-a-asymmetric-link.3d.png)

### Small three-band walk

![Small three-band walk](pictures/home-a-band-walk-small.3d.png)
