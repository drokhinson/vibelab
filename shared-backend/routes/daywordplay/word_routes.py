"""
routes/daywordplay/word_routes.py
Word of the day: today's word, sentences, voting, bookmarks.
"""
import random
from datetime import date, timedelta
from fastapi import Depends, HTTPException, Path

from db import get_supabase

from . import router
from .models import ProposeWordBody, ReusableSentencesResponse, SubmitSentenceBody, VoteCountItem, VoteCountsResponse
from .dependencies import get_current_user


# Module-level cache: same word for all groups on a given date.
# Keyed by date_str → { word_id, word dict }. Avoids redundant DB lookups
# when multiple groups request the same date's word within a single process.
_word_cache: dict[str, dict] = {}


def _get_or_assign_word(sb, group_id: str, target_date: date) -> dict:
    """Return the word assigned to a group for a given date, assigning lazily if needed.

    All groups share the same global word each day. The global word is determined
    first (from any existing assignment), then this group's entry is created or
    corrected to match. Results are cached per date to avoid redundant queries.
    """
    date_str = target_date.isoformat()

    # Fast path: word already resolved for this date
    if date_str in _word_cache:
        cached = _word_cache[date_str]
        _ensure_group_assignment(sb, group_id, date_str, cached["id"])
        return cached

    # 1. Determine the global word for this date (from ANY group's assignment)
    any_assignment = sb.table("daywordplay_daily_words").select(
        "word_id"
    ).eq("assigned_date", date_str).limit(1).execute()

    if any_assignment.data:
        word_id = any_assignment.data[0]["word_id"]
    else:
        # First request for this date — pick a globally unused word
        all_used = sb.table("daywordplay_daily_words").select("word_id").execute()
        used_ids = {r["word_id"] for r in (all_used.data or [])}

        all_words = sb.table("daywordplay_words").select("id").execute()
        all_ids = [w["id"] for w in (all_words.data or [])]
        available = [wid for wid in all_ids if wid not in used_ids]

        if not available:
            available = all_ids  # reset cycle if all words exhausted

        if not available:
            raise HTTPException(status_code=500, detail="No words available in the word bank.")

        word_id = random.choice(available)

    # 2. Ensure this group has an entry for this date with the correct word
    _ensure_group_assignment(sb, group_id, date_str, word_id)

    # 3. Fetch and return the word details
    word_result = sb.table("daywordplay_words").select(
        "id, word, part_of_speech, definition, etymology"
    ).eq("id", word_id).execute()

    word = word_result.data[0] if word_result.data else {}
    if word:
        _word_cache[date_str] = word
    return word


def _ensure_group_assignment(sb, group_id: str, date_str: str, word_id: str) -> None:
    """Ensure this group has a daily_words row for the given date with the correct word_id."""
    existing = sb.table("daywordplay_daily_words").select(
        "id, word_id"
    ).eq("group_id", group_id).eq("assigned_date", date_str).execute()

    if not existing.data:
        try:
            sb.table("daywordplay_daily_words").insert({
                "group_id": group_id,
                "word_id": word_id,
                "assigned_date": date_str,
            }).execute()
        except Exception:
            pass  # Race condition — another request inserted first
    elif existing.data[0]["word_id"] != word_id:
        sb.table("daywordplay_daily_words").update(
            {"word_id": word_id}
        ).eq("id", existing.data[0]["id"]).execute()


def _verify_member(sb, group_id: str, user_id: str):
    membership = sb.table("daywordplay_group_members").select("id").eq("group_id", group_id).eq("user_id", user_id).execute()
    if not membership.data:
        raise HTTPException(status_code=403, detail="You are not a member of this group.")


