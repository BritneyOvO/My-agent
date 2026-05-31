import unittest

from ctf_platforms import PlatformConfig, create_client, list_platforms


def test_platforms_registered():
    keys = set(list_platforms())
    assert {"ctfd", "gzctf", "nssctf", "adworld", "ctfplus"}.issubset(keys)


class ImportTests(unittest.TestCase):
    def test_platforms_registered(self):
        test_platforms_registered()
