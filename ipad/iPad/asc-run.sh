#!/bin/bash
# Runs asc.py with the App Store Connect API key from Bitwarden Secrets Manager (project agentdev),
# one secret per nested run, looked up by name. Example: ipad/iPad/asc-run.sh check
set -euo pipefail
B="$(ls -d "$HOME"/gitrepos/_SKILLS/skills/*/bws-secrets-manager | head -1)/scripts/bws_manager.py"
id() { python3 "$B" list-secrets --project-name agentdev | awk -v n="$1" '$0==n{getline; sub(/^ *ID: */,""); print; exit}'; }
P8="$(id 'APPSTORE_CONNECT_API_RELEASE _MANAGER')"; KID="$(id APPSTORE_CONNECT_API_KEY_ID)"; ISS="$(id APPSTORE_CONNECT_API_ISSUER_ID)"
[ -n "$P8" ] && [ -n "$KID" ] && [ -n "$ISS" ] || { echo "App Store Connect secrets not found in agentdev" >&2; exit 2; }
exec python3 "$B" run --secret-id "$P8" --as ASC_KEY_P8 -- \
  python3 "$B" run --secret-id "$KID" --as ASC_KEY_ID -- \
  python3 "$B" run --secret-id "$ISS" --as ASC_ISSUER_ID -- \
  python3 "$(cd "$(dirname "$0")" && pwd)/asc.py" "$@"
