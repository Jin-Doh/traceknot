export const EGRESS_ORIGINS = ["skill", "user-task", "repository-evidence", "unknown"] as const;
export type EgressOrigin = (typeof EGRESS_ORIGINS)[number];

export const NETWORK_PROTOCOLS = ["dns", "tcp", "udp", "http", "https", "websocket"] as const;
export type NetworkProtocol = (typeof NETWORK_PROTOCOLS)[number];

export const EXECUTION_SURFACES = ["native-http-client", "browser", "subprocess", "mcp", "extension", "embedded-runtime"] as const;
export type ExecutionSurface = (typeof EXECUTION_SURFACES)[number];

export const EGRESS_DATA_CLASSES = ["public", "repository", "artifact", "log", "conversation", "environment", "credential"] as const;
export type EgressDataClass = (typeof EGRESS_DATA_CLASSES)[number];

export const EGRESS_DECISIONS = ["allow", "deny", "blocked"] as const;
export type EgressDecision = (typeof EGRESS_DECISIONS)[number];

export const EGRESS_REASONS = [
  "AUTHORIZED_EGRESS",
  "SKILL_ORIGIN_EGRESS",
  "ORIGIN_UNATTRIBUTABLE",
  "UPDATER_TRUST_BOUNDARY",
  "MISSING_AUTHORIZATION",
  "SENSITIVE_DATA_UNAUTHORIZED",
  "TARGET_MISMATCH",
  "PROTOCOL_MISMATCH",
  "REDIRECT_REQUIRES_REAUTHORIZATION",
] as const;
export type EgressReason = (typeof EGRESS_REASONS)[number];

export type CanonicalDestination = Readonly<{
  scheme: string;
  hostname: string;
  port: number;
  pathPrefix: string;
}>;

export type EgressIntent = Readonly<{
  destination: CanonicalDestination;
  protocol: NetworkProtocol;
  executionSurface: ExecutionSurface;
  dataClasses: readonly EgressDataClass[];
  requestId?: string;
  obligationId?: string;
  mandatory?: boolean;
}>;

export type TrustedExecutionScope = Readonly<{
  scopeId: string;
  origin: Exclude<EgressOrigin, "updater">;
  issuedBy: "host-runtime";
  expiresAt: string;
}>;

export type EgressAuthorization = Readonly<{
  authorizationId: string;
  scopeId: string;
  destination: CanonicalDestination;
  protocol: NetworkProtocol;
  executionSurface: ExecutionSurface;
  dataClasses: readonly EgressDataClass[];
  sensitiveDataAuthorized: boolean;
  expiresAt: string;
}>;

export type SkillEgressFailure = Readonly<{
  status: "FAIL" | "BLOCKED";
  requestId: string;
  obligationId: string;
  reason: EgressReason;
}>;

export type EgressObservation = Readonly<{
  decision: EgressDecision;
  reason: EgressReason;
  scopeId: string;
  origin: EgressOrigin;
  destination: CanonicalDestination;
  protocol: NetworkProtocol;
  executionSurface: ExecutionSurface;
  dataClasses: readonly EgressDataClass[];
  authorizationId?: string;
  requestId?: string;
  obligationId?: string;
  failure?: SkillEgressFailure;
}>;

export interface GovernedTransport<TPayload = unknown, TResult = unknown> {
  send(authorization: EgressAuthorization, payload: TPayload): Promise<TResult>;
}

export interface DurableEgressEvidenceStore {
  prepared(observation: EgressObservation): Promise<void>;
  completed(observation: EgressObservation): Promise<void>;
  failed(observation: EgressObservation): Promise<void>;
}

export type RedirectResult = Readonly<{
  kind: "redirect";
  destination: CanonicalDestination;
}>;

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0 || value !== value.trim()) throw new Error(`${label} must be a non-empty trimmed string`);
}

function iso(value: string, label: string): void {
  nonEmpty(value, label);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}

export function canonicalizeDestination(value: string): CanonicalDestination {
  nonEmpty(value, "destination");
  const url = new URL(value);
  if (!url.hostname || url.username || url.password || url.hash) throw new Error("destination must have a canonical host without userinfo or fragment");
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  const port = url.port === "" ? (scheme === "https" ? 443 : scheme === "http" ? 80 : 0) : Number(url.port);
  return freeze({
    scheme,
    hostname: url.hostname.toLowerCase().replace(/\.$/u, ""),
    port,
    pathPrefix: url.pathname === "" ? "/" : url.pathname,
  });
}

function sameDestination(left: CanonicalDestination, right: CanonicalDestination): boolean {
  return left.scheme === right.scheme
    && left.hostname === right.hostname
    && left.port === right.port
    && left.pathPrefix === right.pathPrefix;
}

