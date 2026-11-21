#!/usr/bin/env python3
"""App Store Connect helper for AttendWell iPad: upload an archive and add a build to a TestFlight group.

The API key never lives in this repo or on disk between runs. It arrives from Bitwarden Secrets Manager
(project agentdev) for this one process, either as ASC_API_KEY_JSON = {"keyId","issuerId","p8"} or as three
variables, one secret per nested run:

  B=bws_manager.py
  $B run --secret-id <APPSTORE_CONNECT_API_RELEASE _MANAGER> --as ASC_KEY_P8 -- \
    $B run --secret-id <APPSTORE_CONNECT_API_KEY_ID> --as ASC_KEY_ID -- \
    $B run --secret-id <APPSTORE_CONNECT_API_ISSUER_ID> --as ASC_ISSUER_ID -- python3 ipad/iPad/asc.py <command> ...

ipad/iPad/asc-run.sh wraps this.

Commands
  check                                   sign in and print the app's name (proves the key works)
  upload <archive.xcarchive>              export and upload with the key (key file exists only during the upload)
  add <version> <build> [--group NAME]    wait until the build is processed, then add it to the group (default AttendWell)
  status <version> <build>                print the build's processing state
"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request, urllib.parse, urllib.error

import jwt  # PyJWT, ES256 via cryptography

BUNDLE_ID = "net.dominiklukes.attendwell.ipad"
API = "https://api.appstoreconnect.apple.com/v1"
HERE = os.path.dirname(os.path.abspath(__file__))


def pem(p8):
    """Accepts a full .p8 PEM or just its base64 body (lines possibly joined by spaces)."""
    if "BEGIN PRIVATE KEY" in p8:
        return p8
    body = "".join(p8.split())
    head, tail = ("-----%s PRIVATE KEY-----" % w for w in ("BEGIN", "END"))  # built, so no PEM block sits in source
    return head + "\n" + "\n".join(body[i:i + 64] for i in range(0, len(body), 64)) + "\n" + tail + "\n"


def key():
    raw = os.environ.get("ASC_API_KEY_JSON")
    if raw:
        k = json.loads(raw)
    else:
        k = {"keyId": os.environ.get("ASC_KEY_ID", "").strip(), "issuerId": os.environ.get("ASC_ISSUER_ID", "").strip(),
             "p8": os.environ.get("ASC_KEY_P8", "")}
        if not k["p8"]:
            sys.exit("Set ASC_API_KEY_JSON, or ASC_KEY_P8 + ASC_KEY_ID + ASC_ISSUER_ID, through bws_manager.py run")
    k["p8"] = pem(k["p8"])
    for f in ("keyId", "issuerId", "p8"):
        if not k.get(f):
            sys.exit(f"ASC_API_KEY_JSON lacks {f}")
    return k


def token(k):
    now = int(time.time())
    return jwt.encode({"iss": k["issuerId"], "iat": now, "exp": now + 15 * 60, "aud": "appstoreconnect-v1"},
                      k["p8"], algorithm="ES256", headers={"kid": k["keyId"], "typ": "JWT"})


def call(k, method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + token(k), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
            return json.loads(data) if data else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:600]
        sys.exit(f"App Store Connect {method} {path.split('?')[0]} failed: HTTP {e.code} {detail}")


def app_id(k):
    r = call(k, "GET", "/apps?" + urllib.parse.urlencode({"filter[bundleId]": BUNDLE_ID}))
    if not r.get("data"):
        sys.exit(f"No app with bundle id {BUNDLE_ID} is visible to this key")
    return r["data"][0]["id"], r["data"][0]["attributes"]["name"]


def find_build(k, aid, version, build):
    q = urllib.parse.urlencode({"filter[app]": aid, "filter[version]": build,
                                "filter[preReleaseVersion.version]": version, "limit": 5})
    r = call(k, "GET", "/builds?" + q)
    return r["data"][0] if r.get("data") else None


def cmd_upload(k, archive):
    d = tempfile.mkdtemp(prefix="asc-key-")
    try:
        os.chmod(d, 0o700)
        p = os.path.join(d, f"AuthKey_{k['keyId']}.p8")
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(k["p8"])
        out = os.path.join(os.path.dirname(os.path.abspath(archive)), "export-asc")
        env = dict(os.environ, PATH="/usr/bin:/bin:/usr/sbin:/sbin")
        for v in ("ASC_API_KEY_JSON", "ASC_KEY_P8", "ASC_KEY_ID", "ASC_ISSUER_ID"):
            env.pop(v, None)
        rc = subprocess.call(["xcodebuild", "-exportArchive", "-archivePath", archive,
                              "-exportOptionsPlist", os.path.join(HERE, "ExportOptions-appstore.plist"),
                              "-exportPath", out, "-allowProvisioningUpdates",
                              "-authenticationKeyPath", p, "-authenticationKeyID", k["keyId"],
                              "-authenticationKeyIssuerID", k["issuerId"]], env=env)
        sys.exit(rc)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def cmd_add(k, version, build, group):
    aid, _ = app_id(k)
    deadline = time.time() + 45 * 60
    while True:
        b = find_build(k, aid, version, build)
        state = b["attributes"]["processingState"] if b else "NOT_FOUND"
        print(f"{version} ({build}): {state}", flush=True)
        if state == "VALID":
            break
        if state in ("FAILED", "INVALID"):
            sys.exit(f"Build {version} ({build}) is {state}; it cannot be tested")
        if time.time() > deadline:
            sys.exit("Gave up after 45 minutes waiting for Apple to process the build")
        time.sleep(60)
    g = call(k, "GET", "/betaGroups?" + urllib.parse.urlencode({"filter[app]": aid, "filter[name]": group}))
    if not g.get("data"):
        sys.exit(f"No TestFlight group named {group!r}")
    gid = g["data"][0]["id"]
    call(k, "POST", f"/betaGroups/{gid}/relationships/builds", {"data": [{"type": "builds", "id": b["id"]}]})
    print(f"Added {version} ({build}) to TestFlight group {group}.")


def main(argv):
    if not argv:
        sys.exit(__doc__)
    k = key()
    c = argv[0]
    if c == "check":
        aid, name = app_id(k)
        print(f"Key works: {name}")
    elif c == "upload" and len(argv) == 2:
        cmd_upload(k, argv[1])
    elif c == "add" and len(argv) >= 3:
        group = argv[argv.index("--group") + 1] if "--group" in argv else "AttendWell"
        cmd_add(k, argv[1], argv[2], group)
    elif c == "status" and len(argv) == 3:
        aid, _ = app_id(k)
        b = find_build(k, aid, argv[1], argv[2])
        print(b["attributes"]["processingState"] if b else "NOT_FOUND")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
