# Source of these fixtures

Copied unchanged from the iPad contract in `ipad/contract/device-v1/` (an earlier revision of it: `pairing.md` here still
describes the five-line organiser proof). The contract authority is the `ipad/contract/` folder; do not edit these copies.
Re-copy them when the contract changes.
`tests/device-contract.test.ts` checks the host's responses against their shapes.

One file is **not** a copy: `hello-reply-organiser-proof-origin-bound.example.json` was written here for the contract change
that binds the organiser proof to the participant origin (six signed lines instead of five). It is also in `ipad/contract/device-v1/`, which no longer has the
five-line `pairing-offer-organiser-proof.example.json`. Here `pairing-offer-organiser-proof.example.json` is the five-line proof, still checked here as the byte-level framing.

The roster carries no `cursor`: `pairing.md` at this commit names `rosterVersion` as the change token, compared for equality only
(the iPad accepts 1–128 characters of `[A-Za-z0-9._~-]`).
