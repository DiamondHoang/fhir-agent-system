"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Box, Flex, Heading, Text, Textarea, IconButton, VStack, HStack,
  Badge, Button, Spinner, Skeleton, Collapsible, Circle,
  Input, Separator,
} from "@chakra-ui/react";
import {
  Send, RotateCcw, ChevronDown, Bot, User, Sparkles,
  Plus, Trash2, LogOut, ImagePlus, X, Stethoscope, Loader2, CheckCircle2,
  PanelLeft, AlertCircle, SquarePen, Square, Save,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DOMAIN, API_BASE, API_ORIGIN } from "@/lib/config";
import type { GraphData } from "@/lib/config";
import {
  ApiError,
  clearAuth,
  deleteConversation,
  fetchAuthenticatedImage,
  getAccessToken,
  getStoredUser,
  listConversations,
  listMessages,
  login,
  openConversationStream,
  openMessageStream,
  register,
  startSkinDiagnostic,
  saveSkinPhotoOnly,
  getSkinDiagnosticStatus,
  getSkinDiagnosticByConversation,
  submitSkinDiagnosticAnswers,
  searchExistingPatients,
} from "@/lib/api";

import type {
  ChatMessage,
  Conversation,
  UserProfile,
  SkinDiagnosticStatus,
  SkinPendingQuestion,
  SkinAnsweredQuestion,
  SkinDiagnosticResult,
  SkinImageResult,
  PatientSearchResult,
} from "@/lib/api";
import { parseSseStream } from "@/lib/sse";
import type { ParsedSseEvent } from "@/lib/sse";

const CHAT_STREAM_TIMEOUT_MS = 900_000;

export const RANK_COLORS = ["#22c55e", "#eab308", "#3b82f6"];
export const RANK_LABELS = [
  "#1 — Khả năng cao nhất",
  "#2 — Khả năng trung bình",
  "#3 — Cần xem xét",
];

export const STEP_LABELS: Record<string, string> = {
  visual_extract: "Phân tích hình ảnh tổn thương",
  knowledge_base: "Tra cứu y văn & tri thức da liễu",
  clinical_planner_round1: "Lập danh sách câu hỏi lâm sàng 1",
  user_interview_round1: "Phỏng vấn lâm sàng 1",
  clinical_planner_round2: "Lập danh sách câu hỏi lâm sàng 2",
  user_interview_round2: "Phỏng vấn lâm sàng 2",
  diagnostic_reasoning: "Biện luận & tổng hợp chẩn đoán",
};

interface ToolCall {
  name: string;
  inputs: Record<string, unknown>;
  output_preview: string;
  status: "running" | "complete" | "failed";
  graph_data?: GraphData;
  raw_output?: unknown;
}

interface ExtractedEntity {
  name: string;
  type: string;
  subtype?: string;
}

interface DetectedPreference {
  category: string;
  preference: string;
  confidence?: number;
}

interface Message extends ChatMessage {
  role: "user" | "assistant" | "system";
  toolCalls?: ToolCall[];
  retryInput?: string;
  pending?: boolean;
  failed?: boolean;
  entities?: ExtractedEntity[];
  preferences?: DetectedPreference[];
  // Photos found via search_skin_images / start_diagnosis_from_patient_image
  // — rendered as real authenticated thumbnails instead of the model's text
  // trying (and failing) to link to them directly.
  skinImageResults?: SkinImageResult[];
  imagePreview?: string;
  type?: "text" | "skin_questions" | "skin_result" | "skin_progress" | "skin_qa_progress";
  skinQuestions?: SkinPendingQuestion[];
  skinAnsweredQuestions?: SkinAnsweredQuestion[];
  skinSubmitted?: boolean;
  skinResult?: SkinDiagnosticResult;
  skinStep?: string;
  skinRunId?: string;
}

interface ChatInterfaceProps {
  onGraphUpdate?: (data: GraphData) => void;
  externalInput?: string | null;
  onExternalInputConsumed?: () => void;
}

const THINKING_PATTERNS = [
  /^let me /i, /^i'll /i, /^i will /i, /^first,? i /i,
  /^now let me /i, /^let me also /i, /^let me try /i,
  /^i need to /i, /^i should /i, /^let me check /i,
  /^let me look /i, /^let me search /i, /^let me query /i,
  /^let me find /i, /^now i'll /i, /^now i need /i,
];

const CONTINUATION_PATTERNS = [
  /^(and |also |then |additionally |next |finally )/i,
  /^(this will |this should |this means |that way )/i,
  /^(so |because |since |in order to )/i,
  /^(after that |once |before )/i,
];

const MARKDOWN_LINE = /^(#{1,6} |[-*] |\d+\. |\|)/;

function splitThinkingAndResponse(text: string): { thinking: string; response: string } {
  if (!text) return { thinking: "", response: "" };
  if (/\berror\b/i.test(text) || /\bfailed\b/i.test(text) || /\bsyntax error\b/i.test(text)) {
    return { thinking: "", response: text };
  }

  const lines = text.split("\n");
  const thinkingLines: string[] = [];
  const responseLines: string[] = [];
  let foundResponse = false;
  let inThinkingBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!foundResponse && trimmed && THINKING_PATTERNS.some((p) => p.test(trimmed))) {
      thinkingLines.push(line);
      inThinkingBlock = true;
    } else if (
      inThinkingBlock &&
      !foundResponse &&
      trimmed &&
      !MARKDOWN_LINE.test(trimmed) &&
      (CONTINUATION_PATTERNS.some((p) => p.test(trimmed)) || trimmed.length < 80)
    ) {
      thinkingLines.push(line);
    } else {
      if (trimmed) {
        foundResponse = true;
        inThinkingBlock = false;
      }
      responseLines.push(line);
    }
  }

  const response = responseLines.join("\n").trim();
  const thinking = thinkingLines.join("\n").trim();
  if (!response && thinking) return { thinking: "", response: text };
  return { thinking, response };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isConversation(value: unknown): value is Conversation {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string";
}

function isChatMessage(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.conversation_id === "string" &&
    typeof value.role === "string" &&
    typeof value.content === "string" &&
    typeof value.created_at === "string"
  );
}

function isGraphData(value: unknown): value is GraphData {
  return isRecord(value) && Array.isArray(value.results);
}

function mapBackendMessage(message: ChatMessage): Message {
  const mapped: Message = {
    id: message.id,
    conversation_id: message.conversation_id,
    role: message.role,
    content: message.content,
    created_at: message.created_at,
  };
  // Rebuild the structured dermatology result card from what the backend
  // persisted, instead of leaving it as the plain-text summary in
  // `content`. The image (imagePreview) is re-hydrated separately in
  // loadConversationMessages, since fetching it needs an auth header and
  // can't happen synchronously here.
  if (message.message_type === "skin_result" && message.structured_data) {
    mapped.type = "skin_result";
    mapped.skinResult = message.structured_data as unknown as SkinDiagnosticResult;
    // `run_id` is saved alongside the result fields (see
    // _save_diagnosis_message on the backend) specifically so this mapped
    // message carries the same `skinRunId` the live Round 1/Round 2 cards
    // use. Without this, `skinRunId` stays undefined here, so
    // loadConversationMessages' `resultIdx` lookup (matching on
    // `m.skinRunId === run_id && m.type === "skin_result"`) never finds
    // this message and falls back to appending the round cards at the very
    // end of the conversation instead of right before the result — exactly
    // the "Round 1/2 luôn nhảy xuống cuối sau khi rời rồi quay lại chat" bug.
    const runId = message.structured_data.run_id;
    if (typeof runId === "string") {
      mapped.skinRunId = runId;
    }
  }
  // Photos found via search_skin_images / start_diagnosis_from_patient_image
  // are persisted onto structured_data.skin_images (see chat_stream.py) so
  // the gallery survives a reload, not just the live streaming session.
  const skinImages = isRecord(message.structured_data)
    ? message.structured_data.skin_images
    : undefined;
  if (Array.isArray(skinImages) && skinImages.length > 0) {
    mapped.skinImageResults = skinImages as SkinImageResult[];
  }
  return mapped;
}

function upsertConversation(items: Conversation[], conversation: Conversation): Conversation[] {
  return [conversation, ...items.filter((item) => item.id !== conversation.id)];
}

/** Three bouncing dots, like ChatGPT/Claude's "thinking" indicator — used
 * instead of "Đang phân tích...", "Đang tra cứu..." style status text. */
function TypingDots({ color = "gray.400" }: { color?: string }) {
  return (
    <Box as="span" className="typing-dots" color={color} lineHeight={0}>
      <span />
      <span />
      <span />
    </Box>
  );
}

/** Renders one skin photo found via search_skin_images /
 * start_diagnosis_from_patient_image as an actual thumbnail. The endpoint
 * (`view_url`) needs a Bearer token, so a plain <img src> can't load it
 * directly — fetch the bytes ourselves and hand the component a blob URL,
 * the same trick used for the user's own uploaded photo (see
 * fetchAuthenticatedImage in lib/api.ts). */
function SkinImageThumbnail({ image }: { image: SkinImageResult }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!image.view_url) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    fetchAuthenticatedImage(`${API_ORIGIN}${image.view_url}`)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image.view_url]);

  return (
    <Box w="140px" flexShrink={0} borderRadius="lg" overflow="hidden" borderWidth="1px" borderColor="gray.200" bg="white" shadow="xs">
      <Box w="140px" h="140px" bg="gray.100" display="flex" alignItems="center" justifyContent="center">
        {src ? (
          <img
            src={src}
            alt={image.patient_name || "Ảnh da"}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : failed ? (
          <AlertCircle size={20} color="#9CA3AF" />
        ) : (
          <Spinner size="sm" color="gray.400" />
        )}
      </Box>
      <Box px={2} py={1.5}>
        <Text fontSize="xs" fontWeight="medium" truncate>
          {image.patient_name || "(không rõ bệnh nhân)"}
        </Text>
        {image.last_updated && (
          <Text fontSize="2xs" color="gray.500">
            {new Date(image.last_updated).toLocaleDateString("vi-VN")}
          </Text>
        )}
      </Box>
    </Box>
  );
}

