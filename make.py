#!/usr/bin/env python3
import io
import json
import os.path
import requests
import sys
import zipfile
from subprocess import check_call

def build(cwd):
    check_call(['yarn', 'install', '--non-interactive'], cwd=cwd)
    check_call(['yarn', 'tsc'], cwd=cwd)
    try:
        make_data = json.load(open(cwd + '/make.json', 'r'))
    except:
        make_data = {}

    externals = make_data.get('externals', {})
    for pkg in externals.get('archivePackages', []):
        zf = zipfile.ZipFile(io.BytesIO(requests.get(pkg['url']).content))
        for member in zf.filelist:
            bad = False
            for c in member.filename:
                if c in ' #^[]<>?%':
                    print(f'WARN: ignoring {member.filename} because it ' + \
                        'contains a disallowed character.')
                    bad = True
                    break
            if bad: continue
            if member.filename.endswith('.'):
                print(f'WARN: ignoring {member.filename} because it ended with a period')
                continue

            zf.extract(member, path=cwd + '/' + pkg['dest'])

def test(cwd):
    check_call(['mocha', 'tests/_suite.js'], cwd=cwd)

def main():
    if len(sys.argv) < 2:
        print('Usage: make.py {build|test}')
        exit(2)
    cmd = sys.argv[1]
    cmds = {
        'build': build,
        'test': test,
    }
    if cmd in cmds:
        cmd = cmds[cmd]
    else:
        print(f'Illegal command: {cmd}')
        exit(2)

    with open('vss-extension.json') as f:
        for dir in json.load(f)['files']:
            cmd(dir['path'])

if __name__ == '__main__':
    main()
