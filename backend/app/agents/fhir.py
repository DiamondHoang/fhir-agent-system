from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import logging
import os
import time
import traceback
import uuid
from dataclasses import dataclass
from typing import Annotated, Any

from app.core.config import settings
from openai import AsyncOpenAI
from pydantic import Field
from pydantic_ai import Agent, ModelSettings, RunContext
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.usage import UsageLimits

from app.graph.client import execute_cypher, get_collector, get_schema
from app.services.long_term_memory import save_conversation_memory, search_memories
from app.skin_diagnostic.service import start_skin_diagnostic_from_binary
from app.skin_images.neo4j_repository import search_patient_skin_images
from app.skin_images.schemas import SkinImageSearchFilters, SkinImageSummary
from app.skin_images.search_filters import resolve_skin_image_filters
from app.skin_images.service import to_frontend_skin_image_result


SYSTEM_PROMPT = """
ROLE

You are a clinical data assistant operating on a FHIR-oriented Neo4j graph.

Your responsibility is to produce evidence-grounded answers.

You must:
- retrieve relevant evidence;
- validate evidence;
- answer only from retrieved information.

You must never:
- invent missing data;
- infer unsupported relationships;
- guess code meanings;
- create clinical conclusions without evidence.


==================================================
REQUEST ROUTING (choose a capability before acting)
==================================================

Two distinct capabilities are available. Decide which one the request needs
before calling anything:

1. PATIENT / RECORD DATA REQUESTS
   The user wants facts already stored about a patient: history, encounters,
   observations, medications, identifying a patient, timelines, counts, etc.
   -> Use the FHIR graph tools (search_patient, search_resource,
      get_related_resources, list_resource_fields, get_resource_field,
      resolve_reference, resolve_coding, run_cypher, ...).

2. SKIN / DERMATOLOGY DIAGNOSIS REQUESTS
   The user is asking you to diagnose, assess, or report on a skin lesion,
   rash, or other dermatological complaint (e.g. "bệnh nhân bị ngứa, hãy
   chẩn đoán bệnh").

   First decide WHOSE photo is being diagnosed:

   a) A NAMED PATIENT (not "I"/the current chat user) is the subject —
      either named in this same message (e.g. "lấy ảnh gần nhất của Nam
      Vũ, bệnh nhân nổi mảng trắng, hãy chẩn đoán"), OR named earlier in
      this same conversation and the current message is a follow-up about
      that same patient's symptoms (e.g. a prior turn already looked up
      "Nam Vũ"'s photo, and this turn just says "bệnh nhân nổi nhiều mảng
      trắng, hãy chẩn đoán bệnh" with no new photo attached).
      -> Use start_diagnosis_from_patient_image (or find_patient_skin_images
         + start_skin_diagnostic if the patient's photo lives in the Neo4j
         graph) to resolve and diagnose that named patient's most recent
         photo. If a binary_id for this patient was already found earlier
         in this same conversation, reuse it directly instead of looking it
         up again (see REUSE FIRST later in this prompt) — do not call
         diagnose_skin_condition for a named patient, since that tool only
         ever reports on the current chat user's own uploaded photo and
         will incorrectly say no photo was attached.

   b) The subject is the current chat user's OWN just-uploaded photo in
      this chat (no other patient named or implied), or the user is asking
      about the status/result of a diagnosis already running for them.
      -> Call diagnose_skin_condition. Diagnosis in this system is
         image-based: it runs a dedicated vision + clinical-interview
         pipeline that only starts once the user attaches a photo in the
         chat composer. You cannot diagnose from a text description alone
         and must not guess a diagnosis yourself — report what
         diagnose_skin_condition returns (an existing result, an
         in-progress run, or instructions to attach a photo) and relay
         that to the user.
         A skin diagnosis result from this path is about the uploaded
         photo only — it is NOT automatically linked to any named patient.
         If the request that triggered it did not name a patient, treat
         that result as belonging to an unidentified/unnamed subject.

IDENTITY GUARD — do not let a recent skin diagnosis leak onto a different,
named patient. If the current request asks about a specific patient by
name or identifier (e.g. "bệnh nhân Nam Vũ bị bệnh gì?"), that is ALWAYS
category 1 (PATIENT / RECORD DATA REQUEST) — call search_patient / FHIR
graph tools for that name, even if a skin diagnosis was just produced in
this same conversation. Only reuse a prior skin diagnosis result to answer
a named-patient question if that name was explicitly the subject of that
diagnosis request. When in doubt about whether the previous diagnosis and
the newly named patient are the same person, look them up in FHIR rather
than assuming.

A single request may need both in sequence (e.g. "look up this patient's
last visit, then diagnose the rash they mentioned") — in that case, call
each relevant tool for its part of the request. If the request only needs
general clinical knowledge and touches neither a specific patient's stored
data nor a skin lesion, answer directly without tools.


==================================================
REQUEST UNDERSTANDING
==================================================

The current user request is the only task to solve.

Before using tools, identify:

1. What information is requested?
2. What evidence is required?
3. What is currently unknown?

Classify the missing information as one of:

- ENTITY DISCOVERY:
  Find the target resource or entity.

- RESOURCE VERIFICATION:
  Confirm a known resource exists.

- FIELD RETRIEVAL:
  Read information from a known resource.

- RELATIONSHIP RETRIEVAL:
  Find resources connected to an existing resource.

- REFERENCE OR CODE RESOLUTION:
  Resolve identifiers, references, or coded concepts.

- DATA COMPUTATION:
  Perform aggregation, comparison, filtering, or graph computation
  after the required evidence has been retrieved.


==================================================
TOOL SELECTION POLICY
==================================================

Always select the smallest capability that resolves the current uncertainty.

Follow this priority:

1. Use discovery capabilities when the target entity is unknown.

2. Use verification capabilities when the target identity is known.

3. Use field-reading capabilities when the resource exists but information
   inside it is required.

4. Use relationship or resolution capabilities when connected information
   is required.

5. Use computation capabilities only after the required evidence set exists.


Do not skip earlier stages unless the required evidence is already available.

Do not choose a more powerful tool when a narrower capability is sufficient.


==================================================
GENERAL QUERY RESTRICTION
==================================================

General graph query tools are for computation, not normal retrieval.

Use them only when:

- the required entities are already identified;
- the required relationships are understood;
- specialized capabilities cannot express the operation;
- the operation requires custom aggregation, filtering, joining,
  or graph computation.

Do not use general graph queries to replace:
- entity discovery;
- resource lookup;
- field retrieval;
- relationship resolution;
- code resolution.


==================================================
EVIDENCE VALIDATION
==================================================

Tool output is evidence, not automatically the final answer.

Validate:

- Is this the correct entity?
- Is this the correct resource scope?
- Does the returned information answer the request?

Do not treat an empty result as proof that data does not exist.

An empty result means:

"The current retrieval attempt found no evidence."

Before concluding missing data:

- check whether the retrieval approach matches the requested information;
- consider whether another capability is required;
- distinguish unavailable data from unattempted retrieval.


==================================================
MULTI RESOURCE REQUEST
==================================================

For requests involving multiple resources:

First determine:

- the complete resource population required;
- the fields needed from each resource;
- the related information required.

Then:

- retrieve the primary resource set;
- retrieve required related information;
- use batch operations when available;
- account for every requested resource.

Do not:

- assume a partial result is complete;
- stop after finding examples;
- claim completeness from bounded results.


==================================================
TOOL EXECUTION RULES
==================================================

Always:

- follow tool schemas exactly;
- provide correct argument types;
- reuse previously retrieved values;
- prefer batch operations for repeated work.
- treat a tool name and its complete argument set as one unique call;
- reuse the existing result instead of calling the same tool again with the
  same or equivalent arguments during the current request.
- for get_resource_field and get_resource_fields_batch, pass one field name or
  comma-separated field names in field_name when multiple known fields are
  needed from the same resource scope, instead of calling the tool once per
  field.

Never:

- guess identifiers;
- guess field names;
- guess graph structure;
- repeat a tool call with the same or equivalent arguments;
- repeat identical failed operations.

If a tool fails:

- correct the specific issue once;
- stop if the corrected attempt fails.


==================================================
STOP CONDITION
==================================================

Stop retrieving when:

- the requested scope is covered;
- required fields are collected;
- unresolved information cannot affect the answer.

Do not stop only because an answer can already be generated.


==================================================
FHIR EVIDENCE RULES
==================================================

Preserve when relevant:

- resource identifiers;
- resource types;
- dates;
- statuses;
- quantities;
- units;
- codes.

Use available display values.

Never interpret unknown codes.

Never infer beyond retrieved evidence.


==================================================
SKIN IMAGE RETRIEVAL (photos are stored in the local Neo4j graph)
==================================================

Saved dermatology photos are stored directly in the local Neo4j graph (as FHIR
Binary, Media, and DiagnosticReport nodes connected to Patients).

Use `search_skin_images` or `find_patient_skin_images` to search and retrieve
past skin photos for a patient.

For latest/gần nhất, use count=1 and sort=desc. For a specific number, pass
that count. For all/toàn bộ/tất cả, set all_images=true.

Never invent binary_id, view_url, or any photo metadata; never query
Binary.data directly; never ignore the tool result.


==================================================
SKIN DIAGNOSTIC ROUTING (saved Neo4j Patient photos)
==================================================

Choose the correct dermatology capability for diagnosis:

- The user's own just-uploaded photo in this chat, with no other patient
  named or implied -> diagnose_skin_condition.
- A specific already-saved patient photo by name and symptom ->
  start_diagnosis_from_patient_image (or start_skin_diagnostic if binary_id
  is already known).

REUSE FIRST — if a binary_id for this patient's photo already appears
anywhere earlier in this same conversation, do NOT search for or display it
again. Call start_skin_diagnostic directly with that binary_id.

Do not diagnose yourself in words from a text description alone —
dermatology diagnosis in this system is always image-based, through one of
the tools above. Never request, echo, or store Base64 image bytes or
Binary.data in model context or in your reply.


==================================================
FINAL RESPONSE
==================================================

Answer in the user's language.

Write the final answer as a clinical/business narrative, not a raw FHIR
resource inventory. Convert retrieved resources into the most meaningful
human-readable facts available in the evidence. Prefer clinical or business
meaning over technical identifiers.

Do not present internal resource IDs as the main content and do not summarize
groups of records as lists of IDs. If a record has no usable human-readable
content in the retrieved evidence, say that the record exists but its details
were not available. Include technical identifiers only when the user asks for
them or when they are necessary to disambiguate records.

Provide:

- direct answer;
- structured tables or lists when appropriate;
- clear distinction between facts and uncertainty.

Skin photo results (search_skin_images / start_diagnosis_from_patient_image)
are rendered by the UI as actual image thumbnails as soon as the tool
returns them — never include a view_url, binary id link, or any raw URL
pointing at a photo in your reply; it needs an auth header the user's
browser can't attach, so it would only ever 401. Just describe the result
in words (patient name, count, dates); the photo(s) already appear on
screen.

Do not reveal:

- internal reasoning;
- tool selection process;
- hidden analysis.
"""
@dataclass
class AgentDeps:
    """Dependencies injected into the agent."""

    session_id: str
    user_id: str
    active_patient_id: str = ""


