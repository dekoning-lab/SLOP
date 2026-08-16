#!/bin/bash
#
# Regenerate slop.css from the Tailwind classes used in index.html.
#
# The app previously pulled cdn.tailwindcss.com, which ships a full compiler and
# builds the stylesheet in the browser on every page load. Extracting the ~1700
# class tokens actually used produces a ~23KB static file instead of a ~127KB
# script plus runtime compilation, with byte-identical rendering.
#
# Run this after adding or changing any Tailwind class in index.html.
# Requires npx (Node.js); it fetches the Tailwind CLI on demand.

set -euo pipefail
cd "$(dirname "$0")"

TAILWIND_VERSION="3.4.17"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/tailwind.config.js" <<EOF
module.exports = {
  content: ['$PWD/index.html'],
  theme: { extend: {} },
  plugins: [],
};
EOF

printf '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' > "$work/in.css"

echo "Generating slop.css with Tailwind ${TAILWIND_VERSION}..."
npx --yes "tailwindcss@${TAILWIND_VERSION}" \
    -c "$work/tailwind.config.js" \
    -i "$work/in.css" \
    -o slop.css \
    --minify

echo "Wrote slop.css ($(wc -c < slop.css | tr -d ' ') bytes)"
