from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from ctf_platforms import Credentials, PlatformConfig
from ctf_platforms.adapters.adworld import AdWorldPlatform
from ctf_platforms.adapters.ctfd import CTFdPlatform
from ctf_platforms.adapters.ctfplus import CTFPlusPlatform
from ctf_platforms.adapters.gzctf import GZCTFPlatform
from ctf_platforms.adapters.nssctf import NSSCTFPlatform
from ctf_platforms.cli import build_parser


class CookieJar:
    def __init__(self):
        self.data = {}

    def set(self, key, value):
        self.data[key] = value

    def get_dict(self):
        return dict(self.data)


class FakeSession:
    def __init__(self):
        self.headers = {}
        self.cookies = CookieJar()


class FakeDownloaded:
    def __init__(self, path: str):
        self.url = "http://files.local/a.zip"
        self.path = path
        self.size = 4


class FakeCTFdClient:
    def __init__(self, base_url, timeout=20, verify=True, debug=False):
        self.base_url = base_url
        self.session = FakeSession()
        self.csrf_nonce = "csrf"

    @staticmethod
    def default_session_file(base_url):
        return Path(tempfile.gettempdir()) / "ctfd_session.json"

    def probe(self):
        return {"ok": True}

    def login(self, username, password):
        return {"success": username == "user" and password == "pass"}

    def save_session(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps({"cookies": {}, "csrf_nonce": self.csrf_nonce}), encoding="utf-8")
        return {"saved": True, "path": str(path)}

    def load_session(self, path):
        return {"loaded": Path(path).exists(), "path": str(path)}

    def get_me(self):
        return {"name": "user"}

    def list_challenges(self):
        return [{"id": 1, "name": "web baby", "category": "web"}, {"id": 2, "name": "pwn", "category": "pwn"}]

    def get_challenge(self, challenge_id):
        return {"id": challenge_id, "name": "web baby"}

    def download_challenge_files(self, challenge_id, outdir):
        Path(outdir).mkdir(parents=True, exist_ok=True)
        path = Path(outdir) / f"ctfd_{challenge_id}.txt"
        path.write_text("data", encoding="utf-8")
        return [FakeDownloaded(str(path))]

    def submit_flag(self, challenge_id, flag):
        return {"status": "correct", "challenge_id": challenge_id, "flag": flag}

    def get_scoreboard(self):
        return [{"name": "team", "score": 100}]


class FakeGZCTFClient:
    def __init__(self, base_url, token=None, timeout=20, verify=True, debug=False):
        self.base_url = base_url
        self._token = token
        self.session = FakeSession()

    @staticmethod
    def default_session_file(base_url):
        return Path(tempfile.gettempdir()) / "gzctf_session.json"

    def set_token(self, token):
        self._token = token

    def save_session(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps({"token": self._token}), encoding="utf-8")
        return {"saved": True, "path": str(path), "token_present": bool(self._token)}

    def load_session(self, path):
        return {"loaded": Path(path).exists()}

    def probe(self):
        return {"ok": True}

    def login(self, username, password, remember_me=True, captcha_token=None):
        self._token = "login-token"
        return {"success": True, "user": username, "remember_me": remember_me}

    def _verify_login(self):
        return {"name": "gz-user"}

    def list_games(self, count=50, skip=0):
        return {"items": [{"id": 1, "title": "Game"}], "count": count, "skip": skip}

    def get_game_details(self, game_id):
        return {"id": game_id, "challenges": [{"id": 100, "title": "misc"}]}

    def get_game(self, game_id):
        return {"id": game_id, "title": "Game"}

    def list_teams(self):
        return [{"id": 7, "name": "team"}]

    def join_game(self, game_id, team_id=None, division_id=None, invite_code=None):
        return {"joined": True, "game_id": game_id, "team_id": team_id, "invite_code": invite_code}

    def get_challenge(self, game_id, challenge_id):
        return {"game_id": game_id, "id": challenge_id}

    def download_challenge_attachments(self, game_id, challenge_id, outdir):
        Path(outdir).mkdir(parents=True, exist_ok=True)
        path = Path(outdir) / f"gz_{challenge_id}.txt"
        path.write_text("data", encoding="utf-8")
        return [FakeDownloaded(str(path))]

    def submit_flag(self, game_id, challenge_id, flag):
        return {"accepted": True, "game_id": game_id, "challenge_id": challenge_id, "flag": flag}

    def open_challenge_container(self, game_id, challenge_id):
        return {"game_id": game_id, "challenge_id": challenge_id, "start_result": {"status": "Running", "entry": "target.local:31337"}, "addresses": ["target.local:31337"]}

    def close_challenge_container(self, game_id, challenge_id):
        return {"game_id": game_id, "challenge_id": challenge_id, "closed": True, "addresses": []}