internal_llm_client = AsyncOpenAI(
    base_url=settings.internal_llm_base_url,
    api_key=settings.internal_llm_api_key or "internal",
)

internal_llm_model = OpenAIChatModel(
    settings.internal_llm_model,
    provider=OpenAIProvider(openai_client=internal_llm_client),
)

agent = Agent(
    internal_llm_model,
    system_prompt=SYSTEM_PROMPT,
    deps_type=AgentDeps,
    retries=1,
)



# ---------------------------------------------------------------------------
# Debug logging
# ---------------------------------------------------------------------------

_LOG_LEVEL = os.getenv("FHIR_AGENT_LOG_LEVEL", "DEBUG").upper()
_LOG_FILE = os.getenv(
    "FHIR_AGENT_LOG_FILE",
    "logs/fhir_agent_debug.log",
)
logger = logging.getLogger("fhir_agent")
logger.setLevel(
    getattr(logging, _LOG_LEVEL, logging.DEBUG)
)
logger.propagate = False

# Write all agent logs to one file only.
if not logger.handlers:
    log_path = os.path.abspath(_LOG_FILE)
    log_directory = os.path.dirname(log_path)

    if log_directory:
        os.makedirs(log_directory, exist_ok=True)

    file_handler = logging.FileHandler(
        log_path,
        mode="w",
        encoding="utf-8",
    )
    file_handler.setFormatter(
        logging.Formatter(
            "%(asctime)s | %(levelname)s | %(message)s"
        )
    )
    logger.addHandler(file_handler)


def _pretty_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            default=str,
            ensure_ascii=False,
            indent=2,
        )
    except Exception:
        return repr(value)


def _log_payload(title: str, value: Any) -> None:
    text = _pretty_json(value)
    logger.debug("%s\n%s", title, text)


_AGENT_REQUEST_LIMIT = 100
_TOOL_RESULT_LIMIT = 200
_BATCH_RESOURCE_LIMIT = int(
    os.getenv("FHIR_AGENT_BATCH_RESOURCE_LIMIT", "50")
)
_MAX_MODEL_TOOL_RESULT_CHARS = int(
    os.getenv("FHIR_AGENT_MAX_TOOL_RESULT_CHARS", "400000")
)
_BLOCKED_TRAVERSAL_RELATIONSHIPS = ("RESOLVES_TO", "DEFINED_BY")


def _json_response(
    *,
    status: str,
    data: Any,
    count: int | None = None,
    message: str | None = None,
) -> str:
    payload: dict[str, Any] = {"status": status, "data": data}
    if count is not None:
        payload["count"] = count
    if message:
        payload["message"] = message
    return json.dumps(payload, default=str, ensure_ascii=False)


def _parse_ids(resource_ids: str) -> list[str]:
    return list(
        dict.fromkeys(
            item.strip()
            for item in resource_ids.split(",")
            if item.strip()
        )
    )


def _parse_field_names(field_name: str) -> list[str]:
    return list(
        dict.fromkeys(
            item.strip()
            for item in field_name.split(",")
            if item.strip()
        )
    )


def _normalize_optional_exact_filter(value: str) -> str:
    normalized = value.strip()
    return "" if normalized == "*" else normalized


def _batch_size_error(resource_ids: list[str]) -> str | None:
    if len(resource_ids) <= _BATCH_RESOURCE_LIMIT:
        return None
    return _json_response(
        status="error",
        count=0,
        data=[],
        message=(
            f"A batch accepts at most {_BATCH_RESOURCE_LIMIT} resource ids; "
            "split the ids into smaller batches."
        ),
    )


async def _execute_tool(
    *,
    tool_name: str,
    cypher: str,
    parameters: dict[str, Any] | None = None,
) -> str:
    actual_parameters = parameters or {}

    run_id = _CURRENT_RUN_ID.get()
    handler_name = _CURRENT_HANDLER.get()
    logger.info(
        "TOOL START | run_id=%s | handler=%s | tool=%s",
        run_id, handler_name, tool_name,
    )
    _log_payload(
        f"TOOL INPUT | {tool_name} | parameters",
        actual_parameters,
    )
    # logger.debug(
    #     "TOOL INPUT | %s | cypher\n%s",
    #     tool_name,
    #     cypher.strip(),
    # )

    try:
        rows = await execute_cypher(
            cypher,
            actual_parameters,
            tool_name=tool_name,
        )

        _log_payload(
            f"NEO4J RAW RESULT | {tool_name}",
            rows,
        )

        payload: dict[str, Any] = {
            "status": "ok",
            "count": len(rows),
            "data": rows,
        }

        model_content = json.dumps(
            payload,
            default=str,
            ensure_ascii=False,
        )

        if len(model_content) > _MAX_MODEL_TOOL_RESULT_CHARS:
            preview_rows = rows[:20]
            payload = {
                "status": "truncated",
                "count": len(rows),
                "returned_count": len(preview_rows),
                "data": preview_rows,
                "message": (
                    "The tool result exceeded the model payload limit. "
                    "Use a narrower field, fewer resource ids, or a dedicated tool."
                ),
            }
            model_content = json.dumps(
                payload,
                default=str,
                ensure_ascii=False,
            )

        _log_payload(
            f"MODEL TOOL RESULT OBJECT | {tool_name}",
            payload,
        )
        logger.debug(
            "MODEL TOOL RESULT STRING | %s\n%s",
            tool_name,
            model_content,
        )
        _record_tool_result_chars(len(model_content))
        logger.info(
            "TOOL END | run_id=%s | handler=%s | tool=%s | status=%s | count=%s | chars=%s",
            run_id, handler_name, tool_name, payload["status"],
            payload["count"], len(model_content),
        )

        return model_content

    except Exception as exc:
        payload = {
            "status": "error",
            "count": 0,
            "data": [],
            "message": str(exc),
        }

        model_content = json.dumps(
            payload,
            default=str,
            ensure_ascii=False,
        )

        logger.exception(
            "TOOL ERROR | %s | %s",
            tool_name,
            exc,
        )
        logger.debug(
            "MODEL TOOL RESULT STRING | %s\n%s",
            tool_name,
            model_content,
        )

        return model_content


# ---------------------------------------------------------------------------
# Generic FHIR tools
# ---------------------------------------------------------------------------

@agent.tool
async def search_patient(
    ctx: RunContext[AgentDeps],
    query: Annotated[
        str,
        Field(description="Patient FHIR id, HumanName text, family/given name fragment, or Identifier value to search for; use an empty string to list Patient resources."),
    ],
) -> str:
    """
    Search or list Patient resources.

    Use when:
    - You need to find candidate Patient FHIRResource ids from a name, identifier, or Patient id.
    - You need the Patient resource list before a batch operation.

    Do not use when:
    - You already have the Patient id; prefer search_resource or relationship tools.
    - You need fields from a known Patient; prefer list_resource_fields or get_resource_field.

    Behavior:
    - Matches Patient.id exactly and name or identifier values by case-insensitive contains.
    - An empty query lists up to 200 matching Patient resources.
    - Does not traverse from Patient to clinical resources.

    Returns:
        str: JSON payload with matching Patient resource_id, resource_type, direct name
        properties, and identifier properties, limited to 200 rows.
    """
    cypher = """
    MATCH (patient:FHIRResource:Patient)
    OPTIONAL MATCH (patient)-[:name]->(name)
    OPTIONAL MATCH (patient)-[:identifier]->(identifier)
    WITH patient,
         collect(DISTINCT name) AS names,
         collect(DISTINCT identifier) AS identifiers
    WHERE $query = ''
       OR patient.id = $query
       OR any(name_node IN names WHERE
            toLower(coalesce(name_node.text, '')) CONTAINS toLower($query)
            OR toLower(coalesce(name_node.family, '')) CONTAINS toLower($query)
            OR any(given IN coalesce(name_node.given, [])
                   WHERE toLower(given) CONTAINS toLower($query))
          )
       OR any(identifier_node IN identifiers WHERE
            toLower(coalesce(identifier_node.value, ''))
            CONTAINS toLower($query)
          )
    RETURN patient.id AS resource_id,
           patient.resourceType AS resource_type,
           [name_node IN names | properties(name_node)] AS names,
           [identifier_node IN identifiers | properties(identifier_node)] AS identifiers
    ORDER BY patient.id
    LIMIT $result_limit
    """
    return await _execute_tool(
        tool_name="search_patient",
        cypher=cypher,
        parameters={
            "query": query,
            "result_limit": _TOOL_RESULT_LIMIT,
        },
    )


@agent.tool
async def search_resource(
    ctx: RunContext[AgentDeps],
    resource_type: Annotated[
        str,
        Field(description="Exact FHIR resourceType to match, such as Patient, Encounter, Observation, or Condition."),
    ],
    resource_id: Annotated[
        str,
        Field(description="Exact FHIR id of the resource to find."),
    ],
) -> str:
    """
    Find one FHIRResource by exact resourceType and FHIR id.

    Use when:
    - You need to verify that a known FHIRResource exists.
    - You need root properties for one known resource.

    Do not use when:
    - You only have a patient name or identifier; prefer search_patient.
    - You need child fields or nested FHIR elements; prefer list_resource_fields or get_resource_field.
    - You need resources related by Reference; prefer get_related_resources or resolve_reference.

    Behavior:
    - Matches only the root FHIRResource node with the exact resourceType and id.

    Returns:
        str: JSON payload with resource_type, resource_id, and root node properties only.
    """
    cypher = """
    MATCH (resource:FHIRResource {
        resourceType: $resource_type,
        id: $resource_id
    })
    RETURN resource.resourceType AS resource_type,
           resource.id AS resource_id,
           properties(resource) AS properties
    """
    return await _execute_tool(
        tool_name="search_resource",
        cypher=cypher,
        parameters={
            "resource_type": resource_type,
            "resource_id": resource_id,
        },
    )


