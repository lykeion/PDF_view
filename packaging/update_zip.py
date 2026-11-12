import hashlib
import json
from pathlib import Path
import sys
import zipfile

root, records, target = map(Path, sys.argv[1:])
items = json.loads(records.read_text(encoding='utf-8'))
pending = target.with_suffix('.building.zip')
with zipfile.ZipFile(pending, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for item in items:
        source = root / item['path']
        if not source.resolve().is_relative_to(root.resolve()) or source.is_symlink():
            raise RuntimeError('Invalid release path')
        archive.write(source, item['path'])
with zipfile.ZipFile(pending) as archive:
    if len(archive.namelist()) != len(items):
        raise RuntimeError('Wrong ZIP entry count')
    for item in items:
        data = archive.read(item['path'])
        if len(data) != item['size'] or hashlib.sha256(data).hexdigest() != item['sha256']:
            raise RuntimeError('Release verification failed')
pending.replace(target)
