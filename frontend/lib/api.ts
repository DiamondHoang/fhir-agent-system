"use client";

import { API_BASE } from "@/lib/config";

const ACCESS_TOKEN_KEY = "fhir-agent-access-token";
const USER_KEY = "fhir-agent-user";

export interface UserProfile {
  id: string;
  username: string;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: UserProfile;
}

export interface Conversation {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
  // Persisted alongside the plain-text `content` so a reload can rebuild
  // the rich view (attached photo, structured dermatology result card)
  // instead of only having text to fall back to.
  message_type?: string;
  image_url?: string | null;
  structured_data?: Record<string, unknown> | null;
}

export interface ConversationListResponse {
  items: Conversation[];
  total: number;
}

export interface MessageListResponse {
  items: ChatMessage[];
  total: number;
}

export interface InitialExchangeResponse {
  conversation: Conversation;
  user_message: ChatMessage;
  assistant_message: ChatMessage;
}

export interface MessageExchangeResponse {
  conversation_id: string;
  user_message: ChatMessage;
  assistant_message: ChatMessage;
}

export interface SkinPendingQuestion {
  question: string;
  pqrst_category: string;
  purpose: string;
  discriminates: string[];
  question_num: number | null;
  total: number | null;
}

export interface SkinDiagnosticResult {
  ranked_diagnoses: Record<string, unknown>[];
  reasoning: string;
  visual_observations: string;
  visual_differentials: string[];
  qa_history: string;
}

export interface SkinDiagnosticStatus {
  run_id: string;
  status: "idle" | "running" | "interrupt" | "completed" | "error";
  current_step: string;
  progress: number;
  pending_questions: SkinPendingQuestion[] | null;
  result: SkinDiagnosticResult | Record<string, never>;
  error: string | null;
}

export interface SkinDiagnosticStartResponse {
  run_id: string;
  status: string;
  current_step: string;
  conversation_id: string;
  conversation_title: string;
}

export interface SkinImageResult {
  study_id: string;
  patient_id: string | null;
  patient_name: string | null;
  binary_id: string | null;
  last_updated: string;
  view_url: string | null;
}

/** Response from POST /skin-images/analyze (luong B — upload for an
 * existing Neo4j patient). Mirrors backend app/skin_images/schemas.py
 * SkinImageAnalyzeResponse. */
export interface SkinImageAnalyzeResponse {
  binary_id: string;
  media_id: string;
  diagnostic_report_id: string;
  modality: string;
  analysis_text: string;
  image_url: string;
  content_type: string | null;
  created_at: string;
  // Conversation this result was persisted into (F-10) — same pattern as
  // SkinDiagnosticStartResponse for luong A, so a reload doesn't lose it.
  conversation_id: string;
  conversation_title: string;
}

/** Response from POST /skin-images/save — pure "attach photo to existing
 * patient, no diagnosis, no chat message" case. Mirrors backend
 * app/skin_images/schemas.py SkinImageSaveResponse. */
export interface SkinImageSaveResponse {
  binary_id: string;
  media_id: string;
  diagnostic_report_id: string;
}

/** Minimal patient row from GET /patients/search, used by the "existing
 * patient" autocomplete when uploading a skin image (luong B). */
export interface PatientSearchResult {
  id: string;
  name: string | null;
  birth_date: string | null;
}

/** One row of GET /skin-images — mirrors backend SkinImageSummary. Distinct
 * shape from SkinImageResult (which is the luong A / agent-tool gallery
 * shape); this one backs a direct per-patient image list if the UI needs it. */
export interface SkinImageSummary {
  diagnostic_report_id: string;
  media_id: string | null;
  binary_id: string | null;
  modality: string | null;
  conclusion: string;
  image_url: string | null;
  created_at: string | null;
}

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getStoredUser(): UserProfile | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserProfile;
  } catch {
    return null;
  }
}

export function storeAuth(tokenResponse: TokenResponse): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, tokenResponse.access_token);
  localStorage.setItem(USER_KEY, JSON.stringify(tokenResponse.user));
}

