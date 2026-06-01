import unittest
from types import SimpleNamespace
from unittest.mock import patch

from ctf_platforms.vendor.nssctf_client import DEFAULT_PROBLEM_FILTERS, NSSCTFClient


class NSSCTFVendorTests(unittest.TestCase):
    @staticmethod
    def response(payload):
        return SimpleNamespace(url="https://www.nssctf.cn/api/test/", json=lambda: payload)

    def test_problem_list_uses_official_default_filters(self):
        client = object.__new__(NSSCTFClient)
        captured = {}

        def request(method, path, **kwargs):
            captured.update(kwargs["json"])
            return SimpleNamespace(raise_for_status=lambda: None)

        client._request = request
        client._unwrap = lambda response: {"data": {"problems": [], "total": 4206}}
        result = client.problem_list(page=1, page_size=50, filters={"search": "baby"})

        self.assertEqual(result["total"], 4206)
        self.assertEqual(captured["name"], "baby")
        self.assertNotIn("search", captured)
        self.assertEqual(captured["point"], DEFAULT_PROBLEM_FILTERS["point"])

    def test_decodes_chinese_attachment_filename(self):
        self.assertEqual(
            NSSCTFClient._filename_from_content_disposition("attachment; filename*=UTF-8''%E9%99%84%E4%BB%B6.py"),
            "附件.py",
        )
        self.assertEqual(
            NSSCTFClient._filename_from_content_disposition("attachment; filename=éä»¶.py"),
            "附件.py",
        )
        self.assertEqual(
            NSSCTFClient._filename_from_url(
                "https://files.nssctf.cn/43f?response-content-disposition=attachment;filename=%E9%99%84%E4%BB%B6.py"
            ),
            "附件.py",
        )

    def test_normalize_problem_exposes_type_and_capabilities(self):
        normalized = NSSCTFClient._normalize_problem({"pid": 7549, "type": 8, "category": 0, "docker": True, "annex": False})

        self.assertEqual(normalized["category"], "IOT")
        self.assertEqual(normalized["category_id"], 0)
        self.assertEqual(normalized["type_name"], "IOT")
        self.assertTrue(normalized["has_target"])
        self.assertFalse(normalized["has_attachment"])

    def test_open_problem_target_polls_until_url_is_ready(self):
        client = object.__new__(NSSCTFClient)
        states = iter([
            {"code": 200, "data": {"state": 2}},
            {"code": 200, "data": {"state": 4, "url": "http://target.local:8080"}},
        ])
        client.open_problem_attachment = lambda problem_id, type_id=0: {"code": 200, "data": ""}
        client.problem_target_info = lambda problem_id: next(states)

        with patch("ctf_platforms.vendor.nssctf_client.time.sleep"):
            result = client.open_problem_target(7549)

        self.assertTrue(result["opened"])
        self.assertFalse(result["pending"])
        self.assertEqual(result["addresses"], ["http://target.local:8080"])

    def test_open_problem_target_recovers_existing_instance(self):
        client = object.__new__(NSSCTFClient)
        client.open_problem_attachment = lambda problem_id, type_id=0: {"code": 203, "data": "already open"}
        client.problem_target_info = lambda problem_id: {"code": 200, "data": {"state": 4, "url": "target.local:31337"}}

        result = client.open_problem_target(7549)

        self.assertTrue(result["opened"])
        self.assertEqual(result["addresses"], ["target.local:31337"])

    def test_problem_flag_submit_uses_official_wrong_flag_message(self):
        client = object.__new__(NSSCTFClient)

        result = client._result_from_response(self.response({"code": 204, "data": {}}), context="problem_flag_submit")

        self.assertFalse(result["accepted"])
        self.assertEqual(result["message"], "flag有误，请重新提交。")

    def test_contest_flag_submit_preserves_false_data_as_wrong_flag(self):
        client = object.__new__(NSSCTFClient)

        result = client._result_from_response(self.response({"code": 200, "data": False}), context="contest_flag_submit")

        self.assertFalse(result["ok"])
        self.assertFalse(result["accepted"])
        self.assertIs(result["data"], False)
        self.assertEqual(result["message"], "Flag不正确。")

    def test_contest_flag_submit_uses_official_error_messages(self):
        client = object.__new__(NSSCTFClient)

        self.assertEqual(client.explain_code(203, context="contest_flag_submit"), "该题提交次数已达上限。")
        self.assertEqual(client.explain_code(204, context="contest_flag_submit"), "您已经解决本题了。")
        self.assertEqual(client.explain_code(201, context="contest_detail"), "比赛不存在！")
        self.assertEqual(client.explain_code(403, context="contest_detail"), "您没有权限查看本场比赛！")


if __name__ == "__main__":
    unittest.main(verbosity=2)
