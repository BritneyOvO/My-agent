import unittest

from ctf_platforms.normalize import collect_paginated_listings, extract_listing_items, merge_contest_listings


class ListingMergeTests(unittest.TestCase):
    def test_recursively_extracts_nested_items(self):
        data = {"data": {"events": [{"id": 1}, {"id": 2}]}}
        self.assertEqual([x["id"] for x in extract_listing_items(data)], [1, 2])

    def test_merges_public_and_private_without_duplicates(self):
        merged = merge_contest_listings(
            {"items": [{"id": 1, "name": "private"}, {"id": 2, "name": "shared"}]},
            {"data": {"events": [{"id": 2, "name": "shared"}, {"id": 3, "name": "public"}]}},
        )
        self.assertEqual([x["id"] for x in merged["items"]], [1, 2, 3])
        self.assertEqual(merged["total"], 3)

    def test_collects_all_pages_until_total(self):
        pages = {
            1: {"contests": [{"id": 1}, {"id": 2}], "total": 5},
            2: {"contests": [{"id": 3}, {"id": 4}], "total": 5},
            3: {"contests": [{"id": 5}], "total": 5},
        }
        merged = collect_paginated_listings(lambda page: pages.get(page, {"contests": [], "total": 5}))
        self.assertEqual([x["id"] for x in merged["items"]], [1, 2, 3, 4, 5])


if __name__ == "__main__":
    unittest.main(verbosity=2)