@agent.tool
async def count_resources(
    ctx: RunContext[AgentDeps],
    resource_type: Annotated[
        str,
        Field(description="Exact FHIR resourceType to count, such as Patient, Encounter, Observation, or Condition."),
    ],
) -> str:
    """
    Count all FHIRResources of one resourceType.

    Use when:
    - The user asks for the total number of resources of a known resourceType.
    - You need an exact count rather than a bounded resource list.

    Do not use when:
    - The user needs resource ids, names, fields, or individual records.
    - The count requires custom filters or relationships not accepted by this tool.

    Behavior:
    - Counts root FHIRResource nodes with the exact resourceType.
    - Does not inspect fields, relationships, or referenced resources.

    Returns:
        str: JSON payload containing resource_type and total_count. It does not
        return individual resources.
    """
    cypher = """
    MATCH (resource:FHIRResource {
        resourceType: $resource_type
    })
    RETURN $resource_type AS resource_type,
           count(resource) AS total_count
    """
    return await _execute_tool(
        tool_name="count_resources",
        cypher=cypher,
        parameters={"resource_type": resource_type},
    )


@agent.tool
async def get_related_resources(
    ctx: RunContext[AgentDeps],
    resource_type: Annotated[
        str,
        Field(description="Exact resourceType of the target FHIRResource being referenced."),
    ],
    resource_id: Annotated[
        str,
        Field(description="Exact FHIR id of the target FHIRResource being referenced."),
    ],
    related_type: Annotated[
        str,
        Field(description="Optional exact resourceType filter for source resources; use an empty string for all types."),
    ] = "",
) -> str:
    """
    Find FHIRResources that reference a selected target resource.

    Use when:
    - You have a target FHIRResource id and need source resources that point to it through a Reference.
    - You need matching resources, or one resourceType, related to a Patient, Encounter, Practitioner, or other target.

    Do not use when:
    - You need fields inside a known resource; prefer field-reading tools.
    - You need to resolve one Reference string like Patient/123; prefer resolve_reference.

    Behavior:
    - Follows Reference nodes that RESOLVES_TO the target, then searches up to 4 hops back to source FHIRResource nodes.
    - Optionally filters source resources by related_type.

    Returns:
        str: JSON payload with distinct source resource_type and resource_id pairs only,
        not field details, limited to 200 rows.
    """
    normalized_related_type = _normalize_optional_exact_filter(related_type)

    cypher = """
    MATCH (target:FHIRResource {
        resourceType: $resource_type,
        id: $resource_id
    })
    MATCH (reference:Reference)-[:RESOLVES_TO]->(target)
    MATCH (source:FHIRResource)-[*1..4]->(reference)
    WHERE source <> target
      AND ($related_type = '' OR source.resourceType = $related_type)
    WITH DISTINCT source
    ORDER BY source.resourceType, source.id
    RETURN source.resourceType AS resource_type,
           source.id AS resource_id
    LIMIT $result_limit
    """
    return await _execute_tool(
        tool_name="get_related_resources",
        cypher=cypher,
        parameters={
            "resource_type": resource_type,
            "resource_id": resource_id,
            "related_type": normalized_related_type,
            "result_limit": _TOOL_RESULT_LIMIT,
        },
    )


@agent.tool
async def get_related_resources_batch(
    ctx: RunContext[AgentDeps],
    resource_type: Annotated[
        str,
        Field(description="Exact resourceType shared by all target FHIRResources."),
    ],
    resource_ids: Annotated[
        str,
        Field(description="Comma-separated target FHIR ids; at most 50 ids per call; this tool expects text, not an array."),
    ],
    related_type: Annotated[
        str,
        Field(description="Exact resourceType filter for referencing source resources; use an empty string only when all related types are required."),
    ],
) -> str:
    """
    Find FHIRResources that reference multiple selected target resources.

    Use when:
    - The same relationship lookup is required for multiple known target ids.
    - A search or earlier tool returned a bounded target set for batch traversal.

    Do not use when:
    - You have only one target; prefer get_related_resources.
    - You need fields from the related resources; use a batch field-reading tool
      after this tool returns their resource ids.
    - You need to resolve Reference text; prefer resolve_reference.

    Behavior:
    - Follows Reference nodes that RESOLVES_TO each target, then searches up to
      4 hops back to source FHIRResource nodes.
    - Optionally filters source resources by related_type.
    - Does not read fields from source resources.

    Returns:
        str: JSON payload with one row per requested target. Each row contains
        target_resource_id, target_found, and a related_resources list of distinct
        resource_type and resource_id pairs. An empty list means no matching
        relationship was found for that processed target.
    """
    ids = _parse_ids(resource_ids)
    normalized_related_type = _normalize_optional_exact_filter(related_type)

    if not ids:
        return _json_response(
            status="error",
            count=0,
            data=[],
            message="resource_ids must contain at least one id",
        )
    if batch_error := _batch_size_error(ids):
        return batch_error

    cypher = """
    UNWIND $resource_ids AS requested_id

    OPTIONAL MATCH (target:FHIRResource {
        resourceType: $resource_type,
        id: requested_id
    })

    OPTIONAL MATCH (reference:Reference)-[:RESOLVES_TO]->(target)
    OPTIONAL MATCH (source:FHIRResource)-[*1..4]->(reference)
    WHERE source <> target
      AND ($related_type = '' OR source.resourceType = $related_type)

    WITH requested_id,
         target,
         collect(DISTINCT source) AS related_sources

    RETURN requested_id AS target_resource_id,
           target IS NOT NULL AS target_found,
           [
               source IN related_sources |
               {
                   resource_type: source.resourceType,
                   resource_id: source.id
               }
           ] AS related_resources
    ORDER BY target_resource_id
    """

    return await _execute_tool(
        tool_name="get_related_resources_batch",
        cypher=cypher,
        parameters={
            "resource_type": resource_type,
            "resource_ids": ids,
            "related_type": normalized_related_type,
        },
    )


@agent.tool
async def get_resources_for_encounter(
    ctx: RunContext[AgentDeps],
    encounter_id: Annotated[
        str,
        Field(description="Exact FHIR id of the Encounter target."),
    ],
    resource_types: Annotated[
        str,
        Field(description="Optional comma-separated resourceTypes to include, such as Observation,Condition; empty means all types."),
    ] = "",
) -> str:
    """
    Find FHIRResources associated with one Encounter.

    Use when:
    - You have an Encounter id and need resources that reference that Encounter.
    - You need an Encounter-scoped resource set before reading fields.

    Do not use when:
    - You need to inspect fields on the Encounter itself; prefer list_resource_fields or get_resource_field.
    - You need to resolve a single Reference string; prefer resolve_reference.

    Behavior:
    - Finds Reference nodes that RESOLVES_TO the Encounter and source FHIRResource nodes up to 4 hops away.
    - resource_types is parsed as comma-separated text and filters source resourceType values when provided.

    Returns:
        str: JSON payload with distinct resource_type and resource_id pairs only, not field
        details, limited to 200 rows.
    """

    requested_types = _parse_ids(resource_types)

    cypher = """
    MATCH (encounter:FHIRResource:Encounter {
        resourceType: 'Encounter',
        id: $encounter_id
    })

    MATCH (encounter_reference:Reference)-[:RESOLVES_TO]->(encounter)
    MATCH (resource:FHIRResource)-[*1..4]->(encounter_reference)

    WHERE resource <> encounter
      AND (
          size($resource_types) = 0
          OR resource.resourceType IN $resource_types
      )

    WITH DISTINCT resource
    ORDER BY resource.resourceType, resource.id

    RETURN resource.resourceType AS resource_type,
           resource.id AS resource_id
    LIMIT $result_limit
    """

    return await _execute_tool(
        tool_name="get_resources_for_encounter",
        cypher=cypher,
        parameters={
            "encounter_id": encounter_id,
            "resource_types": requested_types,
            "result_limit": _TOOL_RESULT_LIMIT,
        },
    )


@agent.tool
async def list_resource_fields(
    ctx: RunContext[AgentDeps],
    resource_type: Annotated[
        str,
        Field(description="Exact resourceType of the single FHIRResource to inspect."),
    ],
    resource_id: Annotated[
        str,
        Field(description="Exact FHIR id of the single FHIRResource to inspect."),
    ],
) -> str:
    """
    List root properties and direct internal FHIR fields for one resource.

    Use when:
    - You need a shallow overview of one known FHIRResource before choosing a field.
    - You need direct field names, direct properties, or node ids for expansion.

    Do not use when:
    - You have multiple ids; prefer list_resource_fields_batch.
    - You already know the specific field to read in detail; prefer get_resource_field.
    - You need to follow a Reference to another FHIRResource; prefer resolve_reference.

    Behavior:
    - Reads the root FHIRResource and its direct non-FHIRResource child nodes.
    - Does not traverse RESOLVES_TO, DEFINED_BY, blocked relationships, or into another FHIRResource.

    Returns:
        str: JSON payload with resource_type, resource_id, root_properties, and direct
        fields containing field_name, node_id, labels, direct_properties, and
        has_internal_children.
    """

    cypher = """
    MATCH (resource:FHIRResource {
        resourceType: $resource_type,
        id: $resource_id
    })

    OPTIONAL MATCH (resource)-[relationship]->(child)

    WITH resource,
         collect(
             DISTINCT CASE
                 WHEN child IS NULL
                   OR type(relationship) IN $blocked_relationships
                   OR child:FHIRResource
                 THEN NULL
                 ELSE {
                     field_name: type(relationship),
                     node_id: toString(id(child)),
                     labels: labels(child),
                     direct_properties: properties(child),
                     has_internal_children:
                         size([
                             (child)-[next]->(grandchild)
                             WHERE NOT type(next) IN $blocked_relationships
                               AND NOT grandchild:FHIRResource
                             | 1
                         ]) > 0
                 }
             END
         ) AS raw_fields

    RETURN resource.resourceType AS resource_type,
           resource.id AS resource_id,
           properties(resource) AS root_properties,
           [field IN raw_fields WHERE field IS NOT NULL] AS fields
    """

    return await _execute_tool(
        tool_name="list_resource_fields",
        cypher=cypher,
        parameters={
            "resource_type": resource_type,
            "resource_id": resource_id,
            "blocked_relationships": list(
                _BLOCKED_TRAVERSAL_RELATIONSHIPS
            ),
        },
    )

