// "use client";

// import { useState, useRef, useEffect, useCallback } from "react";
// import {
//   Box, Flex, Heading, Text, Textarea, IconButton, VStack, HStack,
//   Badge, Button, Spinner, Skeleton, Collapsible, Timeline, Circle,
//   Input, Separator,
// } from "@chakra-ui/react";
// import {
//   Send, RotateCcw, ChevronDown, Wrench, Check, Bot, User, Sparkles,
//   Plus, Trash2, LogOut, ImagePlus, X, Stethoscope, Loader2, CheckCircle2,
//   PanelLeft, AlertCircle,
// } from "lucide-react";
// import ReactMarkdown from "react-markdown";
// import remarkGfm from "remark-gfm";
// import { DOMAIN, API_BASE } from "@/lib/config";
// import type { GraphData } from "@/lib/config";
// import {
//   ApiError,
//   clearAuth,
//   deleteConversation,
//   getAccessToken,
//   getStoredUser,
//   listConversations,
//   listMessages,
//   login,
//   openConversationStream,
//   openMessageStream,
//   register,
//   startSkinDiagnostic,
//   getSkinDiagnosticStatus,
//   submitSkinDiagnosticAnswers,
// } from "@/lib/api";

// import type {
//   ChatMessage,
//   Conversation,
//   UserProfile,
//   SkinDiagnosticStatus,
//   SkinPendingQuestion,
//   SkinDiagnosticResult,
// } from "@/lib/api";
// import { parseSseStream } from "@/lib/sse";
// import type { ParsedSseEvent } from "@/lib/sse";

// const CHAT_STREAM_TIMEOUT_MS = 900_000;

// export const PQRST_COLORS: Record<string, string> = {
//   P: "#d946ef",  // magenta
//   Q: "#06b6d4",  // cyan
//   R: "#3b82f6",  // blue
//   S: "#ef4444",  // red
//   T: "#eab308",  // yellow
// };

// export const RANK_COLORS = ["#22c55e", "#eab308", "#3b82f6"];
// export const RANK_LABELS = [
//   "#1 — Khả năng cao nhất",
//   "#2 — Khả năng trung bình",
//   "#3 — Cần xem xét",
// ];

// export const STEP_LABELS: Record<string, string> = {
//   visual_extract: "Phân tích hình ảnh tổn thương",
//   knowledge_base: "Tra cứu y văn & tri thức da liễu",
//   clinical_planner_round1: "Lập danh sách câu hỏi lâm sàng 1",
//   user_interview_round1: "Phỏng vấn lâm sàng 1",
//   clinical_planner_round2: "Lập danh sách câu hỏi lâm sàng 2",
//   user_interview_round2: "Phỏng vấn lâm sàng 2",
//   diagnostic_reasoning: "Biện luận & tổng hợp chẩn đoán",
// };

// interface ToolCall {
//   name: string;
//   inputs: Record<string, unknown>;
//   output_preview: string;
//   status: "running" | "complete" | "failed";
//   graph_data?: GraphData;
//   raw_output?: unknown;
// }

// interface ExtractedEntity {
//   name: string;
//   type: string;
//   subtype?: string;
// }

// interface DetectedPreference {
//   category: string;
//   preference: string;
//   confidence?: number;
// }

// interface Message extends ChatMessage {
//   role: "user" | "assistant" | "system";
//   toolCalls?: ToolCall[];
//   retryInput?: string;
//   pending?: boolean;
//   failed?: boolean;
//   entities?: ExtractedEntity[];
//   preferences?: DetectedPreference[];
//   imagePreview?: string;
//   type?: "text" | "skin_questions" | "skin_result" | "skin_progress";
//   skinQuestions?: SkinPendingQuestion[];
//   skinSubmitted?: boolean;
//   skinResult?: SkinDiagnosticResult;
//   skinStep?: string;
//   skinRunId?: string;
// }

// interface ChatInterfaceProps {
//   onGraphUpdate?: (data: GraphData) => void;
//   externalInput?: string | null;
//   onExternalInputConsumed?: () => void;
// }

// const THINKING_PATTERNS = [
//   /^let me /i, /^i'll /i, /^i will /i, /^first,? i /i,
//   /^now let me /i, /^let me also /i, /^let me try /i,
//   /^i need to /i, /^i should /i, /^let me check /i,
//   /^let me look /i, /^let me search /i, /^let me query /i,
//   /^let me find /i, /^now i'll /i, /^now i need /i,
// ];

// const CONTINUATION_PATTERNS = [
//   /^(and |also |then |additionally |next |finally )/i,
//   /^(this will |this should |this means |that way )/i,
//   /^(so |because |since |in order to )/i,
//   /^(after that |once |before )/i,
// ];

// const MARKDOWN_LINE = /^(#{1,6} |[-*] |\d+\. |\|)/;

// function splitThinkingAndResponse(text: string): { thinking: string; response: string } {
//   if (!text) return { thinking: "", response: "" };
//   if (/\berror\b/i.test(text) || /\bfailed\b/i.test(text) || /\bsyntax error\b/i.test(text)) {
//     return { thinking: "", response: text };
//   }

//   const lines = text.split("\n");
//   const thinkingLines: string[] = [];
//   const responseLines: string[] = [];
//   let foundResponse = false;
//   let inThinkingBlock = false;

//   for (const line of lines) {
//     const trimmed = line.trim();
//     if (!foundResponse && trimmed && THINKING_PATTERNS.some((p) => p.test(trimmed))) {
//       thinkingLines.push(line);
//       inThinkingBlock = true;
//     } else if (
//       inThinkingBlock &&
//       !foundResponse &&
//       trimmed &&
//       !MARKDOWN_LINE.test(trimmed) &&
//       (CONTINUATION_PATTERNS.some((p) => p.test(trimmed)) || trimmed.length < 80)
//     ) {
//       thinkingLines.push(line);
//     } else {
//       if (trimmed) {
//         foundResponse = true;
//         inThinkingBlock = false;
//       }
//       responseLines.push(line);
//     }
//   }

//   const response = responseLines.join("\n").trim();
//   const thinking = thinkingLines.join("\n").trim();
//   if (!response && thinking) return { thinking: "", response: text };
//   return { thinking, response };
// }

// function isRecord(value: unknown): value is Record<string, unknown> {
//   return typeof value === "object" && value !== null;
// }

// function asString(value: unknown): string {
//   return typeof value === "string" ? value : "";
// }

// function isConversation(value: unknown): value is Conversation {
//   return isRecord(value) && typeof value.id === "string" && typeof value.title === "string";
// }

// function isChatMessage(value: unknown): value is ChatMessage {
//   return (
//     isRecord(value) &&
//     typeof value.id === "string" &&
//     typeof value.conversation_id === "string" &&
//     typeof value.role === "string" &&
//     typeof value.content === "string" &&
//     typeof value.created_at === "string"
//   );
// }

// function isGraphData(value: unknown): value is GraphData {
//   return isRecord(value) && Array.isArray(value.results);
// }

// function mapBackendMessage(message: ChatMessage): Message {
//   return {
//     id: message.id,
//     conversation_id: message.conversation_id,
//     role: message.role,
//     content: message.content,
//     created_at: message.created_at,
//   };
// }

// function upsertConversation(items: Conversation[], conversation: Conversation): Conversation[] {
//   return [conversation, ...items.filter((item) => item.id !== conversation.id)];
// }

// function replaceMessage(messages: Message[], localId: string, message: ChatMessage): Message[] {
//   return messages.map((item) => (
//     item.id === localId ? { ...mapBackendMessage(message), toolCalls: item.toolCalls } : item
//   ));
// }

// function appendMessageOnce(messages: Message[], message: Message): Message[] {
//   if (messages.some((item) => item.id === message.id)) return messages;
//   return [...messages, message];
// }