class FakeNSSCTFClient:
    def __init__(self, base_url, timeout=20, verify=True, debug=False):
        self.base_url = base_url
        self.session = FakeSession()

    @staticmethod
    def default_session_file(base_url):
        return Path(tempfile.gettempdir()) / "nssctf_session.json"

    def save_session(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps({"cookies": {}}), encoding="utf-8")
        return {"saved": True, "path": str(path)}

    def load_session(self, path):
        return {"loaded": Path(path).exists()}

    def probe(self):
        return {"ok": True}

    def login(self, username, password, remember=True):
        return {"success": True, "user": username, "remember": remember}

    def current_user(self):
        return {"name": "nss-user"}

    def list_contests(self, page=1, filters=None):
        suffix = "private" if isinstance(filters, dict) and filters.get("type") == 1 else "public"
        return {"contests": [{"id": 815 if suffix == "public" else 816, "name": f"NSS-{suffix}"}], "page": page, "filters": filters}

    def contest_info(self, contest_id):
        return {"id": contest_id, "title": "contest"}

    def contest_problem_list(self, contest_id):
        return {"contest_id": contest_id, "problems": [{"id": 1001, "title": "contest problem"}], "total": 1}

    def contest_rank(self, contest_id, page=1):
        return {"contest_id": contest_id, "rank": [{"name": "team", "score": 1}]}

    def contest_register(self, contest_id, payload=None):
        return {"registered": True, "contest_id": contest_id, "payload": payload}

    def problem_list(self, page=1, page_size=50, filters=None):
        return {"problems": [{"id": 6434, "name": "bank"}], "page": page, "page_size": page_size, "filters": filters}

    def problem_detail(self, problem_id):
        return {"id": problem_id, "name": "bank"}

    def challenge_detail(self, contest_id, problem_id):
        return {"contest_id": contest_id, "id": problem_id}

    def download_problem_annex(self, problem_id, outdir):
        Path(outdir).mkdir(parents=True, exist_ok=True)
        path = Path(outdir) / f"nss_problem_{problem_id}.txt"
        path.write_text("data", encoding="utf-8")
        return [FakeDownloaded(str(path))]

    def download_annex(self, contest_id, problem_id, outdir):
        Path(outdir).mkdir(parents=True, exist_ok=True)
        path = Path(outdir) / f"nss_contest_{problem_id}.txt"
        path.write_text("data", encoding="utf-8")
        return [FakeDownloaded(str(path))]

    def submit_problem_flag(self, problem_id, flag):
        return {"code": 200, "problem_id": problem_id, "flag": flag}

    def submit_flag(self, contest_id, problem_id, flag):
        return {"code": 200, "contest_id": contest_id, "problem_id": problem_id, "flag": flag}