@agent.tool
async def list_resource_fields_batch(
    ctx: RunContext[AgentDeps],
    resource_type: Annotated[
        str,
        Field(description="Exact resourceType shared by every requested FHIRResource id."),
    ],
    resource_ids: Annotated[
        list[str],
        Field(description="Array of at most 50 exact FHIR ids to inspect; do not pass a JSON string."),
    ],
    blocked_relationships: Annotated[
        list[str] | None,
        Field(description="Optional relationship names to exclude from shallow field listing; omit to use server defaults."),
    ] = None,
) -> str:
    """
    List root properties and direct internal FHIR fields for multiple resources.

    Use when:
    - You need the same shallow field overview for several FHIRResources of one resourceType.
    - You have multiple ids and want one batch call instead of repeated list_resource_fields calls.

    Do not use when:
    - You have only one resource id; prefer list_resource_fields.
    - You need one known field in detail; prefer get_resource_fields_batch.
    - You need to follow Reference targets; prefer resolve_reference.

    Behavior:
    - Deduplicates and trims resource_ids before querying.
    - Reads each root FHIRResource and direct non-FHIRResource child nodes only.
    - Does not traverse RESOLVES_TO, DEFINED_BY, blocked relationships, or into another FHIRResource.

    Returns:
        str: JSON payload with one row per requested id including resource_found,
        resource_type, root_properties, and direct fields.
    """

    ids = [
        str(resource_id).strip()
        for resource_id in resource_ids
        if str(resource_id).strip()
    ]
    ids = list(dict.fromkeys(ids))

    if not ids:
        return _json_response(
            status="error",
            count=0,
            data=[],
            message="resource_ids must contain at least one id",
        )
    if batch_error := _batch_size_error(ids):
        return batch_error

    blocked = (
        blocked_relationships
        if blocked_relationships is not None
        else list(_BLOCKED_TRAVERSAL_RELATIONSHIPS)
    )

    cypher = """
    UNWIND $resource_ids AS requested_id

    OPTIONAL MATCH (resource:FHIRResource {
        resourceType: $resource_type,
        id: requested_id
    })

    OPTIONAL MATCH (resource)-[field_relationship]->(field_node)
    WHERE NOT type(field_relationship) IN $blocked_relationships
      AND NOT field_node:FHIRResource

    OPTIONAL MATCH (field_node)-[internal_relationship]->(internal_child)
    WHERE NOT type(internal_relationship) IN $blocked_relationships
      AND NOT internal_child:FHIRResource

    WITH requested_id,
         resource,
         field_relationship,
         field_node,
         count(internal_child) > 0 AS has_internal_children

    ORDER BY requested_id, type(field_relationship)

    WITH requested_id,
         resource,
         collect(
             CASE
                 WHEN field_node IS NULL THEN NULL
                 ELSE {
                     field_name: type(field_relationship),
                     node_id: toString(id(field_node)),
                     labels: labels(field_node),
                     direct_properties: properties(field_node),
                     has_internal_children: has_internal_children
                 }
             END
         ) AS raw_fields

    RETURN requested_id AS resource_id,
           resource IS NOT NULL AS resource_found,
           CASE
               WHEN resource IS NULL THEN $resource_type
               ELSE resource.resourceType
           END AS resource_type,
           CASE
               WHEN resource IS NULL THEN {}
               ELSE properties(resource)
           END AS root_properties,
           [
               field IN raw_fields
               WHERE field IS NOT NULL
           ] AS fields

    ORDER BY resource_id
    """

    return await _execute_tool(
        tool_name="list_resource_fields_batch",
        cypher=cypher,
        parameters={
            "resource_type": resource_type,
            "resource_ids": ids,
            "blocked_relationships": blocked,
        },
    )


@agent.tool
async def get_resource_field(
    ctx: RunContext[AgentDeps],
    resource_type: Annotated[
        str,
        Field(description="Exact resourceType of the single FHIRResource to read."),
    ],
    resource_id: Annotated[
        str,
        Field(description="Exact FHIR id of the single FHIRResource to read."),
    ],
    field_name: Annotated[
        str,
        Field(description="Exact field relationship/root property name to read. Pass one name or comma-separated names, such as code,valueQuantity,effectiveDateTime."),
    ],
) -> str:
    """
    Read one or more named root properties or internal FHIR fields from one resource.

    Use when:
    - You know the field_name or comma-separated field names needed for one FHIRResource.
    - A shallow field listing showed a relevant field that needs more detail.

    Do not use when:
    - You need a field across multiple resources; prefer get_resource_fields_batch.
    - You need only a shallow list of available fields; prefer list_resource_fields.
    - You need to resolve a Reference target or Coding meaning; prefer resolve_reference or resolve_coding.

    Behavior:
    - Reads matching root properties or paths starting with each requested field up to 2 internal hops.
    - Does not traverse RESOLVES_TO, DEFINED_BY, blocked relationships, or into another FHIRResource.

    Returns:
        str: JSON payload with one row per requested field containing field_found
        and values with source, node_id, path, labels, properties, and has_children.
    """
    field_names = _parse_field_names(field_name)
    if not field_names:
        return _json_response(
            status="error",
            count=0,
            data=[],
            message="field_name must contain at least one field",
        )

    cypher = """
    OPTIONAL MATCH (resource:FHIRResource {
        resourceType: $resource_type,
        id: $resource_id
    })

    UNWIND $field_names AS requested_field

    CALL {
        WITH resource, requested_field

        WITH resource, requested_field, resource[requested_field] AS root_value
        WHERE resource IS NOT NULL
          AND root_value IS NOT NULL

        RETURN {
            source: 'root_property',
            node_id: null,
            path: [requested_field],
            labels: labels(resource),
            properties: {value: root_value},
            has_children: false
        } AS value

        UNION

        WITH resource, requested_field
        MATCH path=
            (resource)-[first]->(field_node)-[*0..2]->(value_node)

        WHERE resource IS NOT NULL
          AND type(first) = requested_field
          AND all(
              relationship IN relationships(path)
              WHERE NOT type(relationship) IN $blocked_relationships
          )
          AND all(
              path_node IN nodes(path)[1..]
              WHERE NOT path_node:FHIRResource
          )

        RETURN {
            source: 'child_node',
            node_id: toString(id(value_node)),
            path: [
                relationship IN relationships(path) |
                type(relationship)
            ],
            labels: labels(value_node),
            properties: properties(value_node),
            has_children:
                size([
                    (value_node)-[next]->(child)
                    WHERE NOT type(next) IN $blocked_relationships
                      AND NOT child:FHIRResource
                    | 1
                ]) > 0
        } AS value

        UNION

        WITH resource, requested_field
        RETURN null AS value
    }

    WITH requested_field,
         resource IS NOT NULL AS resource_found,
         collect(value) AS raw_values

    RETURN requested_field AS field_name,
           resource_found,
           size([value IN raw_values WHERE value IS NOT NULL]) > 0 AS field_found,
           [
               value IN raw_values
               WHERE value IS NOT NULL |
               {
                   source: value.source,
                   node_id: value.node_id,
                   path: value.path,
                   labels: value.labels,
                   properties: value.properties,
                   has_children: value.has_children
               }
           ] AS values
    ORDER BY field_name
    """

    return await _execute_tool(
        tool_name="get_resource_field",
        cypher=cypher,
        parameters={
            "resource_type": resource_type,
            "resource_id": resource_id,
            "field_names": field_names,
            "blocked_relationships": list(
                _BLOCKED_TRAVERSAL_RELATIONSHIPS
            ),
        },
    )

@agent.tool
async def get_resource_fields_batch(
    ctx: RunContext[AgentDeps],
    resource_type: Annotated[
        str,
        Field(description="Exact resourceType shared by every requested FHIRResource id."),
    ],
    resource_ids: Annotated[
        str,
        Field(description="Comma-separated FHIR ids to read, such as 10797,10842; this tool expects text, not an array."),
    ],
    field_name: Annotated[
        str,
        Field(description="Exact field relationship/root property name to read across all requested resources. Pass one name or comma-separated names."),
    ],
) -> str:
    """
    Read one or more named root properties or internal FHIR fields from multiple resources.

    Use when:
    - You need one or more field names from several FHIRResources of one resourceType.
    - You want one batch call instead of repeated get_resource_field/get_resource_fields_batch calls.

    Do not use when:
    - You only need a shallow field overview; prefer list_resource_fields_batch.
    - You need to resolve Reference targets or Coding meanings; prefer resolve_reference or resolve_coding.

    Behavior:
    - Parses resource_ids from comma-separated text.
    - Parses field_name from comma-separated text.
    - Reads matching root properties or paths starting with each requested field up to 2 internal hops.
    - Does not traverse RESOLVES_TO, DEFINED_BY, blocked relationships, or into another FHIRResource.
    - Groups matching values by requested resource id and field name.

    Returns:
        str: JSON payload with one row per requested resource id containing
        resource_found, field_found, and fields with source, path, and
        properties. Use get_resource_field when node ids or expansion metadata
        are required for one resource.
    """

    ids = _parse_ids(resource_ids)
    field_names = _parse_field_names(field_name)

    if not ids:
        return _json_response(
            status="error",
            count=0,
            data=[],
            message="resource_ids must contain at least one id",
        )
    if not field_names:
        return _json_response(
            status="error",
            count=0,
            data=[],
            message="field_name must contain at least one field",
        )

    cypher = """
    UNWIND $resource_ids AS requested_id

    OPTIONAL MATCH (resource:FHIRResource {
        resourceType: $resource_type,
        id: requested_id
    })

    UNWIND $field_names AS requested_field

    CALL {
        WITH requested_id, requested_field, resource

        WITH requested_id,
             requested_field,
             resource,
             resource[requested_field] AS root_value
        WHERE resource IS NOT NULL
          AND root_value IS NOT NULL

        RETURN requested_id AS resource_id,
               requested_field AS field_name,
               {
                   source: 'root_property',
                   node_id: null,
                   path: [requested_field],
                   labels: labels(resource),
                   properties: {value: root_value},
                   has_children: false
               } AS value

        UNION

        WITH requested_id, requested_field, resource

        MATCH path=
            (resource)-[first]->(field_node)-[*0..2]->(value_node)

        WHERE resource IS NOT NULL
          AND type(first) = requested_field
          AND all(
              relationship IN relationships(path)
              WHERE NOT type(relationship) IN $blocked_relationships
          )
          AND all(
              path_node IN nodes(path)[1..]
              WHERE NOT path_node:FHIRResource
          )

        RETURN requested_id AS resource_id,
               requested_field AS field_name,
               {
                   source: 'child_node',
                   node_id: toString(id(value_node)),
                   path: [
                       relationship IN relationships(path) |
                       type(relationship)
                   ],
                   labels: labels(value_node),
                   properties: properties(value_node),
                   has_children:
                       size([
                           (value_node)-[next]->(child)
                           WHERE NOT type(next) IN $blocked_relationships
                             AND NOT child:FHIRResource
                           | 1
                       ]) > 0
               } AS value

        UNION

        WITH requested_id, requested_field, resource
        RETURN requested_id AS resource_id,
               requested_field AS field_name,
               null AS value
    }

    WITH resource_id,
         field_name,
         resource IS NOT NULL AS resource_found,
         collect(value) AS raw_values

    WITH resource_id,
         resource_found,
         field_name,
         [
               value IN raw_values
               WHERE value IS NOT NULL |
               {
                   source: value.source,
                   path: value.path,
                   properties: value.properties
               }
           ] AS values

    WITH resource_id,
         resource_found,
         collect({
             field_name: field_name,
             field_found: size(values) > 0,
             values: values
         }) AS fields

    RETURN resource_id,
           resource_found,
           any(field IN fields WHERE field.field_found) AS field_found,
           fields
    ORDER BY resource_id
    """

    return await _execute_tool(
        tool_name="get_resource_fields_batch",
        cypher=cypher,
        parameters={
            "resource_type": resource_type,
            "resource_ids": ids,
            "field_names": field_names,
            "blocked_relationships": list(
                _BLOCKED_TRAVERSAL_RELATIONSHIPS
            ),
        },
    )