@router.get("/groups/{group_id}/today")
async def get_today(group_id: str, current_user: dict = Depends(get_current_user)):
    """Today's word for a group + current user's submission status."""
    sb = get_supabase()
    _verify_member(sb, group_id, current_user["user_id"])

    today = date.today()
    word = _get_or_assign_word(sb, group_id, today)

    # Check if user already submitted today
    sentence_result = sb.table("daywordplay_sentences").select(
        "id, sentence, created_at"
    ).eq("group_id", group_id).eq("user_id", current_user["user_id"]).eq("assigned_date", today.isoformat()).execute()

    submitted = bool(sentence_result.data)
    my_sentence = sentence_result.data[0] if submitted else None

    # Count submissions in this group today
    all_sentences = sb.table("daywordplay_sentences").select("user_id").eq("group_id", group_id).eq("assigned_date", today.isoformat()).execute()
    submission_count = len(all_sentences.data or [])

    # Count group members
    members = sb.table("daywordplay_group_members").select("user_id").eq("group_id", group_id).execute()
    member_count = len(members.data or [])

    # Check if user is bookmarked
    bookmark = sb.table("daywordplay_bookmarks").select("id").eq("user_id", current_user["user_id"]).eq("word_id", word["id"]).execute()

    return {
        "word": word,
        "date": today.isoformat(),
        "submitted": submitted,
        "my_sentence": my_sentence,
        "submission_count": submission_count,
        "member_count": member_count,
        "bookmarked": bool(bookmark.data),
    }


@router.get(
    "/groups/{group_id}/today/reusable-sentences",
    response_model=ReusableSentencesResponse,
    status_code=200,
    summary="Get user's sentences from other groups for today's word",
)
async def get_reusable_sentences(
    group_id: str = Path(..., description="Group ID to check reusable sentences for"),
    current_user: dict = Depends(get_current_user),
) -> ReusableSentencesResponse:
    """Return sentences the user already submitted today in other groups for the same word."""
    sb = get_supabase()
    _verify_member(sb, group_id, current_user["user_id"])
    today = date.today()
    word = _get_or_assign_word(sb, group_id, today)
    result = sb.table("daywordplay_sentences").select(
        "id, sentence, group_id"
    ).eq("user_id", current_user["user_id"]).eq("word_id", word["id"]).eq(
        "assigned_date", today.isoformat()
    ).neq("group_id", group_id).execute()
    return ReusableSentencesResponse(reusable_sentences=result.data or [])


@router.post("/groups/{group_id}/sentences")
async def submit_sentence(
    group_id: str,
    body: SubmitSentenceBody,
    current_user: dict = Depends(get_current_user),
):
    """Submit a sentence for today's word. One submission per user per day."""
    sentence_text = body.sentence.strip()
    if len(sentence_text) < 5:
        raise HTTPException(status_code=400, detail="Sentence is too short.")

    sb = get_supabase()
    _verify_member(sb, group_id, current_user["user_id"])

    today = date.today()
    word = _get_or_assign_word(sb, group_id, today)

    if word.get("word", "").lower() not in sentence_text.lower():
        raise HTTPException(
            status_code=400,
            detail=f"Your sentence must include the word \"{word.get('word', '')}\".",
        )

    # Check for existing submission
    existing = sb.table("daywordplay_sentences").select("id").eq("group_id", group_id).eq("user_id", current_user["user_id"]).eq("assigned_date", today.isoformat()).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail="You already submitted a sentence for today.")

    result = sb.table("daywordplay_sentences").insert({
        "group_id": group_id,
        "word_id": word["id"],
        "user_id": current_user["user_id"],
        "sentence": sentence_text,
        "assigned_date": today.isoformat(),
    }).execute()

    return {"sentence": result.data[0]}


