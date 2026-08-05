"""API routes for skin diagnostic runs."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.conversations import create_conversation_with_user_message
from app.db.models import Conversation, Message, User
from app.db.session import get_db
from app.dependencies.auth import get_current_user
from app.skin_diagnostic import fhir_images
from app.skin_diagnostic.answer_validation import normalize_yes_no
from app.skin_diagnostic.fhir_images import FhirImageError
from app.skin_diagnostic.pipeline_runner import resume_pipeline, run_pipeline_background
from app.skin_diagnostic.schemas import (
    BulkAnswerRequest,
    PatientCreateRequest,
    PatientCreateResponse,
    SkinDiagnosticAnswersResponse,
    SkinDiagnosticDetailResponse,
    SkinDiagnosticStartResponse,
    SkinDiagnosticStatusResponse,
    SkinImageResult,
    SkinImageSearchResponse,
)
from app.skin_diagnostic.session_store import get_store
from app.skin_diagnostic.session_view import build_result, get_pending_questions, get_step_progress
from app.skin_diagnostic.uploads import UPLOADS_DIR, save_upload

_CONTENT_TYPE_BY_EXT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


router = APIRouter(prefix="/skin-diagnostics", tags=["skin diagnostics"])


@router.post("/patients", response_model=PatientCreateResponse)
async def create_fhir_patient(
    request: PatientCreateRequest,
    current_user: User = Depends(get_current_user),
):
    """Create a minimal Patient on the live FHIR server for the "new
    patient" popup shown right after an image is selected. The frontend
    holds the returned patient_id in memory and sends it back on /start.
    """
    try:
        result = await fhir_images.create_patient(
            request.name, request.gender, request.birth_year
        )
    except FhirImageError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return PatientCreateResponse(**result)


@router.get("/fhir-images", response_model=SkinImageSearchResponse)
async def search_fhir_skin_images(
    patient_id: str | None = None,
    patient_name: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    count: int = 20,
    current_user: User = Depends(get_current_user),
):
    """Look up skin photos stored on the FHIR server (used by the chat
    agent's search_skin_images tool and by any direct-query UI)."""
    try:
        results = await fhir_images.search_skin_images(
            patient_id=patient_id,
            patient_name=patient_name,
            date_from=date_from,
            date_to=date_to,
            count=count,
        )
    except FhirImageError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return SkinImageSearchResponse(results=[SkinImageResult(**r) for r in results])


@router.get("/fhir-image/{binary_id}")
async def get_fhir_skin_image(
    binary_id: str,
    current_user: User = Depends(get_current_user),
):
    """Proxy raw photo bytes from the FHIR server's Binary resource."""
    try:
        raw_bytes, content_type = await fhir_images.fetch_binary(binary_id)
    except FhirImageError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    from fastapi.responses import Response

    return Response(content=raw_bytes, media_type=content_type)


@router.post("/start", response_model=SkinDiagnosticStartResponse)
async def start_skin_diagnostic(
    image: UploadFile = File(...),
    anamnesis: str = Form(""),
    conversation_id: str | None = Form(None),
    fhir_patient_id: str | None = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # A photo-based diagnosis request previously never touched the
    # conversations/messages tables at all — it only lived in this module's
    # own in-memory session store. That meant it never showed up as a named
    # conversation in the sidebar and nothing recorded what the user asked.
    # Reuse the currently open conversation if the frontend has one (same
    # behaviour as sending a normal text message into an open chat);
    # otherwise create a new Conversation, titled from what the user typed,
    # exactly like the regular chat flow does for the first message.
    first_message = anamnesis.strip() or "Yêu cầu chẩn đoán hình ảnh tổn thương da liễu"

    # Save the upload first so the user's Message row can record image_url
    # right away — previously the message was written before the image was
    # saved, so nothing on the message ever pointed at the photo, and a page
    # reload had no way to know one had been attached at all.
    store = await get_store()
    run_id = str(uuid.uuid4())
    image_path, image_url = await save_upload(image, run_id)

    # Push the same photo to the live FHIR server (Binary + ImagingStudy) if
    # a patient was created via the "new patient" popup before this call.
    # Best-effort: a FHIR outage should not block the local diagnostic run
    # the doctor is already looking at, so failures are logged, not raised.
    fhir_study_id = ""
    fhir_binary_id = ""
    if fhir_patient_id:
        try:
            content_type = _CONTENT_TYPE_BY_EXT.get(
                Path(image_path).suffix.lower(), "image/jpeg"
            )
            raw_bytes = Path(image_path).read_bytes()
            fhir_result = await fhir_images.save_skin_image(
                fhir_patient_id, raw_bytes, content_type
            )
            fhir_study_id = fhir_result["study_id"]
            fhir_binary_id = fhir_result["binary_id"]
        except FhirImageError:
            logging.getLogger(__name__).exception(
                "FHIR image save failed for run %s (patient %s) — continuing without it",
                run_id, fhir_patient_id,
            )

    conversation: Conversation | None = None
    if conversation_id:
        try:
            candidate_uuid = uuid.UUID(conversation_id)
        except ValueError:
            candidate_uuid = None
        if candidate_uuid is not None:
            result = await db.execute(
                select(Conversation).where(
                    Conversation.id == candidate_uuid,
                    Conversation.user_id == current_user.id,
                )
            )
            conversation = result.scalar_one_or_none()

    if conversation is not None:
        db.add(
            Message(
                conversation_id=conversation.id,
                role="user",
                content=first_message,
                message_type="skin_image",
                image_url=image_url,
            )
        )
        conversation.updated_at = datetime.now(timezone.utc)
        if fhir_patient_id:
            conversation.fhir_patient_id = fhir_patient_id
        await db.commit()
        await db.refresh(conversation)
    else:
        conversation, _user_message = await create_conversation_with_user_message(
            db=db,
            user_id=current_user.id,
            first_message=first_message,
            message_type="skin_image",
            image_url=image_url,
        )
        if fhir_patient_id:
            conversation.fhir_patient_id = fhir_patient_id
            await db.commit()
            await db.refresh(conversation)

    run = await store.create(
        run_id=run_id,
        user_id=str(current_user.id),
        image_path=image_path,
        image_url=image_url,
        anamnesis=anamnesis,
        conversation_id=str(conversation.id),
        fhir_patient_id=fhir_patient_id or "",
    )
    if fhir_study_id:
        await store.update(run_id, fhir_study_id=fhir_study_id, fhir_binary_id=fhir_binary_id)

    # No symptoms typed -> the doctor just wants the photo saved, not a
    # diagnosis. Skip the (slow, LLM-heavy) pipeline entirely.
    if not anamnesis.strip():
        await store.update(run_id, status="saved", current_step="saved")
        return SkinDiagnosticStartResponse(
            run_id=run.id,
            status="saved",
            current_step="saved",
            conversation_id=str(conversation.id),
            conversation_title=conversation.title or first_message,
        )

    asyncio.create_task(run_pipeline_background(run.id, image_path, anamnesis))
    return SkinDiagnosticStartResponse(
        run_id=run.id,
        status="running",
        current_step="visual_extract",
        conversation_id=str(conversation.id),
        conversation_title=conversation.title or first_message,
    )


@router.get("/{run_id}/status", response_model=SkinDiagnosticStatusResponse)
async def get_skin_diagnostic_status(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    run = await _get_run_or_404(run_id, str(current_user.id))
    result = build_result(run.state) if run.status == "completed" else {}
    return SkinDiagnosticStatusResponse(
        run_id=run.id,
        status=run.status,
        current_step=run.current_step,
        progress=get_step_progress(run.current_step),
        pending_questions=get_pending_questions(run),
        result=result,
        error=run.error,
    )


@router.get("/{run_id}", response_model=SkinDiagnosticDetailResponse)
async def get_skin_diagnostic_detail(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    run = await _get_run_or_404(run_id, str(current_user.id))
    result = build_result(run.state) if run.status == "completed" else None
    return SkinDiagnosticDetailResponse(
        run_id=run.id,
        status=run.status,
        current_step=run.current_step,
        image_url=run.image_url,
        anamnesis=run.anamnesis,
        step_history=run.step_history,
        pending_questions=get_pending_questions(run),
        result=result,
        error=run.error,
    )


@router.post("/{run_id}/answers", response_model=SkinDiagnosticAnswersResponse)
async def submit_skin_diagnostic_answers(
    run_id: str,
    request: BulkAnswerRequest,
    current_user: User = Depends(get_current_user),
):
    run = await _get_run_or_404(run_id, str(current_user.id))
    store = await get_store()
    if run.status != "interrupt":
        return SkinDiagnosticAnswersResponse(status=run.status, current_step=run.current_step)

    if run.pending_answers or run.pending_answer:
        return SkinDiagnosticAnswersResponse(status="running", current_step=run.current_step)

    normalized_answers = []
    for item in request.answers:
        normalized_answers.append(
            {
                "question_num": item.question_num,
                "answer": normalize_yes_no(item.answer, question_num=item.question_num),
            }
        )
    run.pending_answers.extend(normalized_answers)
    await store.update(
        run_id,
        status="running",
        pending_questions=None,
        pending_answer=None,
    )
    asyncio.create_task(resume_pipeline(run_id))
    return SkinDiagnosticAnswersResponse(status="running", current_step=run.current_step)


@router.delete("/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_skin_diagnostic(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    store = await get_store()
    deleted = await store.delete(run_id, user_id=str(current_user.id))
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found")
    return None


@router.get("/uploads/{filename}")
async def get_uploaded_skin_image(
    filename: str,
    current_user: User = Depends(get_current_user),
):
    path = (UPLOADS_DIR / filename).resolve()
    uploads_root = UPLOADS_DIR.resolve()
    if uploads_root not in path.parents or not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found")
    store = await get_store()
    run = await store.get(Path(filename).stem, user_id=str(current_user.id))
    if run is None or Path(run.image_path).resolve() != path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found")
    return FileResponse(path)


async def _get_run_or_404(run_id: str, user_id: str):
    store = await get_store()
    run = await store.get(run_id, user_id=user_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found")
    return run