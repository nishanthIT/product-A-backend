#!/usr/bin/env python3
"""Redacted credential scan of source and optional Git history; never prints matches.
Run from each repository: python3 scripts/security_scan.py [--history]
This small offline guard supplements a provider secret scanner and rotation.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

RULES = {
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'aws-access-key': re.compile(r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b'),
    'github-token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b'),
    'jwt': re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b'),
    'url-credentials': re.compile(r'\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?|amqps?)://[^\s:@/]+:([^\s@/]+)@[^\s/]+'),
    'secret-assignment': re.compile(r'''(?m)^\s*(?:export\s+)?(?:[A-Z][A-Z0-9_]*_)?(?:SECRET|PASSWORD|PASS|API_KEY|ACCESS_TOKEN|PRIVATE_KEY|AUTH_TOKEN|CLIENT_SECRET|ACCESS_KEY_ID|SECRET_ACCESS_KEY)\s*[:=]\s*["']?([^\r\n"'#]{8,})'''),
    'quoted-secret': re.compile(r'''(?i)\b(?:secret|password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']([A-Za-z0-9_+/-]{20,})["']'''),
}
PLACEHOLDER = re.compile(r'(?i)(example|replace|changeme|your[-_]|development|fixture|sample|placeholder|redacted|process\.env|os\.environ|\$\{|^test[-_]|^x+$|^<|\bundefined\b)')
SKIP_PARTS = {'node_modules', '.git', 'dist', '.expo', '.private-backups', 'release-artifacts'}
MAX_BYTES = 2_000_000

def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL)

def eligible(path):
    return not any(part in SKIP_PARTS for part in Path(path).parts) and not path.endswith(('.lock', 'lock.json', '.map', '.png', '.jpg', '.webp', '.pdf', '.mp4', '.ipa', '.aab'))

def findings(data, path, source):
    if b'\x00' in data: return []
    text = data.decode('utf-8', errors='replace')
    results = []
    for category, pattern in RULES.items():
        for match in pattern.finditer(text):
            value = match.group(1) if match.lastindex else match.group(0)
            if PLACEHOLDER.search(value): continue
            # Route constants such as RESET_PASSWORD: '/auth/reset-password' are not credentials.
            if category == 'secret-assignment' and re.fullmatch(r'/[a-z0-9_./:-]+,?', value): continue
            if category == 'url-credentials' and re.search(r'@(localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$)', match.group(0)): continue
            results.append({'path': path, 'line': text[:match.start()].count('\n') + 1, 'category': category, 'source': source})
    return results

def scan(history=False):
    results = []
    skipped = 0
    files = set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\x00')) - {''}
    for file in sorted(files):
        path = Path(file)
        if not eligible(file) or not path.is_file() or path.is_symlink(): continue
        if path.stat().st_size > MAX_BYTES:
            skipped += 1; continue
        results.extend(findings(path.read_bytes(), file, 'working-tree'))
    blobs = 0
    if history:
        for entry in git('rev-list', '--objects', '--all').decode().splitlines():
            oid, _, path = entry.partition(' ')
            if not path or not eligible(path): continue
            info = git('cat-file', '-t', oid).strip()
            if info != b'blob': continue
            size = int(git('cat-file', '-s', oid))
            if size > MAX_BYTES:
                skipped += 1; continue
            blobs += 1
            results.extend(findings(git('cat-file', 'blob', oid), path, 'history:' + oid[:12]))
    return {'findings': results, 'historyBlobsScanned': blobs, 'oversizedFilesSkipped': skipped}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--history', action='store_true')
    args = parser.parse_args()
    try:
        report = scan(args.history)
        print(json.dumps(report, indent=2))
        raise SystemExit(1 if report['findings'] else 0)
    except subprocess.CalledProcessError:
        print(json.dumps({'error': 'Git inventory unavailable; scan did not complete.'}))
        raise SystemExit(2)