// export function ChatInterface({ onGraphUpdate, externalInput, onExternalInputConsumed }: ChatInterfaceProps) {
//   const [messages, setMessages] = useState<Message[]>([]);
//   const [conversations, setConversations] = useState<Conversation[]>([]);
//   const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
//   const [user, setUser] = useState<UserProfile | null>(null);
//   const [authReady, setAuthReady] = useState(false);
//   const [authMode, setAuthMode] = useState<"login" | "register" | "choose">("choose");
//   const [username, setUsername] = useState("");
//   const [password, setPassword] = useState("");
//   const [authLoading, setAuthLoading] = useState(false);
//   const [loadingConversations, setLoadingConversations] = useState(false);
//   const [loadingMessages, setLoadingMessages] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [input, setInput] = useState("");
//   const [loading, setLoading] = useState(false);
//   const [sidebarOpen, setSidebarOpen] = useState(true);

//   // File Upload State for Skin Diagnostic
//   const [selectedFile, setSelectedFile] = useState<File | null>(null);
//   const [filePreview, setFilePreview] = useState<string | null>(null);
//   const fileInputRef = useRef<HTMLInputElement>(null);

//   // Skin Diagnostic State
//   const [activeSkinRunId, setActiveSkinRunId] = useState<string | null>(null);
//   const [skinStatus, setSkinStatus] = useState<SkinDiagnosticStatus | null>(null);
//   const [pqrstAnswers, setPqrstAnswers] = useState<Record<number, string>>({});
//   const [submittingSkinAnswers, setSubmittingSkinAnswers] = useState(false);
//   const skinPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

//   // FHIR SSE Streaming State
//   const [streamingContent, setStreamingContent] = useState("");
//   const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCall[]>([]);
//   const [streamingEntities, setStreamingEntities] = useState<ExtractedEntity[]>([]);
//   const [streamingPreferences, setStreamingPreferences] = useState<DetectedPreference[]>([]);
//   const [elapsedSeconds, setElapsedSeconds] = useState(0);

//   const messagesEndRef = useRef<HTMLDivElement>(null);
//   const textBufferRef = useRef("");
//   const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
//   const abortControllerRef = useRef<AbortController | null>(null);
//   const streamingEntitiesRef = useRef<ExtractedEntity[]>([]);
//   const streamingPreferencesRef = useRef<DetectedPreference[]>([]);

//   // Health Status
//   const [backendStatus, setBackendStatus] = useState<"ok" | "degraded" | "offline">("offline");

//   useEffect(() => {
//     async function checkHealth() {
//       try {
//         const res = await fetch(`${API_BASE.replace("/api", "")}/health`, {
//           signal: AbortSignal.timeout(4000),
//         });
//         const data = await res.json();
//         setBackendStatus(data.status === "ok" ? "ok" : "degraded");
//       } catch {
//         setBackendStatus("offline");
//       }
//     }
//     checkHealth();
//     const interval = setInterval(checkHealth, 30000);
//     return () => clearInterval(interval);
//   }, []);

//   const handleAuthFailure = useCallback(() => {
//     clearAuth();
//     setUser(null);
//     setMessages([]);
//     setConversations([]);
//     setActiveConversationId(null);
//     setError("Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.");
//   }, []);

//   const loadConversationList = useCallback(async () => {
//     if (!getAccessToken()) return;
//     setLoadingConversations(true);
//     setError(null);
//     try {
//       const data = await listConversations();
//       setConversations(data.items);
//     } catch (err) {
//       if (err instanceof ApiError && err.status === 401) {
//         handleAuthFailure();
//       } else {
//         setError(err instanceof Error ? err.message : "Không thể tải danh sách cuộc trò chuyện");
//       }
//     } finally {
//       setLoadingConversations(false);
//     }
//   }, [handleAuthFailure]);

//   const stopSkinPolling = useCallback(() => {
//     if (skinPollIntervalRef.current) {
//       clearInterval(skinPollIntervalRef.current);
//       skinPollIntervalRef.current = null;
//     }
//   }, []);

//   const pollSkinStatus = useCallback(async (runId: string) => {
//     try {
//       const status = await getSkinDiagnosticStatus(runId);
//       setSkinStatus(status);

//       if (status.status === "interrupt" && status.pending_questions) {
//         stopSkinPolling();
//         setLoading(false);
//         // Append or update questions card in messages
//         setMessages((prev) => {
//           const filtered = prev.filter((m) => m.skinRunId !== runId || m.type !== "skin_questions");
//           return [
//             ...filtered,
//             {
//               id: `skin-q-${runId}-${Date.now()}`,
//               conversation_id: activeConversationId || runId,
//               role: "assistant",
//               content: "Vui lòng trả lời các câu hỏi lâm sàng dưới đây để làm rõ chẩn đoán:",
//               created_at: new Date().toISOString(),
//               type: "skin_questions",
//               skinQuestions: status.pending_questions || [],
//               skinSubmitted: false,
//               skinRunId: runId,
//             },
//           ];
//         });
//       } else if (status.status === "completed" && status.result) {
//         stopSkinPolling();
//         setLoading(false);
//         const resultObj = status.result as SkinDiagnosticResult;
//         setMessages((prev) => {
//           const filtered = prev.filter((m) => m.skinRunId !== runId || m.type !== "skin_questions");
//           return [
//             ...filtered,
//             {
//               id: `skin-res-${runId}`,
//               conversation_id: activeConversationId || runId,
//               role: "assistant",
//               content: "Kết quả chẩn đoán da liễu:",
//               created_at: new Date().toISOString(),
//               type: "skin_result",
//               skinResult: resultObj,
//               skinRunId: runId,
//             },
//           ];
//         });
//       } else if (status.status === "error") {
//         stopSkinPolling();
//         setLoading(false);
//         setError(`Lỗi chẩn đoán da liễu: ${status.error || "Không xác định"}`);
//       }
//     } catch (err) {
//       stopSkinPolling();
//       setLoading(false);
//       setError(err instanceof Error ? err.message : "Không thể kiểm tra trạng thái chẩn đoán da liễu");
//     }
//   }, [activeConversationId, stopSkinPolling]);

//   const startSkinPolling = useCallback((runId: string) => {
//     stopSkinPolling();
//     void pollSkinStatus(runId);
//     skinPollIntervalRef.current = setInterval(() => pollSkinStatus(runId), 2000);
//   }, [pollSkinStatus, stopSkinPolling]);

//   const loadConversationMessages = useCallback(async (conversationId: string) => {
//     stopSkinPolling();
//     setActiveConversationId(conversationId);
//     setMessages([]);
//     setStreamingContent("");
//     setStreamingToolCalls([]);
//     setLoadingMessages(true);
//     setError(null);
//     try {
//       const data = await listMessages(conversationId);
//       setMessages(data.items.map(mapBackendMessage));
//     } catch (err) {
//       if (err instanceof ApiError && err.status === 401) {
//         handleAuthFailure();
//       } else if (err instanceof ApiError && err.status === 404) {
//         setActiveConversationId(null);
//         setMessages([]);
//         await loadConversationList();
//         setError("Không tìm thấy cuộc trò chuyện.");
//       } else {
//         setError(err instanceof Error ? err.message : "Không thể tải tin nhắn");
//       }
//     } finally {
//       setLoadingMessages(false);
//     }
//   }, [handleAuthFailure, loadConversationList, stopSkinPolling]);

//   useEffect(() => {
//     const storedUser = getStoredUser();
//     if (getAccessToken() && storedUser) {
//       setUser(storedUser);
//       void loadConversationList();
//     }
//     setAuthReady(true);
//   }, [loadConversationList]);

