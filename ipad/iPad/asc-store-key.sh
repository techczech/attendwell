#!/bin/bash
# Stores a downloaded App Store Connect API key (AuthKey_<KEYID>.p8) in Bitwarden Secrets Manager as one
# secret, ASC_API_KEY_JSON = {"keyId","issuerId","p8"}, without printing it. The value travels on stdin only.
#   asc-store-key.sh <path/to/AuthKey_KEYID.p8> <issuer-id>
# Afterwards prove it with: bws_manager.py run --secret-id <uuid> --as ASC_API_KEY_JSON -- python3 ipad/iPad/asc.py check
set -euo pipefail
p8="$1"; issuer="$2"
bws="$(ls -d "$HOME"/gitrepos/_SKILLS/skills/*/bws-secrets-manager | head -1)/scripts/bws_manager.py"
base="$(basename "$p8")"; kid="${base#AuthKey_}"; kid="${kid%.p8}"
[ -n "$kid" ] && [ "$kid" != "$base" ] || { echo "Expected a file named AuthKey_<KEYID>.p8" >&2; exit 2; }
python3 -c 'import json,sys; print(json.dumps({"keyId":sys.argv[1],"issuerId":sys.argv[2],"p8":open(sys.argv[3]).read()}))' "$kid" "$issuer" "$p8" \
  | python3 "$bws" ensure-secret --project-name apple-developer --key ASC_API_KEY_JSON \
      --note "App Store Connect API key $kid (App Manager), for TestFlight uploads and group assignment" --from-stdin