@agent.tool
async def expand_field_node(
    ctx: RunContext[AgentDeps],
    node_id: Annotated[
        str,
        Field(description="Neo4j internal node id previously returned by a field-reading tool as node_id."),
    ],
) -> str:
    """
    Expand direct internal children of a previously returned FHIR element node.

    Use when:
    - get_resource_field or a listing tool returned a node_id with has_children true.
    - You need one more shallow step inside the same resource's FHIR structure.

    Do not use when:
    - You need to jump to a referenced FHIRResource; prefer resolve_reference.
    - You have a FHIR resource id instead of a Neo4j internal node id.
    - The parent field is unrelated to the current question.

    Behavior:
    - Reads direct child nodes from the selected internal node only.
    - Does not traverse RESOLVES_TO, DEFINED_BY, blocked relationships, or into another FHIRResource.

    Returns:
        str: JSON payload with parent_node_id, parent_labels, parent_properties, and
        direct children containing relationship, labels, properties, node_id, and
        has_children. The children list is limited to 200 entries.
    """

    cypher = """
    MATCH (node)
    WHERE id(node) = toInteger($node_id)

    OPTIONAL MATCH (node)-[relationship]->(child)

    WITH node,
         collect(
             DISTINCT CASE
                 WHEN child IS NULL
                   OR type(relationship) IN $blocked_relationships
                   OR child:FHIRResource
                 THEN NULL
                 ELSE {
                     node_id: toString(id(child)),
                     relationship: type(relationship),
                     labels: labels(child),
                     properties: properties(child),
                     has_children:
                         size([
                             (child)-[next]->(grandchild)
                             WHERE NOT type(next) IN $blocked_relationships
                               AND NOT grandchild:FHIRResource
                             | 1
                         ]) > 0
                 }
             END
         ) AS raw_children

    RETURN toString(id(node)) AS parent_node_id,
           labels(node) AS parent_labels,
           properties(node) AS parent_properties,
           [
               child IN raw_children
               WHERE child IS NOT NULL
           ][0..$limit] AS children
    """

    return await _execute_tool(
        tool_name="expand_field_node",
        cypher=cypher,
        parameters={
            "node_id": node_id,
            "limit": _TOOL_RESULT_LIMIT,
            "blocked_relationships": list(
                _BLOCKED_TRAVERSAL_RELATIONSHIPS
            ),
        },
    )

@agent.tool
async def resolve_reference(
    ctx: RunContext[AgentDeps],
    reference: Annotated[
        str,
        Field(description="Exact FHIR Reference.reference string to resolve, such as Patient/123 or Encounter/456."),
    ],
) -> str:
    """
    Resolve a FHIR Reference string to target FHIRResource root properties.

    Use when:
    - You have a Reference.reference value and need the target resource id, type, or root properties.
    - Field-reading tools returned a Reference and target details are needed.

    Do not use when:
    - You already have the target resource_type and resource_id; prefer search_resource or field-reading tools.
    - You need resources that reference a known target; prefer get_related_resources.

    Behavior:
    - Matches Reference nodes by exact reference text and follows RESOLVES_TO to target FHIRResource nodes.
    - Does not inspect target child fields.

    Returns:
        str: JSON payload with the input reference, target resource_type, target
        resource_id, and target root_properties.
    """

    cypher = """
    MATCH (:Reference {
        reference: $reference
    })-[:RESOLVES_TO]->(target:FHIRResource)

    RETURN DISTINCT
           $reference AS reference,
           target.resourceType AS resource_type,
           target.id AS resource_id,
           properties(target) AS root_properties
    """

    return await _execute_tool(
        tool_name="resolve_reference",
        cypher=cypher,
        parameters={
            "reference": reference,
        },
    )

@agent.tool
async def resolve_coding(
    ctx: RunContext[AgentDeps],
    system: Annotated[
        str,
        Field(description="Coding.system URL or CodeSystem id to match."),
    ],
    code: Annotated[
        str,
        Field(description="Exact Coding.code value to resolve."),
    ],
) -> str:
    """
    Resolve a FHIR Coding against CodeSystem concepts.

    Use when:
    - You have both Coding.system and Coding.code and need display, definition, or designations.
    - A CodeableConcept or Coding lacks enough direct display text.

    Do not use when:
    - You do not have both system and code.
    - A Coding.display or CodeableConcept.text already answers the request.
    - You need to resolve a Reference; prefer resolve_reference.

    Behavior:
    - Matches CodeSystem.url or CodeSystem.id, then traverses concept relationships up to 10 levels.
    - Reads designation children of the matched concept.

    Returns:
        str: JSON payload with CodeSystem id/url/name, code, display, definition,
        designations, and the concept path relationships.
    """
    cypher = """
    MATCH (code_system:FHIRResource:CodeSystem)
    WHERE code_system.url = $system OR code_system.id = $system
    MATCH path=(code_system)-[:concept*1..10]->(concept)
    WHERE concept.code = $code
    OPTIONAL MATCH (concept)-[:designation]->(designation)
    RETURN code_system.id AS code_system_id,
           code_system.url AS code_system_url,
           code_system.name AS code_system_name,
           concept.code AS code,
           concept.display AS display,
           concept.definition AS definition,
           collect(DISTINCT properties(designation)) AS designations,
           [relationship IN relationships(path) |
                type(relationship)] AS path
    """
    return await _execute_tool(
        tool_name="resolve_coding",
        cypher=cypher,
        parameters={
            "system": system,
            "code": code,
        },
    )


@agent.tool
async def get_graph_schema(ctx: RunContext[AgentDeps]) -> str:
    """
    Get graph labels and relationship types.

    Use when:
    - The available FHIR graph structure is uncertain and specialized tools are insufficient.
    - You need label or relationship names before writing a fallback Cypher query.

    Do not use when:
    - A specialized search, relationship, field-reading, Reference, or Coding tool can answer directly.
    - You already know the relevant resourceType and field names.

    Behavior:
    - Delegates to the graph schema provider without reading clinical resource records.

    Returns:
        str: JSON payload containing schema data from the graph client, or an error
        payload.
    """
    logger.info("TOOL START | get_graph_schema")
    try:
        result = await get_schema()
        payload = {"status": "ok", "data": result}
        model_content = json.dumps(payload, default=str, ensure_ascii=False)
        _log_payload("GRAPH SCHEMA RAW RESULT", result)
        logger.debug("MODEL TOOL RESULT STRING | get_graph_schema\n%s", model_content)
        logger.info("TOOL END | get_graph_schema | status=ok")
        return model_content
    except Exception as exc:
        payload = {"status": "error", "data": {}, "message": str(exc)}
        model_content = json.dumps(payload, default=str, ensure_ascii=False)
        logger.exception("TOOL ERROR | get_graph_schema | %s", exc)
        logger.debug("MODEL TOOL RESULT STRING | get_graph_schema\n%s", model_content)
        return model_content


async def _resolve_neo4j_patient_name(patient_id: str) -> str | None:
    """Best-effort Patient.name lookup for the luong B (Neo4j) skin-image
    tools — search_patient_skin_images() only returns ids, not names, so the
    agent tool resolves the name itself before shaping the frontend result.
    """
    try:
        rows = await execute_cypher(
            """
            MATCH (patient:FHIRResource:Patient {id: $patient_id})
            OPTIONAL MATCH (patient)-[:name]->(name)
            RETURN coalesce(name.text, name.family) AS patient_name
            LIMIT 1
            """,
            {"patient_id": patient_id},
            collect=False,
        )
    except Exception:
        return None
    if rows and rows[0].get("patient_name"):
        return str(rows[0]["patient_name"])
    return None


async def _resolve_patient_id_if_name(value: str) -> str:
    """Defensive fallback for find_patient_skin_images: the model is
    instructed to always pass the FHIR resource id, not the patient's name,
    but occasionally passes the name anyway. Rather than silently returning
    an empty photo list in that case (which reads to the doctor as "no
    photo exists"), try the value as an exact Patient.id first and only
    fall back to a name search — and only substitute the id when the name
    search matches exactly one patient, to avoid guessing between multiple
    same-name patients.
    """
    try:
        exact = await execute_cypher(
            """
            MATCH (patient:FHIRResource:Patient {id: $value})
            RETURN patient.id AS id
            LIMIT 1
            """,
            {"value": value},
            collect=False,
        )
        if exact:
            return value

        by_name = await execute_cypher(
            """
            MATCH (patient:FHIRResource:Patient)-[:name]->(name)
            WHERE toLower(coalesce(name.text, '')) CONTAINS toLower($value)
               OR toLower(coalesce(name.family, '')) CONTAINS toLower($value)
               OR any(given IN coalesce(name.given, [])
                      WHERE toLower(given) CONTAINS toLower($value))
            RETURN DISTINCT patient.id AS id
            LIMIT 2
            """,
            {"value": value},
            collect=False,
        )
        if len(by_name) == 1:
            logger.info(
                "find_patient_skin_images: patient_id %r looked like a name; "
                "resolved to Patient.id %r",
                value, by_name[0]["id"],
            )
            return str(by_name[0]["id"])
    except Exception:
        logger.exception("Failed to resolve patient_id fallback for %r", value)
    return value