class FakeAdWorldClient:
    def __init__(self, base_url, timeout=20, verify=True, debug=False):
        self.base_url = base_url
        self.session = FakeSession()
        self.token = None

    @staticmethod
    def default_session_file(base_url):
        return Path(tempfile.gettempdir()) / "adworld_session.json"

    def _refresh_common_headers(self):
        self.session.headers["Authorization"] = self.token

    def save_session(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps({"token": self.token}), encoding="utf-8")
        return {"saved": True, "path": str(path)}

    def load_session(self, path):
        return {"loaded": Path(path).exists()}

    def probe(self):
        return {"ok": True}

    def login(self, username, password):
        self.token = "ad-token"
        return {"success": True, "user": username}

    def current_auth(self):
        return {"username": "ad-user"}

    def competitions(self, page=1, per_page=50, search="", public=False, **kw):
        return {"items": [{"id": "event1", "name": "Ad"}], "public": public, "search": search}

    def competition(self, contest_id, public=False):
        if contest_id == "ACTF":
            raise Exception("not an id")
        return {"id": contest_id, "name": "Ad", "public": public}

    def find_competition(self, query):
        return {"id": "event1", "name": "ACTF 2026", "races": [{"race_id": "race1", "race_url": "/flag/race1/GuidePage", "category": 2}]}

    def contest_entry(self, contest_id):
        if contest_id == "ACTF":
            raise Exception("keyword lookup disabled")
        return {"query": contest_id, "kind": "race", "target_id": contest_id, "race_url": f"/flag/{contest_id}/GuidePage"}

    def enter_contest(self, contest_id):
        return {"entered": True, "contest_id": contest_id}

    def contest_challenges(self, contest_id, page=1, page_size=50, search=""):
        return {"challenges": [{"id": "c1", "name": "web"}], "contest_id": contest_id, "search": search}

    def contest_challenge_detail(self, contest_id, challenge_id):
        return {"contest_id": contest_id, "id": challenge_id}

    def contest_download_attachment(self, contest_id, challenge_id, outdir):
        Path(outdir).mkdir(parents=True, exist_ok=True)
        path = Path(outdir) / f"ad_{challenge_id}.txt"
        path.write_text("data", encoding="utf-8")
        return [FakeDownloaded(str(path))]

    def contest_submit_flag(self, contest_id, challenge_id, flag):
        return {"accepted": True, "contest_id": contest_id, "challenge_id": challenge_id, "flag": flag}

    def contest_start_target(self, contest_id, challenge_id):
        return {"kind": "practice", "contest_id": contest_id, "challenge_id": challenge_id, "addresses": ["http://target.local:8080"]}

    def contest_close_target(self, contest_id, challenge_id):
        return {"kind": "practice", "contest_id": contest_id, "challenge_id": challenge_id, "closed": True}

    def contest_scoreboard(self, contest_id):
        return [{"team": "ad", "score": 1}]


class FakeCTFPlusMainClient:
    def __init__(self):
        self.main_token = None
        self.s = FakeSession()

    @staticmethod
    def default_session_file():
        return Path(tempfile.gettempdir()) / "ctfplus_main.json"

    def save_session(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps({"token": self.main_token}), encoding="utf-8")
        return {"saved": True, "path": str(path)}

    def load_session(self, path):
        return {"loaded": Path(path).exists()}

    def login(self, account, password):
        self.main_token = "plus-token"
        return {"token": self.main_token, "account": account}

    def get_me(self):
        return {"name": "plus-user"}

    def list_joined_competitions(self, page=1, size=50):
        return {"competitions": [{"id": "FlyCTF", "shortName": "FlyCTF", "name": "Fly"}], "page": page, "size": size}

    def competition_overview(self, key):
        return {"summary": {"id": key, "shortName": key}, "detail": {"competition": {"address": "http://play.local"}}}

    def generate_tmp_login_token(self):
        return "tmp"

    def probe_tmp_login_token(self, token, auth_type=1):
        return {"json": {"code": 200}}


class FakeCTFPlusPlayClient:
    def __init__(self, play_origin):
        self.play_origin = play_origin
        self.s = FakeSession()

    @staticmethod
    def default_session_file(play_origin):
        return Path(tempfile.gettempdir()) / "ctfplus_play.json"

    def set_cookie_header(self, cookie_header):
        return {"loaded": True}

    def load_session(self, path):
        return {"loaded": Path(path).exists()}

    def save_session(self, path):
        Path(path).write_text(json.dumps({}), encoding="utf-8")
        return {"saved": True}

    def get_base(self):
        return {"ok": True}

    def bootstrap_with_tmp_token(self, tmp_token, verifier=None):
        return {"ok": True}

    def list_challenges(self):
        return {"challenges": [{"challenge_id": 1, "name": "plus"}]}

    def get_challenge_detail(self, challenge_id):
        return {"challenge_id": challenge_id, "attachments": [{"attachment_name": "plus.txt", "attachment_path": "plus.txt"}]}

    def challenge_view(self, detail):
        return {**detail, "attachments_normalized": [{"name": "plus.txt", "url": "http://files.local/plus.txt"}]}

    def submit_flag(self, challenge_id, flag):
        return {"accepted": True, "challenge_id": challenge_id, "flag": flag}


