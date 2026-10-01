# Offline browser dependencies

`web-vendor.tar.gz` holds the topology page's offline browser libraries.
It contains D3 7.9.0, Chart.js 3.9.1, Animate.css 4.1.1 and Font Awesome Free
6.4.0, including every font referenced by its stylesheet. The archive SHA-256
is `699a85cca2578c7d1563ab7e0544f934ca3b2292fef42b85022a1fca89139e08`.

`assemble.sh` verifies the archive and `vendor/SHA256SUMS` before installing
them next to the page. On RDK the normal CLI startup copies them into
`/nvram/static/`; prplMesh embeds them. No CDN, additional proxy or browser
Internet access is needed.
Room acceptance blocks HTTP requests outside the two supplied lab origins.

The sources are the official npm distribution archives:

- <https://registry.npmjs.org/d3/-/d3-7.9.0.tgz>
- <https://registry.npmjs.org/chart.js/-/chart.js-3.9.1.tgz>
- <https://registry.npmjs.org/animate.css/-/animate.css-4.1.1.tgz>
- <https://registry.npmjs.org/@fortawesome/fontawesome-free/-/fontawesome-free-6.4.0.tgz>

`vendor/UPSTREAM-SHA256SUMS` records the downloaded archive identities. Original
license files accompany the redistributed assets. When updating, extract only
the minified distributions, Font Awesome CSS/webfonts and licenses, retain the
versioned filenames used in the HTML, regenerate both checksum lists, and
produce a sorted tar with numeric owner/group zero and mtime zero, update
`web-vendor.tar.gz.sha256` and the test, and rerun both labs' browser checks.