/** First letter of the username (or first+last word), for the account
 * avatar circle — mirrors how ChatGPT renders its bottom-left account chip. */
function getInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function replaceMessage(messages: Message[], localId: string, message: ChatMessage): Message[] {
  return messages.map((item) => (
    item.id === localId ? { ...mapBackendMessage(message), toolCalls: item.toolCalls } : item
  ));
}

function appendMessageOnce(messages: Message[], message: Message): Message[] {
  if (messages.some((item) => item.id === message.id)) return messages;
  return [...messages, message];
}

/** Chèn `card` ngay sau card CUỐI CÙNG thuộc cùng `runId` (ảnh, round đã
 * trả lời, v.v.), hoặc nối vào cuối mảng nếu run này chưa có card nào.
 *
 * Trước đây các card round câu hỏi (Round 1, Round 2, ...) được chèn "ngay
 * sau tin nhắn user gần nhất" — heuristic này chỉ đúng cho Round 1. Từ
 * Round 2 trở đi không có tin nhắn user mới nào được thêm giữa các round
 * (submit chỉ đánh dấu `skinSubmitted: true` trên card cũ), nên
 * "tin nhắn user gần nhất" vẫn trỏ về đúng tin nhắn user ban đầu — khiến
 * card Round 2 bị chèn TRƯỚC card Round 1 (đã submit) nằm phía sau vị trí
 * đó, làm sai thứ tự hiển thị dù dữ liệu vẫn đúng thứ tự thời gian.
 * Neo theo "card cuối cùng của cùng run" thay vì "user message gần nhất"
 * loại bỏ hoàn toàn lớp giả định đó và luôn cho thứ tự đúng bất kể số round. */
function insertAfterLastRunCard(arr: Message[], runId: string, card: Message): Message[] {
  let lastRunIdx = -1;
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i].skinRunId === runId) {
      lastRunIdx = i;
      break;
    }
  }
  if (lastRunIdx === -1) return [...arr, card];
  return [...arr.slice(0, lastRunIdx + 1), card, ...arr.slice(lastRunIdx + 1)];
}

/** Rebuild the two "Đã hoàn thành trả lời (5/5 câu hỏi)" cards (Round 1,
 * Round 2) from the backend's persisted answers, instead of the live
 * pqrst_answers-based cards — those only exist in React state for the
 * current tab and vanish on reload, which is exactly what made the 10
 * questions disappear when reopening an old chat. Used both right after a
 * live run finishes and when rehydrating a completed run from history, so
 * the two code paths can never drift out of sync. */
function buildAnsweredRoundCards(
  runId: string,
  conversationId: string,
  result: SkinDiagnosticResult
): Message[] {
  const cards: Message[] = [];
  const rounds: [SkinAnsweredQuestion[] | undefined, string][] = [
    [result.round1_qa_pairs, "r1"],
    [result.round2_qa_pairs, "r2"],
  ];
  rounds.forEach(([pairs, tag]) => {
    if (!pairs || pairs.length === 0) return;
    cards.push({
      id: `skin-qa-${tag}-${runId}`,
      conversation_id: conversationId,
      role: "assistant",
      content: `Đã hoàn thành trả lời (${pairs.length}/${pairs.length} câu hỏi)`,
      created_at: new Date().toISOString(),
      type: "skin_qa_progress",
      skinAnsweredQuestions: pairs,
      skinRunId: runId,
    });
  });
  return cards;
}

/** Read-only version of the live "CÓ/KHÔNG" question card, used to re-show
 * already-answered clinical questions — either inside the finished
 * diagnosis result, or above a still-pending round when an old chat is
 * reopened mid-interview. Same visual shape as the live card (see
 * `msg.type === "skin_questions"` below) so it reads as "the same 10
 * questions", just locked in on whichever answer was actually given. */
function AnsweredQuestionsCard({ questions }: { questions: SkinAnsweredQuestion[] }) {
  return (
    <VStack align="stretch" gap={3}>
      {questions.map((q) => {
        const isYes = q.answer?.trim().toLowerCase() === "yes" || q.answer === "Có";
        const isNo = q.answer?.trim().toLowerCase() === "no" || q.answer === "Không";
        return (
          <Box key={q.question_num} p={3} bg="white" borderRadius="md" borderWidth="1px" borderColor="gray.200">
            <HStack gap={2} mb={1}>
              <Text fontSize="xs" color="gray.500">Câu {q.question_num}</Text>
            </HStack>
            <Text fontSize="sm" fontWeight="medium" mb={2}>{q.question}</Text>
            <HStack gap={2}>
              <Button size="xs" flex={1} variant={isYes ? "solid" : "outline"} colorPalette="green" disabled>
                CÓ
              </Button>
              <Button size="xs" flex={1} variant={isNo ? "solid" : "outline"} colorPalette="red" disabled>
                KHÔNG
              </Button>
            </HStack>
          </Box>
        );
      })}
    </VStack>
  );
}

