from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import ctf_platforms.server as server


class FakeApiPlatform:
    def __init__(self, config):
        self.config = config
        self.loaded_session_path = None

    def login(self, credentials):
        if credentials.username == "bad":
            raise RuntimeError("login failed")
        return {
            "success": True,
            "user": credentials.username or "token-user",
            "token": credentials.token or "secret-token",
            "cookies": {"session": "secret-cookie"},
            "nested": {"csrf_nonce": "secret-csrf"},
        }

    def load_session(self, path=None):
        self.loaded_session_path = path
        return {"loaded": True, "path": path}

    def current_user(self):
        return {"name": "api-user", "token": "secret-token", "profile": {"role": "player"}}

    def list_contests(self, page=1, page_size=50, search=None, public=None):
        return {"items": [{"id": "contest-1", "title": "Demo CTF"}], "page": page, "page_size": page_size, "search": search, "public": public}

    def get_contest(self, contest_id):
        return {"id": str(contest_id), "title": "Demo CTF", "status": "running"}

    def join_contest(self, contest_id, team_id=None, invite_code=None):
        return {"joined": True, "contest_id": str(contest_id), "team_id": team_id, "invite_code": invite_code}

    def list_challenges(self, contest_id=None, page=1, page_size=50, search=None):
        return {
            "contest_id": contest_id,
            "items": [{"id": "chal-1", "name": "web baby", "category": "web"}],
            "page": page,
            "page_size": page_size,
            "search": search,
        }

    def get_challenge(self, challenge_id, contest_id=None):
        return {"id": str(challenge_id), "contest_id": contest_id, "name": "web baby", "points": 100}

    def download_attachment(self, challenge_id, outdir, contest_id=None):
        out = Path(outdir)
        out.mkdir(parents=True, exist_ok=True)
        dest = out / f"{challenge_id}.txt"
        dest.write_text("attachment-data", encoding="utf-8")
        return [{"path": dest, "name": dest.name, "size": dest.stat().st_size, "contest_id": contest_id}]

    def submit_flag(self, challenge_id, flag, contest_id=None):
        return {"accepted": flag == "flag{ok}", "challenge_id": str(challenge_id), "contest_id": contest_id, "flag": flag}

    def start_target(self, challenge_id, contest_id=None):
        return {"ok": True, "challenge_id": str(challenge_id), "contest_id": contest_id, "url": "http://target.local:10001"}

    def close_target(self, challenge_id, contest_id=None):
        return {"closed": True, "challenge_id": str(challenge_id), "contest_id": contest_id}

    def scoreboard(self, contest_id=None):
        return {"contest_id": contest_id, "rows": [{"rank": 1, "name": "team", "score": 100}]}


def fake_create_client(platform, config):
    return FakeApiPlatform(config)


class ServerApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patches = [
            patch.object(server, "SESSION_DIR", self.root / "sessions"),
            patch.object(server, "DOWNLOAD_DIR", self.root / "downloads"),
            patch.object(server, "create_client", fake_create_client),
        ]
        for p in self.patches:
            p.start()
        self.client = TestClient(server.app)

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def create_session(self):
        response = self.client.post(
            "/api/sessions",
            json={
                "platform": "ctfd",
                "base_url": "http://ctfd.local",
                "auth": {"username": "user", "password": "pass"},
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertIn("session_id", data)
        return data["session_id"], data

    def test_health_and_platforms(self):
        self.assertEqual(self.client.get("/health").json(), {"ok": True})
        response = self.client.get("/api/platforms")
        self.assertEqual(response.status_code, 200)
        self.assertIn("ctfd", response.json()["platforms"])

    def test_create_session_redacts_sensitive_login_result(self):
        session_id, data = self.create_session()
        self.assertTrue((self.root / "sessions" / f"{session_id}.meta.json").exists())
        result = data["result"]
        self.assertEqual(result["token"], "<redacted>")
        self.assertEqual(result["cookies"], "<redacted>")
        self.assertEqual(result["nested"]["csrf_nonce"], "<redacted>")

    def test_create_session_login_failure_returns_400_and_cleans_meta(self):
        response = self.client.post(
            "/api/sessions",
            json={"platform": "ctfd", "base_url": "http://ctfd.local", "auth": {"username": "bad", "password": "pass"}},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(list((self.root / "sessions").glob("*.meta.json")), [])

    def test_full_ctf_session_api_flow(self):
        session_id, _ = self.create_session()

        me = self.client.get(f"/api/sessions/{session_id}/me")
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json()["name"], "api-user")
        self.assertEqual(me.json()["token"], "<redacted>")

        contests = self.client.get(f"/api/sessions/{session_id}/contests?page=2&page_size=10&search=demo")
        self.assertEqual(contests.status_code, 200)
        self.assertEqual(contests.json()["page"], 2)
        self.assertEqual(contests.json()["items"][0]["id"], "contest-1")

        contest = self.client.get(f"/api/sessions/{session_id}/contests/contest-1")
        self.assertEqual(contest.status_code, 200)
        self.assertEqual(contest.json()["status"], "running")

        joined = self.client.post(
            f"/api/sessions/{session_id}/contests/contest-1/join",
            json={"team_id": "team-1", "invite_code": "invite"},
        )
        self.assertEqual(joined.status_code, 200)
        self.assertTrue(joined.json()["joined"])

        challenges = self.client.get(f"/api/sessions/{session_id}/challenges?contest_id=contest-1&page=1&page_size=5&search=web")
        self.assertEqual(challenges.status_code, 200)
        self.assertEqual(challenges.json()["items"][0]["category"], "web")

        challenge = self.client.get(f"/api/sessions/{session_id}/challenges/chal-1?contest_id=contest-1")
        self.assertEqual(challenge.status_code, 200)
        self.assertEqual(challenge.json()["points"], 100)

        download = self.client.post(f"/api/sessions/{session_id}/challenges/chal-1/download?contest_id=contest-1")
        self.assertEqual(download.status_code, 200)
        downloaded_path = Path(download.json()[0]["path"])
        self.assertTrue(downloaded_path.exists())
        self.assertTrue(str(downloaded_path).startswith(str(self.root / "downloads")))

        target = self.client.post(f"/api/sessions/{session_id}/challenges/chal-1/target?contest_id=contest-1")
        self.assertEqual(target.status_code, 200)
        self.assertEqual(target.json()["url"], "http://target.local:10001")

        close_target = self.client.delete(f"/api/sessions/{session_id}/challenges/chal-1/target?contest_id=contest-1")
        self.assertEqual(close_target.status_code, 200)
        self.assertTrue(close_target.json()["closed"])

        wrong = self.client.post(
            f"/api/sessions/{session_id}/challenges/chal-1/submit?contest_id=contest-1",
            json={"flag": "flag{wrong}"},
        )
        self.assertEqual(wrong.status_code, 200)
        self.assertFalse(wrong.json()["accepted"])

        correct = self.client.post(
            f"/api/sessions/{session_id}/challenges/chal-1/submit?contest_id=contest-1",
            json={"flag": "flag{ok}"},
        )
        self.assertEqual(correct.status_code, 200)
        self.assertTrue(correct.json()["accepted"])

        scoreboard = self.client.get(f"/api/sessions/{session_id}/scoreboard?contest_id=contest-1")
        self.assertEqual(scoreboard.status_code, 200)
        self.assertEqual(scoreboard.json()["rows"][0]["score"], 100)

    def test_unknown_session_returns_404(self):
        response = self.client.get("/api/sessions/not-exist/me")
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
