"""Live HAPI FHIR integration for dermatology photos.

Talks to a real FHIR REST server (``settings.fhir_image_base_url``) — this
is a *different* data source than the Neo4j "FHIR graph" used elsewhere in
this app for clinical-knowledge queries (see app/agents/fhir.py). Newly
created Patients/images here do NOT appear in that graph.

Resource shape (deliberately simple — only dermatology photos, modality is
always XC):

- Patient: created from the "new patient" popup (name, gender, birth year).
- Binary: raw JPEG/PNG bytes of the photo.
- ImagingStudy: one per photo, ``subject`` -> Patient, single series/instance.
  No Media resource, no custom datetime extension — the instant a photo was
  saved is read straight off ``meta.lastUpdated`` (HAPI sets this itself).
  To avoid inventing a custom extension just to link back to the photo
  bytes, the Binary id is reused directly as ``instance.uid`` (FHIR's ``id``
  datatype accepts that character set, and HAPI's own Binary ids are plain
  numeric strings, so this round-trips cleanly).
"""

from __future__ import annotations

import logging
import unicodedata
from typing import Any

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# Dermatology photo, per DICOM's modality code system — the only modality
# this module ever writes, so it is never taken as a parameter.
_MODALITY_CODE = "XC"
_MODALITY_DISPLAY = "External-camera Photography"
_MODALITY_SYSTEM = "http://dicom.nema.org/resources/ontology/DCM"
# Secondary Capture / VL Photographic Image Storage SOP class — plain photos
# have no real DICOM SOP class; this is the closest standard placeholder.
_SOP_CLASS_SYSTEM = "urn:ietf:rfc:3986"
_SOP_CLASS_CODE = "1.2.840.10008.5.1.4.1.1.7.4"

_FHIR_JSON_HEADERS = {
    "Content-Type": "application/fhir+json",
    "Accept": "application/fhir+json",
}


class FhirImageError(RuntimeError):
    """Raised when the FHIR server rejects or fails a request."""


def _base_url() -> str:
    return settings.fhir_image_base_url.rstrip("/")


async def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=_base_url(), timeout=settings.fhir_image_timeout)


# ---------------------------------------------------------------------------
# Patient
# ---------------------------------------------------------------------------

async def create_patient(name: str, gender: str | None, birth_year: str | None) -> dict[str, Any]:
    """Create a minimal Patient. Returns {"patient_id": ..., "name": ...}.

    gender: "male" | "female" | "other" | "unknown" | None
    birth_year: e.g. "1990" (FHIR accepts a year-only birthDate)
    """
    clean_name = name.strip()
    # Split "Nguyễn Kim Cương" -> family="Nguyễn", given=["Kim", "Cương"]
    # (Vietnamese order: family name first). This is in addition to `text`,
    # never instead of it — `text` stays the source of truth for display,
    # but populating family/given lets HAPI's native `name` search parameter
    # (a *prefix*-only match) succeed on individual name parts, not just on
    # the very first word of the full string. Search still falls back to a
    # substring match server-side (see search_patients_by_name) for
    # fragments that land in the middle of a word.
    words = clean_name.split()
    human_name: dict[str, Any] = {"use": "anonymous", "text": clean_name}
    if len(words) >= 2:
        human_name["family"] = words[0]
        human_name["given"] = words[1:]
    elif words:
        human_name["given"] = words

    payload: dict[str, Any] = {
        "resourceType": "Patient",
        "name": [human_name],
    }
    if gender:
        payload["gender"] = gender
    if birth_year:
        payload["birthDate"] = str(birth_year)

    async with await _client() as client:
        resp = await client.post("/Patient", json=payload, headers=_FHIR_JSON_HEADERS)
    if resp.status_code not in (200, 201):
        logger.error("FHIR Patient create failed: %s %s", resp.status_code, resp.text[:500])
        raise FhirImageError(f"FHIR Patient create failed: {resp.text[:300]}")
    data = resp.json()
    patient_id = data["id"]
    logger.info("Patient/%s created (name=%r)", patient_id, name)
    return {"patient_id": patient_id, "name": clean_name}


