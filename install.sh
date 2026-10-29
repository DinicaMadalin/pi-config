#!/bin/sh
# Copies the portable Pi config from this clone into the Pi agent directory,
# then installs the npm extension packages declared in settings.json.
# Safe to re-run after every `git pull`.
set -eu

repo_dir=$(cd "$(dirname "$0")" && pwd)
agent_dir=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}

if [ "$repo_dir/agent" = "$agent_dir" ]; then
	echo "This clone is the live agent directory already; nothing to copy."
	exit 0
fi

if [ ! -d "$agent_dir" ]; then
	echo "Pi agent directory $agent_dir not found. Install Pi first:" >&2
	echo "  curl -fsSL https://pi.dev/install.sh | sh" >&2
	exit 1
fi

mkdir -p "$agent_dir/extensions"
cp "$repo_dir/agent/AGENTS.md" "$repo_dir/agent/settings.json" "$agent_dir/"
cp "$repo_dir/agent/extensions/guardrails.json" "$agent_dir/extensions/"
# Replace each directory whole so files deleted upstream disappear here too.
for extension_name in auto-model quality-gate project-memory; do
	rm -rf "$agent_dir/extensions/$extension_name"
	cp -R "$repo_dir/agent/extensions/$extension_name" "$agent_dir/extensions/"
done
echo "Copied config into $agent_dir"

pi_bin="$agent_dir/bin/pi"
if [ -x "$pi_bin" ]; then
	"$pi_bin" update --extensions
else
	echo "Pi launcher $pi_bin not found; run 'pi update --extensions' yourself." >&2
fi

key_file="$agent_dir/secrets/typesafe_api_key"
if [ -z "${TYPESAFE_API_KEY:-}" ] && [ ! -s "$key_file" ]; then
	echo
	echo "Missing TypeSafe Jev API key: auto-model routing and the jev tools need it."
	echo "  mkdir -p $agent_dir/secrets && printf '%s' 'YOUR_KEY' > $key_file"
fi