@router.get("/groups/{group_id}/yesterday")
async def get_yesterday(group_id: str, current_user: dict = Depends(get_current_user)):
    """Yesterday's word + all sentences + vote counts. Ready for voting."""
    sb = get_supabase()
    _verify_member(sb, group_id, current_user["user_id"])

    yesterday = date.today() - timedelta(days=1)
    word = _get_or_assign_word(sb, group_id, yesterday)

    if not word:
        return {"word": None, "sentences": [], "date": yesterday.isoformat()}

    # Get all sentences from yesterday with author names
    sentences_result = sb.table("daywordplay_sentences").select(
        "id, sentence, user_id, created_at, daywordplay_users(username, display_name)"
    ).eq("group_id", group_id).eq("assigned_date", yesterday.isoformat()).execute()

    sentences = sentences_result.data or []
    sentence_ids = [s["id"] for s in sentences]

    # Count votes per sentence
    vote_counts: dict[str, int] = {}
    if sentence_ids:
        votes = sb.table("daywordplay_votes").select("sentence_id").in_("sentence_id", sentence_ids).execute()
        for v in (votes.data or []):
            sid = v["sentence_id"]
            vote_counts[sid] = vote_counts.get(sid, 0) + 1

    # Check which sentence(s) the current user voted for
    my_votes: set[str] = set()
    if sentence_ids:
        my_vote_result = sb.table("daywordplay_votes").select("sentence_id").eq("voter_user_id", current_user["user_id"]).in_("sentence_id", sentence_ids).execute()
        my_votes = {v["sentence_id"] for v in (my_vote_result.data or [])}

    # Annotate sentences
    enriched = []
    for s in sentences:
        user_info = s.get("daywordplay_users") or {}
        enriched.append({
            "id": s["id"],
            "sentence": s["sentence"],
            "user_id": s["user_id"],
            "username": user_info.get("username", ""),
            "display_name": user_info.get("display_name", ""),
            "vote_count": vote_counts.get(s["id"], 0),
            "i_voted": s["id"] in my_votes,
            "is_mine": s["user_id"] == current_user["user_id"],
        })

    # Sort by votes desc
    enriched.sort(key=lambda x: x["vote_count"], reverse=True)

    # Did the current user vote for anyone yet?
    has_voted = len(my_votes) > 0

    return {
        "word": word,
        "date": yesterday.isoformat(),
        "sentences": enriched,
        "has_voted": has_voted,
    }


@router.get(
    "/groups/{group_id}/vote-counts",
    response_model=VoteCountsResponse,
    status_code=200,
    summary="Lightweight vote counts for yesterday's sentences",
)
async def get_vote_counts(
    group_id: str = Path(..., description="Group ID"),
    current_user: dict = Depends(get_current_user),
) -> VoteCountsResponse:
    """Return only vote counts and i_voted flags for yesterday's sentences. No sentence text or author info."""
    sb = get_supabase()
    _verify_member(sb, group_id, current_user["user_id"])

    yesterday = (date.today() - timedelta(days=1)).isoformat()

    sentences_result = sb.table("daywordplay_sentences").select(
        "id"
    ).eq("group_id", group_id).eq("assigned_date", yesterday).execute()

    sentence_ids = [s["id"] for s in (sentences_result.data or [])]

    if not sentence_ids:
        return VoteCountsResponse(vote_counts=[], has_voted=False)

    votes = sb.table("daywordplay_votes").select("sentence_id").in_("sentence_id", sentence_ids).execute()
    vote_counts: dict[str, int] = {}
    for v in (votes.data or []):
        sid = v["sentence_id"]
        vote_counts[sid] = vote_counts.get(sid, 0) + 1

    my_vote_result = sb.table("daywordplay_votes").select("sentence_id").eq(
        "voter_user_id", current_user["user_id"]
    ).in_("sentence_id", sentence_ids).execute()
    my_votes = {v["sentence_id"] for v in (my_vote_result.data or [])}

    items = [
        VoteCountItem(
            sentence_id=sid,
            vote_count=vote_counts.get(sid, 0),
            i_voted=sid in my_votes,
        )
        for sid in sentence_ids
    ]

    return VoteCountsResponse(vote_counts=items, has_voted=len(my_votes) > 0)


@router.post("/sentences/{sentence_id}/vote")
async def vote_for_sentence(sentence_id: str, current_user: dict = Depends(get_current_user)):
    """Vote for a sentence. One vote per user per group per day. Cannot vote for own sentence."""
    sb = get_supabase()

    # Get sentence info
    sentence_result = sb.table("daywordplay_sentences").select(
        "id, group_id, user_id, assigned_date"
    ).eq("id", sentence_id).execute()
    if not sentence_result.data:
        raise HTTPException(status_code=404, detail="Sentence not found.")

    sentence = sentence_result.data[0]

    # Must be a member of the group
    _verify_member(sb, sentence["group_id"], current_user["user_id"])

    # Cannot vote for own sentence
    if sentence["user_id"] == current_user["user_id"]:
        raise HTTPException(status_code=400, detail="You cannot vote for your own sentence.")

    # Can only vote for yesterday's sentences
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    if sentence["assigned_date"] != yesterday:
        raise HTTPException(status_code=400, detail="You can only vote on yesterday's sentences.")

    # Check if already voted in this group for this day
    all_sentences_yesterday = sb.table("daywordplay_sentences").select("id").eq("group_id", sentence["group_id"]).eq("assigned_date", yesterday).execute()
    yesterday_sentence_ids = [s["id"] for s in (all_sentences_yesterday.data or [])]

    if yesterday_sentence_ids:
        existing_vote = sb.table("daywordplay_votes").select("id").eq("voter_user_id", current_user["user_id"]).in_("sentence_id", yesterday_sentence_ids).execute()
        if existing_vote.data:
            raise HTTPException(status_code=409, detail="You already voted today.")

    sb.table("daywordplay_votes").insert({
        "sentence_id": sentence_id,
        "voter_user_id": current_user["user_id"],
    }).execute()

    return {"voted": True, "sentence_id": sentence_id}