function validIntent(intent: EgressIntent): void {
  if (!NETWORK_PROTOCOLS.includes(intent.protocol)) throw new Error("protocol is invalid");
  if (!EXECUTION_SURFACES.includes(intent.executionSurface)) throw new Error("executionSurface is invalid");
  if (intent.dataClasses.length === 0 || intent.dataClasses.some((item) => !EGRESS_DATA_CLASSES.includes(item))) throw new Error("dataClasses must contain known data classes");
  if (intent.requestId !== undefined) nonEmpty(intent.requestId, "requestId");
  if (intent.obligationId !== undefined) nonEmpty(intent.obligationId, "obligationId");
  if (intent.mandatory === true && (intent.requestId === undefined || intent.obligationId === undefined)) throw new Error("mandatory egress requires requestId and obligationId");
  if ((intent.protocol === "http" || intent.protocol === "https") && intent.destination.scheme !== intent.protocol) throw new Error("protocol does not match destination scheme");
}

function validScope(scope: TrustedExecutionScope): void {
  nonEmpty(scope.scopeId, "scopeId");
  if (!EGRESS_ORIGINS.includes(scope.origin)) throw new Error("scope origin is invalid");
  if (scope.issuedBy !== "host-runtime") throw new Error("scope issuer is invalid");
  iso(scope.expiresAt, "scope.expiresAt");
  if (Date.parse(scope.expiresAt) <= Date.now()) throw new Error("scope.expiresAt is expired");
}
function validAuthorization(intent: EgressIntent, scope: TrustedExecutionScope, authorization: EgressAuthorization): EgressReason | undefined {
  if (authorization.scopeId !== scope.scopeId) return "MISSING_AUTHORIZATION";
  if (!sameDestination(authorization.destination, intent.destination)) return "TARGET_MISMATCH";
  if (authorization.protocol !== intent.protocol) return "PROTOCOL_MISMATCH";
  if (authorization.executionSurface !== intent.executionSurface) return "MISSING_AUTHORIZATION";
  if (authorization.dataClasses.length !== intent.dataClasses.length || authorization.dataClasses.some((item, index) => item !== intent.dataClasses[index])) return "MISSING_AUTHORIZATION";
  if (typeof authorization.sensitiveDataAuthorized !== "boolean") return "MISSING_AUTHORIZATION";
  const authorizationExpiry = Date.parse(authorization.expiresAt);
  if (Number.isNaN(authorizationExpiry) || authorizationExpiry <= Date.now()) return "MISSING_AUTHORIZATION";
  return undefined;
}

function failure(intent: EgressIntent, reason: EgressReason, status: "FAIL" | "BLOCKED"): SkillEgressFailure | undefined {
  return intent.mandatory === true && intent.requestId !== undefined && intent.obligationId !== undefined
    ? freeze({ status, requestId: intent.requestId, obligationId: intent.obligationId, reason })
    : undefined;
}

function observe(scope: TrustedExecutionScope, intent: EgressIntent, decision: EgressDecision, reason: EgressReason, authorization?: EgressAuthorization): EgressObservation {
  const failureStatus = decision === "blocked" ? "BLOCKED" : "FAIL";
  const failureRecord = decision === "allow" ? undefined : failure(intent, reason, failureStatus);
  return freeze({
    decision,
    reason,
    scopeId: scope.scopeId,
    origin: scope.origin,
    destination: freeze({ ...intent.destination }),
    protocol: intent.protocol,
    executionSurface: intent.executionSurface,
    dataClasses: freeze([...intent.dataClasses]),
    ...(authorization === undefined ? {} : { authorizationId: authorization.authorizationId }),
    ...(intent.requestId === undefined ? {} : { requestId: intent.requestId }),
    ...(intent.obligationId === undefined ? {} : { obligationId: intent.obligationId }),
    ...(failureRecord === undefined ? {} : { failure: failureRecord }),
  });
}

export function evaluateGovernedEgress(scope: TrustedExecutionScope, intent: EgressIntent, authorization: EgressAuthorization): EgressObservation {
  validScope(scope);
  validIntent(intent);
  if (scope.origin === "skill") return observe(scope, intent, "deny", "SKILL_ORIGIN_EGRESS");
  if (scope.origin === "unknown") return observe(scope, intent, "blocked", "ORIGIN_UNATTRIBUTABLE");
  const authorizationFailure = validAuthorization(intent, scope, authorization);
  if (authorizationFailure !== undefined) return observe(scope, intent, "deny", authorizationFailure);
  if (intent.dataClasses.some((item) => item === "environment" || item === "credential" || item === "conversation" || item === "repository" || item === "artifact" || item === "log") && !authorization.sensitiveDataAuthorized) {
    return observe(scope, intent, "deny", "SENSITIVE_DATA_UNAUTHORIZED", authorization);
  }
  return observe(scope, intent, "allow", "AUTHORIZED_EGRESS", authorization);
}

export class GovernedEgressDeniedError extends Error {
  constructor(readonly observation: EgressObservation) {
    super(`Governed egress ${observation.decision}: ${observation.reason}`);
    this.name = "GovernedEgressDeniedError";
  }
}

function snapshotScope(scope: TrustedExecutionScope): TrustedExecutionScope {
  return freeze({ ...scope });
}

function snapshotAuthorization(authorization: EgressAuthorization): EgressAuthorization {
  return freeze({
    ...authorization,
    destination: freeze({ ...authorization.destination }),
    dataClasses: freeze([...authorization.dataClasses]),
  });
}