//   useEffect(() => {
//     if (externalInput && !loading && user) {
//       sendMessage(externalInput);
//       onExternalInputConsumed?.();
//     }
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, [externalInput, loading, user]);

//   useEffect(() => {
//     messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
//   }, [messages, streamingContent, streamingToolCalls, skinStatus]);

//   useEffect(() => {
//     if (!loading) { setElapsedSeconds(0); return; }
//     const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
//     return () => clearInterval(interval);
//   }, [loading]);

//   const flushTextBuffer = useCallback(() => {
//     setStreamingContent(textBufferRef.current);
//     flushTimerRef.current = null;
//   }, []);

//   const appendStreamingText = useCallback((text: string) => {
//     textBufferRef.current += text;
//     if (!flushTimerRef.current) {
//       flushTimerRef.current = setTimeout(flushTextBuffer, 50);
//     }
//   }, [flushTextBuffer]);

//   function cancelRequest() {
//     stopSkinPolling();
//     abortControllerRef.current?.abort();
//     abortControllerRef.current = null;
//     setLoading(false);
//   }

//   function resetStreamingState() {
//     setStreamingContent("");
//     setStreamingToolCalls([]);
//     setStreamingEntities([]);
//     setStreamingPreferences([]);
//     streamingEntitiesRef.current = [];
//     streamingPreferencesRef.current = [];
//     textBufferRef.current = "";
//   }

//   function startNewConversation() {
//     cancelRequest();
//     setActiveConversationId(null);
//     setActiveSkinRunId(null);
//     setSkinStatus(null);
//     setPqrstAnswers({});
//     setSelectedFile(null);
//     setFilePreview(null);
//     setMessages([]);
//     resetStreamingState();
//     setLoading(false);
//     setError(null);
//   }

//   const handleFileSelect = (file: File | null) => {
//     if (!file) return;
//     if (!file.type.startsWith("image/")) {
//       setError("Vui lòng chọn file hình ảnh hợp lệ (.jpg, .png, .webp)");
//       return;
//     }
//     setSelectedFile(file);
//     if (filePreview) URL.revokeObjectURL(filePreview);
//     setFilePreview(URL.createObjectURL(file));
//   };

//   const clearSelectedFile = () => {
//     setSelectedFile(null);
//     if (filePreview) URL.revokeObjectURL(filePreview);
//     setFilePreview(null);
//     if (fileInputRef.current) fileInputRef.current.value = "";
//   };

//   async function handleAuthSubmit() {
//     const trimmedUsername = username.trim();
//     if (!trimmedUsername || !password || authLoading) return;
//     setAuthLoading(true);
//     setError(null);
//     try {
//       if (authMode === "register") {
//         await register(trimmedUsername, password);
//       }
//       const tokenResponse = await login(trimmedUsername, password);
//       setUser(tokenResponse.user);
//       setUsername("");
//       setPassword("");
//       await loadConversationList();
//     } catch (err) {
//       setError(err instanceof Error ? err.message : "Xác thực thất bại");
//     } finally {
//       setAuthLoading(false);
//     }
//   }

//   function handleLogout() {
//     cancelRequest();
//     clearAuth();
//     setUser(null);
//     setConversations([]);
//     setActiveConversationId(null);
//     setMessages([]);
//     resetStreamingState();
//     setError(null);
//   }

//   function applyToolStart(data: Record<string, unknown>, toolCalls: ToolCall[]): ToolCall[] {
//     return [
//       ...toolCalls,
//       {
//         name: asString(data.name) || "tool",
//         inputs: isRecord(data.inputs) ? data.inputs : {},
//         output_preview: "",
//         status: "running",
//       },
//     ];
//   }

//   function applyToolEnd(data: Record<string, unknown>, toolCalls: ToolCall[]): ToolCall[] {
//     const endName = asString(data.name);
//     let matched = false;
//     return toolCalls.map((tc) => {
//       if (tc.name === endName && tc.status === "running" && !matched) {
//         matched = true;
//         const graphData = isGraphData(data.graph_data) ? data.graph_data : undefined;
//         return {
//           ...tc,
//           output_preview: asString(data.output_preview),
//           status: "complete" as const,
//           graph_data: graphData,
//           raw_output: data,
//         };
//       }
//       return tc;
//     });
//   }

//   // Submit Bulk Answers for PQRST Questions
//   async function handleSubmitPqrstAnswers(questions: SkinPendingQuestion[], runId: string) {
//     if (!runId || submittingSkinAnswers) return;
//     setSubmittingSkinAnswers(true);
//     setError(null);

//     const payload = questions.map((q) => ({
//       question_num: q.question_num,
//       answer: pqrstAnswers[q.question_num ?? -1] || "Không",
//     }));

//     try {
//       await submitSkinDiagnosticAnswers(runId, payload);
//       // Mark card as submitted locally
//       setMessages((prev) =>
//         prev.map((m) =>
//           m.skinRunId === runId && m.type === "skin_questions"
//             ? { ...m, skinSubmitted: true }
//             : m
//         )
//       );
//       setLoading(true);
//       startSkinPolling(runId);
//     } catch (err) {
//       setError(err instanceof Error ? err.message : "Không thể gửi câu trả lời");
//     } finally {
//       setSubmittingSkinAnswers(false);
//     }
//   }

//   async function sendMessage(overrideText?: string) {
//     const messageText = (overrideText !== undefined ? overrideText : input).trim();
//     if ((!messageText && !selectedFile) || loading || !user) return;

//     // Check if an image is attached -> Trigger Skin Diagnostic Pipeline!
//     if (selectedFile) {
//       const file = selectedFile;
//       const currentPreview = filePreview;
//       clearSelectedFile();
//       setInput("");
//       // Question numbers are reused by each diagnostic run, so answers must
//       // never carry over from a previous patient/image.
//       setPqrstAnswers({});
//       setLoading(true);
//       setError(null);

//       const localUserMsg: Message = {
//         id: `user-skin-${Date.now()}`,
//         conversation_id: activeConversationId || "skin",
//         role: "user",
//         content: messageText || "Yêu cầu chẩn đoán hình ảnh tổn thương da liễu",
//         created_at: new Date().toISOString(),
//         imagePreview: currentPreview || undefined,
//       };

//       setMessages((prev) => [...prev, localUserMsg]);

//       try {
//         const startRes = await startSkinDiagnostic(file, messageText);
//         setActiveSkinRunId(startRes.run_id);
//         startSkinPolling(startRes.run_id);
//       } catch (err) {
//         setLoading(false);
//         setError(err instanceof Error ? err.message : "Không thể khởi động phân tích da liễu");
//       }
//       return;
//     }

//     // Otherwise: Send Text Message to FHIR Agent SSE Stream
//     const targetConversationId = activeConversationId;
//     const localUserId = `local-user-${crypto.randomUUID()}`;
//     const userMessage: Message = {
//       id: localUserId,
//       conversation_id: targetConversationId ?? "pending",
//       role: "user",
//       content: messageText,
//       created_at: new Date().toISOString(),
//       pending: true,
//     };

//     setMessages((prev) => [...prev, userMessage]);
//     setInput("");
//     setLoading(true);
//     setError(null);
//     resetStreamingState();

//     const controller = new AbortController();
//     abortControllerRef.current = controller;
//     let timeout = setTimeout(() => controller.abort(), CHAT_STREAM_TIMEOUT_MS);
//     const resetTimeout = () => {
//       clearTimeout(timeout);
//       timeout = setTimeout(() => controller.abort(), CHAT_STREAM_TIMEOUT_MS);
//     };

//     let fullText = "";
//     let toolCalls: ToolCall[] = [];
//     let confirmedUserId: string | null = null;

//     try {
//       const response = targetConversationId
//         ? await openMessageStream(targetConversationId, messageText, controller.signal)
//         : await openConversationStream(messageText, controller.signal);