@router.get("/words/history", summary="Get all past words from user's groups with winning sentences")
async def get_word_history(current_user: dict = Depends(get_current_user)) -> dict:
    """Return all past daily words from user's groups, sorted alphabetically, with winning sentence."""
    sb = get_supabase()
    user_id = current_user["user_id"]
    today = date.today().isoformat()

    # Get user's group IDs
    memberships = sb.table("daywordplay_group_members").select("group_id").eq("user_id", user_id).execute()
    group_ids = [m["group_id"] for m in (memberships.data or [])]
    if not group_ids:
        return {"words": []}

    # Get all past daily word assignments for those groups
    past = sb.table("daywordplay_daily_words").select(
        "word_id, group_id, assigned_date, daywordplay_words(id, word, part_of_speech, definition, etymology)"
    ).in_("group_id", group_ids).lt("assigned_date", today).execute()

    if not past.data:
        return {"words": []}

    # Build unique word map (dedup by word_id)
    word_map: dict[str, dict] = {}
    for row in past.data:
        wid = row["word_id"]
        if wid not in word_map:
            word_map[wid] = row["daywordplay_words"]

    # Get all sentences from those groups for past dates
    sentences_result = sb.table("daywordplay_sentences").select(
        "id, sentence, word_id, user_id, daywordplay_users(display_name, username)"
    ).in_("group_id", group_ids).lt("assigned_date", today).execute()

    sentences_by_word: dict[str, list] = {}
    sentence_ids: list[str] = []
    for s in (sentences_result.data or []):
        wid = s["word_id"]
        if wid not in sentences_by_word:
            sentences_by_word[wid] = []
        sentences_by_word[wid].append(s)
        sentence_ids.append(s["id"])

    # Get vote counts for all those sentences
    vote_counts: dict[str, int] = {}
    if sentence_ids:
        votes = sb.table("daywordplay_votes").select("sentence_id").in_("sentence_id", sentence_ids).execute()
        for v in (votes.data or []):
            sid = v["sentence_id"]
            vote_counts[sid] = vote_counts.get(sid, 0) + 1

    # Build result: one entry per unique word with winning sentence
    result = []
    for wid, word_info in word_map.items():
        word_sentences = sentences_by_word.get(wid, [])
        winning_sentence = None
        winning_author = None
        winning_user_id = None

        if word_sentences:
            best = max(word_sentences, key=lambda s: vote_counts.get(s["id"], 0))
            if vote_counts.get(best["id"], 0) > 0:
                winning_sentence = best["sentence"]
                user_info = best.get("daywordplay_users") or {}
                winning_author = user_info.get("display_name") or user_info.get("username", "")
                winning_user_id = best.get("user_id")

        result.append({
            **word_info,
            "winning_sentence": winning_sentence,
            "winning_author": winning_author,
            "winning_user_id": winning_user_id,
        })

    result.sort(key=lambda w: w["word"].lower())
    return {"words": result}


@router.get("/words/bookmarks")
async def get_bookmarks(current_user: dict = Depends(get_current_user)):
    """Get current user's bookmarked words (friend dictionary)."""
    sb = get_supabase()
    result = sb.table("daywordplay_bookmarks").select(
        "id, created_at, daywordplay_words(id, word, part_of_speech, definition, etymology)"
    ).eq("user_id", current_user["user_id"]).order("created_at", desc=True).execute()

    bookmarks = []
    for b in (result.data or []):
        word_info = b.get("daywordplay_words") or {}
        bookmarks.append({
            "bookmark_id": b["id"],
            "bookmarked_at": b["created_at"],
            **word_info,
        })

    return {"bookmarks": bookmarks}


