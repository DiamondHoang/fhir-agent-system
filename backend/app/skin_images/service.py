from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException, UploadFile, status

from app.skin_images.fhir_builders import (
    build_binary_resource,
    build_diagnostic_report_resource,
    build_media_resource,
    utc_now_fhir,
)
from app.skin_images.image_processing import binary_data, normalize_uploaded_skin_image
from app.skin_images.modality import classify_skin_modality
from app.skin_images.neo4j_repository import patient_exists, save_skin_analysis
from app.skin_images.references import build_image_api_url
from app.skin_images.schemas import SkinImageAnalyzeResponse
from app.skin_images.vision import analyze_skin_image


# ---------------------------------------------------------------------------
# Frontend adapter — luong B (Neo4j) reuses the exact same SkinImageResult
# shape/UI component that luong A (HAPI FHIR) already renders in
# ChatInterface.tsx (SkinImageThumbnail expects study_id/patient_name/
# binary_id/last_updated/view_url). Do NOT rename these keys without also
# updating frontend/lib/api.ts SkinImageResult.
# ---------------------------------------------------------------------------
def to_frontend_skin_image_result(
    row: dict,
    *,
    patient_name: str | None = None,
) -> dict:
    """Map a neo4j_repository.search_patient_skin_images() row to the
    frontend SkinImageResult shape shared with the luong A HAPI flow."""
    return {
        "study_id": row.get("diagnostic_report_id") or row.get("binary_id") or "",
        "patient_id": row.get("patient_id"),
        "patient_name": patient_name,
        "binary_id": row.get("binary_id"),
        "last_updated": row.get("created_at") or "",
        "view_url": row.get("url") or build_image_api_url(row.get("binary_id")),
    }


logger = logging.getLogger(__name__)


def normalize_patient_id(patient_id: str) -> str:
    patient_id = patient_id.strip()
    if not patient_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Patient ID is required",
        )
    return patient_id


_CONTENT_TYPE_BY_PATH_EXT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


async def save_skin_photo_result(
    *,
    patient_id: str,
    image_path,
    conclusion_text: str,
) -> dict[str, str]:
    """Persist an already-on-disk skin photo + a text conclusion into
    Neo4j as Binary/Media/DiagnosticReport, linked to an existing Patient.

    Shared by app/skin_diagnostic (router.py's "save only, no diagnosis"
    case and pipeline_runner.py's "diagnosis completed" case) so both write
    through the same Neo4j persistence path this module already used for
    the (now retired) single-shot /skin-images/analyze flow — nothing here
    ever touches the remote FHIR server (FHIR_SERVER_URL); it only calls
    CyFHIR against the local Neo4j graph via save_skin_analysis().
    """
    from pathlib import Path

    path = Path(image_path)
    content_type = _CONTENT_TYPE_BY_PATH_EXT.get(path.suffix.lower(), "image/jpeg")
    raw_bytes = path.read_bytes()
    created_at = utc_now_fhir()
    image_uuid = str(uuid.uuid4())
    binary_id = f"binary-{image_uuid}"
    media_id = f"media-{image_uuid}"
    report_id = f"report-{image_uuid}"

    resources = [
        build_binary_resource(
            binary_id=binary_id,
            content_type=content_type,
            data=binary_data(raw_bytes),
            size=len(raw_bytes),
            created_at=created_at,
        ),
        build_media_resource(
            media_id=media_id,
            patient_id=patient_id,
            binary_id=binary_id,
            content_type=content_type,
            modality="XC",
            modality_display="Dermatology",
            analysis_text=conclusion_text,
            created_at=created_at,
        ),
        build_diagnostic_report_resource(
            report_id=report_id,
            patient_id=patient_id,
            media_id=media_id,
            analysis_text=conclusion_text,
            created_at=created_at,
        ),
    ]
    return await save_skin_analysis(resources, patient_id=patient_id, patient_already_validated=True)


async def analyze_and_save_skin_image(
    *,
    patient_id: str,
    image: UploadFile,
) -> SkinImageAnalyzeResponse:
    request_started = time.perf_counter()
    patient_id = normalize_patient_id(patient_id)

    step_started = time.perf_counter()
    patient_found = await patient_exists(patient_id)
    logger.info(
        "skin_image.patient_lookup duration=%.3fs patient_id=%s",
        time.perf_counter() - step_started,
        patient_id,
    )
    if not patient_found:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Patient was not found in Neo4j",
        )

    created_at = utc_now_fhir()
    created_dt = datetime.now(timezone.utc)
    image_uuid = str(uuid.uuid4())

    step_started = time.perf_counter()
    processed_image = await normalize_uploaded_skin_image(image)
    logger.info(
        "skin_image.image_processing duration=%.3fs size=%d content_type=%s",
        time.perf_counter() - step_started,
        processed_image.size,
        processed_image.content_type,
    )

    step_started = time.perf_counter()
    modality, modality_display = await classify_skin_modality(processed_image)
    logger.info(
        "skin_image.modality duration=%.3fs modality=%s",
        time.perf_counter() - step_started,
        modality,
    )
    if modality != "XC":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Uploaded image is classified as {modality}, not dermatology (XC)",
        )

    step_started = time.perf_counter()
    analysis_text = await analyze_skin_image(processed_image)
    logger.info("skin_image.vision duration=%.3fs", time.perf_counter() - step_started)
    if not analysis_text:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Vision model returned an empty analysis",
        )

    binary_id = f"binary-{image_uuid}"
    media_id = f"media-{image_uuid}"
    report_id = f"report-{image_uuid}"

    step_started = time.perf_counter()
    resources = [
        build_binary_resource(
            binary_id=binary_id,
            content_type=processed_image.content_type,
            data=binary_data(processed_image.raw),
            size=processed_image.size,
            created_at=created_at,
        ),
        build_media_resource(
            media_id=media_id,
            patient_id=patient_id,
            binary_id=binary_id,
            content_type=processed_image.content_type,
            modality=modality,
            modality_display=modality_display,
            analysis_text=analysis_text,
            created_at=created_at,
        ),
        build_diagnostic_report_resource(
            report_id=report_id,
            patient_id=patient_id,
            media_id=media_id,
            analysis_text=analysis_text,
            created_at=created_at,
        ),
    ]
    logger.info(
        "skin_image.resource_building duration=%.3fs report_id=%s",
        time.perf_counter() - step_started,
        report_id,
    )

    step_started = time.perf_counter()
    try:
        ids = await save_skin_analysis(
            resources,
            patient_id=patient_id,
            patient_already_validated=True,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to persist skin image analysis")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to save skin image analysis to Neo4j",
        ) from exc

    logger.info(
        "skin_image.persistence duration=%.3fs report_id=%s",
        time.perf_counter() - step_started,
        ids["diagnostic_report_id"],
    )
    logger.info(
        "skin_image.total duration=%.3fs patient_id=%s report_id=%s",
        time.perf_counter() - request_started,
        patient_id,
        ids["diagnostic_report_id"],
    )

    return SkinImageAnalyzeResponse(
        binary_id=ids["binary_id"],
        media_id=ids["media_id"],
        diagnostic_report_id=ids["diagnostic_report_id"],
        modality=modality,
        analysis_text=analysis_text,
        image_url=build_image_api_url(ids["binary_id"]),
        content_type=processed_image.content_type,
        created_at=created_dt,
    )