//       if (!response.ok) {
//         const errorData = await response.json().catch(() => null);
//         const detail = isRecord(errorData) ? asString(errorData.detail) : "";
//         throw new Error(detail || `Backend error (${response.status})`);
//       }

//       if (!response.body) {
//         throw new Error("Không có dữ liệu phản hồi từ máy chủ");
//       }

//       for await (const parsedEvent of parseSseStream(response.body)) {
//         resetTimeout();
//         await handleChatEvent(parsedEvent);
//       }
//     } catch (err: unknown) {
//       if (err instanceof ApiError && err.status === 401) {
//         handleAuthFailure();
//       }
//       if (flushTimerRef.current) {
//         clearTimeout(flushTimerRef.current);
//         flushTimerRef.current = null;
//       }
//       const errorMsg = err instanceof DOMException && err.name === "AbortError"
//         ? "Hệ thống phản hồi lâu hoặc bị hủy. Vui lòng thử lại."
//         : err instanceof Error && err.message
//           ? err.message
//           : "Không thể kết nối Backend. Vui lòng kiểm tra dịch vụ.";
//       setMessages((prev) => {
//         const marked = confirmedUserId
//           ? prev
//           : prev.map((item) => item.id === localUserId ? { ...item, failed: true, pending: false } : item);
//         return [
//           ...marked,
//           {
//             id: `local-error-${crypto.randomUUID()}`,
//             conversation_id: activeConversationId ?? confirmedUserId ?? "pending",
//             role: "assistant",
//             content: `**Lỗi:** ${errorMsg}`,
//             created_at: new Date().toISOString(),
//             retryInput: messageText,
//           },
//         ];
//       });
//       toolCalls = toolCalls.map((tc) => tc.status === "running" ? { ...tc, status: "failed" } : tc);
//       setStreamingToolCalls([]);
//       setStreamingContent("");
//       textBufferRef.current = "";
//     } finally {
//       clearTimeout(timeout);
//       abortControllerRef.current = null;
//       setLoading(false);
//     }

//     async function handleChatEvent({ event, data }: ParsedSseEvent) {
//       if (!isRecord(data)) return;

//       switch (event) {
//         case "conversation_started": {
//           const conversation = data.conversation;
//           const userMessageData = data.user_message;
//           if (isConversation(conversation)) {
//             setActiveConversationId(conversation.id);
//             setConversations((prev) => upsertConversation(prev, conversation));
//           }
//           if (isChatMessage(userMessageData)) {
//             confirmedUserId = userMessageData.conversation_id;
//             setMessages((prev) => replaceMessage(prev, localUserId, userMessageData));
//           }
//           break;
//         }

//         case "message_started": {
//           const userMessageData = data.user_message;
//           if (isChatMessage(userMessageData)) {
//             confirmedUserId = userMessageData.conversation_id;
//             setMessages((prev) => replaceMessage(prev, localUserId, userMessageData));
//           }
//           break;
//         }

//         case "tool_start":
//           toolCalls = applyToolStart(data, toolCalls);
//           setStreamingToolCalls([...toolCalls]);
//           break;

//         case "tool_end": {
//           toolCalls = applyToolEnd(data, toolCalls);
//           setStreamingToolCalls([...toolCalls]);
//           const graphData = isGraphData(data.graph_data) ? data.graph_data : undefined;
//           if (graphData?.results?.length && onGraphUpdate) {
//             onGraphUpdate(graphData);
//           }
//           break;
//         }

//         case "text_delta": {
//           const delta = asString(data.text) || asString(data.delta);
//           fullText += delta;
//           appendStreamingText(delta);
//           break;
//         }

//         case "entities_extracted":
//           if (Array.isArray(data.entities)) {
//             streamingEntitiesRef.current = [
//               ...streamingEntitiesRef.current,
//               ...(data.entities as ExtractedEntity[]),
//             ];
//             setStreamingEntities([...streamingEntitiesRef.current]);
//           }
//           break;

//         case "preferences_detected":
//           if (Array.isArray(data.preferences)) {
//             streamingPreferencesRef.current = [
//               ...streamingPreferencesRef.current,
//               ...(data.preferences as DetectedPreference[]),
//             ];
//             setStreamingPreferences([...streamingPreferencesRef.current]);
//           }
//           break;

//         case "done": {
//           if (flushTimerRef.current) {
//             clearTimeout(flushTimerRef.current);
//             flushTimerRef.current = null;
//           }
//           const conversation = data.conversation;
//           const userMessageData = data.user_message;
//           const assistantMessage = data.assistant_message;
//           const responseText = asString(data.response) || fullText;

//           if (isConversation(conversation)) {
//             setActiveConversationId(conversation.id);
//             setConversations((prev) => upsertConversation(prev, conversation));
//           } else {
//             void loadConversationList();
//           }

//           if (isChatMessage(userMessageData)) {
//             setMessages((prev) => replaceMessage(prev, localUserId, userMessageData));
//           }

//           if (isChatMessage(assistantMessage)) {
//             const finalEntities = streamingEntitiesRef.current;
//             const finalPreferences = streamingPreferencesRef.current;
//             setMessages((prev) => appendMessageOnce(prev, {
//               ...mapBackendMessage(assistantMessage),
//               content: responseText || assistantMessage.content,
//               toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
//               entities: finalEntities.length > 0 ? [...finalEntities] : undefined,
//               preferences: finalPreferences.length > 0 ? [...finalPreferences] : undefined,
//             }));
//           }
//           resetStreamingState();
//           break;
//         }

//         case "error":
//           throw new Error(asString(data.detail) || "Lỗi truyền dữ liệu");
//       }
//     }
//   }

//   async function handleDeleteConversation(conversationId: string) {
//     if (loading) return;
//     setError(null);
//     try {
//       await deleteConversation(conversationId);
//       const remaining = conversations.filter((item) => item.id !== conversationId);
//       setConversations(remaining);
//       if (activeConversationId === conversationId) {
//         const next = remaining[0];
//         if (next) {
//           await loadConversationMessages(next.id);
//         } else {
//           startNewConversation();
//         }
//       }
//     } catch (err) {
//       if (err instanceof ApiError && err.status === 401) {
//         handleAuthFailure();
//       } else {
//         setError(err instanceof Error ? err.message : "Không thể xóa cuộc trò chuyện");
//       }
//     }
//   }

//   function handleKeyDown(e: React.KeyboardEvent) {
//     if ((e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229) return;
//     if (e.key === "Enter" && !e.shiftKey) {
//       e.preventDefault();
//       sendMessage();
//     }
//   }

//   if (!authReady) {
//     return (
//       <Flex align="center" justify="center" h="100vh">
//         <Spinner size="md" color="blue.500" />
//       </Flex>
//     );
//   }