@router.post("/words/{word_id}/bookmark")
async def add_bookmark(word_id: str, current_user: dict = Depends(get_current_user)):
    """Bookmark a word."""
    sb = get_supabase()

    word_check = sb.table("daywordplay_words").select("id").eq("id", word_id).execute()
    if not word_check.data:
        raise HTTPException(status_code=404, detail="Word not found.")

    existing = sb.table("daywordplay_bookmarks").select("id").eq("user_id", current_user["user_id"]).eq("word_id", word_id).execute()
    if existing.data:
        return {"bookmarked": True}  # Already bookmarked — idempotent

    sb.table("daywordplay_bookmarks").insert({
        "user_id": current_user["user_id"],
        "word_id": word_id,
    }).execute()

    return {"bookmarked": True}


@router.delete("/words/{word_id}/bookmark")
async def remove_bookmark(word_id: str, current_user: dict = Depends(get_current_user)):
    """Remove a bookmark."""
    sb = get_supabase()
    sb.table("daywordplay_bookmarks").delete().eq("user_id", current_user["user_id"]).eq("word_id", word_id).execute()
    return {"bookmarked": False}


@router.get("/words/all", summary="Get all words in the dictionary with play/bookmark metadata")
async def get_all_words(current_user: dict = Depends(get_current_user)) -> dict:
    """Return every word in the word bank, annotated with is_played, my_sentence, winning_sentence, and is_bookmarked."""
    sb = get_supabase()
    user_id = current_user["user_id"]
    today = date.today().isoformat()

    # All words in the word bank
    all_words_result = sb.table("daywordplay_words").select(
        "id, word, part_of_speech, definition, etymology"
    ).order("word").execute()
    all_words = all_words_result.data or []
    word_ids = [w["id"] for w in all_words]

    if not word_ids:
        return {"words": []}

    # User's sentences for any of these words (past, not today)
    my_sentences_result = sb.table("daywordplay_sentences").select(
        "word_id, sentence"
    ).eq("user_id", user_id).lt("assigned_date", today).execute()
    my_sentence_by_word: dict[str, str] = {}
    for s in (my_sentences_result.data or []):
        if s["word_id"] not in my_sentence_by_word:
            my_sentence_by_word[s["word_id"]] = s["sentence"]

    # Winning sentences (most votes) for each word across all groups
    past_sentences_result = sb.table("daywordplay_sentences").select(
        "id, sentence, word_id, user_id, daywordplay_users(display_name, username)"
    ).lt("assigned_date", today).execute()
    sentences_by_word: dict[str, list] = {}
    all_sentence_ids: list[str] = []
    for s in (past_sentences_result.data or []):
        wid = s["word_id"]
        if wid not in sentences_by_word:
            sentences_by_word[wid] = []
        sentences_by_word[wid].append(s)
        all_sentence_ids.append(s["id"])

    vote_counts: dict[str, int] = {}
    if all_sentence_ids:
        votes = sb.table("daywordplay_votes").select("sentence_id").in_("sentence_id", all_sentence_ids).execute()
        for v in (votes.data or []):
            sid = v["sentence_id"]
            vote_counts[sid] = vote_counts.get(sid, 0) + 1

    # User's bookmarks
    bookmarks_result = sb.table("daywordplay_bookmarks").select("word_id").eq("user_id", user_id).execute()
    bookmarked_ids = {b["word_id"] for b in (bookmarks_result.data or [])}

    # Build result
    result = []
    for w in all_words:
        wid = w["id"]
        word_sentences = sentences_by_word.get(wid, [])
        winning_sentence = None
        winning_author = None
        if word_sentences:
            best = max(word_sentences, key=lambda s: vote_counts.get(s["id"], 0))
            if vote_counts.get(best["id"], 0) > 0:
                winning_sentence = best["sentence"]
                user_info = best.get("daywordplay_users") or {}
                winning_author = user_info.get("display_name") or user_info.get("username", "")

        result.append({
            **w,
            "is_played": wid in my_sentence_by_word,
            "my_sentence": my_sentence_by_word.get(wid),
            "winning_sentence": winning_sentence,
            "winning_author": winning_author,
            "winning_user_id": winning_user_id,
            "is_bookmarked": wid in bookmarked_ids,
        })

    return {"words": result}


