from __future__ import annotations

import time
from typing import Any, Callable, Mapping


CONTEST_LIST_KEYS = ("list", "items", "contests", "competitions", "games", "events", "data", "results", "rows")
CONTEST_ID_KEYS = ("contest_id", "id", "event_id", "game_id", "competition_id", "shortName", "key")


def first_present(mapping: Mapping[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        value = mapping.get(key)
        if value not in (None, ""):
            return value
    return None


def contest_id_of(item: Mapping[str, Any]) -> str | None:
    value = first_present(item, CONTEST_ID_KEYS)
    return str(value) if value not in (None, "") else None


def usage_for(platform: str, contest_id: str) -> dict[str, Any]:
    """Stable upper-layer hints returned together with contest listings.

    Callers should select a `contest_id` from `contests` output and pass it
    back unchanged; adapters keep race/practice/game/play-node internals hidden.
    """
    return {
        "--contest-id": contest_id,
        "commands": {
            "detail": f"python3 -m ctf_platforms -p {platform} contest {contest_id}",
            "join": f"python3 -m ctf_platforms -p {platform} join {contest_id}",
            "challenges": f"python3 -m ctf_platforms -p {platform} challenges --contest-id {contest_id}",
            "scoreboard": f"python3 -m ctf_platforms -p {platform} scoreboard --contest-id {contest_id}",
        },
    }


def annotate_contest_item(
    item: Mapping[str, Any],
    platform: str,
    *,
    command_id: str | int | None = None,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    out = dict(item)
    cid = str(command_id) if command_id not in (None, "") else contest_id_of(out)
    if cid:
        out["contest_id"] = cid
        out["usage"] = usage_for(platform, cid)
    if extra:
        out.update(dict(extra))
    return out


def annotate_contest_listing(
    data: Any,
    platform: str,
    *,
    item_annotator: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None,
) -> Any:
    """Annotate common listing response shapes with `contest_id` and usage hints."""
    annotator = item_annotator or (lambda item: annotate_contest_item(item, platform))
    if isinstance(data, list):
        return [annotator(x) if isinstance(x, Mapping) else x for x in data]
    if not isinstance(data, dict):
        return data
    out = dict(data)
    for key in CONTEST_LIST_KEYS:
        value = out.get(key)
        if isinstance(value, list):
            out[key] = [annotator(x) if isinstance(x, Mapping) else x for x in value]
            break
    return out


def extract_listing_items(data: Any) -> list[Any]:
    """Recursively extract the first contest-like list from common response shapes."""
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for key in CONTEST_LIST_KEYS:
        value = data.get(key)
        if isinstance(value, list):
            return value
    for key in CONTEST_LIST_KEYS:
        value = data.get(key)
        if isinstance(value, dict):
            nested = extract_listing_items(value)
            if nested:
                return nested
    return []


def merge_contest_listings(*sources: Any) -> dict[str, Any]:
    """Merge multiple contest listings and de-duplicate by stable contest id/name."""
    seen: set[str] = set()
    merged: list[Any] = []

    for source in sources:
        for item in extract_listing_items(source):
            if isinstance(item, Mapping):
                key = contest_id_of(item) or str(first_present(item, ("name", "title", "shortName", "race_id", "resource_id")) or item)
            else:
                key = str(item)
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)

    return {
        "items": merged,
        "total": len(merged),
        "sources": len([source for source in sources if source])
    }


def collect_paginated_listings(
    fetch_page: Callable[[int], Any],
    *,
    start_page: int = 1,
    max_pages: int = 100,
    delay_seconds: float = 0.12,
    retries: int = 3,
) -> dict[str, Any]:
    """Fetch visible contest pages until exhausted, then return a stable merged listing."""
    pages: list[Any] = []
    seen_count = 0

    for page in range(start_page, start_page + max_pages):
        data: Any = None
        last_error: Exception | None = None
        for attempt in range(retries + 1):
            try:
                data = fetch_page(page)
                break
            except Exception as exc:
                last_error = exc
                if attempt < retries:
                    time.sleep(max(delay_seconds, 0.1) * (attempt + 1))
        if last_error is not None and data is None:
            if pages:
                break
            raise last_error
        items = extract_listing_items(data)
        if not items:
            break
        pages.append(data)
        merged = merge_contest_listings(*pages)
        if merged["total"] <= seen_count:
            break
        seen_count = merged["total"]

        total_hint = data.get("total") if isinstance(data, dict) else None
        if isinstance(total_hint, int) and seen_count >= total_hint:
            break
        if delay_seconds > 0:
            time.sleep(delay_seconds)

    return merge_contest_listings(*pages)