//   if (!user) {
//     return (
//       <Flex direction="column" h="100vh" bg="gray.50">
//         <HStack px={6} py={4} bg="gray.900" color="white" justify="space-between">
//           <HStack gap={2}>
//             <Sparkles size={20} color="#10a37f" />
//             <Heading size="md">{DOMAIN.name} AI Agent System</Heading>
//           </HStack>
//         </HStack>
//         <Flex flex={1} align="center" justify="center" px={4}>
//           {authMode === "choose" ? (
//             /* Initial screen: just 2 buttons */
//             <VStack gap={4} align="stretch" w="100%" maxW="320px">
//               <VStack gap={1} mb={2}>
//                 <Sparkles size={32} color="#10a37f" />
//                 <Heading size="md" textAlign="center" color="gray.800">Chào mừng bạn</Heading>
//                 <Text fontSize="sm" color="gray.500" textAlign="center">Đăng nhập hoặc tạo tài khoản để tiếp tục</Text>
//               </VStack>
//               <Button
//                 colorPalette="blue"
//                 size="lg"
//                 w="100%"
//                 onClick={() => { setError(null); setAuthMode("login"); }}
//               >
//                 Đăng nhập
//               </Button>
//               <Button
//                 variant="outline"
//                 size="lg"
//                 w="100%"
//                 onClick={() => { setError(null); setAuthMode("register"); }}
//               >
//                 Đăng ký
//               </Button>
//             </VStack>
//           ) : (
//             /* Form screen */
//             <VStack gap={4} align="stretch" w="100%" maxW="380px" bg="white" p={6} borderRadius="xl" shadow="md">
//               <Heading size="sm" textAlign="center">
//                 {authMode === "login" ? "Đăng nhập" : "Tạo tài khoản mới"}
//               </Heading>
//               <Input
//                 value={username}
//                 onChange={(e) => setUsername(e.target.value)}
//                 placeholder="Tên đăng nhập"
//                 autoComplete="username"
//               />
//               <Input
//                 value={password}
//                 onChange={(e) => setPassword(e.target.value)}
//                 placeholder="Mật khẩu"
//                 type="password"
//                 autoComplete={authMode === "login" ? "current-password" : "new-password"}
//               />
//               {error && <Text color="red.500" fontSize="xs">{error}</Text>}
//               <Button colorPalette="blue" onClick={handleAuthSubmit} loading={authLoading} w="100%">
//                 {authMode === "login" ? "Đăng nhập" : "Đăng ký"}
//               </Button>
//               <Button
//                 variant="ghost"
//                 size="xs"
//                 onClick={() => {
//                   setAuthMode("choose");
//                   setError(null);
//                   setUsername("");
//                   setPassword("");
//                 }}
//               >
//                 ← Quay lại
//               </Button>
//             </VStack>
//           )}
//         </Flex>
//       </Flex>
//     );
//   }

//   return (
//     <Flex h="100vh" w="100vw" overflow="hidden" bg="white">
//       {/* Left Sidebar */}
//       {sidebarOpen && (
//         <Box w="260px" bg="gray.50" borderRight="1px solid" borderColor="gray.200" display="flex" flexDirection="column" flexShrink={0}>
//           <HStack px={4} py={3} borderBottom="1px solid" borderColor="gray.200" justify="space-between">
//             <HStack gap={2}>
//               <Sparkles size={18} color="#10a37f" />
//               <Heading size="xs" fontWeight="bold">Lịch sử hội thoại</Heading>
//             </HStack>
//             <IconButton aria-label="Đóng sidebar" size="xs" variant="ghost" onClick={() => setSidebarOpen(false)}>
//               <PanelLeft size={16} />
//             </IconButton>
//           </HStack>

//           <Box p={3}>
//             <Button
//               w="100%"
//               size="sm"
//               variant="outline"
//               colorPalette="blue"
//               justifyContent="flex-start"
//               onClick={startNewConversation}
//             >
//               <Plus size={16} />
//               Cuộc trò chuyện mới
//             </Button>
//           </Box>

//           <Flex direction="column" flex={1} overflowY="auto" px={2} gap={1}>
//             {loadingConversations ? (
//               <VStack align="stretch" px={2} gap={2}>
//                 <Skeleton height="8" />
//                 <Skeleton height="8" />
//               </VStack>
//             ) : conversations.length === 0 ? (
//               <Text fontSize="xs" color="gray.400" textAlign="center" py={4}>
//                 Chưa có cuộc trò chuyện nào
//               </Text>
//             ) : (
//               conversations.map((conversation) => (
//                 <HStack
//                   key={conversation.id}
//                   gap={1}
//                   px={2}
//                   py={1.5}
//                   borderRadius="md"
//                   bg={activeConversationId === conversation.id ? "blue.50" : "transparent"}
//                   _hover={{ bg: "gray.100" }}
//                   cursor="pointer"
//                 >
//                   <Button
//                     variant="ghost"
//                     size="xs"
//                     justifyContent="flex-start"
//                     flex={1}
//                     minW={0}
//                     onClick={() => loadConversationMessages(conversation.id)}
//                   >
//                     <Text truncate fontSize="xs" color={activeConversationId === conversation.id ? "blue.700" : "gray.800"}>
//                       {conversation.title || "Tư vấn lâm sàng"}
//                     </Text>
//                   </Button>
//                   <IconButton
//                     aria-label="Xóa cuộc trò chuyện"
//                     size="2xs"
//                     variant="ghost"
//                     color="gray.400"
//                     _hover={{ color: "red.500" }}
//                     onClick={(e) => {
//                       e.stopPropagation();
//                       handleDeleteConversation(conversation.id);
//                     }}
//                   >
//                     <Trash2 size={12} />
//                   </IconButton>
//                 </HStack>
//               ))
//             )}
//           </Flex>
//           <Separator />
//           <HStack p={3} justify="space-between" bg="gray.100">
//             <Text fontSize="xs" fontWeight="medium" color="gray.700" truncate>
//               {user.username}
//             </Text>
//             <IconButton aria-label="Đăng xuất" size="xs" variant="ghost" color="gray.600" onClick={handleLogout}>
//               <LogOut size={14} />
//             </IconButton>
//           </HStack>
//         </Box>
//       )}

//       {/* Main Container */}
//       <Flex direction="column" flex={1} minW={0} h="100%">
//         {/* Header Bar */}
//         <Flex px={4} py={2.5} borderBottom="1px solid" borderColor="gray.200" justify="space-between" align="center" bg="white">
//           <HStack gap={3}>
//             {!sidebarOpen && (
//               <IconButton aria-label="Mở sidebar" size="xs" variant="ghost" onClick={() => setSidebarOpen(true)}>
//                 <PanelLeft size={18} />
//               </IconButton>
//             )}
//             <HStack gap={2}>
//               <Stethoscope size={20} color="#10a37f" />
//               <Heading size="sm">Hệ thống Trợ lý Bác sĩ</Heading>
//             </HStack>
//           </HStack>

//           <HStack gap={3}>
//             {(messages.length > 0 || activeConversationId) && (
//               <Button size="xs" variant="ghost" onClick={startNewConversation}>
//                 <RotateCcw size={14} />
//                 Làm mới
//               </Button>
//             )}
//           </HStack>
//         </Flex>

//         {error && (
//           <Box px={4} py={2} bg="red.50" color="red.700" fontSize="sm" borderBottom="1px solid" borderColor="red.200">
//             <HStack gap={2}>
//               <AlertCircle size={16} />
//               <Text>{error}</Text>
//             </HStack>
//           </Box>
//         )}