@router.get("/words/played", summary="Get only words the current user has played")
async def get_played_words(current_user: dict = Depends(get_current_user)) -> dict:
    """Return words the current user has submitted a sentence for, with my_sentence, winning_sentence, and is_bookmarked."""
    sb = get_supabase()
    user_id = current_user["user_id"]
    today = date.today().isoformat()

    # Words this user has played (submitted a sentence for, past days only)
    my_sentences_result = sb.table("daywordplay_sentences").select(
        "word_id, sentence"
    ).eq("user_id", user_id).lt("assigned_date", today).execute()

    my_sentence_by_word: dict[str, str] = {}
    for s in (my_sentences_result.data or []):
        if s["word_id"] not in my_sentence_by_word:
            my_sentence_by_word[s["word_id"]] = s["sentence"]

    played_word_ids = list(my_sentence_by_word.keys())
    if not played_word_ids:
        return {"words": []}

    # Fetch word details for played words only
    words_result = sb.table("daywordplay_words").select(
        "id, word, part_of_speech, definition, etymology"
    ).in_("id", played_word_ids).order("word").execute()
    played_words = words_result.data or []

    # Winning sentences for played words only
    past_sentences_result = sb.table("daywordplay_sentences").select(
        "id, sentence, word_id, user_id, daywordplay_users(display_name, username)"
    ).in_("word_id", played_word_ids).lt("assigned_date", today).execute()

    sentences_by_word: dict[str, list] = {}
    all_sentence_ids: list[str] = []
    for s in (past_sentences_result.data or []):
        wid = s["word_id"]
        if wid not in sentences_by_word:
            sentences_by_word[wid] = []
        sentences_by_word[wid].append(s)
        all_sentence_ids.append(s["id"])

    vote_counts: dict[str, int] = {}
    if all_sentence_ids:
        votes = sb.table("daywordplay_votes").select("sentence_id").in_("sentence_id", all_sentence_ids).execute()
        for v in (votes.data or []):
            sid = v["sentence_id"]
            vote_counts[sid] = vote_counts.get(sid, 0) + 1

    # User's bookmarks
    bookmarks_result = sb.table("daywordplay_bookmarks").select("word_id").eq("user_id", user_id).execute()
    bookmarked_ids = {b["word_id"] for b in (bookmarks_result.data or [])}

    result = []
    for w in played_words:
        wid = w["id"]
        word_sentences = sentences_by_word.get(wid, [])
        winning_sentence = None
        winning_author = None
        if word_sentences:
            best = max(word_sentences, key=lambda s: vote_counts.get(s["id"], 0))
            if vote_counts.get(best["id"], 0) > 0:
                winning_sentence = best["sentence"]
                user_info = best.get("daywordplay_users") or {}
                winning_author = user_info.get("display_name") or user_info.get("username", "")

        result.append({
            **w,
            "is_played": True,
            "my_sentence": my_sentence_by_word.get(wid),
            "winning_sentence": winning_sentence,
            "winning_author": winning_author,
            "winning_user_id": winning_user_id,
            "is_bookmarked": wid in bookmarked_ids,
        })

    return {"words": result}


@router.post("/words/propose", status_code=201, summary="Propose a new word for the dictionary")
async def propose_word(
    body: ProposeWordBody,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Submit a word proposal for admin review. Rejects duplicates of existing or pending words."""
    sb = get_supabase()
    word = body.word.strip().lower()
    if not word:
        raise HTTPException(status_code=400, detail="Word cannot be empty.")

    # Check active dictionary
    existing = sb.table("daywordplay_words").select("id").eq("word", word).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail=f'"{word}" is already in the dictionary.')

    # Check pending proposals
    pending = sb.table("daywordplay_proposed_words").select("id").eq("word", word).eq("status", "pending").execute()
    if pending.data:
        raise HTTPException(status_code=409, detail=f'"{word}" already has a pending proposal awaiting review.')

    result = sb.table("daywordplay_proposed_words").insert({
        "word": word,
        "part_of_speech": body.part_of_speech.strip(),
        "definition": body.definition.strip(),
        "etymology": body.etymology.strip() if body.etymology else None,
        "proposed_by": current_user["user_id"],
        "status": "pending",
    }).execute()

    return {"proposal": result.data[0]}
