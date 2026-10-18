#!/usr/bin/env python3
"""Fake wdev manager CLI for route tests.

Implements the manager contract surface the proxy routes depend on:
  wdev.py --home <home> components
  wdev.py --home <home> submit --component C --action A --request-json J --dispatch
  wdev.py --home <home> operation <uuid>
Behaviour is steered by FAKE_WDEV_MODE so one fixture covers every failure class:
  ok        default inventory/submit/operation flow
  badjson   prints non-JSON on stdout
  huge      prints > the output cap
  fail2     exits 2 with a secret-bearing stderr
  slow      sleeps past the CLI timeout
"""
import json, os, sys, time, uuid

mode = os.environ.get('FAKE_WDEV_MODE', 'ok')
argv = sys.argv[1:]

def expect_home():
    # --home must be present and first-pair; the proxy builds a fixed argv shape.
    if len(argv) >= 2 and argv[0] == '--home' and argv[1]:
        return argv[2:]
    print(json.dumps({'error': 'missing --home'}), file=sys.stderr)
    sys.exit(3)

def main():
    args = expect_home()
    verb = args[0] if args else ''
    if mode == 'badjson':
        print('not json at all {{{')
        return
    if mode == 'huge':
        print('x' * (400 * 1024))
        return
    if mode == 'fail2':
        print('boom x-opencodex-api-key: SUPERSECRET-xyz', file=sys.stderr)
        sys.exit(2)
    if mode == 'slow':
        time.sleep(6)
        return
    if verb == 'components':
        print(json.dumps({'components': [
            {'id': 'web', 'unit': 'wdev.service', 'url': 'http://127.0.0.1:3737',
             'status': 'active', 'releaseId': '2026.10.18.090849', 'configRevision': 7, 'secret': 'leak'},
            {'id': 'llm-proxy', 'unit': 'wdev-proxy.service', 'url': 'http://127.0.0.1:10100',
             'status': 'inactive', 'releaseId': '2.87.0-fork', 'configRevision': 3},
        ]}))
        return
    if verb == 'submit':
        request_json = None
        i = 1
        while i < len(args):
            a = args[i]
            if a == '--request-json':
                request_json = json.loads(args[i + 1])
                i += 2
                continue
            if a in ('--component', '--action'):
                i += 2
                continue
            # The frozen parser's submit group: --dispatch (default True) and
            # --no-dispatch are mutually exclusive and both accepted; anything else is
            # a hard usage failure, so a proxy build that invented a flag fails here
            # exactly as it would against the real manager.
            # FAKE_WDEV_MODE=no_dispatch_flag simulates an older manager build whose
            # parser predates the flag: --dispatch is then an unknown argument.
            if a in ('--dispatch', '--no-dispatch'):
                if a == '--dispatch' and mode == 'no_dispatch_flag':
                    print(json.dumps({'error': 'unrecognized argument: --dispatch'}), file=sys.stderr)
                    sys.exit(2)
                i += 1
                continue
            print(json.dumps({'error': 'unrecognized argument: ' + a}), file=sys.stderr)
            sys.exit(2)
        if request_json is None:
            print(json.dumps({'error': 'bad submit'}), file=sys.stderr)
            sys.exit(3)
        # The durable-write contract: the real manager fsyncs its ledger FILE (a real
        # fd) before printing. fsync on a captured stdout pipe raises OSError, so the
        # fake persists a ledger file first, then prints. The test harness points
        # FAKE_WDEV_LEDGER at a temp dir; the fallback keeps a bare invocation working.
        ledger_path = os.environ.get('FAKE_WDEV_LEDGER') or os.path.join(
            os.environ.get('TEMP', '/tmp'), 'wdev-manager-fake-ledger.jsonl')
        op_id = os.environ.get('FAKE_WDEV_OP_ID', str(uuid.uuid4()))
        with open(ledger_path, 'a') as fh:
            fh.write(json.dumps({'operationId': op_id, 'request': request_json}) + '\n')
            fh.flush()
            os.fsync(fh.fileno())
        print(json.dumps({'operationId': op_id, 'state': 'queued', 'request': request_json}))
        return
    if verb == 'operation':
        op = args[1]
        # Mirrors the real manager's ledger record: key "component", live status in
        # state+phase, ISO timestamps.
        print(json.dumps({'operationId': op, 'component': 'web', 'action': 'restart',
                          'state': 'succeeded', 'phase': 'succeeded',
                          'expectedRevision': 7, 'newRevision': 8,
                          'createdAt': '2026-10-18T12:00:00Z',
                          'updatedAt': '2026-10-18T12:00:05Z'}))
        return
    print(json.dumps({'error': 'unknown verb'}), file=sys.stderr)
    sys.exit(4)

main()
