---
title: Roster import format
type: reference
status: current
---
# Roster import format

The register imports one normalised JSON file. Any booking system can feed it through a small converter. The import happens in one transaction and runs these checks:

```json
{
  "sessionId": "example-session-001",
  "date": "2030-01-15",
  "source": {"filename": "export.csv", "sha256": "<64 hex characters>", "exportedAt": "2030-01-10T09:00:00Z"},
  "participants": [
    {"id": "booking-0001", "name": "Alex Example", "email": "alex@example.org", "booking": "confirmed", "sourceStatus": "Confirmed"}
  ]
}
```

- `sessionId` and `date` must equal the workshop file.
- `source` records provenance: the original file name, its SHA-256 checksum, and when it was downloaded. All three are required.
- Each participant needs a unique, stable `id` (up to 100 characters) and a non-empty `name`. `email` may be empty.
- `sourceStatus` must be a label in the workshop's `sourceStatuses`, and `booking` must be the value that label maps to. `Manual addition` is reserved for people the organiser adds.
- An import holds 1–500 records.

On re-import, attendance is never inferred or erased. Changed rows update. Missing rows become inactive but recoverable. Organiser additions are kept. A booking-status change revokes a waiting-list admission.

See `examples/roster.example.json` for a fictional file that imports under `examples/workshop.example.json`.

## Adding a name list (desktop app)

The desktop app adds a pasted or imported list next to the people already in the register, through `POST /api/names` on the organiser listener (owner only; refused in the fictional preview). The body is `{source:{kind:'paste'|'file', filename?, sha256?}, rows:[{row, name, email, status?, date?}], dryRun}`, at most 2000 rows; `date` is `YYYY-MM-DD` as the app read it. The answer is `{plan, written, roster}`. The rules live in `server/names-list.ts` and run inside the write's transaction, so the preview (`dryRun: true`) is what the write does:

- People merge by email only: trimmed, case-insensitive, plus addresses kept distinct. Never by name alone. A row with the email of someone already in the register is `known` and not added; a second row with the same email as an earlier row is `merged` into it.
- Rows are skipped with a reason: no name, a name over 200 characters, an email address that is not valid, a cancelled booking, a date other than the workshop's, or a booking status the workshop has no label for.
- A booking status matches a workshop label first; otherwise cancelled, withdrawn, declined or refunded is cancelled, anything with "wait" is the waiting list, and anything else (blank included) is a confirmed place.
- The same list again (the same rows, however pasted or saved) changes nothing: 409. Every list's key is kept in `metadata` key `name-list-keys`, never truncated (each write adds at least one person), so the first list is still recognised after any number of later ones.
- The register holds at most 500 people: 409 past that.
- Attendance is never touched. Ids are `list-` plus a keyed hash of the email (the same person from a later list is the same record), or a random id when there is no email.
- What is kept about each list is its provenance, never a copy: `metadata` key `name-lists` (the last 100 lists) (kind, file name, the file's checksum, when, and the counts), also returned as `nameLists` by `GET /api/roster`.

A later full JSON import replaces the list as before, including people added from a pasted list (they become inactive, recoverable records).

## Optional CoSy adapter

`scripts/convert-cosy-roster.py` converts a CoSy XLSX export. It reads only the columns `User Fullname`, `User Email`, `Start Date` and `Status`. It takes the session ID, date, start time and status labels from the workshop file:

```sh
python3 scripts/convert-cosy-roster.py private-export.xlsx ~/workshop-private/roster-v1.json \
  --workshop examples/workshop.cosy-adapter.example.json --exported-at 2030-01-10T09:00:00Z
```

- `sourceStatuses` must list CoSy's labels (`Booked`, `Cancelled`, `Waiting List`); `examples/workshop.cosy-adapter.example.json` shows the mapping.
- The adapter stops on an unknown status, a start date that differs from the workshop, a missing name, or duplicate keys.
- IDs are derived from the session, email and name, because the export has no booking IDs.
- The output file is created with mode 600 and never overwrites an existing file.
- Keep both the export and the output outside the repository.
