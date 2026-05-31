from __future__ import annotations

from typing import Any, Callable, Mapping


CONTEST_LIST_KEYS = ("list", "items", "contests", "competitions", "games", "data", "results", "rows")
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