export function clearAuth(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function readError(response: Response): Promise<string> {
  const fallback = `Backend error (${response.status})`;
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== "object" || !("detail" in data)) return fallback;
  const detail = data.detail;
  if (typeof detail === "string") return detail;
  return fallback;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (response.status === 401) {
    clearAuth();
    throw new ApiError(401, "Please sign in again.");
  }

  return response;
}

async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    throw new ApiError(response.status, await readError(response));
  }
  return response.json() as Promise<T>;
}

export async function login(username: string, password: string): Promise<TokenResponse> {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    throw new ApiError(response.status, await readError(response));
  }
  const tokenResponse = (await response.json()) as TokenResponse;
  storeAuth(tokenResponse);
  return tokenResponse;
}

export async function register(username: string, password: string): Promise<UserProfile> {
  const response = await fetch(`${API_BASE}/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    throw new ApiError(response.status, await readError(response));
  }
  return response.json() as Promise<UserProfile>;
}

export async function listConversations(skip = 0, limit = 50): Promise<ConversationListResponse> {
  return jsonRequest<ConversationListResponse>(`/conversations?skip=${skip}&limit=${limit}`);
}

export async function listMessages(
  conversationId: string,
  skip = 0,
  limit = 200,
): Promise<MessageListResponse> {
  return jsonRequest<MessageListResponse>(
    `/conversations/${conversationId}/messages?skip=${skip}&limit=${limit}`,
  );
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const response = await apiFetch(`/conversations/${conversationId}`, {
    method: "DELETE",
  });
  if (response.status === 204) return;
  if (!response.ok) {
    throw new ApiError(response.status, await readError(response));
  }
}

export async function createConversation(firstMessage: string): Promise<InitialExchangeResponse> {
  return jsonRequest<InitialExchangeResponse>("/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ first_message: firstMessage }),
  });
}

export async function sendConversationMessage(
  conversationId: string,
  content: string,
): Promise<MessageExchangeResponse> {
  return jsonRequest<MessageExchangeResponse>(`/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

export async function openConversationStream(firstMessage: string, signal: AbortSignal): Promise<Response> {
  return apiFetch("/conversations/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ first_message: firstMessage }),
    signal,
  });
}

export async function openMessageStream(
  conversationId: string,
  content: string,
  signal: AbortSignal,
): Promise<Response> {
  return apiFetch(`/conversations/${conversationId}/messages/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ content }),
    signal,
  });
}

/**
 * Upload a skin photo for an existing Neo4j patient (luong B). Backs the
 * "existing patient" branch of the image-attach popup, as opposed to
 * startSkinDiagnostic (luong A, creates/uses a HAPI patient instead).
 * `note` is whatever the doctor typed alongside the photo (optional); it's
 * persisted as the user message the same way luong A does with `anamnesis`.
 * `conversationId` reuses the open chat if there is one, mirroring
 * startSkinDiagnostic's `conversation_id` param.
 */
export async function analyzeSkinImage(
  image: File,
  patientId: string,
  note?: string,
  conversationId?: string | null,
): Promise<SkinImageAnalyzeResponse> {
  const body = new FormData();
  body.append("patient_id", patientId);
  body.append("image", image);
  if (note) body.append("note", note);
  if (conversationId) body.append("conversation_id", conversationId);

  const response = await apiFetch("/skin-images/analyze", {
    method: "POST",
    body,
  });
  if (!response.ok) {
    throw new ApiError(response.status, await readError(response));
  }
  return response.json() as Promise<SkinImageAnalyzeResponse>;
}

/**
 * Attach a photo to an existing Neo4j patient with no diagnosis and no
 * chat message — used when the doctor picks a patient but doesn't type
 * any symptoms, so the flow doesn't need to jump into the chat view at
 * all. Backs POST /skin-images/save.
 */
export async function saveSkinPhotoOnly(
  image: File,
  patientId: string,
): Promise<SkinImageSaveResponse> {
  const body = new FormData();
  body.append("patient_id", patientId);
  body.append("image", image);

  const response = await apiFetch("/skin-images/save", {
    method: "POST",
    body,
  });
  if (!response.ok) {
    throw new ApiError(response.status, await readError(response));
  }
  return response.json() as Promise<SkinImageSaveResponse>;
}

/** List skin images already saved in Neo4j, optionally scoped to one patient. */
export async function listSkinImages(patientId?: string): Promise<SkinImageSummary[]> {
  const query = new URLSearchParams();
  if (patientId) query.set("patient_id", patientId);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const response = await jsonRequest<{ items: SkinImageSummary[] }>(`/skin-images${suffix}`);
  return response.items;
}

/** Autocomplete lookup for an existing Neo4j patient (skin-image upload
 * popup, luong B). Thin wrapper around GET /patients/search. */
export async function searchExistingPatients(query: string): Promise<PatientSearchResult[]> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const response = await jsonRequest<{ results: PatientSearchResult[] }>(
    `/patients/search?${params.toString()}`,
  );
  return response.results;
}

export async function startSkinDiagnostic(
  image: File,
  anamnesis: string,
  conversationId?: string | null,
  neo4jPatientId?: string | null,
): Promise<SkinDiagnosticStartResponse> {
  const body = new FormData();
  body.append("image", image);
  body.append("anamnesis", anamnesis);
  if (conversationId) {
    body.append("conversation_id", conversationId);
  }
  if (neo4jPatientId) {
    body.append("neo4j_patient_id", neo4jPatientId);
  }

  const response = await apiFetch("/skin-diagnostics/start", {
    method: "POST",
    body,
  });
  if (!response.ok) {
    throw new ApiError(response.status, await readError(response));
  }
  return response.json() as Promise<SkinDiagnosticStartResponse>;
}

/** Look up skin photos already stored on the FHIR server — by patient id,
 * patient name, and/or a lastUpdated date range. Backs any direct-query UI
 * (the chat agent has its own equivalent tool for natural-language asks). */
export async function searchFhirSkinImages(params: {
  patientId?: string;
  patientName?: string;
  dateFrom?: string;
  dateTo?: string;
  count?: number;
}): Promise<{ results: SkinImageResult[] }> {
  const query = new URLSearchParams();
  if (params.patientId) query.set("patient_id", params.patientId);
  if (params.patientName) query.set("patient_name", params.patientName);
  if (params.dateFrom) query.set("date_from", params.dateFrom);
  if (params.dateTo) query.set("date_to", params.dateTo);
  if (params.count) query.set("count", String(params.count));
  return jsonRequest<{ results: SkinImageResult[] }>(
    `/skin-diagnostics/fhir-images?${query.toString()}`,
  );
}

export async function getSkinDiagnosticStatus(runId: string): Promise<SkinDiagnosticStatus> {
  return jsonRequest<SkinDiagnosticStatus>(`/skin-diagnostics/${runId}/status`);
}

export async function submitSkinDiagnosticAnswers(
  runId: string,
  answers: { question_num: number | null; answer: string }[],
): Promise<{ status: string; current_step: string }> {
  return jsonRequest<{ status: string; current_step: string }>(
    `/skin-diagnostics/${runId}/answers`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    },
  );
}

/**
 * Fetch an auth-protected image (e.g. a persisted skin-diagnostic upload)
 * and turn it into a local blob URL. Needed because `<img src>` can't send
 * an Authorization header itself, and the uploads endpoint requires one —
 * without this, a saved photo simply 404s as "unauthenticated" after a
 * reload even though the file is still there.
 *
 * `absoluteUrl` should already be a full URL (see API_ORIGIN in
 * lib/config.ts) — this does not prefix it with API_BASE.
 */
export async function fetchAuthenticatedImage(absoluteUrl: string): Promise<string> {
  const token = getAccessToken();
  const response = await fetch(absoluteUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new ApiError(response.status, "Không thể tải ảnh đã lưu");
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}