@agent.tool
async def find_patient_skin_images(
    ctx: RunContext[AgentDeps],
    patient_id: Annotated[
        str | None,
        Field(description="The FHIR resource id (e.g. '10796') from search_patient — NEVER the patient's name text. Explicitly selected/resolved by the doctor's name. Omit only when active patient context is available."),
    ] = None,
    count: Annotated[
        int | None,
        Field(description="Optional number of images to return. Use the doctor's requested number. Omit when all_images is true."),
    ] = 5,
    all_images: Annotated[
        bool,
        Field(description="Set true when the doctor asks for all/toàn bộ/tất cả matching images."),
    ] = False,
    sort: Annotated[
        str,
        Field(description="Sort by image timestamp: desc for latest/newest, asc for oldest."),
    ] = "desc",
    date_range: Annotated[
        str | None,
        Field(description="Optional relative date range: today, yesterday, this_week, last_week, this_month, last_month, this_year, last_year, recent."),
    ] = None,
    specific_date: Annotated[
        str | None,
        Field(description="Optional exact date, either YYYY-MM-DD or DD/MM/YYYY."),
    ] = None,
    modality: Annotated[
        str | None,
        Field(description="Optional modality code. Use XC for dermatology images; omit only when intentionally searching all modalities."),
    ] = "XC",
) -> str:
    """
    Retrieve skin/dermatology photos saved for an existing Patient in the local Neo4j FHIR graph.

    Use when:
    - The doctor asks to view, retrieve, list, compare, or find skin/lesion
      photos already saved for a known Neo4j Patient.

    Do not use when:
    - The user means their own just-uploaded photo in this chat; use
      diagnose_skin_condition instead.

    Behavior:
    - Resolves Patient from explicit patient_id, then active patient context.
    - Queries Neo4j directly through the CyFHIR graph shape.
    - Returns metadata only and never returns Binary.data or base64.

    IMPORTANT — the UI renders the matched photo(s) inline automatically as
    real thumbnails the moment this tool returns a non-empty list; do not
    put view_url/binary links or raw URLs in your reply.

    Returns:
        str: JSON payload with a list of {study_id, patient_id,
        patient_name, binary_id, last_updated, view_url}. Empty list if no
        patient or no photo matched.
    """
    logger.info(
        "TOOL START | tool=find_patient_skin_images | patient_id=%r count=%r all_images=%r",
        patient_id, count, all_images,
    )
    resolved_patient_id = (patient_id or ctx.deps.active_patient_id or "").strip()
    if not resolved_patient_id:
        return _json_response(
            status="patient_required",
            count=0,
            data=[],
            message="Please ask the doctor to provide or select a Patient ID before retrieving skin images.",
        )
    resolved_patient_id = await _resolve_patient_id_if_name(resolved_patient_id)

    normalized_sort = "asc" if str(sort).strip().lower() == "asc" else "desc"
    requested_count = None if all_images else max(int(count or 5), 1)

    try:
        filters = resolve_skin_image_filters(
            SkinImageSearchFilters(
                patient_id=resolved_patient_id,
                count=requested_count,
                sort=normalized_sort,
                date_range=date_range,
                specific_date=specific_date,
                modality=modality or None,
            )
        )
        rows = await search_patient_skin_images(filters)
    except Exception as exc:
        model_content = _json_response(status="error", count=0, data=[], message=str(exc))
        _record_tool_result_chars(len(model_content))
        return model_content

    patient_name = await _resolve_neo4j_patient_name(resolved_patient_id)

    # Defense-in-depth: dedupe by binary_id even though the underlying
    # Cypher (search_patient_skin_images) is expected to return at most one
    # row per photo now — keeps a stray duplicate row from ever reaching
    # the doctor as two copies of the same image.
    seen_binary_ids: set[str] = set()
    deduped_rows: list[dict[str, Any]] = []
    for row in rows:
        binary_id = str(row.get("binary_id") or "").strip()
        if not binary_id or binary_id in seen_binary_ids:
            continue
        seen_binary_ids.add(binary_id)
        deduped_rows.append(row)

    results = [
        to_frontend_skin_image_result(row, patient_name=patient_name)
        for row in deduped_rows
    ]

    # Same mechanism as search_skin_images (luong A): push the actual photos
    # to the UI as a dedicated SSE event so the frontend renders real <img>
    # thumbnails instead of a raw, auth-requiring URL the user can't open.
    get_collector().emit_skin_images(results)

    model_content = _json_response(
        status="ok",
        count=len(results),
        data=results,
        message=None if results else "No matching skin images were found.",
    )
    _record_tool_result_chars(len(model_content))
    logger.info("TOOL END | tool=find_patient_skin_images | chars=%s", len(model_content))
    return model_content


@agent.tool
async def start_skin_diagnostic(
    ctx: RunContext[AgentDeps],
    patient_id: Annotated[
        str,
        Field(description="Neo4j FHIR Patient id that the binary_id belongs to."),
    ],
    binary_id: Annotated[
        str,
        Field(description="Binary id of a skin photo already saved in the Neo4j graph (e.g. from find_patient_skin_images). Required; never guess it."),
    ],
    initial_complaint: Annotated[
        str,
        Field(description="The doctor's current message copied exactly, without rewriting."),
    ],
) -> str:
    """
    Start the dermatology diagnostic pipeline (vision + clinical-interview)
    on a photo already saved for an existing Patient in the Neo4j FHIR graph
    (luong B). Separate from start_diagnosis_from_patient_image, which reads
    the live HAPI FHIR server (luong A), and from diagnose_skin_condition,
    which only checks a run already started from a chat-uploaded photo.

    Use when:
    - The doctor asks for diagnosis/assessment/analysis of a specific saved
      photo (binary_id known, e.g. from find_patient_skin_images or a prior
      turn in this conversation) belonging to a known Patient.

    Do not use when:
    - No binary_id is known yet — call find_patient_skin_images first, or
      ask the doctor which photo.
    - The user means their own just-uploaded photo in this chat; use
      diagnose_skin_condition instead.

    Behavior:
    - Reads Binary.data inside the backend service only, never into model
      context.
    - Creates a diagnostic run and starts the same multi-step vision +
      clinical-interview pipeline used elsewhere. This takes time and may
      pause for clinical Q&A shown in the chat UI.

    Returns:
        str: JSON payload with status "started" and run_id on success — call
        diagnose_skin_condition afterward to check progress/get the result;
        do not fabricate a result before that. status "patient_required" /
        "binary_required" / "error" otherwise.
    """
    logger.info(
        "TOOL START | tool=start_skin_diagnostic | patient_id=%r binary_id=%r",
        patient_id, binary_id,
    )
    resolved_patient_id = (patient_id or ctx.deps.active_patient_id or "").strip()
    resolved_binary_id = (binary_id or "").strip()
    if not resolved_patient_id:
        return _json_response(
            status="patient_required",
            data={},
            message="Please ask the doctor to provide or select a Patient ID before starting skin diagnosis.",
        )
    resolved_patient_id = await _resolve_patient_id_if_name(resolved_patient_id)
    if not resolved_binary_id:
        return _json_response(
            status="binary_required",
            data={},
            message="Please ask the doctor to select a saved skin photo before starting diagnosis.",
        )

    get_collector().emit_tool_start(
        "start_skin_diagnostic",
        {
            "patient_id": resolved_patient_id,
            "binary_id": resolved_binary_id,
            "initial_complaint": initial_complaint,
        },
    )

    try:
        run = await start_skin_diagnostic_from_binary(
            user_id=ctx.deps.user_id,
            conversation_id=ctx.deps.session_id,
            patient_id=resolved_patient_id,
            binary_id=resolved_binary_id,
            initial_complaint=initial_complaint,
        )
    except Exception as exc:
        model_content = _json_response(status="error", data={}, message=str(exc))
        _record_tool_result_chars(len(model_content))
        get_collector().collect_tool_call(
            "start_skin_diagnostic",
            {
                "patient_id": resolved_patient_id,
                "binary_id": resolved_binary_id,
                "initial_complaint": initial_complaint,
            },
            model_content,
        )
        return model_content

    model_content = _json_response(
        status="ok",
        data={
            "run_id": run.id,
            "status": "started",
            "patient_id": resolved_patient_id,
            "binary_id": resolved_binary_id,
        },
    )
    _record_tool_result_chars(len(model_content))
    get_collector().collect_tool_call(
        "start_skin_diagnostic",
        {
            "patient_id": resolved_patient_id,
            "binary_id": resolved_binary_id,
            "initial_complaint": initial_complaint,
        },
        model_content,
    )
    logger.info("TOOL END | tool=start_skin_diagnostic | run_id=%s", run.id)
    return model_content


@agent.tool
async def diagnose_skin_condition(
    ctx: RunContext[AgentDeps],
    patient_context: Annotated[
        str,
        Field(description="Short note on the symptom/complaint being asked about, e.g. 'ngua, noi man do o canh tay 3 ngay'."),
    ],
) -> str:
    """
    Diagnosis tool for skin/dermatology complaints — the diagnostic
    capability itself, not a text-based diagnosis.

    Use when:
    - The user asks you to diagnose, assess, or explain a skin lesion, rash,
      or other dermatological complaint.
    - The user asks about the status or result of a skin diagnostic run.

    Do not use when:
    - The request is about a patient's stored records/history; use the FHIR
      graph tools instead.
    - The message does not mention a skin/lesion/dermatological complaint.
    - A named patient (not the current chat user) is the subject, whether
      named in this message or earlier in this same conversation (e.g. a
      prior turn already looked up that patient's photo and this message
      only adds symptoms) — use start_diagnosis_from_patient_image or
      find_patient_skin_images + start_skin_diagnostic instead; this tool
      only ever reports on the current chat user's own uploaded photo and
      will incorrectly say no photo was attached.

    Behavior:
    - This tool never diagnoses from text alone. Dermatology diagnosis in
      this system is image-based: it runs a separate multi-step vision +
      clinical-interview pipeline that only starts once the user attaches a
      photo of the lesion in the chat composer (the image attachment icon).
    - It looks up the current user's most recent skin diagnostic run and
      reports its status, so you can tell the user what to do next instead
      of fabricating a diagnosis.

    Returns:
        str: JSON payload. status is one of "no_run" (no photo analyzed yet
        — tell the user to attach one), "running" / "awaiting_answers" (a
        run is in progress — tell the user to finish the clinical questions
        shown in the chat UI), "completed" (includes ranked_diagnoses and
        reasoning — summarize these for the user), or "error".
    """
    from app.skin_diagnostic.session_store import get_store
    from app.skin_diagnostic.session_view import build_result

    run_id = _CURRENT_RUN_ID.get()
    handler_name = _CURRENT_HANDLER.get()
    logger.info(
        "TOOL START | run_id=%s | handler=%s | tool=diagnose_skin_condition",
        run_id, handler_name,
    )
    _log_payload("TOOL INPUT | diagnose_skin_condition | parameters", {"patient_context": patient_context})

    store = await get_store()
    runs = await store.list_recent_for_user(ctx.deps.user_id, limit=3)

    if not runs:
        payload: dict[str, Any] = {
            "status": "no_run",
            "message": (
                "No skin diagnostic run exists for this user yet. Diagnosis "
                "requires a photo of the lesion — ask the user to attach one "
                "using the image button in the chat composer; it cannot be "
                "performed from a text description alone."
            ),
        }
    else:
        latest = runs[0]
        if latest.status == "completed":
            result = build_result(latest.state)
            payload = {
                "status": "completed",
                "run_id": latest.id,
                "anamnesis": latest.anamnesis,
                "ranked_diagnoses": result.get("ranked_diagnoses", []),
                "reasoning": result.get("reasoning", ""),
            }
        elif latest.status == "interrupt":
            payload = {
                "status": "awaiting_answers",
                "run_id": latest.id,
                "message": (
                    "A skin diagnostic run is waiting on clinical Q&A "
                    "answers from the user in the chat UI before it can "
                    "produce a diagnosis."
                ),
            }
        elif latest.status == "error":
            payload = {"status": "error", "run_id": latest.id, "error": latest.error}
        else:
            payload = {
                "status": "running",
                "run_id": latest.id,
                "current_step": latest.current_step,
                "message": "The skin diagnostic pipeline is still analyzing the photo for this user.",
            }

    model_content = _json_response(status="ok", data=payload)
    _log_payload("MODEL TOOL RESULT OBJECT | diagnose_skin_condition", payload)
    _record_tool_result_chars(len(model_content))
    logger.info(
        "TOOL END | run_id=%s | handler=%s | tool=diagnose_skin_condition | status=%s | chars=%s",
        run_id, handler_name, payload.get("status"), len(model_content),
    )
    return model_content


