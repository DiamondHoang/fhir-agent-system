"""Compatibility exports for the upstream skin diagnostic skill prompts."""

from __future__ import annotations

from pathlib import Path

from app.pipeline.prompts import (
    _DIAGNOSE_INSTRUCTION,
    _DIAGNOSE_SYSTEM,
    _PLANNER_INSTRUCTION,
)
from app.utils.quality_gate import VISUAL_EXTRACT_PROMPT


PROMPTS_DIR = Path(__file__).resolve().parent.parent / "skills"

VISUAL_PROMPT = VISUAL_EXTRACT_PROMPT
PLANNER_PROMPT = _PLANNER_INSTRUCTION
DIAGNOSE_SYSTEM = _DIAGNOSE_SYSTEM
DIAGNOSE_PROMPT = _DIAGNOSE_INSTRUCTION
