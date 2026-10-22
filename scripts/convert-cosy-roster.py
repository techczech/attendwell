"""Optional adapter: convert a CoSy booking XLSX export to the normalised roster import.

Driven by the workshop configuration: session ID, date, start time and the source-status map come from
the same JSON file the service uses, so the output passes the service's own import checks.
Only the columns User Fullname, User Email, Start Date and Status are read. Standard library only.
"""
import argparse, datetime, hashlib, json, re, xml.etree.ElementTree as ET, zipfile
from pathlib import Path
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
BOOKINGS = {'confirmed', 'cancelled', 'waiting'}

def read_rows(path):
    with zipfile.ZipFile(path) as z:
        strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            strings = [''.join(i.itertext()) for i in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS)]
        rows = []
        for row in ET.fromstring(z.read('xl/worksheets/sheet1.xml')).findall('.//m:row', NS):
            fields = {}
            for cell in row.findall('m:c', NS):
                column = re.match(r'[A-Z]+', cell.get('r', '')).group()
                value = cell.find('m:v', NS)
                if cell.get('t') == 's': value = strings[int(value.text)]
                elif cell.get('t') == 'inlineStr': value = ''.join(cell.find('m:is', NS).itertext())
                else: value = value.text if value is not None else ''
                fields[column] = value
            rows.append(fields)
        return rows

def load_workshop(path):
    workshop = json.loads(Path(path).read_text())
    for key in ('sessionId', 'date'):
        if not isinstance(workshop.get(key), str) or not workshop[key]: raise ValueError(f'Workshop configuration needs "{key}".')
    workshop.setdefault('startTime', '13:00')
    statuses = workshop.get('sourceStatuses')
    if not isinstance(statuses, dict) or not statuses or any(v not in BOOKINGS for v in statuses.values()):
        raise ValueError('Workshop configuration needs "sourceStatuses" mapping each CoSy status (for example "Booked") to confirmed, cancelled or waiting.')
    return workshop

def session_start(workshop):
    return datetime.datetime.fromisoformat(f"{workshop['date']}T{workshop['startTime']}")

def matches_start(value, start):
    # CoSy writes either the text DD/MM/YYYY HH:MM or a spreadsheet serial number.
    if value == start.strftime('%d/%m/%Y %H:%M'): return True
    try: serial = datetime.datetime(1899, 12, 30) + datetime.timedelta(days=float(value))
    except ValueError: raise ValueError('Wrong or unreadable session date.')
    return abs((serial - start).total_seconds()) < 60

def convert(path, exported_at, workshop):
    rows = read_rows(path)
    if not rows: raise ValueError('The export is empty.')
    headers = rows[0]
    required = ['User Fullname', 'User Email', 'Start Date', 'Status']
    if any(value not in headers.values() for value in required): raise ValueError('Missing required CoSy columns.')
    columns = {value: key for key, value in headers.items()}
    statuses, start, session = workshop['sourceStatuses'], session_start(workshop), workshop['sessionId']
    people = []
    for row in rows[1:]:
        if not any(row.values()): continue
        status = row.get(columns['Status'], '')
        if status not in statuses: raise ValueError('A booking status is not in the workshop "sourceStatuses": import stopped.')
        if not matches_start(row.get(columns['Start Date'], ''), start): raise ValueError('Wrong session date.')
        name = row.get(columns['User Fullname'], '').strip()
        email = row.get(columns['User Email'], '').strip().lower()
        if not name: raise ValueError('Missing name: import stopped.')
        # The export has no delegate IDs. A stable session+email+name key keeps separate bookings;
        # email deduplication happens only in recipient export, never by guessing identity.
        identifier = hashlib.sha256((session + '\0' + email + '\0' + name.casefold()).encode()).hexdigest()[:24]
        people.append({'id': identifier, 'name': name, 'email': email, 'booking': statuses[status], 'sourceStatus': status})
    if len({p['id'] for p in people}) != len(people): raise ValueError('Duplicate booking keys require manual reconciliation.')
    return {'sessionId': session, 'date': workshop['date'], 'source': {'filename': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'exportedAt': exported_at}, 'participants': people}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('source', type=Path, help='CoSy XLSX export (private; keep outside the repository).')
    parser.add_argument('destination', type=Path, help='New normalised JSON file (private; keep outside the repository).')
    parser.add_argument('--workshop', required=True, type=Path, help='Workshop configuration JSON used by the service.')
    parser.add_argument('--exported-at', required=True, help='Original download timestamp, ISO 8601.')
    args = parser.parse_args()
    datetime.datetime.fromisoformat(args.exported_at.replace('Z', '+00:00'))
    if args.destination.exists(): raise SystemExit('Destination already exists; use a new versioned output.')
    data = convert(args.source, args.exported_at, load_workshop(args.workshop))
    args.destination.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    args.destination.chmod(0o600)
    counts = {booking: sum(p['booking'] == booking for p in data['participants']) for booking in sorted(BOOKINGS)}
    print(json.dumps({'records': len(data['participants']), 'status_counts': counts, 'destination': str(args.destination)}))