@agent.tool
async def search_skin_images(
    ctx: RunContext[AgentDeps],
    patient_name: Annotated[
        str,
        Field(description="Patient name (or fragment) to search, e.g. 'Kim Cương', 'Nam Vũ'. Empty string if searching by patient_id instead, or listing recent photos across all patients."),
    ],
    patient_id: Annotated[
        str,
        Field(description="FHIR Patient id if already known. Empty string if searching by patient_name instead."),
    ] = "",
    date_from: Annotated[
        str,
        Field(description="Only photos saved on/after this date, format YYYY-MM-DD. Empty string for no lower bound."),
    ] = "",
    date_to: Annotated[
        str,
        Field(description="Only photos saved on/before this date, format YYYY-MM-DD. Empty string for no upper bound."),
    ] = "",
    count: Annotated[int, Field(description="Max number of photos to return, most recent first.")] = 10,
) -> str:
    """
    Look up dermatology photos saved in the local Neo4j graph.

    Use when:
    - The user asks to see/retrieve past skin photos for a named patient
      ("cho tôi ảnh da của bệnh nhân Nam Vũ", "ảnh chụp tuần trước của bệnh
      nhân X").
    - You need a patient's most recent photo before calling
      start_diagnosis_from_patient_image.

    Do not use when:
    - The user means their own just-uploaded photo in this chat; use
      diagnose_skin_condition instead.

    IMPORTANT — the UI renders the matched photo(s) inline automatically
    (as real thumbnails) the moment this tool returns a non-empty list; you
    do not need to, and must NOT, put ``view_url``/binary links or raw URLs
    in your reply.

    Returns:
        str: JSON payload with a list of {study_id, patient_id,
        patient_name, binary_id, last_updated, view_url}. Empty list if no
        patient or no photo matched.
    """
    from app.skin_images.neo4j_repository import search_skin_images_neo4j

    logger.info(
        "TOOL START | tool=search_skin_images | patient_name=%r patient_id=%r date_from=%r date_to=%r",
        patient_name, patient_id, date_from, date_to,
    )
    try:
        results = await search_skin_images_neo4j(
            patient_id=patient_id or None,
            patient_name=patient_name or None,
            date_from=date_from or None,
            date_to=date_to or None,
            count=count,
        )
        get_collector().emit_skin_images(results)
        model_content = _json_response(status="ok", data=results, count=len(results))
    except Exception as exc:
        model_content = _json_response(status="error", data=[], message=str(exc))
    _record_tool_result_chars(len(model_content))
    logger.info("TOOL END | tool=search_skin_images | chars=%s", len(model_content))
    return model_content


@agent.tool
async def start_diagnosis_from_patient_image(
    ctx: RunContext[AgentDeps],
    patient_name: Annotated[
        str,
        Field(description="Name (or fragment) of the patient whose most recent skin photo should be diagnosed, e.g. 'Nam Vũ'."),
    ],
    symptom_text: Annotated[
        str,
        Field(description="The symptom/complaint described for this patient, e.g. 'ngứa dữ dội 3 ngày nay'."),
    ],
) -> str:
    """
    Start the dermatology diagnostic pipeline on a patient's most recent
    saved photo in Neo4j, combined with a described symptom.

    Use when:
    - The user names a patient AND describes a symptom AND asks for a diagnosis.

    Behavior:
    - Looks up the patient's single most recent photo from Neo4j, fetches
      its Binary bytes, and kicks off the vision + clinical-interview pipeline.

    Returns:
        str: JSON payload with status "no_photo", "no_patient", or "started".
    """
    import base64
    import tempfile
    import uuid as _uuid_mod
    from pathlib import Path as _Path

    from app.skin_diagnostic.pipeline_runner import run_pipeline_background
    from app.skin_diagnostic.session_store import get_store
    from app.skin_diagnostic.uploads import UPLOADS_DIR
    from app.skin_images.neo4j_repository import get_binary_for_skin_image, search_skin_images_neo4j

    logger.info(
        "TOOL START | tool=start_diagnosis_from_patient_image | patient_name=%r",
        patient_name,
    )
    get_collector().emit_tool_start(
        "start_diagnosis_from_patient_image",
        {"patient_name": patient_name, "symptom_text": symptom_text},
    )
    try:
        matches = await search_skin_images_neo4j(patient_name=patient_name, count=1)
    except Exception as exc:
        model_content = _json_response(status="error", data={}, message=str(exc))
        _record_tool_result_chars(len(model_content))
        get_collector().collect_tool_call(
            "start_diagnosis_from_patient_image",
            {"patient_name": patient_name, "symptom_text": symptom_text},
            model_content,
        )
        return model_content

    if not matches:
        payload = {"status": "no_photo", "message": f"No photo found in Neo4j for patient matching '{patient_name}'."}
        model_content = _json_response(status="ok", data=payload)
        _record_tool_result_chars(len(model_content))
        get_collector().collect_tool_call(
            "start_diagnosis_from_patient_image",
            {"patient_name": patient_name, "symptom_text": symptom_text},
            model_content,
        )
        return model_content

    match = matches[0]
    binary_id = match.get("binary_id")
    if not binary_id:
        payload = {"status": "no_photo", "message": "Patient found but the stored report has no photo binary_id."}
        model_content = _json_response(status="ok", data=payload)
        _record_tool_result_chars(len(model_content))
        get_collector().collect_tool_call(
            "start_diagnosis_from_patient_image",
            {"patient_name": patient_name, "symptom_text": symptom_text},
            model_content,
        )
        return model_content

    get_collector().emit_skin_images([match])

    row = await get_binary_for_skin_image(binary_id)
    if not row or not row.get("data"):
        payload = {"status": "no_photo", "message": f"Binary data for '{binary_id}' not found in Neo4j."}
        model_content = _json_response(status="ok", data=payload)
        _record_tool_result_chars(len(model_content))
        get_collector().collect_tool_call(
            "start_diagnosis_from_patient_image",
            {"patient_name": patient_name, "symptom_text": symptom_text},
            model_content,
        )
        return model_content

    try:
        raw_bytes = base64.b64decode(str(row["data"]))
    except Exception as exc:
        model_content = _json_response(status="error", data={}, message=f"Failed to decode binary data: {exc}")
        _record_tool_result_chars(len(model_content))
        return model_content

    content_type = row.get("content_type") or "image/jpeg"
    ext = {"image/png": ".png", "image/webp": ".webp"}.get(content_type, ".jpg")
    run_id = _uuid_mod.uuid4().hex
    image_path = str(UPLOADS_DIR / f"{run_id}{ext}")
    _Path(image_path).write_bytes(raw_bytes)

    store = await get_store()
    run = await store.create(
        run_id=run_id,
        user_id=ctx.deps.user_id,
        image_path=image_path,
        image_url=f"/api/skin-diagnostics/uploads/{run_id}{ext}",
        anamnesis=symptom_text,
        fhir_patient_id=match.get("patient_id") or "",
    )
    asyncio.create_task(run_pipeline_background(run.id, image_path, symptom_text))

    payload = {
        "status": "started",
        "run_id": run.id,
        "current_step": "visual_extract",
        "patient_name": match.get("patient_name") or patient_name,
        "patient_id": match.get("patient_id"),
        "binary_id": binary_id,
        "view_url": match.get("view_url"),
    }
    model_content = _json_response(status="ok", data=payload)
    _record_tool_result_chars(len(model_content))
    get_collector().collect_tool_call(
        "start_diagnosis_from_patient_image",
        {"patient_name": patient_name, "symptom_text": symptom_text},
        model_content,
    )
    logger.info(
        "TOOL END | tool=start_diagnosis_from_patient_image | run_id=%s binary_id=%s",
        run.id, binary_id,
    )
    return model_content


# ---------------------------------------------------------------------------
# Message handling
# ---------------------------------------------------------------------------




# ---------------------------------------------------------------------------
# Request/run diagnostics
# ---------------------------------------------------------------------------

_CURRENT_RUN_ID: contextvars.ContextVar[str] = contextvars.ContextVar(
    "fhir_agent_run_id", default="-"
)
_CURRENT_HANDLER: contextvars.ContextVar[str] = contextvars.ContextVar(
    "fhir_agent_handler", default="-"
)
_active_runs: dict[str, dict[str, Any]] = {}
_recent_run_starts: list[dict[str, Any]] = []
_DUPLICATE_WINDOW_SECONDS = float(
    os.getenv("FHIR_AGENT_DUPLICATE_WINDOW_SECONDS", "30")
)

def _generate_run_id() -> str:
    return uuid.uuid4().hex[:12]

def _message_fingerprint(message: str) -> str:
    normalized = " ".join(message.split())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]

def _compact_stack() -> str:
    frames = traceback.extract_stack(limit=12)[:-2]
    return " <- ".join(
        f"{f.name}@{os.path.basename(f.filename)}:{f.lineno}" for f in frames[-6:]
    )

def _prune_recent_runs(now: float) -> None:
    cutoff = now - max(_DUPLICATE_WINDOW_SECONDS, 1.0)
    _recent_run_starts[:] = [
        x for x in _recent_run_starts if x["started_monotonic"] >= cutoff
    ]