export function ChatInterface({ onGraphUpdate, externalInput, onExternalInputConsumed }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register" | "choose">("choose");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // File Upload State for Skin Diagnostic
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Image-attach popup: only the "existing patient" (Neo4j) branch exists
  // now — the old "new patient" (live FHIR server) flow was removed, so a
  // photo is either linked to an existing Neo4j patient or not saved to a
  // patient record at all (diagnosis-only, see the 3 cases documented on
  // POST /skin-diagnostics/start).
  const [patientChoiceModalOpen, setPatientChoiceModalOpen] = useState(false);
  const [existingPatientModalOpen, setExistingPatientModalOpen] = useState(false);
  const [existingPatientQuery, setExistingPatientQuery] = useState("");
  const [existingPatientResults, setExistingPatientResults] = useState<PatientSearchResult[]>([]);
  const [searchingExistingPatients, setSearchingExistingPatients] = useState(false);
  const [existingPatientError, setExistingPatientError] = useState<string | null>(null);
  const existingPatientDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingNeo4jPatientId, setPendingNeo4jPatientId] = useState<string | null>(null);
  const [pendingNeo4jPatientName, setPendingNeo4jPatientName] = useState<string | null>(null);
  // Lightweight top-right toast for actions that don't produce a chat
  // message (e.g. "save photo to patient record, no diagnosis") — separate
  // from `error`, which renders as a banner under the header bar.
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [savingPhotoOnly, setSavingPhotoOnly] = useState(false);
  const saveNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showSaveNotice(message: string) {
    setSaveNotice(message);
    if (saveNoticeTimerRef.current) clearTimeout(saveNoticeTimerRef.current);
    saveNoticeTimerRef.current = setTimeout(() => setSaveNotice(null), 3000);
  }

  // Skin Diagnostic State
  const [activeSkinRunId, setActiveSkinRunId] = useState<string | null>(null);
  const [skinStatus, setSkinStatus] = useState<SkinDiagnosticStatus | null>(null);
  const [pqrstAnswers, setPqrstAnswers] = useState<Record<number, string>>({});
  const [submittingSkinAnswers, setSubmittingSkinAnswers] = useState(false);
  const skinPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // FHIR SSE Streaming State
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCall[]>([]);
  const [streamingEntities, setStreamingEntities] = useState<ExtractedEntity[]>([]);
  const [streamingPreferences, setStreamingPreferences] = useState<DetectedPreference[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textBufferRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Set right before abort() when the user clicks the Stop button, so the
  // catch block in sendMessage can tell a deliberate stop apart from a
  // network failure or the 15-minute safety timeout, and keep the partial
  // answer instead of showing an error bubble.
  const stopRequestedRef = useRef(false);
  const streamingEntitiesRef = useRef<ExtractedEntity[]>([]);
  const streamingPreferencesRef = useRef<DetectedPreference[]>([]);
  const streamingSkinImagesRef = useRef<SkinImageResult[]>([]);
  // Nhớ tên bệnh nhân đã chọn theo run_id — dùng để hiện thông báo "Đã lưu
  // ảnh vào hồ sơ bệnh nhân ..." đúng tên khi diagnosis hoàn tất (luồng gửi
  // kèm tin nhắn triệu chứng), vì `pendingNeo4jPatientName` bị clear ngay
  // sau khi run bắt đầu để không dính sang lần chọn ảnh kế tiếp.
  const linkedPatientNamesRef = useRef<Record<string, string>>({});

  // Health Status
  const [backendStatus, setBackendStatus] = useState<"ok" | "degraded" | "offline">("offline");

  useEffect(() => {
    async function checkHealth() {
      try {
        const res = await fetch(`${API_BASE.replace("/api", "")}/health`, {
          signal: AbortSignal.timeout(4000),
        });
        const data = await res.json();
        setBackendStatus(data.status === "ok" ? "ok" : "degraded");
      } catch {
        setBackendStatus("offline");
      }
    }
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleAuthFailure = useCallback(() => {
    clearAuth();
    setUser(null);
    setMessages([]);
    setConversations([]);
    setActiveConversationId(null);
    setError("Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.");
  }, []);

  const loadConversationList = useCallback(async () => {
    if (!getAccessToken()) return;
    setLoadingConversations(true);
    setError(null);
    try {
      const data = await listConversations();
      setConversations(data.items);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        handleAuthFailure();
      } else {
        setError(err instanceof Error ? err.message : "Không thể tải danh sách cuộc trò chuyện");
      }
    } finally {
      setLoadingConversations(false);
    }
  }, [handleAuthFailure]);

  const stopSkinPolling = useCallback(() => {
    if (skinPollIntervalRef.current) {
      clearInterval(skinPollIntervalRef.current);
      skinPollIntervalRef.current = null;
    }
  }, []);

  const pollSkinStatus = useCallback(async (runId: string) => {
    try {
      const status = await getSkinDiagnosticStatus(runId);
      setSkinStatus(status);

      if (status.status === "interrupt" && status.pending_questions) {
        stopSkinPolling();
        setLoading(false);
        // Keep submitted question cards (previous rounds) and only remove
        // the current unsubmitted pending card so all answered rounds stay visible.
        setMessages((prev) => {
          const filtered = prev.filter(
            (m) => !(m.skinRunId === runId && m.type === "skin_questions" && !m.skinSubmitted)
          );
          const pendingCard: Message = {
            id: `skin-q-${runId}-${Date.now()}`,
            conversation_id: activeConversationId || runId,
            role: "assistant",
            content: "Vui lòng trả lời các câu hỏi lâm sàng dưới đây để làm rõ chẩn đoán:",
            created_at: new Date().toISOString(),
            type: "skin_questions",
            skinQuestions: status.pending_questions || [],
            skinSubmitted: false,
            skinRunId: runId,
          };
          // Chèn ngay sau card cuối cùng của CÙNG run này (ảnh, round đã
          // trả lời, ...) — không dùng "user message gần nhất" nữa vì
          // heuristic đó chèn nhầm Round 2 lên trước Round 1 đã submit.
          return insertAfterLastRunCard(filtered, runId, pendingCard);
        });
      } else if (status.status === "completed" && status.result) {
        stopSkinPolling();
        setLoading(false);
        const resultObj = status.result as SkinDiagnosticResult;
        setMessages((prev) => {
          // Guard against duplicate result cards: concurrent polls (the
          // immediate call in startSkinPolling plus an interval tick that
          // was already in flight) can both observe status "completed"
          // before stopSkinPolling() takes effect. Bail out if a result
          // card for this run is already present instead of appending a
          // second one.
          if (prev.some((m) => m.skinRunId === runId && m.type === "skin_result")) {
            return prev;
          }
          // Drop the live pqrst_answers-based round cards for this run —
          // they relied on client-side selection state, so from here on
          // we always rebuild the two round cards from the backend's
          // persisted answers (buildAnsweredRoundCards) instead.
          const filtered = prev.filter(
            (m) => !(m.skinRunId === runId && m.type === "skin_questions")
          );
          return [
            ...filtered,
            ...buildAnsweredRoundCards(runId, activeConversationId || runId, resultObj),
            {
              id: `skin-res-${runId}`,
              conversation_id: activeConversationId || runId,
              role: "assistant",
              content: "Kết quả chẩn đoán da liễu:",
              created_at: new Date().toISOString(),
              type: "skin_result",
              skinResult: resultObj,
              skinRunId: runId,
            },
          ];
        });
        // Luồng gửi kèm tin nhắn triệu chứng + ảnh + đã chọn bệnh nhân: ảnh
        // chỉ thực sự được lưu vào hồ sơ Neo4j ở bước cuối cùng của
        // pipeline (sau khi có chẩn đoán), khác với nút "Lưu vào hồ sơ"
        // riêng (lưu ngay, có thông báo ngay). Giờ backend đã trả về cờ
        // `photo_saved_to_patient` trong cùng kết quả này, nên hiện thông
        // báo tương tự ngay khi thấy cờ đó — không còn im lặng nữa.
        if (resultObj.photo_saved_to_patient) {
          const patientName = linkedPatientNamesRef.current[runId];
          if (patientName) {
            showSaveNotice(`Đã lưu ảnh vào hồ sơ bệnh nhân ${patientName}`);
          }
          delete linkedPatientNamesRef.current[runId];
        }
      } else if (status.status === "error") {
        stopSkinPolling();
        setLoading(false);
        setError(`Lỗi chẩn đoán da liễu: ${status.error || "Không xác định"}`);
      }
    } catch (err) {
      stopSkinPolling();
      setLoading(false);
      setError(err instanceof Error ? err.message : "Không thể kiểm tra trạng thái chẩn đoán da liễu");
    }
  }, [activeConversationId, stopSkinPolling]);

  const startSkinPolling = useCallback((runId: string) => {
    stopSkinPolling();
    void pollSkinStatus(runId);
    skinPollIntervalRef.current = setInterval(() => pollSkinStatus(runId), 2000);
  }, [pollSkinStatus, stopSkinPolling]);

  const loadConversationMessages = useCallback(async (conversationId: string) => {
    stopSkinPolling();
    setActiveConversationId(conversationId);
    setMessages([]);
    setStreamingContent("");
    setStreamingToolCalls([]);
    setLoadingMessages(true);
    setError(null);
    try {
      const data = await listMessages(conversationId);
      setMessages(
        data.items
          .filter((item) => item.message_type !== "interview_qa")
          .map(mapBackendMessage)
      );

      // Re-hydrate attached photos. The thumbnail shown while chatting is a
      // local blob: URL that only lives for the current tab — after a
      // reload we have to re-fetch the persisted file from the backend
      // (auth-protected, so this can't just be an <img src=...>) and patch
      // it back onto the matching message once it arrives.
      data.items.forEach((item) => {
        if (!item.image_url) return;
        fetchAuthenticatedImage(`${API_ORIGIN}${item.image_url}`)
          .then((blobUrl) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === item.id ? { ...m, imagePreview: blobUrl } : m))
            );
          })
          .catch(() => {
            // Image no longer available (deleted run, etc.) — leave the
            // message without a thumbnail rather than blocking the rest.
          });
      });

      // Re-hydrate active/pending skin diagnostic run for this conversation
      try {
        const skinStatus = await getSkinDiagnosticByConversation(conversationId);
        if (skinStatus && skinStatus.run_id) {
          setActiveSkinRunId(skinStatus.run_id);
          setSkinStatus(skinStatus);

          // Câu hỏi/trả lời đã hoàn thành ở (các) round trước — backend giờ
          // lưu state ngay sau mỗi round thay vì chỉ lúc "completed", nên
          // round1_qa_pairs/round2_qa_pairs có thể đã có dữ liệu dù run vẫn
          // đang "interrupt" hoặc "running". Không có block này thì 5 câu
          // Round 1 sẽ biến mất khỏi UI khi user quay lại chat lúc đang chờ
          // trả lời Round 2. Với case "completed", card kết quả đã được nạp
          // sẵn từ listMessages() ở trên — chèn 2 card round vào NGAY TRƯỚC
          // nó để khớp đúng thứ tự Round 1 -> Round 2 -> Kết quả như lúc
          // chạy live, thay vì chỉ nối vào cuối danh sách.
          const resultForRounds = skinStatus.result as SkinDiagnosticResult | undefined;
          if (resultForRounds && (resultForRounds.round1_qa_pairs?.length || resultForRounds.round2_qa_pairs?.length)) {
            setMessages((prev) => {
              if (
                prev.some(
                  (m) => m.skinRunId === skinStatus.run_id && m.type === "skin_qa_progress"
                )
              ) {
                return prev;
              }
              const roundCards = buildAnsweredRoundCards(skinStatus.run_id, conversationId, resultForRounds);
              if (roundCards.length === 0) return prev;
              const resultIdx = prev.findIndex(
                (m) => m.skinRunId === skinStatus.run_id && m.type === "skin_result"
              );
              if (resultIdx === -1) return [...prev, ...roundCards];
              return [...prev.slice(0, resultIdx), ...roundCards, ...prev.slice(resultIdx)];
            });
          }

          if (
            skinStatus.status === "interrupt" &&
            skinStatus.pending_questions &&
            skinStatus.pending_questions.length > 0
          ) {
            setMessages((prev) => {
              if (
                prev.some(
                  (m) => m.skinRunId === skinStatus.run_id && m.type === "skin_questions"
                )
              ) {
                return prev;
              }
              const pendingCard: Message = {
                id: `skin-q-${skinStatus.run_id}`,
                conversation_id: conversationId,
                role: "assistant",
                content: "Vui lòng trả lời các câu hỏi lâm sàng dưới đây để làm rõ chẩn đoán:",
                created_at: new Date().toISOString(),
                type: "skin_questions",
                skinQuestions: skinStatus.pending_questions || [],
                skinSubmitted: false,
                skinRunId: skinStatus.run_id,
              };
              // Chèn ngay sau card cuối cùng của CÙNG run (ảnh, round đã
              // trả lời, ...) thay vì "user message gần nhất" — cách cũ chèn
              // nhầm card câu hỏi đang chờ (vd. Round 2) lên TRƯỚC các round
              // card đã hoàn thành (vd. Round 1) vừa được nạp lại ở trên,
              // vì cả hai đều chỉ tìm thấy cùng 1 user message ban đầu.
              return insertAfterLastRunCard(prev, skinStatus.run_id, pendingCard);
            });
          } else if (skinStatus.status === "running") {
            startSkinPolling(skinStatus.run_id);
          }
        }
      } catch {
        // No active skin diagnostic run found for this conversation, ignore
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        handleAuthFailure();
      } else if (err instanceof ApiError && err.status === 404) {
        setActiveConversationId(null);
        setMessages([]);
        await loadConversationList();
        setError("Không tìm thấy cuộc trò chuyện.");
      } else {
        setError(err instanceof Error ? err.message : "Không thể tải tin nhắn");
      }
    } finally {
      setLoadingMessages(false);
    }
  }, [handleAuthFailure, loadConversationList, stopSkinPolling]);

  useEffect(() => {
    const storedUser = getStoredUser();
    if (getAccessToken() && storedUser) {
      setUser(storedUser);
      void loadConversationList();
    }
    setAuthReady(true);
  }, [loadConversationList]);

  useEffect(() => {
    if (externalInput && !loading && user) {
      sendMessage(externalInput);
      onExternalInputConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalInput, loading, user]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent, streamingToolCalls, skinStatus]);

  useEffect(() => {
    if (!loading) { setElapsedSeconds(0); return; }
    const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [loading]);

  const flushTextBuffer = useCallback(() => {
    setStreamingContent(textBufferRef.current);
    flushTimerRef.current = null;
  }, []);

  const appendStreamingText = useCallback((text: string) => {
    textBufferRef.current += text;
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flushTextBuffer, 50);
    }
  }, [flushTextBuffer]);

  function cancelRequest() {
    stopSkinPolling();
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setLoading(false);
  }

  /** "Dừng" button — mirrors Claude/ChatGPT's stop-generation control.
   * Two cases:
   *  - A text/agent SSE stream is in flight: mark it as a deliberate stop
   *    and abort the fetch. The catch block in sendMessage sees
   *    stopRequestedRef and keeps whatever text/tool calls had already
   *    streamed in as a real message bubble instead of showing an error.
   *  - A skin-diagnostic run is in progress (status polling, no abortable
   *    fetch): just stop polling and drop the loading state — the backend
   *    run keeps going server-side, but the UI stops waiting on it. */
  function handleStopGeneration() {
    if (abortControllerRef.current) {
      stopRequestedRef.current = true;
      abortControllerRef.current.abort();
    } else {
      stopSkinPolling();
      setLoading(false);
    }
  }

  function resetStreamingState() {
    setStreamingContent("");
    setStreamingToolCalls([]);
    setStreamingEntities([]);
    setStreamingPreferences([]);
    streamingEntitiesRef.current = [];
    streamingPreferencesRef.current = [];
    streamingSkinImagesRef.current = [];
    textBufferRef.current = "";
  }

  function startNewConversation() {
    cancelRequest();
    setActiveConversationId(null);
    setActiveSkinRunId(null);
    setSkinStatus(null);
    setPqrstAnswers({});
    setSelectedFile(null);
    setFilePreview(null);
    setPatientChoiceModalOpen(false);
    setExistingPatientModalOpen(false);
    setPendingNeo4jPatientId(null);
    setPendingNeo4jPatientName(null);
    setMessages([]);
    resetStreamingState();
    setLoading(false);
    setError(null);
  }

  const handleFileSelect = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Vui lòng chọn file hình ảnh hợp lệ (.jpg, .png, .webp)");
      return;
    }
    setSelectedFile(file);
    if (filePreview) URL.revokeObjectURL(filePreview);
    setFilePreview(URL.createObjectURL(file));
    // Every new photo is a fresh dermatology case — never carry over a
    // patient picked for a previous photo.
    setPendingNeo4jPatientId(null);
    setPendingNeo4jPatientName(null);
    setExistingPatientQuery("");
    setExistingPatientResults([]);
    setExistingPatientError(null);
    // Ask whether this photo belongs to an existing patient before sending.
    setPatientChoiceModalOpen(true);
  };

  const clearSelectedFile = () => {
    setSelectedFile(null);
    if (filePreview) URL.revokeObjectURL(filePreview);
    setFilePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setPatientChoiceModalOpen(false);
    closeExistingPatientModal();
    setPendingNeo4jPatientId(null);
    setPendingNeo4jPatientName(null);
  };

  /** "Bệnh nhân đang có" chosen from the choice popup — opens the Neo4j
   * patient search. */
  function handleChoiceExistingPatient() {
    setPatientChoiceModalOpen(false);
    setExistingPatientModalOpen(true);
  }

  function closeExistingPatientModal() {
    setExistingPatientModalOpen(false);
    setExistingPatientError(null);
    if (existingPatientDebounceRef.current) {
      clearTimeout(existingPatientDebounceRef.current);
      existingPatientDebounceRef.current = null;
    }
  }

  /** Debounced autocomplete against GET /patients/search (F-04/F-05). */
  function handleExistingPatientQueryChange(value: string) {
    setExistingPatientQuery(value);
    if (existingPatientDebounceRef.current) clearTimeout(existingPatientDebounceRef.current);
    const trimmed = value.trim();
    if (!trimmed) {
      setExistingPatientResults([]);
      setSearchingExistingPatients(false);
      return;
    }
    existingPatientDebounceRef.current = setTimeout(async () => {
      setSearchingExistingPatients(true);
      setExistingPatientError(null);
      try {
        const results = await searchExistingPatients(trimmed);
        setExistingPatientResults(results);
      } catch (err) {
        setExistingPatientError(
          err instanceof Error ? err.message : "Không thể tìm bệnh nhân",
        );
      } finally {
        setSearchingExistingPatients(false);
      }
    }, 300);
  }

  function handleSelectExistingPatient(patient: PatientSearchResult) {
    setPendingNeo4jPatientId(patient.id);
    setPendingNeo4jPatientName(patient.name || patient.id);
    setExistingPatientModalOpen(false);
  }

  /** Photo attached + existing patient chosen + no symptom text typed —
   * the doctor just wants the photo filed under that patient's record, not
   * a diagnosis. Saves directly via POST /skin-images/save and shows a
   * toast; never touches the chat/conversation state, so pressing Enter in
   * this state no longer jumps into a chat bubble with a generic
   * placeholder message. */
  async function saveAttachedPhotoOnly() {
    if (!selectedFile || !pendingNeo4jPatientId || savingPhotoOnly) return;
    const file = selectedFile;
    const patientId = pendingNeo4jPatientId;
    const patientName = pendingNeo4jPatientName || patientId;
    setSavingPhotoOnly(true);
    setError(null);
    try {
      await saveSkinPhotoOnly(file, patientId);
      clearSelectedFile();
      showSaveNotice(`Đã lưu ảnh vào hồ sơ bệnh nhân ${patientName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không thể lưu ảnh vào hồ sơ bệnh nhân");
    } finally {
      setSavingPhotoOnly(false);
    }
  }

  async function handleAuthSubmit() {
    const trimmedUsername = username.trim();
    if (!trimmedUsername || !password || authLoading) return;
    setError(null);
    if (authMode === "register") {
      if (trimmedUsername.length < 3) {
        setError("Tên đăng nhập phải từ 3 ký tự trở lên.");
        return;
      }
      if (password.length < 8) {
        setError("Mật khẩu phải từ 8 ký tự trở lên.");
        return;
      }
    }
    setAuthLoading(true);
    try {
      if (authMode === "register") {
        await register(trimmedUsername, password);
      }
      const tokenResponse = await login(trimmedUsername, password);
      setUser(tokenResponse.user);
      setUsername("");
      setPassword("");
      await loadConversationList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Xác thực thất bại");
    } finally {
      setAuthLoading(false);
    }
  }

  function handleLogout() {
    cancelRequest();
    clearAuth();
    setUser(null);
    setConversations([]);
    setActiveConversationId(null);
    setMessages([]);
    resetStreamingState();
    setError(null);
  }

  function applyToolStart(data: Record<string, unknown>, toolCalls: ToolCall[]): ToolCall[] {
    return [
      ...toolCalls,
      {
        name: asString(data.name) || "tool",
        inputs: isRecord(data.inputs) ? data.inputs : {},
        output_preview: "",
        status: "running",
      },
    ];
  }

  function applyToolEnd(data: Record<string, unknown>, toolCalls: ToolCall[]): ToolCall[] {
    const endName = asString(data.name);
    let matched = false;
    return toolCalls.map((tc) => {
      if (tc.name === endName && tc.status === "running" && !matched) {
        matched = true;
        const graphData = isGraphData(data.graph_data) ? data.graph_data : undefined;
        return {
          ...tc,
          output_preview: asString(data.output_preview),
          status: "complete" as const,
          graph_data: graphData,
          raw_output: data,
        };
      }
      return tc;
    });
  }

  // Submit Bulk Answers for PQRST Questions
  async function handleSubmitPqrstAnswers(questions: SkinPendingQuestion[], runId: string) {
    if (!runId || submittingSkinAnswers) return;
    setSubmittingSkinAnswers(true);
    setError(null);

    const payload = questions.map((q) => ({
      question_num: q.question_num,
      answer: pqrstAnswers[q.question_num ?? -1] || "Không",
    }));

    try {
      await submitSkinDiagnosticAnswers(runId, payload);
      // Mark card as submitted locally
      setMessages((prev) =>
        prev.map((m) =>
          m.skinRunId === runId && m.type === "skin_questions"
            ? { ...m, skinSubmitted: true }
            : m
        )
      );
      setLoading(true);
      startSkinPolling(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không thể gửi câu trả lời");
    } finally {
      setSubmittingSkinAnswers(false);
    }
  }

  async function sendMessage(overrideText?: string) {
    const messageText = (overrideText !== undefined ? overrideText : input).trim();
    if ((!messageText && !selectedFile) || loading || !user) return;

    // Photo + existing patient chosen + no symptom text -> the doctor just
    // wants the photo filed under that patient, not a diagnosis. Handle
    // this before the diagnostic branch below so Enter/Send doesn't jump
    // into a chat conversation with a generic placeholder message.
    if (selectedFile && pendingNeo4jPatientId && !messageText) {
      await saveAttachedPhotoOnly();
      return;
    }

    // Check if an image is attached -> Trigger Skin Diagnostic Pipeline!
    if (selectedFile) {
      const file = selectedFile;
      const currentPreview = filePreview;
      // NOTE: don't call clearSelectedFile() here — it revokes the blob
      // URL held in `filePreview`, but that's the same URL we're about to
      // hand off to the chat message below as `imagePreview`. Revoking it
      // immediately made the thumbnail disappear as soon as the message
      // was sent. Reset the composer fields directly instead, and let the
      // browser reclaim the blob URL when the tab is closed.
      setSelectedFile(null);
      setFilePreview(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setInput("");
      // Question numbers are reused by each diagnostic run, so answers must
      // never carry over from a previous patient/image.
      setPqrstAnswers({});
      setLoading(true);
      setError(null);

      const localUserMsg: Message = {
        id: `user-skin-${Date.now()}`,
        conversation_id: activeConversationId || "skin",
        role: "user",
        content: messageText || "Yêu cầu chẩn đoán hình ảnh tổn thương da liễu",
        created_at: new Date().toISOString(),
        imagePreview: currentPreview || undefined,
      };

      setMessages((prev) => [...prev, localUserMsg]);

      const neo4jPatientIdForRun = pendingNeo4jPatientId;
      // Consumed by this run — the next photo picked must trigger its own
      // patient-choice popup rather than silently reusing this one.
      setPendingNeo4jPatientId(null);
      setPendingNeo4jPatientName(null);

      try {
        const startRes = await startSkinDiagnostic(
          file,
          messageText,
          activeConversationId,
          neo4jPatientIdForRun,
        );
        setActiveSkinRunId(startRes.run_id);
        if (neo4jPatientIdForRun) {
          linkedPatientNamesRef.current[startRes.run_id] =
            pendingNeo4jPatientName || neo4jPatientIdForRun;
        }

        // The skin-diagnostic run now creates/reuses a real Conversation on
        // the backend (see app/skin_diagnostic/router.py). Reflect that here
        // so the sidebar shows a titled conversation instead of the request
        // silently disappearing once the run finishes.
        if (startRes.conversation_id) {
          const wasNewConversation = !activeConversationId;
          setActiveConversationId(startRes.conversation_id);
          if (wasNewConversation) {
            const conversation: Conversation = {
              id: startRes.conversation_id,
              user_id: user.id,
              title: startRes.conversation_title || messageText || "Chẩn đoán da liễu",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            setConversations((prev) => upsertConversation(prev, conversation));
          } else {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === startRes.conversation_id
                  ? { ...c, updated_at: new Date().toISOString() }
                  : c
              )
            );
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === localUserMsg.id
                ? { ...m, conversation_id: startRes.conversation_id }
                : m
            )
          );
        }

        startSkinPolling(startRes.run_id);
      } catch (err) {
        setLoading(false);
        setError(err instanceof Error ? err.message : "Không thể khởi động phân tích da liễu");
      }
      return;
    }

    // Otherwise: Send Text Message to FHIR Agent SSE Stream
    const targetConversationId = activeConversationId;
    const localUserId = `local-user-${crypto.randomUUID()}`;
    const userMessage: Message = {
      id: localUserId,
      conversation_id: targetConversationId ?? "pending",
      role: "user",
      content: messageText,
      created_at: new Date().toISOString(),
      pending: true,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);
    setError(null);
    resetStreamingState();

    const controller = new AbortController();
    abortControllerRef.current = controller;
    let timeout = setTimeout(() => controller.abort(), CHAT_STREAM_TIMEOUT_MS);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), CHAT_STREAM_TIMEOUT_MS);
    };

    let fullText = "";
    let toolCalls: ToolCall[] = [];
    let confirmedUserId: string | null = null;
    // Set to true when the agent calls start_skin_diagnostic /
    // start_diagnosis_from_patient_image so that the assistant's
    // wrap-up text ("Tôi đã bắt đầu quá trình chẩn đoán...") is
    // suppressed in the `done` handler — the Q&A card already
    // renders above and that extra bubble would be confusing.
    let skinDiagnosticStarted = false;

    try {
      const response = targetConversationId
        ? await openMessageStream(targetConversationId, messageText, controller.signal)
        : await openConversationStream(messageText, controller.signal);

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        const detail = isRecord(errorData) ? asString(errorData.detail) : "";
        throw new Error(detail || `Backend error (${response.status})`);
      }

      if (!response.body) {
        throw new Error("Không có dữ liệu phản hồi từ máy chủ");
      }

      for await (const parsedEvent of parseSseStream(response.body)) {
        resetTimeout();
        await handleChatEvent(parsedEvent);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) {
        handleAuthFailure();
      }
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }

      const wasManualStop =
        stopRequestedRef.current && err instanceof DOMException && err.name === "AbortError";
      stopRequestedRef.current = false;

      if (wasManualStop) {
        // User clicked Stop — keep whatever had already streamed in as a
        // normal assistant bubble (like Claude/ChatGPT), instead of
        // discarding it and showing an error. The backend also cancels the
        // in-flight agent task on disconnect (see chat_stream.py), so no
        // half-finished assistant message gets persisted server-side —
        // this bubble is local-only for this session.
        const partialText = (fullText || textBufferRef.current).trim();
        setMessages((prev) => {
          const marked = confirmedUserId
            ? prev
            : prev.map((item) => item.id === localUserId ? { ...item, pending: false } : item);
          if (!partialText && toolCalls.length === 0) return marked;
          return [
            ...marked,
            {
              id: `local-stopped-${crypto.randomUUID()}`,
              conversation_id: activeConversationId ?? confirmedUserId ?? "pending",
              role: "assistant",
              content: partialText || "_Đã dừng phản hồi._",
              created_at: new Date().toISOString(),
              toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
            },
          ];
        });
      } else {
        const errorMsg = err instanceof DOMException && err.name === "AbortError"
          ? "Hệ thống phản hồi lâu hoặc bị hủy. Vui lòng thử lại."
          : err instanceof Error && err.message
            ? err.message
            : "Không thể kết nối Backend. Vui lòng kiểm tra dịch vụ.";
        setMessages((prev) => {
          const marked = confirmedUserId
            ? prev
            : prev.map((item) => item.id === localUserId ? { ...item, failed: true, pending: false } : item);
          return [
            ...marked,
            {
              id: `local-error-${crypto.randomUUID()}`,
              conversation_id: activeConversationId ?? confirmedUserId ?? "pending",
              role: "assistant",
              content: `**Lỗi:** ${errorMsg}`,
              created_at: new Date().toISOString(),
              retryInput: messageText,
            },
          ];
        });
      }

      toolCalls = toolCalls.map((tc) => tc.status === "running" ? { ...tc, status: "failed" } : tc);
      setStreamingToolCalls([]);
      setStreamingContent("");
      textBufferRef.current = "";
    } finally {
      clearTimeout(timeout);
      abortControllerRef.current = null;
      setLoading(false);
    }

    async function handleChatEvent({ event, data }: ParsedSseEvent) {
      if (!isRecord(data)) return;

      switch (event) {
        case "conversation_started": {
          const conversation = data.conversation;
          const userMessageData = data.user_message;
          if (isConversation(conversation)) {
            setActiveConversationId(conversation.id);
            setConversations((prev) => upsertConversation(prev, conversation));
          }
          if (isChatMessage(userMessageData)) {
            confirmedUserId = userMessageData.conversation_id;
            setMessages((prev) => replaceMessage(prev, localUserId, userMessageData));
          }
          break;
        }

        case "message_started": {
          const userMessageData = data.user_message;
          if (isChatMessage(userMessageData)) {
            confirmedUserId = userMessageData.conversation_id;
            setMessages((prev) => replaceMessage(prev, localUserId, userMessageData));
          }
          break;
        }

        case "tool_start":
          toolCalls = applyToolStart(data, toolCalls);
          setStreamingToolCalls([...toolCalls]);
          break;

        case "tool_end": {
          toolCalls = applyToolEnd(data, toolCalls);
          setStreamingToolCalls([...toolCalls]);
          const graphData = isGraphData(data.graph_data) ? data.graph_data : undefined;
          if (graphData?.results?.length && onGraphUpdate) {
            onGraphUpdate(graphData);
          }
          const toolName = asString(data.name);
          if (toolName === "start_skin_diagnostic" || toolName === "start_diagnosis_from_patient_image") {
            skinDiagnosticStarted = true;
            try {
              const outputStr = asString(data.output_preview);
              const outputJson = JSON.parse(outputStr);
              if (outputJson && outputJson.status === "ok" && outputJson.data && outputJson.data.run_id) {
                const runId = outputJson.data.run_id;
                setActiveSkinRunId(runId);
                setLoading(true);
                startSkinPolling(runId);
              }
            } catch (e) {
              console.error("Failed to parse tool output for skin diagnostic run_id:", e);
            }
          }
          break;
        }

        case "text_delta": {
          const delta = asString(data.text) || asString(data.delta);
          fullText += delta;
          appendStreamingText(delta);
          break;
        }

        case "entities_extracted":
          if (Array.isArray(data.entities)) {
            streamingEntitiesRef.current = [
              ...streamingEntitiesRef.current,
              ...(data.entities as ExtractedEntity[]),
            ];
            setStreamingEntities([...streamingEntitiesRef.current]);
          }
          break;

        case "preferences_detected":
          if (Array.isArray(data.preferences)) {
            streamingPreferencesRef.current = [
              ...streamingPreferencesRef.current,
              ...(data.preferences as DetectedPreference[]),
            ];
            setStreamingPreferences([...streamingPreferencesRef.current]);
          }
          break;

        case "skin_images":
          if (Array.isArray(data.images)) {
            const incoming = data.images as SkinImageResult[];
            const existingIds = new Set(
              streamingSkinImagesRef.current.map((img) => img.binary_id || img.study_id),
            );
            const deduped = incoming.filter(
              (img) => !existingIds.has(img.binary_id || img.study_id),
            );
            if (deduped.length > 0) {
              streamingSkinImagesRef.current = [...streamingSkinImagesRef.current, ...deduped];
              // Render ảnh ra chat NGAY khi event này về, thay vì chỉ gom
              // vào ref rồi đợi sự kiện "done" — với luồng
              // start_diagnosis_from_patient_image, khối xử lý "done" bị
              // suppress toàn bộ (xem case "done" bên dưới) nên ảnh sẽ
              // không bao giờ hiện nếu chờ tới đó. Event "skin_images" luôn
              // về TRƯỚC "tool_end" (backend emit ảnh trước khi trả kết quả
              // tool), nên card ảnh này chắc chắn xuất hiện trước card câu
              // hỏi Round 1 (được tạo khi "tool_end" kích hoạt polling).
              setMessages((prev) => [
                ...prev,
                {
                  id: `skin-photo-${Date.now()}`,
                  conversation_id: activeConversationId || "",
                  role: "assistant",
                  content: "Ảnh gần nhất của bệnh nhân:",
                  created_at: new Date().toISOString(),
                  type: "text",
                  skinImageResults: deduped,
                },
              ]);
            }
          }
          break;

        case "done": {
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          const conversation = data.conversation;
          const userMessageData = data.user_message;
          const assistantMessage = data.assistant_message;
          const responseText = asString(data.response) || fullText;

          if (isConversation(conversation)) {
            setActiveConversationId(conversation.id);
            setConversations((prev) => upsertConversation(prev, conversation));
          } else {
            void loadConversationList();
          }

          if (isChatMessage(userMessageData)) {
            setMessages((prev) => replaceMessage(prev, localUserId, userMessageData));
          }

          // If the agent triggered a skin-diagnostic run, its assistant
          // wrap-up text is redundant — the Q&A card is already visible
          // above. Suppress the message bubble entirely in that case.
          // (Ảnh — nếu có — đã được render riêng ngay lúc sự kiện SSE
          // "skin_images" về, không phụ thuộc vào khối này nữa, nên
          // KHÔNG gán lại skinImageResults ở đây để tránh hiện ảnh 2 lần.)
          if (isChatMessage(assistantMessage) && !skinDiagnosticStarted) {
            const finalEntities = streamingEntitiesRef.current;
            const finalPreferences = streamingPreferencesRef.current;
            const mappedAssistant = mapBackendMessage(assistantMessage);
            setMessages((prev) => appendMessageOnce(prev, {
              ...mappedAssistant,
              content: responseText || assistantMessage.content,
              toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
              entities: finalEntities.length > 0 ? [...finalEntities] : undefined,
              preferences: finalPreferences.length > 0 ? [...finalPreferences] : undefined,
              skinImageResults: undefined,
            }));
          }
          resetStreamingState();
          break;
        }

        case "error":
          throw new Error(asString(data.detail) || "Lỗi truyền dữ liệu");
      }
    }
  }

  async function handleDeleteConversation(conversationId: string) {
    if (loading) return;
    setError(null);
    try {
      await deleteConversation(conversationId);
      const remaining = conversations.filter((item) => item.id !== conversationId);
      setConversations(remaining);
      if (activeConversationId === conversationId) {
        const next = remaining[0];
        if (next) {
          await loadConversationMessages(next.id);
        } else {
          startNewConversation();
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        handleAuthFailure();
      } else {
        setError(err instanceof Error ? err.message : "Không thể xóa cuộc trò chuyện");
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  if (!authReady) {
    return (
      <Flex align="center" justify="center" h="100vh">
        <Spinner size="md" color="blue.500" />
      </Flex>
    );
  }

  if (!user) {
    return (
      <Flex direction="column" h="100vh" bg="gray.50">
        <HStack px={6} py={4} bg="gray.900" color="white" justify="space-between">
          <HStack gap={2}>
            <Sparkles size={20} color="#10a37f" />
            <Heading size="md">{DOMAIN.name} AI Agent System</Heading>
          </HStack>
        </HStack>
        <Flex flex={1} align="center" justify="center" px={4}>
          {authMode === "choose" ? (
            /* Initial screen: just 2 buttons */
            <VStack gap={4} align="stretch" w="100%" maxW="320px">
              <VStack gap={1} mb={2}>
                <Sparkles size={32} color="#10a37f" />
                <Heading size="md" textAlign="center" color="gray.800">Chào mừng bạn</Heading>
                <Text fontSize="sm" color="gray.500" textAlign="center">Đăng nhập hoặc tạo tài khoản để tiếp tục</Text>
              </VStack>
              <Button
                colorPalette="blue"
                size="lg"
                w="100%"
                onClick={() => { setError(null); setAuthMode("login"); }}
              >
                Đăng nhập
              </Button>
              <Button
                variant="outline"
                size="lg"
                w="100%"
                onClick={() => { setError(null); setAuthMode("register"); }}
              >
                Đăng ký
              </Button>
            </VStack>
          ) : (
            /* Form screen */
            <VStack gap={4} align="stretch" w="100%" maxW="380px" bg="white" p={6} borderRadius="xl" shadow="md">
              <Heading size="sm" textAlign="center">
                {authMode === "login" ? "Đăng nhập" : "Tạo tài khoản mới"}
              </Heading>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={authMode === "register" ? "Tên đăng nhập (tối thiểu 3 ký tự)" : "Tên đăng nhập"}
                autoComplete="username"
              />
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={authMode === "register" ? "Mật khẩu (tối thiểu 8 ký tự)" : "Mật khẩu"}
                type="password"
                autoComplete={authMode === "login" ? "current-password" : "new-password"}
              />
              {error && <Text color="red.500" fontSize="xs">{error}</Text>}
              <Button colorPalette="blue" onClick={handleAuthSubmit} loading={authLoading} w="100%">
                {authMode === "login" ? "Đăng nhập" : "Đăng ký"}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setAuthMode("choose");
                  setError(null);
                  setUsername("");
                  setPassword("");
                }}
              >
                ← Quay lại
              </Button>
            </VStack>
          )}
        </Flex>
      </Flex>
    );
  }

  return (
    <>
    {saveNotice && (
      <Box
        position="fixed"
        top={4}
        right={4}
        zIndex={2000}
        bg="#10a37f"
        color="white"
        px={4}
        py={2.5}
        borderRadius="lg"
        shadow="lg"
      >
        <HStack gap={2}>
          <CheckCircle2 size={16} />
          <Text fontSize="sm" fontWeight="medium">{saveNotice}</Text>
        </HStack>
      </Box>
    )}
    <Flex h="100vh" w="100vw" overflow="hidden" bg="white">
      {/* Left Sidebar */}
      {sidebarOpen && (
        <Box w="260px" bg="gray.50" borderRight="1px solid" borderColor="gray.200" display="flex" flexDirection="column" flexShrink={0}>
          <HStack px={4} py={3} borderBottom="1px solid" borderColor="gray.200" justify="space-between">
            <HStack gap={2}>
              <Sparkles size={18} color="#10a37f" />
              <Heading size="xs" fontWeight="bold">Lịch sử hội thoại</Heading>
            </HStack>
            <IconButton aria-label="Đóng sidebar" size="xs" variant="ghost" onClick={() => setSidebarOpen(false)}>
              <PanelLeft size={16} />
            </IconButton>
          </HStack>

          <Box p={3}>
            <Button
              w="100%"
              size="sm"
              variant="ghost"
              justifyContent="flex-start"
              gap={2}
              color="gray.700"
              fontWeight="medium"
              _hover={{ bg: "gray.200" }}
              onClick={startNewConversation}
            >
              <SquarePen size={16} />
              Cuộc trò chuyện mới
            </Button>
          </Box>

          <Flex direction="column" flex={1} overflowY="auto" px={2} gap={1}>
            {loadingConversations ? (
              <VStack align="stretch" px={2} gap={2}>
                <Skeleton height="8" />
                <Skeleton height="8" />
              </VStack>
            ) : conversations.length === 0 ? (
              <Text fontSize="xs" color="gray.400" textAlign="center" py={4}>
                Chưa có cuộc trò chuyện nào
              </Text>
            ) : (
              conversations.map((conversation) => (
                <HStack
                  key={conversation.id}
                  gap={1}
                  px={2}
                  py={1.5}
                  borderRadius="md"
                  bg={activeConversationId === conversation.id ? "blue.50" : "transparent"}
                  _hover={{ bg: "gray.100" }}
                  cursor="pointer"
                >
                  <Button
                    variant="ghost"
                    size="xs"
                    justifyContent="flex-start"
                    flex={1}
                    minW={0}
                    onClick={() => loadConversationMessages(conversation.id)}
                  >
                    <Text truncate fontSize="xs" color={activeConversationId === conversation.id ? "blue.700" : "gray.800"}>
                      {conversation.title || "Tư vấn lâm sàng"}
                    </Text>
                  </Button>
                  <IconButton
                    aria-label="Xóa cuộc trò chuyện"
                    size="2xs"
                    variant="ghost"
                    color="gray.400"
                    _hover={{ color: "red.500" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteConversation(conversation.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </HStack>
              ))
            )}
          </Flex>
          <Separator />
          <HStack
            p={2}
            m={2}
            gap={2}
            borderRadius="lg"
            bg="transparent"
            _hover={{ bg: "gray.200" }}
            cursor="pointer"
            onClick={handleLogout}
            title="Đăng xuất"
          >
            <Circle size="7" bg="#10a37f" color="white" fontSize="2xs" fontWeight="bold" flexShrink={0}>
              {getInitials(user.username)}
            </Circle>
            <Text fontSize="sm" fontWeight="medium" color="gray.800" truncate flex={1}>
              {user.username}
            </Text>
            <LogOut size={14} color="#9ca3af" />
          </HStack>
        </Box>
      )}

      {/* Main Container */}
      <Flex direction="column" flex={1} minW={0} h="100%">
        {/* Header Bar */}
        <Flex px={4} py={2.5} borderBottom="1px solid" borderColor="gray.200" justify="space-between" align="center" bg="white">
          <HStack gap={3}>
            {!sidebarOpen && (
              <IconButton aria-label="Mở sidebar" size="xs" variant="ghost" onClick={() => setSidebarOpen(true)}>
                <PanelLeft size={18} />
              </IconButton>
            )}
            <HStack gap={2}>
              <Stethoscope size={20} color="#10a37f" />
              <Heading size="sm">Hệ thống Trợ lý Bác sĩ</Heading>
            </HStack>
          </HStack>
        </Flex>

        {error && (
          <Box px={4} py={2} bg="red.50" color="red.700" fontSize="sm" borderBottom="1px solid" borderColor="red.200">
            <HStack gap={2}>
              <AlertCircle size={16} />
              <Text>{error}</Text>
            </HStack>
          </Box>
        )}

        {/* Chat Stream Timeline */}
        <Box flex={1} overflowY="auto" px={4} py={4}>
          {messages.length === 0 && !loading && !loadingMessages ? (
            <Flex direction="column" h="100%" align="center" justify="center" gap={4} color="gray.500">
              <Sparkles size={36} color="#10a37f" />
              <Heading size="md" color="gray.800">
                Hôm nay tôi có thể hỗ trợ gì cho Bác sĩ?
              </Heading>
            </Flex>
          ) : (
            <VStack gap={4} align="stretch" maxW="800px" mx="auto">
              {messages.map((msg) => {
                const isStartDiagnosticPlaceholder = msg.role === "assistant" && (
                  msg.content?.includes("bắt đầu quy trình chẩn đoán") ||
                  msg.content?.includes("quy trình chẩn đoán hình ảnh") ||
                  msg.content?.includes("phân tích hình ảnh và phỏng vấn lâm sàng")
                );
                if (isStartDiagnosticPlaceholder) return null;

                return (
                  <Box key={msg.id}>
                    {/* User Message */}
                    {msg.role === "user" ? (
                      <Flex justify="flex-end" mb={2}>
                      <Box
                        bg="#10a37f"
                        color="white"
                        px={4}
                        py={3}
                        borderRadius="xl"
                        maxW="75%"
                        shadow="sm"
                      >
                        {msg.imagePreview && (
                          <Box w="200px" maxW="100%" borderRadius="lg" overflow="hidden" mb={2} shadow="sm">
                            <img src={msg.imagePreview} alt="Tổn thương da" style={{ width: "100%", height: "auto", display: "block", objectFit: "cover" }} />
                          </Box>
                        )}
                        <Text fontSize="sm" whiteSpace="pre-wrap">{msg.content}</Text>
                      </Box>
                    </Flex>
                  ) : (
                    /* Assistant Message */
                    <Flex gap={3} align="flex-start" mb={2}>
                      <Circle size="8" bg="#10a37f" color="white" flexShrink={0} mt={1}>
                        <Bot size={16} />
                      </Circle>
                      <Box
                        bg="gray.50"
                        borderWidth="1px"
                        borderColor="gray.200"
                        px={4}
                        py={3}
                        borderRadius="xl"
                        flex={1}
                        minW={0}
                        shadow="xs"
                      >

                        {/* Internal tool-call timeline (FHIR graph lookups, etc.) is
                            intentionally not rendered here — it's noisy for a
                            clinician-facing chat. Full detail still goes to the
                            backend logs (see app/agents/fhir.py TOOL START/END
                            log lines); only the final synthesized answer below
                            is shown to the user. */}

                        {/* Standard Markdown Text Response */}
                        {(!msg.type || msg.type === "text") && (
                          <Box fontSize="sm" className="markdown-content">
                            {(() => {
                              const { thinking, response } = splitThinkingAndResponse(msg.content);
                              return (
                                <>
                                  {thinking && (
                                    <Collapsible.Root mb={2}>
                                      <Collapsible.Trigger asChild>
                                        <Button variant="ghost" size="xs" color="gray.500">
                                          <ChevronDown size={12} />
                                          Suy luận hệ thống
                                        </Button>
                                      </Collapsible.Trigger>
                                      <Collapsible.Content>
                                        <Box px={3} py={2} bg="gray.100" borderRadius="md" fontSize="xs" color="gray.700" mt={1}>
                                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{thinking}</ReactMarkdown>
                                        </Box>
                                      </Collapsible.Content>
                                    </Collapsible.Root>
                                  )}
                                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{response || msg.content}</ReactMarkdown>
                                </>
                              );
                            })()}
                          </Box>
                        )}

                        {/* Extracted Clinical Entities & Preferences */}
                        {msg.entities && msg.entities.length > 0 && (
                          <HStack gap={1} mt={2} flexWrap="wrap">
                            {msg.entities.map((e, i) => (
                              <Badge key={`${e.type}-${e.name}-${i}`} size="xs" colorPalette="teal" variant="subtle">
                                {e.type}: {e.name}
                              </Badge>
                            ))}
                          </HStack>
                        )}

                        {/* Skin Photos found via search_skin_images /
                            start_diagnosis_from_patient_image — real
                            thumbnails, not a text link (the endpoint needs
                            auth a plain link can't provide). */}
                        {msg.skinImageResults && msg.skinImageResults.length > 0 && (
                          <Box mt={2}>
                            <Text fontSize="xs" fontWeight="semibold" color="gray.600" mb={2}>
                              Ảnh da tìm thấy ({msg.skinImageResults.length})
                            </Text>
                            <HStack gap={2} overflowX="auto" pb={1}>
                              {msg.skinImageResults.map((img) => (
                                <SkinImageThumbnail key={img.binary_id || img.study_id} image={img} />
                              ))}
                            </HStack>
                          </Box>
                        )}

                        {/* Câu hỏi lâm sàng đã trả lời ở round trước, hiện lại
                            khi user quay lại chat đang dở dang (chưa completed) */}
                        {msg.type === "skin_qa_progress" && msg.skinAnsweredQuestions && msg.skinAnsweredQuestions.length > 0 && (
                          <Box mt={1}>
                            <Text fontSize="xs" fontWeight="semibold" color="gray.600" mb={2}>
                              {msg.content}
                            </Text>
                            <AnsweredQuestionsCard questions={msg.skinAnsweredQuestions} />
                          </Box>
                        )}

                        {/* Skin Diagnostic Questions Card */}
                        {msg.type === "skin_questions" && msg.skinQuestions && (
                          <Box mt={1}>
                            <Text fontSize="xs" fontWeight="semibold" color="gray.600" mb={2}>
                              {msg.skinSubmitted
                                ? `Đã hoàn thành trả lời (${msg.skinQuestions.length}/${msg.skinQuestions.length} câu hỏi)`
                                : `Vui lòng chọn câu trả lời lâm sàng (${Object.keys(pqrstAnswers).length}/${msg.skinQuestions.length})`}
                            </Text>

                            <VStack align="stretch" gap={3}>
                              {msg.skinQuestions.map((q) => {
                                const qNum = q.question_num ?? -1;
                                const isSelectedYes = pqrstAnswers[qNum] === "Có";
                                const isSelectedNo = pqrstAnswers[qNum] === "Không";

                                return (
                                  <Box key={qNum} p={3} bg="white" borderRadius="md" borderWidth="1px" borderColor="gray.200">
                                    <HStack gap={2} mb={1}>
                                      <Text fontSize="xs" color="gray.500">Câu {q.question_num}</Text>
                                    </HStack>
                                    <Text fontSize="sm" fontWeight="medium" mb={2}>{q.question}</Text>
                                    <HStack gap={2}>
                                      <Button
                                        size="xs"
                                        flex={1}
                                        variant={isSelectedYes ? "solid" : "outline"}
                                        colorPalette="green"
                                        disabled={msg.skinSubmitted || submittingSkinAnswers}
                                        onClick={() => setPqrstAnswers((prev) => ({ ...prev, [qNum]: "Có" }))}
                                      >
                                        CÓ
                                      </Button>
                                      <Button
                                        size="xs"
                                        flex={1}
                                        variant={isSelectedNo ? "solid" : "outline"}
                                        colorPalette="red"
                                        disabled={msg.skinSubmitted || submittingSkinAnswers}
                                        onClick={() => setPqrstAnswers((prev) => ({ ...prev, [qNum]: "Không" }))}
                                      >
                                        KHÔNG
                                      </Button>
                                    </HStack>
                                  </Box>
                                );
                              })}
                            </VStack>

                            {!msg.skinSubmitted && (
                              <Button
                                mt={3}
                                w="100%"
                                colorPalette="blue"
                                size="sm"
                                disabled={submittingSkinAnswers || Object.keys(pqrstAnswers).length < msg.skinQuestions.length}
                                loading={submittingSkinAnswers}
                                onClick={() => handleSubmitPqrstAnswers(msg.skinQuestions!, msg.skinRunId!)}
                              >
                                Gửi trả lời lâm sàng
                              </Button>
                            )}
                            {msg.skinSubmitted && (
                              <HStack justify="center" mt={3} color="green.600" fontSize="xs" fontWeight="semibold">
                                <CheckCircle2 size={16} />
                                <Text>Đã gửi câu trả lời</Text>
                              </HStack>
                            )}
                          </Box>
                        )}

                        {/* Skin Diagnostic Result Card */}
                        {msg.type === "skin_result" && msg.skinResult && (
                          <Box mt={1}>
                            <Heading size="xs" color="#10a37f" mb={3}>
                              KẾT QUẢ CHẨN ĐOÁN DA LIỄU
                            </Heading>

                            {/* Ranked Diagnoses */}
                            <VStack align="stretch" gap={2} mb={3}>
                              {msg.skinResult.ranked_diagnoses?.map((diag: Record<string, unknown>, i: number) => (
                                <Box
                                  key={i}
                                  p={3}
                                  borderRadius="md"
                                  borderWidth="1px"
                                  style={{
                                    borderColor: RANK_COLORS[i % 3],
                                    background: RANK_COLORS[i % 3] + "10",
                                  }}
                                >
                                  <HStack justify="space-between" align="start">
                                    <Text fontSize="sm" fontWeight="bold" style={{ color: RANK_COLORS[i % 3] }}>
                                      {RANK_LABELS[i % 3]}: {String(diag.disease || "Bệnh lý nghi ngờ")}
                                    </Text>
                                    {Boolean(diag.likelihood) && (
                                      <Badge size="xs" colorPalette="purple">
                                        {String(diag.likelihood)}
                                      </Badge>
                                    )}
                                  </HStack>
                                  {(Boolean(diag.supporting_evidence) || Boolean(diag.evidence_for)) && (
                                    <Text fontSize="xs" color="gray.700" mt={1}>
                                      Bằng chứng hỗ trợ: {String(diag.supporting_evidence || diag.evidence_for)}
                                    </Text>
                                  )}
                                  {Boolean(diag.evidence_against) && (
                                    <Text fontSize="xs" color="red.700" mt={1}>
                                      Điểm cần loại trừ: {String(diag.evidence_against)}
                                    </Text>
                                  )}
                                </Box>
                              ))}
                            </VStack>

                            {/* Visual Observations */}
                            {msg.skinResult.visual_observations && (
                              <Box p={3} bg="white" borderRadius="md" borderWidth="1px" borderColor="gray.200" mb={2}>
                                <Text fontSize="xs" fontWeight="bold" color="gray.700" mb={1}>Phân tích hình ảnh tổn thương:</Text>
                                <Text fontSize="xs" color="gray.600" whiteSpace="pre-wrap">{msg.skinResult.visual_observations}</Text>
                              </Box>
                            )}

                            {/* Reasoning */}
                            {msg.skinResult.reasoning && (
                              <Box p={3} bg="white" borderRadius="md" borderWidth="1px" borderColor="gray.200">
                                <Text fontSize="xs" fontWeight="bold" color="gray.700" mb={1}>Biện luận y khoa:</Text>
                                <Text fontSize="xs" color="gray.600" whiteSpace="pre-wrap">{msg.skinResult.reasoning}</Text>
                              </Box>
                            )}
                          </Box>
                        )}
                      </Box>
                    </Flex>
                  )}
                </Box>
              );
            })}

              {/* Running Status / Typing Indicator — intentionally just the
                  three dots, like ChatGPT/Claude's "thinking" state. No
                  progress bar and no visible cancel affordance; internal
                  pipeline detail (step names, % progress) still only goes to
                  the backend logs. */}
              {loading && (
                <Flex gap={3} align="flex-start" mb={2}>
                  <Circle size="8" bg="#10a37f" color="white" flexShrink={0} mt={1}>
                    <Bot size={16} />
                  </Circle>
                  <Box py={3}>
                    <TypingDots color="blue.500" />
                  </Box>
                </Flex>
              )}
              <div ref={messagesEndRef} />
            </VStack>
          )}
        </Box>

        {/* Input Bar */}
        <Box px={4} py={3} borderTop="1px solid" borderColor="gray.200" bg="white">
          <Box maxW="800px" mx="auto">
            {/* Main Input Container — ChatGPT-style single rounded card:
                attached image sits inside the card, above the text row,
                instead of as a separate element floating above it. */}
            <Box
              bg="white"
              borderWidth="1px"
              borderColor="gray.300"
              borderRadius="26px"
              px={3}
              pt={filePreview ? 3 : 2}
              pb={2}
              shadow="sm"
              _focusWithin={{ borderColor: "transparent", shadow: "sm" }}
              transition="all 0.2s"
            >
              {/* Image Preview Chip — inside the input card, like ChatGPT */}
              {filePreview && (
                <Box mb={2} pl={1}>
                  <Flex align="center" gap={2}>
                    <Box position="relative" w="64px" h="64px" borderRadius="lg" overflow="hidden" borderWidth="1px" borderColor="gray.200" shadow="xs">
                      <img src={filePreview} alt="Xem trước" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      <IconButton
                        aria-label="Xóa ảnh"
                        size="2xs"
                        borderRadius="full"
                        bg="gray.800"
                        color="white"
                        _hover={{ bg: "gray.900" }}
                        position="absolute"
                        top="2px"
                        right="2px"
                        minW="18px"
                        h="18px"
                        onClick={clearSelectedFile}
                      >
                        <X size={10} />
                      </IconButton>
                    </Box>
                    {pendingNeo4jPatientId ? (
                      <Badge colorPalette="blue" borderRadius="full" px={2} py={1} fontSize="xs">
                        Bệnh nhân đang có: {pendingNeo4jPatientName} (ID {pendingNeo4jPatientId})
                      </Badge>
                    ) : (
                      <Button
                        size="2xs"
                        variant="outline"
                        borderRadius="full"
                        onClick={() => setPatientChoiceModalOpen(true)}
                      >
                        + Chọn bệnh nhân
                      </Button>
                    )}
                  </Flex>
                </Box>
              )}

              <Flex align="flex-end" gap={2}>
                {/* Image Upload Button */}
                <IconButton
                  aria-label="Tải ảnh lên"
                  size="xs"
                  variant="ghost"
                  borderRadius="full"
                  color={selectedFile ? "#10a37f" : "gray.500"}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={loading}
                >
                  <ImagePlus size={18} />
                </IconButton>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
                  style={{ display: "none" }}
                />

                {/* Textarea */}
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Nhập tin nhắn..."
                  border="none"
                  outline="none"
                  _focus={{ boxShadow: "none", outline: "none" }}
                  resize="none"
                  rows={1}
                  fontSize="sm"
                  px={1}
                  py={1}
                  disabled={loading}
                  style={{ maxHeight: "160px" }}
                />

                {/* Save-to-record icon button — appears next to the send
                    button once a photo is attached and an existing patient
                    has been chosen (same visibility condition as before),
                    replacing the old "Lưu vào hồ sơ" text button. */}
                {filePreview && pendingNeo4jPatientId && (
                  <IconButton
                    aria-label="Lưu vào hồ sơ"
                    title="Lưu vào hồ sơ"
                    size="xs"
                    variant="ghost"
                    borderRadius="full"
                    color="#10a37f"
                    _hover={{ bg: "green.50" }}
                    loading={savingPhotoOnly}
                    onClick={saveAttachedPhotoOnly}
                    disabled={loading}
                  >
                    <Save size={18} />
                  </IconButton>
                )}

                {/* Send / Stop Button — while a response is streaming this
                    becomes a Stop button (like Claude/ChatGPT), instead of
                    just a disabled spinner. */}
                <IconButton
                  aria-label={loading ? "Dừng" : "Gửi"}
                  size="xs"
                  bg={loading ? "gray.700" : "#10a37f"}
                  color="white"
                  _hover={{ bg: loading ? "gray.900" : "#0d8c6d" }}
                  borderRadius="full"
                  onClick={loading ? handleStopGeneration : () => sendMessage()}
                  disabled={!loading && !input.trim() && !selectedFile}
                >
                  {loading ? <Square size={12} fill="white" /> : <Send size={14} />}
                </IconButton>
              </Flex>
            </Box>
          </Box>
        </Box>
      </Flex>
    </Flex>

    {/* Existing-patient choice popup — shown right after a photo is picked,
        before the existing-patient search popup (F-07). */}
    {patientChoiceModalOpen && (
      <Box
        position="fixed"
        inset={0}
        bg="blackAlpha.500"
        zIndex={1000}
        display="flex"
        alignItems="center"
        justifyContent="center"
        onClick={() => setPatientChoiceModalOpen(false)}
      >
        <Box
          bg="white"
          borderRadius="xl"
          shadow="lg"
          p={5}
          w="360px"
          maxW="90vw"
          onClick={(e) => e.stopPropagation()}
        >
          <Heading size="sm" mb={1}>Ảnh này có gắn với bệnh nhân nào không?</Heading>
          <VStack gap={2} align="stretch">
            <Button
              size="sm"
              bg="#10a37f"
              color="white"
              _hover={{ bg: "#0d8c6d" }}
              onClick={handleChoiceExistingPatient}
            >
              Bệnh nhân đang có
            </Button>
            <Button
              size="sm"
              variant="ghost"
              color="gray.500"
              onClick={() => setPatientChoiceModalOpen(false)}
            >
              Bỏ qua (không lưu vào hồ sơ)
            </Button>
          </VStack>
        </Box>
      </Box>
    )}

    {/* "Bệnh nhân đang có" (luong B) — autocomplete search against the
        Neo4j graph (GET /patients/search, F-04/F-05, F-08). Selecting a
        result sets pendingNeo4jPatientId, consumed by sendMessage(). */}
    {existingPatientModalOpen && (
      <Box
        position="fixed"
        inset={0}
        bg="blackAlpha.500"
        zIndex={1000}
        display="flex"
        alignItems="center"
        justifyContent="center"
        onClick={closeExistingPatientModal}
      >
        <Box
          bg="white"
          borderRadius="xl"
          shadow="lg"
          p={5}
          w="380px"
          maxW="90vw"
          onClick={(e) => e.stopPropagation()}
        >
          <Heading size="sm" mb={1}>Tìm bệnh nhân đang có</Heading>
          <Input
            size="sm"
            placeholder="Nhập tên hoặc ID bệnh nhân..."
            value={existingPatientQuery}
            onChange={(e) => handleExistingPatientQueryChange(e.target.value)}
            autoFocus
            mb={3}
          />

          <Box maxH="240px" overflowY="auto">
            {searchingExistingPatients ? (
              <Flex justify="center" py={4}>
                <Spinner size="sm" color="gray.400" />
              </Flex>
            ) : existingPatientError ? (
              <Text fontSize="xs" color="red.500" py={2}>{existingPatientError}</Text>
            ) : existingPatientResults.length === 0 ? (
              <Text fontSize="xs" color="gray.400" textAlign="center" py={4}>
                {existingPatientQuery.trim() ? "Không tìm thấy bệnh nhân" : "Nhập tên để tìm kiếm"}
              </Text>
            ) : (
              <VStack align="stretch" gap={1}>
                {existingPatientResults.map((patient) => (
                  <Box
                    key={patient.id}
                    px={3}
                    py={2}
                    borderRadius="md"
                    borderWidth="1px"
                    borderColor="gray.200"
                    cursor="pointer"
                    _hover={{ bg: "gray.50", borderColor: "gray.300" }}
                    onClick={() => handleSelectExistingPatient(patient)}
                  >
                    <Text fontSize="sm" fontWeight="medium">{patient.name || "(không rõ tên)"}</Text>
                    <Text fontSize="2xs" color="gray.500">
                      ID {patient.id}
                      {patient.birth_date ? ` · Sinh ${patient.birth_date}` : ""}
                    </Text>
                  </Box>
                ))}
              </VStack>
            )}
          </Box>

          <HStack justify="space-between" pt={3}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setExistingPatientModalOpen(false);
                setPatientChoiceModalOpen(true);
              }}
            >
              ← Quay lại
            </Button>
            <Button size="sm" variant="ghost" color="gray.500" onClick={closeExistingPatientModal}>
              Đóng
            </Button>
          </HStack>
        </Box>
      </Box>
    )}
    </>
  );
}