//         {/* Chat Stream Timeline */}
//         <Box flex={1} overflowY="auto" px={4} py={4}>
//           {messages.length === 0 && !loading && !loadingMessages ? (
//             <Flex direction="column" h="100%" align="center" justify="center" gap={4} color="gray.500">
//               <Sparkles size={36} color="#10a37f" />
//               <Heading size="md" color="gray.800">
//                 Hôm nay tôi có thể hỗ trợ gì cho Bác sĩ?
//               </Heading>
//             </Flex>
//           ) : (
//             <VStack gap={4} align="stretch" maxW="800px" mx="auto">
//               {messages.map((msg) => (
//                 <Box key={msg.id}>
//                   {/* User Message */}
//                   {msg.role === "user" ? (
//                     <Flex justify="flex-end" mb={2}>
//                       <Box
//                         bg="#10a37f"
//                         color="white"
//                         px={4}
//                         py={3}
//                         borderRadius="xl"
//                         maxW="75%"
//                         shadow="sm"
//                       >
//                         {msg.imagePreview && (
//                           <Box w="120px" h="120px" borderRadius="md" overflow="hidden" mb={2} border="2px solid white">
//                             <img src={msg.imagePreview} alt="Tổn thương da" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
//                           </Box>
//                         )}
//                         <Text fontSize="sm" whiteSpace="pre-wrap">{msg.content}</Text>
//                       </Box>
//                     </Flex>
//                   ) : (
//                     /* Assistant Message */
//                     <Flex gap={3} align="flex-start" mb={2}>
//                       <Circle size="8" bg="#10a37f" color="white" flexShrink={0} mt={1}>
//                         <Bot size={16} />
//                       </Circle>
//                       <Box
//                         bg="gray.50"
//                         borderWidth="1px"
//                         borderColor="gray.200"
//                         px={4}
//                         py={3}
//                         borderRadius="xl"
//                         flex={1}
//                         minW={0}
//                         shadow="xs"
//                       >
//                         <Badge
//                           size="xs"
//                           mb={2}
//                           colorPalette={msg.type === "skin_questions" || msg.type === "skin_result" ? "green" : "purple"}
//                           variant="subtle"
//                         >
//                           {msg.type === "skin_questions" || msg.type === "skin_result"
//                             ? "Chẩn đoán da liễu"
//                             : msg.toolCalls?.length
//                               ? "Tra cứu hồ sơ FHIR"
//                               : "Trợ lý lâm sàng"}
//                         </Badge>

//                         {/* FHIR Tool Calls Timeline */}
//                         {msg.toolCalls && msg.toolCalls.length > 0 && (
//                           <ToolCallTimeline toolCalls={msg.toolCalls} />
//                         )}

//                         {/* Standard Markdown Text Response */}
//                         {(!msg.type || msg.type === "text") && (
//                           <Box fontSize="sm" className="markdown-content">
//                             {(() => {
//                               const { thinking, response } = splitThinkingAndResponse(msg.content);
//                               return (
//                                 <>
//                                   {thinking && (
//                                     <Collapsible.Root mb={2}>
//                                       <Collapsible.Trigger asChild>
//                                         <Button variant="ghost" size="xs" color="gray.500">
//                                           <ChevronDown size={12} />
//                                           Suy luận hệ thống
//                                         </Button>
//                                       </Collapsible.Trigger>
//                                       <Collapsible.Content>
//                                         <Box px={3} py={2} bg="gray.100" borderRadius="md" fontSize="xs" color="gray.700" mt={1}>
//                                           <ReactMarkdown remarkPlugins={[remarkGfm]}>{thinking}</ReactMarkdown>
//                                         </Box>
//                                       </Collapsible.Content>
//                                     </Collapsible.Root>
//                                   )}
//                                   <ReactMarkdown remarkPlugins={[remarkGfm]}>{response || msg.content}</ReactMarkdown>
//                                 </>
//                               );
//                             })()}
//                           </Box>
//                         )}

//                         {/* Extracted Clinical Entities & Preferences */}
//                         {msg.entities && msg.entities.length > 0 && (
//                           <HStack gap={1} mt={2} flexWrap="wrap">
//                             {msg.entities.map((e, i) => (
//                               <Badge key={`${e.type}-${e.name}-${i}`} size="xs" colorPalette="teal" variant="subtle">
//                                 {e.type}: {e.name}
//                               </Badge>
//                             ))}
//                           </HStack>
//                         )}

//                         {/* Skin Diagnostic Questions Card */}
//                         {msg.type === "skin_questions" && msg.skinQuestions && (
//                           <Box mt={1}>
//                             <Text fontSize="xs" fontWeight="semibold" color="gray.600" mb={2}>
//                               {msg.skinSubmitted
//                                 ? `Đã hoàn thành trả lời (${msg.skinQuestions.length}/${msg.skinQuestions.length} câu hỏi)`
//                                 : `Vui lòng chọn câu trả lời lâm sàng (${Object.keys(pqrstAnswers).length}/${msg.skinQuestions.length})`}
//                             </Text>

//                             <VStack align="stretch" gap={3}>
//                               {msg.skinQuestions.map((q) => {
//                                 const qNum = q.question_num ?? -1;
//                                 const isSelectedYes = pqrstAnswers[qNum] === "Có";
//                                 const isSelectedNo = pqrstAnswers[qNum] === "Không";

//                                 return (
//                                   <Box key={qNum} p={3} bg="white" borderRadius="md" borderWidth="1px" borderColor="gray.200">
//                                     <HStack gap={2} mb={1}>
//                                       <Badge
//                                         size="xs"
//                                         style={{
//                                           background: (PQRST_COLORS[q.pqrst_category] || "#6b7280") + "20",
//                                           color: PQRST_COLORS[q.pqrst_category] || "#6b7280",
//                                           fontWeight: "bold",
//                                         }}
//                                       >
//                                         {q.pqrst_category}
//                                       </Badge>
//                                       <Text fontSize="xs" color="gray.500">Câu {q.question_num}</Text>
//                                     </HStack>
//                                     <Text fontSize="sm" fontWeight="medium" mb={2}>{q.question}</Text>
//                                     <HStack gap={2}>
//                                       <Button
//                                         size="xs"
//                                         flex={1}
//                                         variant={isSelectedYes ? "solid" : "outline"}
//                                         colorPalette="green"
//                                         disabled={msg.skinSubmitted || submittingSkinAnswers}
//                                         onClick={() => setPqrstAnswers((prev) => ({ ...prev, [qNum]: "Có" }))}
//                                       >
//                                         CÓ
//                                       </Button>
//                                       <Button
//                                         size="xs"
//                                         flex={1}
//                                         variant={isSelectedNo ? "solid" : "outline"}
//                                         colorPalette="red"
//                                         disabled={msg.skinSubmitted || submittingSkinAnswers}
//                                         onClick={() => setPqrstAnswers((prev) => ({ ...prev, [qNum]: "Không" }))}
//                                       >
//                                         KHÔNG
//                                       </Button>
//                                     </HStack>
//                                   </Box>
//                                 );
//                               })}
//                             </VStack>

//                             {!msg.skinSubmitted && (
//                               <Button
//                                 mt={3}
//                                 w="100%"
//                                 colorPalette="blue"
//                                 size="sm"
//                                 disabled={submittingSkinAnswers || Object.keys(pqrstAnswers).length < msg.skinQuestions.length}
//                                 loading={submittingSkinAnswers}
//                                 onClick={() => handleSubmitPqrstAnswers(msg.skinQuestions!, msg.skinRunId!)}
//                               >
//                                 Gửi trả lời lâm sàng
//                               </Button>
//                             )}
//                             {msg.skinSubmitted && (
//                               <HStack justify="center" mt={3} color="green.600" fontSize="xs" fontWeight="semibold">
//                                 <CheckCircle2 size={16} />
//                                 <Text>Đã gửi câu trả lời — Đang tổng hợp chẩn đoán...</Text>
//                               </HStack>
//                             )}
//                           </Box>
//                         )}

//                         {/* Skin Diagnostic Result Card */}
//                         {msg.type === "skin_result" && msg.skinResult && (
//                           <Box mt={1}>
//                             <Heading size="xs" color="#10a37f" mb={3}>
//                               KẾT QUẢ CHẨN ĐOÁN DA LIỄU
//                             </Heading>