def _normalize_for_match(text: str) -> str:
    """Lowercase + strip Vietnamese diacritics, e.g. "Kim Cương" ->
    "kim cuong". Used so a fragment search matches regardless of accents
    or how the doctor typed the query."""
    decomposed = unicodedata.normalize("NFD", text)
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return stripped.replace("đ", "d").replace("Đ", "D").lower().strip()


def _patients_from_bundle(bundle: dict[str, Any]) -> list[dict[str, Any]]:
    results = []
    for entry in bundle.get("entry", []):
        resource = entry.get("resource", {})
        names = resource.get("name", [])
        display_name = names[0].get("text") if names else None
        results.append({"patient_id": resource.get("id"), "name": display_name or "(không tên)"})
    return results


async def search_patients_by_name(query: str, count: int = 20) -> list[dict[str, Any]]:
    """Search Patient by name fragment, regardless of where the fragment
    falls in the full name and regardless of accents/case.

    HAPI's plain ``name`` search parameter is a *prefix*-only match per the
    FHIR spec — a query like "Kim Cương" will NOT match a stored patient
    named "Nguyễn Kim Cương" because it isn't a prefix of the family/given/
    text parts, only a match starting at the very first word would work.
    That silently broke every "lấy ảnh da của bệnh nhân <tên/tên đệm>"
    request whenever the fragment wasn't the leading word of the full name.

    Strategy: try the server-side ``:contains`` modifier first (works when
    the FHIR server allows contains searches), then always fall back to
    fetching a broader patient set and filtering client-side with an
    accent-insensitive substring match — this guarantees correct results
    even if the server has contains-search disabled.
    """
    normalized_query = _normalize_for_match(query)
    if not normalized_query:
        return []

    async with await _client() as client:
        resp = await client.get(
            "/Patient",
            params={"name:contains": query, "_count": count},
            headers=_FHIR_JSON_HEADERS,
        )
    if resp.status_code == 200:
        results = _patients_from_bundle(resp.json())
        if results:
            return results
    elif resp.status_code not in (400, 422):
        # A real server error (not just "modifier unsupported") — surface it.
        logger.error("FHIR Patient :contains search failed: %s %s", resp.status_code, resp.text[:500])

    # Fallback: pull a broad set of patients and match substrings locally.
    async with await _client() as client:
        resp = await client.get(
            "/Patient",
            params={"_count": max(count, 200), "_sort": "-_lastUpdated"},
            headers=_FHIR_JSON_HEADERS,
        )
    if resp.status_code != 200:
        logger.error("FHIR Patient search failed: %s %s", resp.status_code, resp.text[:500])
        raise FhirImageError(f"FHIR Patient search failed: {resp.text[:300]}")
    all_patients = _patients_from_bundle(resp.json())
    matched = [p for p in all_patients if normalized_query in _normalize_for_match(p["name"])]
    return matched[:count]


# ---------------------------------------------------------------------------
# Binary + ImagingStudy
# ---------------------------------------------------------------------------

async def _create_binary(raw_bytes: bytes, content_type: str) -> str:
    async with await _client() as client:
        resp = await client.post(
            "/Binary",
            content=raw_bytes,
            headers={"Content-Type": content_type, "Accept": "application/fhir+json"},
        )
    if resp.status_code not in (200, 201):
        logger.error("FHIR Binary create failed: %s %s", resp.status_code, resp.text[:500])
        raise FhirImageError(f"FHIR Binary create failed: {resp.text[:300]}")
    return resp.json()["id"]


