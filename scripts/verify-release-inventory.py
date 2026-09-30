#!/usr/bin/env python3
"""Validate a reviewed release receipt before starting HAPI.

This checks provenance and byte identity, not test semantics. Record 'passed'
only after running the named checks; keep their evidence with the receipt.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

REQUIRED_CHECKS = (
    'ios15-gfm', 'new-session-error-scope', 'codex-startup-budgets',
    'history-preflight', 'clock-replay-sse', 'shared-codex-transport',
    'typechecks', 'compiled-canary', 'live-new-session',
)
COMPONENTS = ('hub', 'cli', 'rollbackHub', 'rollbackCli')


def verify(receipt):
    doc = json.loads(Path(receipt).read_text())
    if doc.get('schema') != 'hapi-release-inventory/v1':
        raise ValueError('Unsupported release receipt')
    if not re.fullmatch(r'[0-9a-f]{40}', doc.get('sourceCommit', '')):
        raise ValueError('Release source must be an immutable commit')
    checks = doc.get('checks', {})
    for name in REQUIRED_CHECKS:
        if checks.get(name) != 'passed':
            raise ValueError(f'Required regression check not passed: {name}')
    artifacts = doc.get('artifacts', {})
    checked = []
    for name in COMPONENTS:
        item = artifacts.get(name, {})
        path = Path(item.get('path', ''))
        expected = item.get('sha256', '')
        if not path.is_absolute() or not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise ValueError(f'Invalid artifact identity: {name}')
        with path.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != expected:
            raise ValueError(f'Artifact drift: {name}: {path}')
        checked.append(name)
    return checked


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('receipt')
    args = parser.parse_args()
    try:
        print('Release inventory PASS: ' + ', '.join(verify(args.receipt)))
    except (OSError, ValueError, TypeError, AttributeError) as error:
        raise SystemExit('Release inventory FAILED: ' + str(error))