//                             {/* Ranked Diagnoses */}
//                             <VStack align="stretch" gap={2} mb={3}>
//                               {msg.skinResult.ranked_diagnoses?.map((diag: Record<string, unknown>, i: number) => (
//                                 <Box
//                                   key={i}
//                                   p={3}
//                                   borderRadius="md"
//                                   borderWidth="1px"
//                                   style={{
//                                     borderColor: RANK_COLORS[i % 3],
//                                     background: RANK_COLORS[i % 3] + "10",
//                                   }}
//                                 >
//                                   <HStack justify="space-between" align="start">
//                                     <Text fontSize="sm" fontWeight="bold" style={{ color: RANK_COLORS[i % 3] }}>
//                                       {RANK_LABELS[i % 3]}: {String(diag.disease || "Bệnh lý nghi ngờ")}
//                                     </Text>
//                                     {Boolean(diag.likelihood) && (
//                                       <Badge size="xs" colorPalette="purple">
//                                         {String(diag.likelihood)}
//                                       </Badge>
//                                     )}
//                                   </HStack>
//                                   {(Boolean(diag.supporting_evidence) || Boolean(diag.evidence_for)) && (
//                                     <Text fontSize="xs" color="gray.700" mt={1}>
//                                       Bằng chứng hỗ trợ: {String(diag.supporting_evidence || diag.evidence_for)}
//                                     </Text>
//                                   )}
//                                   {Boolean(diag.evidence_against) && (
//                                     <Text fontSize="xs" color="red.700" mt={1}>
//                                       Điểm cần loại trừ: {String(diag.evidence_against)}
//                                     </Text>
//                                   )}
//                                 </Box>
//                               ))}
//                             </VStack>

//                             {/* Visual Observations */}
//                             {msg.skinResult.visual_observations && (
//                               <Box p={3} bg="white" borderRadius="md" borderWidth="1px" borderColor="gray.200" mb={2}>
//                                 <Text fontSize="xs" fontWeight="bold" color="gray.700" mb={1}>Phân tích hình ảnh tổn thương:</Text>
//                                 <Text fontSize="xs" color="gray.600" whiteSpace="pre-wrap">{msg.skinResult.visual_observations}</Text>
//                               </Box>
//                             )}

//                             {/* Reasoning */}
//                             {msg.skinResult.reasoning && (
//                               <Box p={3} bg="white" borderRadius="md" borderWidth="1px" borderColor="gray.200">
//                                 <Text fontSize="xs" fontWeight="bold" color="gray.700" mb={1}>Biện luận y khoa:</Text>
//                                 <Text fontSize="xs" color="gray.600" whiteSpace="pre-wrap">{msg.skinResult.reasoning}</Text>
//                               </Box>
//                             )}
//                           </Box>
//                         )}
//                       </Box>
//                     </Flex>
//                   )}
//                 </Box>
//               ))}

//               {/* Running Status / Pipeline Progress Indicator */}
//               {loading && (
//                 <Flex gap={3} align="flex-start" mb={2}>
//                   <Circle size="8" bg="#10a37f" color="white" flexShrink={0} mt={1}>
//                     <Bot size={16} />
//                   </Circle>
//                   <Box bg="gray.50" borderWidth="1px" borderColor="gray.200" px={4} py={3} borderRadius="xl" flex={1}>
//                     {activeSkinRunId && skinStatus ? (
//                       <VStack align="stretch" gap={2}>
//                         <HStack justify="space-between">
//                           <Text fontSize="xs" fontWeight="medium" color="blue.600">
//                             {STEP_LABELS[skinStatus.current_step] || skinStatus.current_step || "Đang xử lý phân tích tổn thương da..."}
//                           </Text>
//                           <Spinner size="xs" color="blue.500" />
//                         </HStack>
//                         <Box h="1.5" bg="gray.200" borderRadius="full" overflow="hidden">
//                           <Box
//                             h="100%"
//                             bg="blue.500"
//                             width={`${Math.min((skinStatus.progress / 7) * 100, 100)}%`}
//                             transition="width 0.3s"
//                           />
//                         </Box>
//                       </VStack>
//                     ) : streamingToolCalls.length > 0 ? (
//                       <VStack align="stretch" gap={2}>
//                         <HStack gap={2}>
//                           <Spinner size="xs" />
//                           <Text fontSize="xs" color="gray.600">
//                             Đang thực thi công cụ {streamingToolCalls.filter((tc) => tc.status === "complete").length + 1} / {streamingToolCalls.length}...
//                           </Text>
//                         </HStack>
//                         <ToolCallTimeline toolCalls={streamingToolCalls} />
//                       </VStack>
//                     ) : (
//                       <HStack gap={2}>
//                         <Spinner size="xs" color="blue.500" />
//                         <Text fontSize="xs" color="gray.500">Đang suy luận phản hồi y khoa...</Text>
//                         {elapsedSeconds > 3 && <Text fontSize="xs" color="gray.400">{elapsedSeconds}s</Text>}
//                       </HStack>
//                     )}
//                     <Button size="xs" variant="ghost" mt={2} color="gray.400" onClick={cancelRequest}>
//                       Hủy bỏ
//                     </Button>
//                   </Box>
//                 </Flex>
//               )}
//               <div ref={messagesEndRef} />
//             </VStack>
//           )}
//         </Box>

//         {/* Input Bar */}
//         <Box px={4} py={3} borderTop="1px solid" borderColor="gray.200" bg="white">
//           <Box maxW="800px" mx="auto">
//             {/* Image Preview Thumbnail */}
//             {filePreview && (
//               <HStack gap={2} mb={2} p={2} bg="gray.50" borderRadius="md" borderWidth="1px" borderColor="blue.300">
//                 <Box w="40px" h="40px" borderRadius="md" overflow="hidden" flexShrink={0} borderWidth="1px" borderColor="blue.500">
//                   <img src={filePreview} alt="Xem trước" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
//                 </Box>
//                 <Text fontSize="xs" color="gray.700" truncate flex={1}>
//                   {selectedFile?.name}
//                 </Text>
//                 <IconButton aria-label="Xóa ảnh" size="2xs" variant="ghost" onClick={clearSelectedFile}>
//                   <X size={14} />
//                 </IconButton>
//               </HStack>
//             )}

//             {/* Main Input Container */}
//             <Flex
//               align="flex-end"
//               gap={2}
//               bg="gray.50"
//               borderWidth="1px"
//               borderColor="gray.300"
//               borderRadius="2xl"
//               px={3}
//               py={2}
//               shadow="sm"
//               _focusWithin={{ borderColor: "blue.500", bg: "white", shadow: "md" }}
//               transition="all 0.2s"
//             >
//               {/* Image Upload Button */}
//               <IconButton
//                 aria-label="Tải ảnh lên"
//                 size="xs"
//                 variant="ghost"
//                 color={selectedFile ? "blue.600" : "gray.500"}
//                 onClick={() => fileInputRef.current?.click()}
//                 disabled={loading}
//               >
//                 <ImagePlus size={18} />
//               </IconButton>
//               <input
//                 ref={fileInputRef}
//                 type="file"
//                 accept="image/png,image/jpeg,image/webp"
//                 onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
//                 style={{ display: "none" }}
//               />

//               {/* Textarea */}
//               <Textarea
//                 value={input}
//                 onChange={(e) => setInput(e.target.value)}
//                 onKeyDown={handleKeyDown}
//                 placeholder="Nhập tin nhắn..."
//                 border="none"
//                 _focus={{ boxShadow: "none" }}
//                 resize="none"
//                 rows={1}
//                 fontSize="sm"
//                 px={1}
//                 py={1}
//                 disabled={loading}
//                 style={{ maxHeight: "160px" }}
//               />

//               {/* Send Button */}
//               <IconButton
//                 aria-label="Gửi"
//                 size="xs"
//                 colorPalette="blue"
//                 borderRadius="full"
//                 onClick={() => sendMessage()}
//                 disabled={(!input.trim() && !selectedFile) || loading}
//               >
//                 {loading ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Send size={14} />}
//               </IconButton>
//             </Flex>
//           </Box>
//         </Box>
//       </Flex>
//     </Flex>
//   );
// }

