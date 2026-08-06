from __future__ import annotations

import base64
import logging
import uuid as uuid_module
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.conversations import create_conversation_with_user_message
from app.db.models import Conversation, Message, User
from app.db.session import get_db
from app.dependencies.auth import get_current_user
from app.skin_images.neo4j_repository import (
    get_binary_for_skin_image,
    get_skin_image_detail,
    list_skin_images,
    patient_exists,
)
from app.skin_images.schemas import (
    SkinImageAnalyzeResponse,
    SkinImageDetailResponse,
    SkinImageListResponse,
    SkinImageSaveResponse,
    SkinImageSummary,
)
from app.skin_images.service import analyze_and_save_skin_image, normalize_patient_id, save_skin_photo_result


router = APIRouter(prefix="/skin-images", tags=["skin images"])
logger = logging.getLogger(__name__)


def _assert_user_can_access_patient(current_user: User, patient_id: str) -> None:
    # Doctor-mode access: authenticated users can work with any Patient record.
    # Patient-scoped authorization was removed because this app currently uses a
    # single doctor role for cross-patient clinical lookup and image upload.
    return None


@router.post("/analyze", response_model=SkinImageAnalyzeResponse)
async def analyze_image(
    patient_id: str = Form(...),
    image: UploadFile = File(...),
    note: str = Form(""),
    conversation_id: str | None = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    patient_id = normalize_patient_id(patient_id)
    _assert_user_can_access_patient(current_user, patient_id)
    result = await analyze_and_save_skin_image(patient_id=patient_id, image=image)

    # F-10: persist this result as chat messages, mirroring how
    # /skin-diagnostics/start (luong A) creates/reuses a Conversation —
    # without this, the result only existed in the frontend's local state
    # and vanished on reload even though the Neo4j record was saved fine.
    first_message = note.strip() or "Yêu cầu lưu và phân tích ảnh da liễu"
    result_content = "\n".join(
        [
            "## Kết quả phân tích ảnh da",
            "",
            f"Bệnh nhân ID: {patient_id}",
            "",
            result.analysis_text,
        ]
    )

    conversation: Conversation | None = None
    if conversation_id:
        try:
            candidate_uuid = uuid_module.UUID(conversation_id)
        except ValueError:
            candidate_uuid = None
        if candidate_uuid is not None:
            query = await db.execute(
                select(Conversation).where(
                    Conversation.id == candidate_uuid,
                    Conversation.user_id == current_user.id,
                )
            )
            conversation = query.scalar_one_or_none()

    if conversation is not None:
        db.add(
            Message(
                conversation_id=conversation.id,
                role="user",
                content=first_message,
                message_type="skin_image",
                image_url=result.image_url,
            )
        )
        db.add(
            Message(
                conversation_id=conversation.id,
                role="assistant",
                content=result_content,
                message_type="text",
            )
        )
        conversation.updated_at = datetime.now(timezone.utc)
        conversation.neo4j_patient_id = patient_id
        await db.commit()
        await db.refresh(conversation)
    else:
        conversation, _user_message = await create_conversation_with_user_message(
            db=db,
            user_id=current_user.id,
            first_message=first_message,
            message_type="skin_image",
            image_url=result.image_url,
        )
        db.add(
            Message(
                conversation_id=conversation.id,
                role="assistant",
                content=result_content,
                message_type="text",
            )
        )
        conversation.neo4j_patient_id = patient_id
        conversation.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(conversation)

    return SkinImageAnalyzeResponse(
        **result.model_dump(exclude={"conversation_id", "conversation_title"}),
        conversation_id=str(conversation.id),
        conversation_title=conversation.title or first_message,
    )


@router.post("/save", response_model=SkinImageSaveResponse)
async def save_image_only(
    patient_id: str = Form(...),
    image: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Attach a photo to an existing Neo4j patient's record with no vision
    analysis and no chat message — the "just save it" case for when a doctor
    picks a patient but doesn't type any symptoms (F-04 patient picker, no
    complaint text). Distinct from /analyze (runs the vision model) and from
    /skin-diagnostics/start (always creates/updates a Conversation, which
    made this case incorrectly surface as a chat bubble with a generic
    placeholder message).
    """
    patient_id = normalize_patient_id(patient_id)
    _assert_user_can_access_patient(current_user, patient_id)
    if not await patient_exists(patient_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Patient was not found in Neo4j")

    from pathlib import Path
    import uuid as uuid_module_local

    from app.skin_diagnostic.uploads import save_upload

    run_id = str(uuid_module_local.uuid4())
    image_path, _image_url = await save_upload(image, run_id)
    try:
        ids = await save_skin_photo_result(
            patient_id=patient_id,
            image_path=image_path,
            conclusion_text="Ảnh da liễu đã được lưu vào hồ sơ bệnh nhân (chưa yêu cầu chẩn đoán).",
        )
    except Exception as exc:
        logger.exception("Failed to save skin photo only for patient %s", patient_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Không thể lưu ảnh vào hồ sơ bệnh nhân: {exc}",
        ) from exc
    finally:
        # The photo is now persisted as Binary.data inside Neo4j and served
        # via /skin-images/files/{binary_id} — this on-disk temp copy isn't
        # tied to any diagnostic run/conversation, so it would otherwise
        # just accumulate unused files under skin_diagnostic/data/uploads.
        try:
            Path(image_path).unlink(missing_ok=True)
        except OSError:
            pass

    return SkinImageSaveResponse(**ids)


@router.get("", response_model=SkinImageListResponse)
async def list_images(
    patient_id: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
):
    patient_id = patient_id.strip() if patient_id else None
    rows = await list_skin_images(patient_id)
    return SkinImageListResponse(items=[SkinImageSummary(**row) for row in rows])


@router.get("/files/{image_id}")
async def get_image_file(
    image_id: str,
    current_user: User = Depends(get_current_user),
):
    binary_id = image_id if image_id.startswith("binary-") else f"binary-{image_id}"
    row = await get_binary_for_skin_image(binary_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found")
    _assert_user_can_access_patient(current_user, str(row.get("patient_id") or ""))

    encoded = str(row.get("data") or "")
    if not encoded:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image data not found")

    try:
        content = base64.b64decode(encoded)
    except Exception:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Invalid image data")

    return Response(content=content, media_type=row.get("content_type") or "image/jpeg")


@router.get("/{report_id}", response_model=SkinImageDetailResponse)
async def get_image_detail(
    report_id: str,
    current_user: User = Depends(get_current_user),
):
    row = await get_skin_image_detail(report_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skin image report not found")
    _assert_user_can_access_patient(current_user, str(row.get("patient_id") or ""))
    return SkinImageDetailResponse(**row)