function malformedMandatoryIntent(intent: EgressIntent): EgressIntent | undefined {
  if (
    intent.mandatory !== true
    || typeof intent.requestId !== "string"
    || intent.requestId.trim().length === 0
    || intent.requestId !== intent.requestId.trim()
    || typeof intent.obligationId !== "string"
    || intent.obligationId.trim().length === 0
    || intent.obligationId !== intent.obligationId.trim()
  ) {
    return undefined;
  }
  const dataClasses = Array.isArray(intent.dataClasses)
    ? intent.dataClasses.filter((item): item is EgressDataClass => EGRESS_DATA_CLASSES.includes(item))
    : [];
  return {
    destination: intent.destination && typeof intent.destination === "object"
      ? intent.destination
      : canonicalizeDestination("https://invalid.invalid/"),
    protocol: NETWORK_PROTOCOLS.includes(intent.protocol) ? intent.protocol : "https",
    executionSurface: EXECUTION_SURFACES.includes(intent.executionSurface) ? intent.executionSurface : "native-http-client",
    dataClasses: dataClasses.length > 0 ? dataClasses : ["public"],
    requestId: intent.requestId,
    obligationId: intent.obligationId,
    mandatory: true,
  };
}
function egressAuthorizationIsFresh(scope: TrustedExecutionScope, authorization: EgressAuthorization): boolean {
  return Date.parse(scope.expiresAt) > Date.now() && Date.parse(authorization.expiresAt) > Date.now();
}

export async function executeGovernedEgress<TPayload, TResult>(
  scope: TrustedExecutionScope,
  intent: EgressIntent,
  authorization: EgressAuthorization,
  transport: GovernedTransport<TPayload, TResult>,
  payload: TPayload,
  evidence: DurableEgressEvidenceStore,
): Promise<Readonly<{ observation: EgressObservation; value: TResult }>> {
  const scopeSnapshot = snapshotScope(scope);
  const fallbackIntent = malformedMandatoryIntent(intent);
  if (fallbackIntent !== undefined && (scopeSnapshot.origin === "skill" || scopeSnapshot.origin === "unknown")) {
    validScope(scopeSnapshot);
    const decision = scopeSnapshot.origin === "skill" ? "deny" : "blocked";
    const reason = scopeSnapshot.origin === "skill" ? "SKILL_ORIGIN_EGRESS" : "ORIGIN_UNATTRIBUTABLE";
    const observation = observe(scopeSnapshot, fallbackIntent, decision, reason);
    await evidence.failed(observation);
    validIntent(intent);
    throw new GovernedEgressDeniedError(observation);
  }
  const authorizationSnapshot = snapshotAuthorization(authorization);
  const observation = evaluateGovernedEgress(scopeSnapshot, intent, authorizationSnapshot);
  if (observation.decision !== "allow") {
    if (observation.failure !== undefined) await evidence.failed(observation);
    throw new GovernedEgressDeniedError(observation);
  }
  await evidence.prepared(observation);
  if (!egressAuthorizationIsFresh(scopeSnapshot, authorizationSnapshot)) {
    const staleObservation = observe(scopeSnapshot, intent, "deny", "MISSING_AUTHORIZATION", authorizationSnapshot);
    await evidence.failed(staleObservation);
    throw new GovernedEgressDeniedError(staleObservation);
  }
  let terminalFailureRecorded = false;
  try {
    const value = await transport.send(authorizationSnapshot, payload);
    if ((value as RedirectResult | undefined)?.kind === "redirect") {
      const redirectObservation = observe(scopeSnapshot, intent, "deny", "REDIRECT_REQUIRES_REAUTHORIZATION", authorizationSnapshot);
      terminalFailureRecorded = true;
      await evidence.failed(redirectObservation);
      throw new GovernedEgressDeniedError(redirectObservation);
    }
    await evidence.completed(observation);
    return freeze({ observation, value });
  } catch (error) {
    if (!terminalFailureRecorded) {
      terminalFailureRecorded = true;
      await evidence.failed(observation);
    }
    throw error;
  }
}

export class UpdaterAuthority {
  readonly #issuer = "updater-subsystem" as const;
  get issuer(): "updater-subsystem" { return this.#issuer; }
}

export type UpdaterRequest<TPayload> = Readonly<{
  destination: CanonicalDestination;
  protocol: NetworkProtocol;
  payload: TPayload;
}>;

export async function executeUpdaterEgress<TPayload, TResult>(
  authority: UpdaterAuthority,
  request: UpdaterRequest<TPayload>,
  transport: GovernedTransport<TPayload, TResult>,
): Promise<TResult> {
  if (authority.issuer !== "updater-subsystem") throw new Error("invalid updater authority");
  return transport.send(freeze({
    authorizationId: `updater:${crypto.randomUUID()}`,
    scopeId: "updater",
    destination: request.destination,
    protocol: request.protocol,
    executionSurface: "native-http-client",
    dataClasses: ["public"],
    sensitiveDataAuthorized: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), request.payload);
}
