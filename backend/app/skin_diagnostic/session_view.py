"""Response shaping helpers for skin diagnostic runs."""

from __future__ import annotations


PIPELINE_STEPS = [
    "visual_extract",
    "knowledge_base",
    "clinical_planner_round1",
    "user_interview_round1",
    "clinical_planner_round2",
    "user_interview_round2",
    "diagnostic_reasoning",
]


def get_step_progress(step: str) -> int:
    if not step:
        return 0
    try:
        return PIPELINE_STEPS.index(step) + 1
    except ValueError:
        return 0


def build_result(state: dict) -> dict:
    if not state:
        return {}
    round1_pairs = _flatten_qa_pairs(state.get("round1_qa_pairs") or [], start=1)
    round2_pairs = _flatten_qa_pairs(state.get("round2_qa_pairs") or [], start=len(round1_pairs) + 1)
    return {
        "ranked_diagnoses": state.get("ranked_diagnoses", []),
        "reasoning": state.get("reasoning", ""),
        "visual_observations": state.get("visual_observations", ""),
        "visual_differentials": state.get("visual_differentials", []),
        "qa_history": state.get("qa_history", ""),
        # Structured, per-round versions of qa_history so the frontend can
        # re-render the same two "Đã hoàn thành trả lời (5/5 câu hỏi)" cards
        # shown live during the interview (question text + CÓ/KHÔNG already
        # locked to the given answer) instead of losing them on reload, or
        # collapsing them into one flat block.
        "round1_qa_pairs": round1_pairs,
        "round2_qa_pairs": round2_pairs,
    }


def _flatten_qa_pairs(raw_pairs: list, *, start: int) -> list[dict]:
    """Turn one round's (question_dict, answer_str) pairs into a numbered,
    JSON-friendly list, continuing numbering from `start` so Round 2
    questions read as 6-10 instead of restarting at 1.

    Each pair is a plain list of length 2 after a JSON round-trip through
    the session store, so index into it rather than unpacking, and skip
    anything malformed instead of raising.
    """
    flat: list[dict] = []
    for i, pair in enumerate(raw_pairs, start=start):
        if not pair or len(pair) != 2 or not isinstance(pair[0], dict):
            continue
        q_obj, answer = pair[0], pair[1]
        flat.append(
            {
                "question_num": i,
                "question": q_obj.get("question", ""),
                "pqrst_category": q_obj.get("pqrst_category", q_obj.get("qrst_category", "")),
                "purpose": q_obj.get("purpose", ""),
                "discriminates": q_obj.get("discriminates", []) or [],
                "answer": answer,
            }
        )
    return flat


def get_pending_questions(run) -> list[dict] | None:
    if run.status != "interrupt":
        return None
    if run.pending_questions:
        return run.pending_questions
    if run.pending_question:
        return [run.pending_question]
    return None