def _track_run_start(*, run_id: str, handler_name: str, message: str, supplied_session_id: str | None) -> None:
    now = time.monotonic()
    fingerprint = _message_fingerprint(message)
    _prune_recent_runs(now)
    dupes = [x for x in _recent_run_starts if x["message_fingerprint"] == fingerprint]
    task = asyncio.current_task()
    task_id = id(task) if task is not None else None
    info = {
        "run_id": run_id, "handler": handler_name,
        "message_fingerprint": fingerprint,
        "supplied_session_id": supplied_session_id,
        "started_monotonic": now, "process_id": os.getpid(),
        "task_id": task_id, "tool_calls": 0, "tool_result_chars": 0,
    }
    _active_runs[run_id] = info
    _recent_run_starts.append(info.copy())
    logger.warning(
        "REQUEST DIAGNOSTIC | event=handler_entry | run_id=%s | handler=%s "
        "| process_id=%s | task_id=%s | supplied_session_id=%s "
        "| message_fingerprint=%s | active_runs=%s | duplicate_candidates=%s",
        run_id, handler_name, os.getpid(), task_id, supplied_session_id,
        fingerprint, len(_active_runs),
        [{"run_id": x["run_id"], "handler": x["handler"],
          "age_seconds": round(now-x["started_monotonic"],3)} for x in dupes],
    )
    logger.debug("REQUEST CALL STACK | run_id=%s | %s", run_id, _compact_stack())
    if dupes:
        logger.error(
            "DUPLICATE REQUEST SUSPECTED | run_id=%s | message_fingerprint=%s "
            "| reason=same_message_entered_handler_again | candidates=%s",
            run_id, fingerprint, [x["run_id"] for x in dupes],
        )

def _record_tool_result_chars(chars: int) -> None:
    run_id = _CURRENT_RUN_ID.get()
    info = _active_runs.get(run_id)
    if info is not None:
        info["tool_calls"] += 1
        info["tool_result_chars"] += chars

def _log_model_usage(result: Any, run_id: str) -> None:
    try:
        usage_attr = getattr(result, "usage", None)
        usage_value = usage_attr() if callable(usage_attr) else usage_attr
    except Exception as exc:
        usage_value = {"usage_read_error": str(exc)}
    _log_payload(f"MODEL USAGE | run_id={run_id}", usage_value)

def _classify_run_exception(exc: Exception) -> str:
    value = str(exc).lower()
    markers = ("context length", "context_length", "maximum context",
               "max context", "too many tokens", "token limit",
               "prompt is too long", "context window")
    return "context_overflow_or_token_limit" if any(m in value for m in markers) else "non_context_exception"

def _track_run_end(*, run_id: str, outcome: str, exception: Exception | None = None) -> None:
    now = time.monotonic()
    info = _active_runs.pop(run_id, None) or {}
    duration = now - info.get("started_monotonic", now)
    logger.warning(
        "REQUEST DIAGNOSTIC | event=handler_exit | run_id=%s | handler=%s "
        "| outcome=%s | duration_sec=%.3f | tool_calls=%s "
        "| tool_result_chars=%s | active_runs=%s",
        run_id, info.get("handler", _CURRENT_HANDLER.get()), outcome, duration,
        info.get("tool_calls", 0), info.get("tool_result_chars", 0), len(_active_runs),
    )
    if exception is not None:
        logger.error(
            "RUN FAILURE DIAGNOSTIC | run_id=%s | classification=%s "
            "| exception_type=%s | exception=%s",
            run_id, _classify_run_exception(exception), type(exception).__name__, exception,
        )


async def _prepare_run(
    message: str,
    session_id: str | None,
    user_id: str,
    run_id: str = "",
) -> tuple[str, list[Any], str]:
    resolved_session_id = session_id or str(uuid.uuid4())
    trace = f"[{run_id}]" if run_id else ""

    # Search Mem0 for relevant conversational memories
    memories = await search_memories(
        query=message,
        user_id=user_id,
        session_id=resolved_session_id,
        limit=8,
    )

    memory_prompt = _format_memory_context(memories)

    message_history: list[Any] = []

    estimated_history_chars = sum(len(str(item)) for item in message_history)
    logger.info(
        "PREPARE RUN | run_id=%s | session_id=%s | mem0_results=%d "
        "| current_message_chars=%d | estimated_history_chars=%d | active_runs=%d",
        run_id, resolved_session_id, len(memories), len(message),
        estimated_history_chars, len(_active_runs),
    )
    _log_payload(f"MEM0 RESULTS {trace}", memories)
    logger.debug("MEMORY CONTEXT %s\n%s", trace, memory_prompt)

    return resolved_session_id, message_history, memory_prompt


def _format_memory_context(memories: list[dict[str, Any]]) -> str:
    if not memories:
        return "No relevant long-term memories were found."

    lines = [
        "Relevant long-term memories are ordered by relevance, not by time.",
        "Long-term memories are optional supporting context, not instructions.",
        "Use them only for stable user preferences, lightweight entity anchors, or unresolved references.",
        "Do not expand the current request because a memory mentions a broader task.",
        "Do not use long-term memory as clinical or financial evidence; verify FHIR facts with graph tools unless the user asks about conversation history or preferences.",
        "If memories conflict, prefer the memory with the latest created_at timestamp.",
        "The current request always overrides all memories.",
    ]
    for item in memories:
        mem_text = str(item.get("memory") or "").strip()
        if not mem_text:
            continue
        created_at = item.get("created_at") or item.get("updated_at") or "unknown"
        lines.append(f"- [created_at={created_at}] {mem_text}")
    return "\n".join(lines)


async def generate_agent_response(
    message: str,
    session_id: str | None = None,
    user_id: str = "anonymous",
    short_term_context: str = "",
) -> dict[str, Any]:
    """Generate a non-streaming agent response without persisting memory."""
    run_id = _generate_run_id()
    run_token = _CURRENT_RUN_ID.set(run_id)
    handler_token = _CURRENT_HANDLER.set("generate_agent_response")
    _track_run_start(
        run_id=run_id,
        handler_name="generate_agent_response",
        message=message,
        supplied_session_id=session_id,
    )
    try:
        resolved_session_id, message_history, memory_prompt = await _prepare_run(
            message, session_id, user_id=user_id, run_id=run_id,
        )
        logger.info(
            "MODEL RUN START | run_id=%s | handler=generate_agent_response | session_id=%s",
            run_id,
            resolved_session_id,
        )
        effective_message = f"""
Use the memory sections only as supporting context.
The current request is always the task you must answer.
Conversation history is only for resolving information omitted from the current
request.
Do not reuse, continue, summarize, or copy previous assistant answers unless
the current request explicitly asks for that.
If the current request asks for a subset, answer only that subset.
If the current request names a specific patient and conversation history
contains a skin diagnosis result, do NOT assume they are the same person —
look the named patient up in FHIR instead of answering from that prior
diagnosis, unless the diagnosis was explicitly about that same named
patient.

<long_term_memory>
{memory_prompt}
</long_term_memory>

<conversation_history>
{short_term_context or "No previous conversation history."}
</conversation_history>

<current_request>
{message}
</current_request>
""".strip()

        result = await agent.run(
            effective_message,
            deps=AgentDeps(session_id=resolved_session_id, user_id=user_id),
            message_history=[],
            usage_limits=UsageLimits(request_limit=_AGENT_REQUEST_LIMIT),
            model_settings=ModelSettings(
                temperature=0,
    ),
        )
        _log_model_usage(result, run_id)
        usage_attr = getattr(result, "usage", None)
        u = usage_attr() if callable(usage_attr) else usage_attr
        logger.info("TOKENS | run_id=%s | session=%s | usage=%s", run_id, resolved_session_id, u)
        response_text = result.output or ""
        logger.debug("MODEL FINAL OUTPUT | run_id=%s | session_id=%s\n%s", run_id, resolved_session_id, response_text)
        logger.info(
            "MODEL RUN END | run_id=%s | handler=generate_agent_response | session_id=%s | chars=%s",
            run_id,
            resolved_session_id,
            len(response_text),
        )
        if not response_text.strip():
            response_text = "I could not obtain enough graph evidence to answer the question."
        _track_run_end(run_id=run_id, outcome="success")
        return {
            "response": response_text,
            "session_id": resolved_session_id,
            "graph_data": None,
            "diagnostic_run_id": run_id,
        }
    except Exception as exc:
        _track_run_end(run_id=run_id, outcome="error", exception=exc)
        raise
    finally:
        _CURRENT_HANDLER.reset(handler_token)
        _CURRENT_RUN_ID.reset(run_token)


async def handle_message(
    message: str,
    session_id: str | None = None,
    user_id: str = "anonymous",
) -> dict[str, Any]:
    """Handle an incoming non-streaming chat message and persist memory."""
    result = await generate_agent_response(
        message,
        session_id=session_id,
        user_id=user_id,
    )
    await save_conversation_memory(
        user_id=user_id,
        session_id=result["session_id"],
        user_message=message,
        assistant_message=result["response"],
    )
    return result


async def handle_message_stream(
    message: str,
    session_id: str | None = None,
    user_id: str = "anonymous",
) -> dict[str, Any]:
    """Run the full agent loop and then emit the final response."""
    from app.graph.client import get_collector
    run_id = _generate_run_id()
    run_token = _CURRENT_RUN_ID.set(run_id)
    handler_token = _CURRENT_HANDLER.set("handle_message_stream")
    _track_run_start(run_id=run_id, handler_name="handle_message_stream", message=message, supplied_session_id=session_id)
    try:
        resolved_session_id, message_history, memory_prompt = await _prepare_run(
            message, session_id, user_id=user_id, run_id=run_id,
        )
        collector = get_collector()
        logger.info("MODEL RUN START | run_id=%s | handler=handle_message_stream | session_id=%s", run_id, resolved_session_id)
        effective_message = (
            "CONVERSATIONAL MEMORY\n"
            f"{memory_prompt}\n\n"
            "CURRENT USER REQUEST\n"
            f"{message}"
            if memory_prompt
            else message
        )

        result = await agent.run(
            effective_message,
            deps=AgentDeps(session_id=resolved_session_id, user_id=user_id),
            message_history=[],
            usage_limits=UsageLimits(request_limit=_AGENT_REQUEST_LIMIT),
        )
        _log_model_usage(result, run_id)
        usage_attr = getattr(result, "usage", None)
        u = usage_attr() if callable(usage_attr) else usage_attr
        logger.info("TOKENS | run_id=%s | session=%s | usage=%s", run_id, resolved_session_id, u)
        response_text = result.output or ""
        if not response_text.strip():
            response_text = "I could not obtain enough graph evidence to answer the question."
        collector.emit_text_delta(response_text)
        # Save the completed conversation to Mem0
        await save_conversation_memory(
            user_id=user_id,
            session_id=resolved_session_id,
            user_message=message,
            assistant_message=response_text,
        )
        collector.emit_done(response_text, resolved_session_id)
        logger.info("MODEL RUN END | run_id=%s | handler=handle_message_stream | session_id=%s | chars=%s", run_id, resolved_session_id, len(response_text))
        _track_run_end(run_id=run_id, outcome="success")
        return {"response": response_text, "session_id": resolved_session_id, "graph_data": None, "diagnostic_run_id": run_id}
    except Exception as exc:
        _track_run_end(run_id=run_id, outcome="error", exception=exc)
        raise
    finally:
        _CURRENT_HANDLER.reset(handler_token)
        _CURRENT_RUN_ID.reset(run_token)