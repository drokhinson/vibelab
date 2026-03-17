"""
routes/daywordplay/word_routes.py
Word of the day: today's word, sentences, voting, bookmarks.
"""
import random
from datetime import date, timedelta
from fastapi import Depends, HTTPException

from db import get_supabase

from . import router
from .models import SubmitSentenceBody
from .dependencies import get_current_user


def _get_or_assign_word(sb, group_id: str, target_date: date) -> dict:
    """Return the word assigned to a group for a given date, assigning lazily if needed."""
    date_str = target_date.isoformat()
    existing = sb.table("daywordplay_daily_words").select(
        "word_id, daywordplay_words(id, word, part_of_speech, definition, pronunciation, etymology)"
    ).eq("group_id", group_id).eq("assigned_date", date_str).execute()

    if existing.data:
        return existing.data[0]["daywordplay_words"]

    # Lazy-assign: pick a word not recently used in this group
    recent = sb.table("daywordplay_daily_words").select("word_id").eq("group_id", group_id).execute()
    used_ids = {r["word_id"] for r in (recent.data or [])}

    all_words = sb.table("daywordplay_words").select("id").execute()
    all_ids = [w["id"] for w in (all_words.data or [])]
    available = [wid for wid in all_ids if wid not in used_ids]

    if not available:
        available = all_ids  # reset cycle if all words exhausted

    if not available:
        raise HTTPException(status_code=500, detail="No words available in the word bank.")

    word_id = random.choice(available)

    # Insert assignment (ignore conflict in case of race condition)
    try:
        sb.table("daywordplay_daily_words").insert({
            "group_id": group_id,
            "word_id": word_id,
            "assigned_date": date_str,
        }).execute()
    except Exception:
        # Race condition — another request inserted first, re-fetch
        pass

    word_result = sb.table("daywordplay_words").select(
        "id, word, part_of_speech, definition, pronunciation, etymology"
    ).eq("id", word_id).execute()

    return word_result.data[0] if word_result.data else {}


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


@router.get("/words/bookmarks")
async def get_bookmarks(current_user: dict = Depends(get_current_user)):
    """Get current user's bookmarked words (friend dictionary)."""
    sb = get_supabase()
    result = sb.table("daywordplay_bookmarks").select(
        "id, created_at, daywordplay_words(id, word, part_of_speech, definition, pronunciation, etymology)"
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
