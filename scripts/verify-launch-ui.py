#!/usr/bin/env python3
"""Refuse a Hub release that reintroduces machine-wide errors on NewSession.

Run after Hub readiness. No credentials, database writes or session creation.
Component tests cover semantics; this checks the bytes actually being served.
"""
import argparse
import re
import time
import urllib.request


def verify(base):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def read(path):
        with opener.open(base.rstrip('/') + path, timeout=5) as response:
            return response.read(16 * 1024 * 1024).decode('utf-8')
    html = read('/')
    scripts = re.findall(r'(?:src|href)="(/assets/[^"?]+\.js)"', html)
    if not scripts:
        raise ValueError('No application script found')
    bundles = '\n'.join(read(path) for path in scripts)
    if 'Runner last spawn error:' in bundles:
        raise ValueError('Historical runner failure is rendered on NewSession')
    if 'Previous session launch failure' not in bundles:
        raise ValueError('Historical machine diagnostics are absent from this release')
    if r'(?<=^|\s|\p{P}|\p{S})' in bundles:
        raise ValueError('iOS 15 incompatible GFM email lookbehind is present')
    if r'(^|[\s\p{P}\p{S}])' not in bundles:
        raise ValueError('Required iOS 15 GFM compatibility implementation is absent')
    return scripts


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://[::1]:3006')
    parser.add_argument('--wait-seconds', type=float, default=0)
    args = parser.parse_args()
    deadline = time.monotonic() + args.wait_seconds
    while True:
        try:
            scripts = verify(args.url)
            print('Launch UI release check passed: ' + ', '.join(scripts))
            break
        except (OSError, ValueError) as error:
            if time.monotonic() >= deadline:
                raise SystemExit('Launch UI release check FAILED: ' + str(error))
            time.sleep(1)
