export const RUNTIME_PROTOCOL_VERSION = 'runtime.v1' as const;
export const RUNTIME_USER_AGENT = 'zhuzeyang-agent-runtime/1.0' as const;
export const RUNTIME_MAX_ATTEMPTS = 1 as const;

/** Default lease window for async runs: worker must heartbeat before expiry. */
export const RUNTIME_ASYNC_LEASE_SECONDS = 120 as const;

export type RuntimeProtocolVersion = typeof RUNTIME_PROTOCOL_VERSION;

export type AgentInvokeTrigger =
  | {
      kind?: 'user_message' | 'system_message' | 'agent_message';
      type?: 'message.created';
      message_id: string;
      sender_participant_id?: string;
      sender_type: 'user' | 'agent' | 'system';
      sender_id?: string;
      recipient_participant_ids?: string[];
      visibility?: 'session' | 'direct';
      dispatch_ttl?: number;
    }
  | {
      kind?: string;
      type: 'manual' | 'scheduled' | 'system';
      reason?: string;
    }
  | {
      kind?: string;
      type?: string;
      [key: string]: unknown;
    };

export interface AgentRuntimeConfigSnapshot {
  id: string;
  name: string;
  description?: string | null;
  endpoint_url?: string | null;
  system_prompt?: string | null;
  config?: Record<string, unknown>;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentSessionSnapshot {
  id: string;
  project_id: string;
  title?: string | null;
  status?: string;
  mode?: string;
  participant_agent_ids?: string[];
  metadata?: Record<string, unknown>;
}

export interface RecentMessage {
  id: string;
  role: 'user' | 'agent' | 'system' | string;
  content: string;
  content_type?: string;
  sender_type?: 'user' | 'agent' | 'system' | string;
  sender_id?: string;
  agent_id?: string | null;
  user_id?: string | null;
  run_id?: string | null;
  caused_by_run_id?: string | null;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectMemorySnapshot {
  id: string;
  agent_id?: string | null;
  content: string;
  tags?: string[];
  visibility?: 'project' | 'agent' | string;
  updated_at: string;
}

export type AgentInvokeMode = 'sync' | 'async';

export interface RuntimeInvokeConfig {
  timeout_ms: number;
  max_attempts: number;
  supports_async: boolean;
  supports_streaming: boolean;
  /** Platform callback URL for async events/complete. Only sent when supports_async=true. */
  callback_url?: string;
  /** Bearer token the worker must use when calling callback_url. */
  callback_token?: string;
  /** How long (seconds) the platform will wait for a worker heartbeat before redelivering/recovering. */
  lease_seconds?: number;
  [key: string]: unknown;
}

export interface AgentInvokeRequest {
  protocol_version: RuntimeProtocolVersion;
  project_id: string;
  session_id: string;
  agent_id: string;
  run_id: string;
  delivery_id: string;
  attempt: number;
  trigger: AgentInvokeTrigger;
  agent: AgentRuntimeConfigSnapshot;
  session: AgentSessionSnapshot;
  recent_messages: RecentMessage[];
  project_memories?: ProjectMemorySnapshot[];
  project_rules?: { path: string; content: string; updated_at: string } | null;
  runtime: RuntimeInvokeConfig;
  trace_id: string;
  correlation_id: string;
  created_at: string;
}

export type AgentInvokeResponseStatus = 'completed' | 'no_reply' | 'failed' | 'rejected';

export interface AgentResponseMessage {
  content: string;
  content_type?: string;
  recipient_participant_ids?: string[];
  visibility?: 'session' | 'direct';
  dispatch_ttl?: number;
  metadata?: Record<string, unknown>;
  target?: {
    type: 'session' | 'agent' | 'user';
    id?: string;
  };
  run_id?: string;
  caused_by_run_id?: string;
  sender_type?: string;
  sender_id?: string;
  role?: string;
  [key: string]: unknown;
}

export interface AgentReportedMetric {
  name: string;
  value: number;
  unit?: string;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface AgentInvokeResponse {
  status: AgentInvokeResponseStatus;
  messages?: AgentResponseMessage[];
  metrics?: AgentReportedMetric[];
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
  debug?: {
    summary?: string;
    logs?: string[];
  };
}

/** Worker ack when accepting an async run (HTTP 202). */
export interface AgentInvokeAsyncAckResponse {
  status: 'accepted';
  run_id?: string;
  delivery_id?: string;
  message?: string;
  lease_seconds?: number;
}

/** Result shape returned by invokeAgent when mode='async' and the worker acks. */
export interface AgentInvokeAsyncResult {
  ok: boolean;
  status: 'accepted';
  async: true;
  runId: string;
  deliveryId: string;
  attempt: number;
  httpStatus: number;
  leaseSeconds?: number;
  messages: SanitizedAgentResponseMessage[];
  metrics: AgentReportedMetric[];
}

export type RuntimeFailureType =
  | 'timeout'
  | 'transport_error'
  | 'auth_error'
  | 'rate_limited'
  | 'agent_error'
  | 'agent_rejected'
  | 'agent_unavailable'
  | 'invalid_response'
  | 'unsupported_async_response'
  | 'async_callback_error'
  | 'lease_expired';

export interface SanitizedAgentResponseMessage {
  message_id: string;
  role: 'agent';
  sender_type: 'agent';
  sender_id: string;
  sender_participant_id?: string;
  agent_id: string;
  run_id: string;
  caused_by_run_id: string;
  content: string;
  content_type: string;
  visibility: 'session' | 'direct';
  recipient_participant_ids: string[];
  dispatch_ttl: number;
  metadata?: Record<string, unknown>;
  target?: AgentResponseMessage['target'];
}

export interface RuntimeEventAppend {
  projectId: string;
  sessionId: string;
  agentId?: string;
  userId?: string;
  actorType?: string;
  type: string;
  payload: Record<string, unknown>;
  traceId?: string;
  idempotencyKey: string;
}

export interface RuntimeEventRepository {
  appendEvent(event: RuntimeEventAppend): Promise<unknown>;
}

/** Worker heartbeat/event payload: extend the run lease and/or append intermediate events. */
export interface AgentRunEventPayload {
  /** Optional short status update from the worker. */
  status?: 'running' | 'processing' | string;
  /** Optional log/event lines the platform should persist. */
  events?: Array<{
    type: string;
    payload?: Record<string, unknown>;
    idempotency_key?: string;
  }>;
  /** Optional health metrics emitted mid-run. */
  metrics?: AgentReportedMetric[];
  /** New lease request in seconds; platform caps to RUNTIME_ASYNC_LEASE_SECONDS. */
  lease_seconds?: number;
}

/** Worker completion payload: finish an async run. */
export interface AgentRunCompletePayload {
  status: 'completed' | 'failed' | 'rejected' | 'no_reply';
  messages?: AgentResponseMessage[];
  metrics?: AgentReportedMetric[];
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
  debug?: {
    summary?: string;
    logs?: string[];
  };
}

export interface RuntimeHttpResponse {
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type RuntimeFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<RuntimeHttpResponse>;