async def save_skin_image(patient_id: str, raw_bytes: bytes, content_type: str) -> dict[str, Any]:
    """Upload a dermatology photo: Binary bytes, then an ImagingStudy pointing at it.

    Returns {"study_id", "binary_id"}.
    """
    binary_id = await _create_binary(raw_bytes, content_type)

    imaging_study = {
        "resourceType": "ImagingStudy",
        "status": "available",
        "subject": {"reference": f"Patient/{patient_id}"},
        "modality": [{"system": _MODALITY_SYSTEM, "code": _MODALITY_CODE, "display": _MODALITY_DISPLAY}],
        "series": [
            {
                "uid": f"series-{binary_id}",
                "number": 1,
                "modality": {"system": _MODALITY_SYSTEM, "code": _MODALITY_CODE},
                "numberOfInstances": 1,
                "instance": [
                    {
                        "uid": binary_id,
                        "sopClass": {"system": _SOP_CLASS_SYSTEM, "code": _SOP_CLASS_CODE},
                        "number": 1,
                    }
                ],
            }
        ],
    }
    async with await _client() as client:
        resp = await client.post("/ImagingStudy", json=imaging_study, headers=_FHIR_JSON_HEADERS)
    if resp.status_code not in (200, 201):
        logger.error("FHIR ImagingStudy create failed: %s %s", resp.status_code, resp.text[:500])
        raise FhirImageError(f"FHIR ImagingStudy create failed: {resp.text[:300]}")
    study_id = resp.json()["id"]
    logger.info("ImagingStudy/%s created for Patient/%s (Binary/%s)", study_id, patient_id, binary_id)
    return {"study_id": study_id, "binary_id": binary_id}


async def fetch_binary(binary_id: str) -> tuple[bytes, str]:
    """Return (raw_bytes, content_type) for a Binary resource."""
    async with await _client() as client:
        resp = await client.get(f"/Binary/{binary_id}")
    if resp.status_code != 200:
        logger.error("FHIR Binary fetch failed: %s %s", binary_id, resp.status_code)
        raise FhirImageError(f"FHIR Binary {binary_id} fetch failed: {resp.status_code}")
    content_type = resp.headers.get("content-type", "image/jpeg")
    return resp.content, content_type


# ---------------------------------------------------------------------------
# Query
# ---------------------------------------------------------------------------

async def search_skin_images(
    *,
    patient_id: str | None = None,
    patient_name: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    sort_desc: bool = True,
    count: int = 20,
) -> list[dict[str, Any]]:
    """Search ImagingStudy resources, filtered natively by HAPI search params
    (no client-side fetch-everything-then-filter).

    date_from/date_to: "YYYY-MM-DD", filtered against the server's own
    ``_lastUpdated`` — no extension of ours needed.
    """
    resolved_patient_id = patient_id
    resolved_patient_name = None
    if not resolved_patient_id and patient_name:
        matches = await search_patients_by_name(patient_name, count=5)
        if not matches:
            return []
        resolved_patient_id = matches[0]["patient_id"]
        resolved_patient_name = matches[0]["name"]

    params: dict[str, Any] = {
        "_count": count,
        "_sort": "-_lastUpdated" if sort_desc else "_lastUpdated",
    }
    if resolved_patient_id:
        params["subject"] = f"Patient/{resolved_patient_id}"
    last_updated: list[str] = []
    if date_from:
        last_updated.append(f"ge{date_from}")
    if date_to:
        last_updated.append(f"le{date_to}")
    if last_updated:
        params["_lastUpdated"] = last_updated

    async with await _client() as client:
        resp = await client.get("/ImagingStudy", params=params, headers=_FHIR_JSON_HEADERS)
    if resp.status_code != 200:
        logger.error("FHIR ImagingStudy search failed: %s %s", resp.status_code, resp.text[:500])
        raise FhirImageError(f"FHIR ImagingStudy search failed: {resp.text[:300]}")
    bundle = resp.json()

    results = []
    for entry in bundle.get("entry", []):
        resource = entry.get("resource", {})
        study_id = resource.get("id")
        last_updated_ts = resource.get("meta", {}).get("lastUpdated", "")
        binary_id = None
        try:
            binary_id = resource["series"][0]["instance"][0]["uid"]
        except (KeyError, IndexError):
            pass
        subject_ref = resource.get("subject", {}).get("reference", "")
        results.append(
            {
                "study_id": study_id,
                "patient_id": subject_ref.split("/", 1)[-1] if subject_ref else resolved_patient_id,
                "patient_name": resolved_patient_name,
                "binary_id": binary_id,
                "last_updated": last_updated_ts,
                "view_url": f"/api/skin-diagnostics/fhir-image/{binary_id}" if binary_id else None,
            }
        )
    return results