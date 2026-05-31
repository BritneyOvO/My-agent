from __future__ import annotations

import argparse
import json
import traceback
from typing import Any

from .models import Credentials, PlatformConfig, to_plain
from .registry import create_client, list_platforms, registry


def emit(data: Any, pretty: bool = True) -> None:
    print(json.dumps(to_plain(data), ensure_ascii=False, indent=2 if pretty else None))


def emit_error(exc: BaseException, pretty: bool = True, debug: bool = False) -> None:
    """Emit platform/runtime failures as stable JSON instead of a traceback.

    The CLI is part of the framework's upper layer.  It should expose the same
    predictable shape for every platform, while the adapter/vendor can still
    raise native exceptions internally.
    """
    payload: dict[str, Any] = {
        "ok": False,
        "error": {
            "type": exc.__class__.__name__,
            "message": str(exc),
        },
    }
    if debug:
        payload["error"]["traceback"] = traceback.format_exc()
    emit(payload, pretty)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ctf-platform", description="Unified CTF platform management CLI")
    p.add_argument("--platform", "-p", help="platform key, e.g. ctfd/gzctf/nssctf/adworld/ctfplus")
    p.add_argument("--base-url", help="platform base URL where applicable")
    p.add_argument("--session-file", help="session cache path")
    p.add_argument("--token", help="authentication token; adapter maps it to the platform token mechanism")
    p.add_argument("--timeout", type=int, default=20)
    p.add_argument("--insecure", action="store_true", help="disable TLS verification")
    p.add_argument("--debug", action="store_true")
    p.add_argument("--no-auto-load", action="store_true", help="do not auto-load session before authenticated commands")
    p.add_argument("--compact", action="store_true")

    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("platforms", help="list registered platforms")
    sub.add_parser("probe")

    login = sub.add_parser("login")
    login.add_argument("--token", dest="login_token", help="token for token authentication; same semantics as global --token")
    login.add_argument("--username", "-u")
    login.add_argument("--password", "-P")
    login.add_argument("--no-remember", action="store_true")
    login.add_argument("--captcha-token")

    sub.add_parser("session-load")
    sub.add_parser("session-save")
    sub.add_parser("me")

    contests = sub.add_parser("contests")
    contests.add_argument("--page", type=int, default=1)
    contests.add_argument("--page-size", type=int, default=50)
    contests.add_argument("--search")

    contest = sub.add_parser("contest")
    contest.add_argument("contest_id")

    join = sub.add_parser("join")
    join.add_argument("contest_id")
    join.add_argument("--team-id")
    join.add_argument("--invite-code")

    challenges = sub.add_parser("challenges")
    challenges.add_argument("--contest-id")
    challenges.add_argument("--page", type=int, default=1)
    challenges.add_argument("--page-size", type=int, default=50)
    challenges.add_argument("--search")

    challenge = sub.add_parser("challenge")
    challenge.add_argument("challenge_id")
    challenge.add_argument("--contest-id")

    download = sub.add_parser("download")
    download.add_argument("challenge_id")
    download.add_argument("--contest-id")
    download.add_argument("--outdir", default="downloads")

    submit = sub.add_parser("submit")
    submit.add_argument("challenge_id")
    submit.add_argument("flag")
    submit.add_argument("--contest-id")

    scoreboard = sub.add_parser("scoreboard")
    scoreboard.add_argument("--contest-id")
    return p


def build_client(args: argparse.Namespace):
    if args.cmd == "platforms":
        return None
    if not args.platform:
        raise SystemExit("--platform is required")
    cfg = PlatformConfig(
        base_url=args.base_url,
        timeout=args.timeout,
        verify=not args.insecure,
        debug=args.debug,
        session_file=args.session_file,
        token=args.token,
    )
    return create_client(args.platform, cfg)


def maybe_auto_load(client, args: argparse.Namespace) -> None:
    if args.no_auto_load or args.cmd in {"platforms", "probe", "login", "session-load"}:
        return
    try:
        client.load_session(args.session_file)
    except Exception:
        # Explicit session-load surfaces errors. Other commands may still work
        # with --token or a platform that does not require login.
        pass


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    pretty = not args.compact

    try:
        if args.cmd == "platforms":
            from .registry import ensure_builtin_adapters_loaded
            ensure_builtin_adapters_loaded()
            emit({"platforms": list_platforms(), "aliases": registry.aliases()}, pretty)
            return 0

        client = build_client(args)
        maybe_auto_load(client, args)

        if args.cmd == "probe":
            out = client.probe()
        elif args.cmd == "login":
            login_token = args.login_token or args.token
            if login_token and args.username:
                raise ValueError("use either token authentication or username/password, not both")
            if login_token:
                creds = Credentials(token=login_token, remember=not args.no_remember, captcha_token=args.captcha_token)
            else:
                if not args.username or args.password is None:
                    raise ValueError("login requires either --token or --username plus --password")
                creds = Credentials(username=args.username, password=args.password, remember=not args.no_remember, captcha_token=args.captcha_token)
            out = client.login(creds)
        elif args.cmd == "session-load":
            out = client.load_session(args.session_file)
        elif args.cmd == "session-save":
            out = client.save_session(args.session_file)
        elif args.cmd == "me":
            out = client.current_user()
        elif args.cmd == "contests":
            out = client.list_contests(page=args.page, page_size=args.page_size, search=args.search)
        elif args.cmd == "contest":
            out = client.get_contest(args.contest_id)
        elif args.cmd == "join":
            out = client.join_contest(args.contest_id, team_id=args.team_id, invite_code=args.invite_code)
        elif args.cmd == "challenges":
            out = client.list_challenges(args.contest_id, page=args.page, page_size=args.page_size, search=args.search)
        elif args.cmd == "challenge":
            out = client.get_challenge(args.challenge_id, contest_id=args.contest_id)
        elif args.cmd == "download":
            out = client.download_attachment(args.challenge_id, args.outdir, contest_id=args.contest_id)
        elif args.cmd == "submit":
            out = client.submit_flag(args.challenge_id, args.flag, contest_id=args.contest_id)
        elif args.cmd == "scoreboard":
            out = client.scoreboard(args.contest_id)
        else:
            raise ValueError(f"unknown command {args.cmd}")
    except Exception as exc:
        emit_error(exc, pretty, args.debug)
        return 1

    emit(out, pretty)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
