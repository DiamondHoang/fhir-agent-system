"""Persist completed skin diagnostic results into chat messages."""

import logging
from datetime import datetime, timezone
from uuid import UUID

from app.db.models import Message
from app.skin_diagnostic.session_store import SkinDiagnosticRun
from app.skin_diagnostic.session_view import build_result


logger = logging.getLogger(__name__)


def _diagnosis_lines(result: dict) -> list[str]:
    lines: list[str] = []
    ranked = result.get("ranked_diagnoses") or []
    if not isinstance(ranked, list):
        return lines

    for index, diagnosis in enumerate(ranked, start=1):
        if not isinstance(diagnosis, dict):
            continue
        rank = diagnosis.get("rank") or index
        disease = str(diagnosis.get("disease") or "Chưa xác định").strip()
        confidence = str(diagnosis.get("confidence") or "Low").strip()
        evidence_for = str(diagnosis.get("evidence_for") or "").strip()
        evidence_against = str(diagnosis.get("evidence_against") or "").strip()

        lines.append(f"{rank}. {disease} - {confidence}")
        if evidence_for:
            lines.append(f"   Bằng chứng hỗ trợ: {evidence_for}")
        if evidence_against:
            lines.append(f"   Điểm cần loại trừ: {evidence_against}")

    return lines


def format_skin_diagnostic_result_message(run: SkinDiagnosticRun) -> str:
    """Format a completed run as markdown suitable for chat and memory."""

    result = build_result(run.state)
    lines = [
        "## Phiếu chẩn đoán da",
        "",
        f"Run ID: {run.id}",
    ]
    if run.anamnesis.strip():
        lines.extend(["", f"Triệu chứng ban đầu: {run.anamnesis.strip()}"])

    diagnosis_lines = _diagnosis_lines(result)
    if diagnosis_lines:
        lines.extend(["", "### Chẩn đoán xếp hạng", *diagnosis_lines])

    visual = str(result.get("visual_observations") or "").strip()
    if visual:
        lines.extend(["", "### Phân tích hình ảnh tổn thương", visual])

    reasoning = str(result.get("reasoning") or "").strip()
    if reasoning:
        lines.extend(["", "### Biện luận y khoa", reasoning])

    uncertainty = str(result.get("remaining_uncertainty") or "").strip()
    if uncertainty:
        lines.extend(["", "### Thông tin cần bổ sung", uncertainty])

    qa_history = str(result.get("qa_history") or "").strip()
    if qa_history:
        lines.extend(["", "### Hỏi bệnh đã ghi nhận", qa_history])

    lines.extend(
        [
            "",
            "_Kết quả chỉ có mục đích hỗ trợ quyết định lâm sàng, không thay thế việc khám trực tiếp và chẩn đoán của bác sĩ._",
        ]
    )
    return "\n".join(lines).strip()


async def create_skin_diagnostic_messages(run: SkinDiagnosticRun) -> list[Message]:
    """
    Create the list of messages to be persisted when a skin diagnostic run completes.
    Returns a list of 1 or 2 messages:
    - A 'skin_image' message containing the image_url.
    - A 'skin_result' message containing the markdown content and structured_data.
    """
    if run.status != "completed" or not run.conversation_id:
        return []

    try:
        conversation_id = UUID(run.conversation_id)
    except ValueError:
        logger.warning("Invalid skin diagnostic conversation_id=%s", run.conversation_id)
        return []

    result = build_result(run.state)
    messages: list[Message] = []

    # 1. The result message (Assistant)
    result_content = format_skin_diagnostic_result_message(run)
    messages.append(
        Message(
            conversation_id=conversation_id,
            role="assistant",
            message_type="skin_result",
            content=result_content,
            structured_data=result,
        )
    )

    # 2. The image message (to ensure the image is visible in the chat context)
    if run.image_url:
        messages.append(
            Message(
                conversation_id=conversation_id,
                role="assistant",
                message_type="skin_image",
                content=f"Image from run {run.id}",
                image_url=run.image_url,
            )
        )

    return messages