class UnifiedOperationTests(unittest.TestCase):
    def test_ctfd_password_token_and_operations(self):
        import ctf_platforms.vendor.ctfd_client as vendor
        with tempfile.TemporaryDirectory() as td, patch.object(vendor, "CTFdClient", FakeCTFdClient):
            session = str(Path(td) / "ctfd.json")
            client = CTFdPlatform(PlatformConfig(base_url="http://ctfd.local", session_file=session))
            self.assertTrue(client.login(Credentials(username="user", password="pass"))["login"]["success"])
            self.assertEqual(client.current_user()["name"], "user")
            self.assertEqual(len(client.list_challenges(search="web")), 1)
            self.assertEqual(client.get_challenge(1)["id"], 1)
            self.assertTrue(Path(client.download_attachment(1, str(Path(td) / "dl"))[0]["path"]).exists())
            self.assertEqual(client.submit_flag(1, "flag{x}")["status"], "correct")
            self.assertEqual(client.scoreboard()[0]["score"], 100)

            token_client = CTFdPlatform(PlatformConfig(base_url="http://ctfd.local", session_file=session))
            self.assertTrue(token_client.login(Credentials(token="abc"))["session_cache"]["token_saved"])
            loaded = CTFdPlatform(PlatformConfig(base_url="http://ctfd.local", session_file=session)).load_session()
            self.assertTrue(loaded["token_loaded"])

    def test_gzctf_operations(self):
        import ctf_platforms.vendor.gzctf_client as vendor
        with tempfile.TemporaryDirectory() as td, patch.object(vendor, "GZCTFClient", FakeGZCTFClient):
            client = GZCTFPlatform(PlatformConfig(base_url="http://gz.local", session_file=str(Path(td) / "gz.json")))
            self.assertTrue(client.login(Credentials(username="u", password="p"))["login"]["success"])
            self.assertEqual(client.current_user()["name"], "gz-user")
            self.assertEqual(client.list_contests()["items"][0]["id"], 1)
            self.assertTrue(client.join_contest(1)["joined"])
            self.assertEqual(client.list_challenges(1)["challenges"][0]["id"], 100)
            self.assertEqual(client.get_challenge(100, contest_id=1)["id"], 100)
            self.assertTrue(Path(client.download_attachment(100, str(Path(td) / "dl"), contest_id=1)[0]["path"]).exists())
            self.assertTrue(client.submit_flag(100, "flag{x}", contest_id=1)["accepted"])
            self.assertEqual(client.start_target(100, contest_id=1)["addresses"][0], "target.local:31337")
            self.assertTrue(client.close_target(100, contest_id=1)["closed"])

            token_client = GZCTFPlatform(PlatformConfig(base_url="http://gz.local", session_file=str(Path(td) / "gz2.json")))
            self.assertTrue(token_client.login(Credentials(token="tok"))["login"]["success"])

    def test_nssctf_problem_bank_and_contest_operations(self):
        import ctf_platforms.vendor.nssctf_client as vendor
        with tempfile.TemporaryDirectory() as td, patch.object(vendor, "NSSCTFClient", FakeNSSCTFClient):
            session = str(Path(td) / "nss.json")
            client = NSSCTFPlatform(PlatformConfig(session_file=session))
            self.assertTrue(client.login(Credentials(username="u", password="p"))["login"]["success"])
            self.assertEqual(client.current_user()["name"], "nss-user")
            self.assertEqual(client.list_contests()["contests"][0]["id"], 815)
            self.assertTrue(client.join_contest(815)["registered"])
            self.assertEqual(client.list_challenges()["problems"][0]["id"], 6434)
            self.assertEqual(client.list_challenges(contest_id=815)["problems"][0]["id"], 1001)
            self.assertEqual(client.get_challenge(6434)["id"], 6434)
            self.assertEqual(client.get_challenge(1001, contest_id=815)["contest_id"], 815)
            self.assertTrue(Path(client.download_attachment(6434, str(Path(td) / "dl1"))[0]["path"]).exists())
            self.assertTrue(Path(client.download_attachment(1001, str(Path(td) / "dl2"), contest_id=815)[0]["path"]).exists())
            self.assertEqual(client.submit_flag(6434, "NSSCTF{x}")["code"], 200)
            self.assertEqual(client.submit_flag(1001, "NSSCTF{x}", contest_id=815)["code"], 200)
            self.assertEqual(client.scoreboard(815)["rank"][0]["score"], 1)

            token_client = NSSCTFPlatform(PlatformConfig(session_file=session))
            self.assertTrue(token_client.login(Credentials(token="tok"))["session_cache"]["token_saved"])

    def test_nssctf_contest_type_filters(self):
        import ctf_platforms.vendor.nssctf_client as vendor
        with tempfile.TemporaryDirectory() as td, patch.object(vendor, "NSSCTFClient", FakeNSSCTFClient):
            client = NSSCTFPlatform(PlatformConfig(session_file=str(Path(td) / "nss.json")))
            public = client.list_contests(public=True)
            private = client.list_contests(public=False)
            self.assertEqual(public["filters"], {"name": "", "type": 0, "kind": 0, "source": 0})
            self.assertEqual(private["filters"], {"name": "", "type": 1, "kind": 0, "source": 0})

    def test_adworld_operations(self):
        import ctf_platforms.vendor.adworld_client as vendor
        with tempfile.TemporaryDirectory() as td, patch.object(vendor, "AdWorldClient", FakeAdWorldClient):
            client = AdWorldPlatform(PlatformConfig(session_file=str(Path(td) / "ad.json")))
            self.assertTrue(client.login(Credentials(username="u", password="p"))["login"]["success"])
            self.assertEqual(client.current_user()["username"], "ad-user")
            listed = client.list_contests()["items"][0]
            self.assertEqual(listed["id"], "event1")
            self.assertEqual(listed["contest_id"], "event1")
            self.assertEqual(listed["usage"]["--contest-id"], "event1")
            self.assertEqual(listed["entry"]["target_id"], "event1")
            self.assertTrue(listed["play_url"].endswith("/flag/event1/GuidePage"))
            self.assertEqual(client.get_contest("event1")["id"], "event1")
            with self.assertRaises(Exception):
                client.get_contest("ACTF")
            self.assertTrue(client.join_contest("event1")["entered"])
            self.assertEqual(client.list_challenges("event1")["challenges"][0]["id"], "c1")
            self.assertEqual(client.get_challenge("c1", contest_id="event1")["id"], "c1")
            self.assertTrue(Path(client.download_attachment("c1", str(Path(td) / "dl"), contest_id="event1")[0]["path"]).exists())
            self.assertTrue(client.submit_flag("c1", "flag{x}", contest_id="event1")["accepted"])
            self.assertEqual(client.start_target("c1", contest_id="event1")["addresses"][0], "http://target.local:8080")
            self.assertTrue(client.close_target("c1", contest_id="event1")["closed"])
            self.assertEqual(client.scoreboard("event1")[0]["score"], 1)
            self.assertTrue(AdWorldPlatform(PlatformConfig(session_file=str(Path(td) / "ad2.json"))).login(Credentials(token="tok"))["session_cache"]["saved"])

    def test_ctfplus_operations(self):
        import ctf_platforms.vendor.ctfplus_client as vendor
        with tempfile.TemporaryDirectory() as td, \
            patch.object(vendor, "CTFPlusMainClient", FakeCTFPlusMainClient), \
            patch.object(vendor, "CTFPlusPlayClient", FakeCTFPlusPlayClient), \
            patch.object(vendor, "download_file", lambda session, url, dest: Path(dest).write_text("data", encoding="utf-8") or Path(dest)):
            client = CTFPlusPlatform(PlatformConfig(session_file=str(Path(td) / "plus.json")))
            self.assertEqual(client.login(Credentials(username="u", password="p"))["login"]["account"], "u")
            self.assertEqual(client.current_user()["name"], "plus-user")
            self.assertEqual(client.list_contests()["competitions"][0]["id"], "FlyCTF")
            self.assertEqual(client.get_contest("FlyCTF")["summary"]["id"], "FlyCTF")
            self.assertEqual(client.list_challenges("FlyCTF")["result"]["challenges"][0]["challenge_id"], 1)
            self.assertEqual(client.get_challenge(1, contest_id="FlyCTF")["challenge"]["challenge_id"], "1")
            self.assertTrue(Path(client.download_attachment(1, str(Path(td) / "dl"), contest_id="FlyCTF")[0]["path"]).exists())
            self.assertTrue(client.submit_flag(1, "flag{x}", contest_id="FlyCTF")["submit_result"]["accepted"])
            self.assertTrue(CTFPlusPlatform(PlatformConfig(session_file=str(Path(td) / "plus2.json"))).login(Credentials(token="tok"))["session_cache"]["saved"])

    def test_cli_auth_shapes(self):
        ns = build_parser().parse_args(["-p", "ctfd", "--base-url", "http://x", "login", "-u", "u", "-P", "p"])
        self.assertEqual(ns.username, "u")
        ns = build_parser().parse_args(["-p", "ctfd", "--base-url", "http://x", "login", "--token", "tok"])
        self.assertEqual(ns.login_token, "tok")
        ns = build_parser().parse_args(["-p", "ctfd", "--base-url", "http://x", "--token", "tok", "challenges"])
        self.assertEqual(ns.token, "tok")


if __name__ == "__main__":
    unittest.main(verbosity=2)