// function ToolCallTimeline({ toolCalls }: { toolCalls: ToolCall[] }) {
//   return (
//     <Timeline.Root size="sm" mb={2}>
//       {toolCalls.map((tc, j) => (
//         <Timeline.Item key={`${tc.name}-${j}`}>
//           <Timeline.Connector>
//             <Timeline.Separator />
//             <Timeline.Indicator
//               bg={tc.status === "running" ? "purple.500" : tc.status === "failed" ? "red.500" : "green.500"}
//               color="white"
//             >
//               {tc.status === "running" ? (
//                 <Spinner size="xs" color="white" />
//               ) : (
//                 <Check size={10} />
//               )}
//             </Timeline.Indicator>
//           </Timeline.Connector>
//           <Timeline.Content pb={1}>
//             <Collapsible.Root>
//               <HStack gap={2}>
//                 <Badge colorPalette="purple" size="xs">
//                   <Wrench size={10} />
//                   {tc.name}
//                 </Badge>
//                 {tc.status === "running" && (
//                   <Text fontSize="xs" color="gray.500">đang chạy...</Text>
//                 )}
//                 {tc.output_preview && (
//                   <Collapsible.Trigger asChild>
//                     <Button variant="ghost" size="xs" px={1}>
//                       <ChevronDown size={12} />
//                     </Button>
//                   </Collapsible.Trigger>
//                 )}
//               </HStack>
//               {tc.output_preview && (
//                 <Collapsible.Content>
//                   <Box mt={1} px={2} py={1} bg="gray.100" borderRadius="xs" fontSize="xs" fontFamily="mono">
//                     <Text color="gray.700">{tc.output_preview.slice(0, 200)}</Text>
//                   </Box>
//                 </Collapsible.Content>
//               )}
//             </Collapsible.Root>
//           </Timeline.Content>
//         </Timeline.Item>
//       ))}
//     </Timeline.Root>
//   );
// }

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
  PanelLeft, AlertCircle,
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
  getSkinDiagnosticStatus,
  submitSkinDiagnosticAnswers,
} from "@/lib/api";

import type {
  ChatMessage,
  Conversation,
  UserProfile,
  SkinDiagnosticStatus,
  SkinPendingQuestion,
  SkinDiagnosticResult,
} from "@/lib/api";
import { parseSseStream } from "@/lib/sse";
import type { ParsedSseEvent } from "@/lib/sse";

const CHAT_STREAM_TIMEOUT_MS = 900_000;

export const PQRST_COLORS: Record<string, string> = {
  P: "#d946ef",  // magenta
  Q: "#06b6d4",  // cyan
  R: "#3b82f6",  // blue
  S: "#ef4444",  // red
  T: "#eab308",  // yellow
};

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
  imagePreview?: string;
  type?: "text" | "skin_questions" | "skin_result" | "skin_progress";
  skinQuestions?: SkinPendingQuestion[];
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
  const streamingEntitiesRef = useRef<ExtractedEntity[]>([]);
  const streamingPreferencesRef = useRef<DetectedPreference[]>([]);

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
        // Append or update questions card in messages
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.skinRunId !== runId || m.type !== "skin_questions");
          return [
            ...filtered,
            {
              id: `skin-q-${runId}-${Date.now()}`,
              conversation_id: activeConversationId || runId,
              role: "assistant",
              content: "Vui lòng trả lời các câu hỏi lâm sàng dưới đây để làm rõ chẩn đoán:",
              created_at: new Date().toISOString(),
              type: "skin_questions",
              skinQuestions: status.pending_questions || [],
              skinSubmitted: false,
              skinRunId: runId,
            },
          ];
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
          const filtered = prev.filter((m) => m.skinRunId !== runId || m.type !== "skin_questions");
          return [
            ...filtered,
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
      setMessages(data.items.map(mapBackendMessage));

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

  function resetStreamingState() {
    setStreamingContent("");
    setStreamingToolCalls([]);
    setStreamingEntities([]);
    setStreamingPreferences([]);
    streamingEntitiesRef.current = [];
    streamingPreferencesRef.current = [];
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
  };

  const clearSelectedFile = () => {
    setSelectedFile(null);
    if (filePreview) URL.revokeObjectURL(filePreview);
    setFilePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  async function handleAuthSubmit() {
    const trimmedUsername = username.trim();
    if (!trimmedUsername || !password || authLoading) return;
    setAuthLoading(true);
    setError(null);
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

      try {
        const startRes = await startSkinDiagnostic(file, messageText, activeConversationId);
        setActiveSkinRunId(startRes.run_id);

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

          if (isChatMessage(assistantMessage)) {
            const finalEntities = streamingEntitiesRef.current;
            const finalPreferences = streamingPreferencesRef.current;
            setMessages((prev) => appendMessageOnce(prev, {
              ...mapBackendMessage(assistantMessage),
              content: responseText || assistantMessage.content,
              toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
              entities: finalEntities.length > 0 ? [...finalEntities] : undefined,
              preferences: finalPreferences.length > 0 ? [...finalPreferences] : undefined,
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
                placeholder="Tên đăng nhập"
                autoComplete="username"
              />
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mật khẩu"
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
              variant="outline"
              justifyContent="flex-start"
              borderWidth="1.5px"
              borderColor="gray.300"
              color="gray.700"
              bg="white"
              _hover={{ borderColor: "#10a37f", color: "#10a37f", bg: "#10a37f0d" }}
              onClick={startNewConversation}
            >
              <Plus size={16} />
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
              {messages.map((msg) => (
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
                        <Badge
                          size="xs"
                          mb={2}
                          colorPalette={msg.type === "skin_questions" || msg.type === "skin_result" ? "green" : "purple"}
                          variant="subtle"
                        >
                          {msg.type === "skin_questions" || msg.type === "skin_result"
                            ? "Chẩn đoán da liễu"
                            : "Trợ lý lâm sàng"}
                        </Badge>

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
                                      <Badge
                                        size="xs"
                                        style={{
                                          background: (PQRST_COLORS[q.pqrst_category] || "#6b7280") + "20",
                                          color: PQRST_COLORS[q.pqrst_category] || "#6b7280",
                                          fontWeight: "bold",
                                        }}
                                      >
                                        {q.pqrst_category}
                                      </Badge>
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
                                <Text>Đã gửi câu trả lời — Đang tổng hợp chẩn đoán...</Text>
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
              ))}

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
                  <Box bg="gray.50" borderWidth="1px" borderColor="gray.200" px={4} py={3} borderRadius="xl" flex={1}>
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
              _focusWithin={{ borderColor: "#10a37f", shadow: "md" }}
              transition="all 0.2s"
            >
              {/* Image Preview Chip — inside the input card, like ChatGPT */}
              {filePreview && (
                <Box mb={2} pl={1}>
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
                  _focus={{ boxShadow: "none" }}
                  resize="none"
                  rows={1}
                  fontSize="sm"
                  px={1}
                  py={1}
                  disabled={loading}
                  style={{ maxHeight: "160px" }}
                />

                {/* Send Button */}
                <IconButton
                  aria-label="Gửi"
                  size="xs"
                  bg="#10a37f"
                  color="white"
                  _hover={{ bg: "#0d8c6d" }}
                  borderRadius="full"
                  onClick={() => sendMessage()}
                  disabled={(!input.trim() && !selectedFile) || loading}
                >
                  {loading ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Send size={14} />}
                </IconButton>
              </Flex>
            </Box>
          </Box>
        </Box>
      </Flex>
    </Flex>
  );
}

// NOTE: the tool-by-tool timeline UI (previously rendered here with
// Chakra's Timeline component) was removed from the chat view on purpose —
// see the comments where `streamingToolCalls` / `msg.toolCalls` are handled
// above. Tool execution is still fully logged on the backend
// (app/agents/fhir.py, "TOOL START"/"TOOL END" log lines) for debugging.
