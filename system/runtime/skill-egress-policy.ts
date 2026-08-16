export const EGRESS_ORIGINS = [
  "user-task",
  "skill",
  "repository-evidence",
  "updater",
  "unknown",
] as const;
export type EgressOrigin = (typeof EGRESS_ORIGINS)[number];

export const EGRESS_TRANSPORTS = [
  "dns",
  "tcp",
  "udp",
  "http",
  "https",
  "websocket",
  "browser",
  "subprocess",
] as const;
export type EgressTransport = (typeof EGRESS_TRANSPORTS)[number];

export const EGRESS_DATA_CLASSES = [
  "public",
  "repository",
  "artifact",
  "conversation",
  "environment",
  "credential",
] as const;
export type EgressDataClass = (typeof EGRESS_DATA_CLASSES)[number];

export const EGRESS_DECISIONS = ["allow", "deny", "blocked", "out-of-scope"] as const;
export type EgressDecision = (typeof EGRESS_DECISIONS)[number];

export const EGRESS_REASONS = [
  "AUTHORIZED_USER_TASK",
  "AUTHORIZED_REPOSITORY_EVIDENCE",
  "SKILL_ORIGIN_EGRESS",
  "ORIGIN_UNATTRIBUTABLE",
  "UPDATER_TRUST_BOUNDARY",
  "MISSING_AUTHORIZATION",
  "SENSITIVE_DATA_UNAUTHORIZED",
] as const;
export type EgressReason = (typeof EGRESS_REASONS)[number];

export type SkillEgressPolicyInput = Readonly<{
  origin: EgressOrigin;
  destination: string;
  transport: EgressTransport;
  dataClasses: readonly EgressDataClass[];
  authorizationBasisId?: string;
  authorizedDestination?: string;
  sensitiveDataAuthorized?: boolean;
  requestId?: string;
  obligationId?: string;
  mandatory?: boolean;
}>;

export type SkillEgressFailure = Readonly<{
  status: "FAIL" | "BLOCKED";
  requestId: string;
  obligationId: string;
  reason: EgressReason;
}>;

export type SkillEgressObservation = Readonly<{
  decision: EgressDecision;
  reason: EgressReason;
  origin: EgressOrigin;
  destination: string;
  transport: EgressTransport;
  dataClasses: readonly EgressDataClass[];
  authorizationBasisId?: string;
  requestId?: string;
  obligationId?: string;
  failure?: SkillEgressFailure;
}>;

const SENSITIVE_DATA_CLASSES: Readonly<Partial<Record<EgressDataClass, true>>> = {
  conversation: true,
  environment: true,
  credential: true,
};

function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0 || value !== value.trim()) throw new Error(`${label} must be a non-empty trimmed string`);
}

function validateInput(input: SkillEgressPolicyInput): void {
  if (!EGRESS_ORIGINS.includes(input.origin)) throw new Error("origin is invalid");
  if (!EGRESS_TRANSPORTS.includes(input.transport)) throw new Error("transport is invalid");
  if (input.dataClasses.length === 0 || input.dataClasses.some((dataClass) => !EGRESS_DATA_CLASSES.includes(dataClass))) {
    throw new Error("dataClasses must contain known data classes");
  }
  nonEmpty(input.destination, "destination");
  if (input.authorizationBasisId !== undefined) nonEmpty(input.authorizationBasisId, "authorizationBasisId");
  if (input.authorizedDestination !== undefined) nonEmpty(input.authorizedDestination, "authorizedDestination");
  if (input.requestId !== undefined) nonEmpty(input.requestId, "requestId");
  if (input.obligationId !== undefined) nonEmpty(input.obligationId, "obligationId");
  if (input.mandatory === true && (input.requestId === undefined || input.obligationId === undefined)) {
    throw new Error("mandatory Skill egress requires requestId and obligationId");
  }
}

function observation(
  input: SkillEgressPolicyInput,
  decision: EgressDecision,
  reason: EgressReason,
): SkillEgressObservation {
  return {
    decision,
    reason,
    origin: input.origin,
    destination: input.destination,
    transport: input.transport,
    dataClasses: Object.freeze([...input.dataClasses]),
    ...(input.authorizationBasisId === undefined ? {} : { authorizationBasisId: input.authorizationBasisId }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.obligationId === undefined ? {} : { obligationId: input.obligationId }),
    ...(input.mandatory === true && (decision === "deny" || decision === "blocked")
      ? {
        failure: {
          status: decision === "blocked" ? "BLOCKED" as const : "FAIL" as const,
          requestId: input.requestId!,
          obligationId: input.obligationId!,
          reason,
        },
      }
      : {}),
  };
}
function hasValidMandatoryIdentifiers(input: SkillEgressPolicyInput): boolean {
  return typeof input.requestId === "string"
    && input.requestId.length > 0
    && input.requestId === input.requestId.trim()
    && typeof input.obligationId === "string"
    && input.obligationId.length > 0
    && input.obligationId === input.obligationId.trim();
}

function malformedObligationObservation(
  input: SkillEgressPolicyInput,
  origin: "skill" | "unknown",
  decision: "deny" | "blocked",
  reason: "SKILL_ORIGIN_EGRESS" | "ORIGIN_UNATTRIBUTABLE",
): SkillEgressObservation {
  const dataClasses = Array.isArray(input.dataClasses)
    ? input.dataClasses.filter((dataClass): dataClass is EgressDataClass => EGRESS_DATA_CLASSES.includes(dataClass))
    : [];
  const transport = EGRESS_TRANSPORTS.includes(input.transport) ? input.transport : "subprocess";
  const destination = typeof input.destination === "string" ? input.destination : "<invalid-destination>";
  return observation({
    origin,
    destination,
    transport,
    dataClasses,
    requestId: input.requestId!,
    obligationId: input.obligationId!,
    mandatory: true,
  }, decision, reason);
}
function hasSensitiveData(dataClasses: readonly EgressDataClass[]): boolean {
  return dataClasses.some((dataClass) => SENSITIVE_DATA_CLASSES[dataClass] === true);
}

function authorizedDestination(input: SkillEgressPolicyInput): boolean {
  return input.authorizationBasisId !== undefined
    && input.authorizationBasisId.trim().length > 0
    && input.authorizedDestination === input.destination;
}

export function decideSkillEgress(input: SkillEgressPolicyInput): SkillEgressObservation {
  validateInput(input);
  if (input.origin === "skill") return observation(input, "deny", "SKILL_ORIGIN_EGRESS");
  if (input.origin === "unknown") return observation(input, "blocked", "ORIGIN_UNATTRIBUTABLE");
  if (input.origin === "updater") return observation(input, "out-of-scope", "UPDATER_TRUST_BOUNDARY");
  if (!authorizedDestination(input)) return observation(input, "deny", "MISSING_AUTHORIZATION");
  if (hasSensitiveData(input.dataClasses) && input.sensitiveDataAuthorized !== true) {
    return observation(input, "deny", "SENSITIVE_DATA_UNAUTHORIZED");
  }
  return observation(
    input,
    "allow",
    input.origin === "user-task" ? "AUTHORIZED_USER_TASK" : "AUTHORIZED_REPOSITORY_EVIDENCE",
  );
}

export function assertSkillEgressAllowed(input: SkillEgressPolicyInput): SkillEgressObservation {
  const result = decideSkillEgress(input);
  if (result.decision === "deny" || result.decision === "blocked") {
    throw new SkillEgressDeniedError(result);
  }
  return result;
}

export class SkillEgressDeniedError extends Error {
  constructor(readonly observation: SkillEgressObservation) {
    super(`Skill egress ${observation.decision}: ${observation.reason}`);
    this.name = "SkillEgressDeniedError";
  }
}

export async function executeSkillEgress<T>(
  input: SkillEgressPolicyInput,
  transmit: (observation: SkillEgressObservation) => Promise<T>,
): Promise<Readonly<{ observation: SkillEgressObservation; value: T }>> {
  let allowedObservation: SkillEgressObservation;
  try {
    allowedObservation = assertSkillEgressAllowed(input);
  } catch (error) {
    if (
      input.mandatory === true
      && hasValidMandatoryIdentifiers(input)
      && (input.origin === "skill" || input.origin === "unknown")
    ) {
      const origin = input.origin;
      throw new SkillEgressDeniedError(malformedObligationObservation(
        input,
        origin,
        origin === "skill" ? "deny" : "blocked",
        origin === "skill" ? "SKILL_ORIGIN_EGRESS" : "ORIGIN_UNATTRIBUTABLE",
      ));
    }
    throw error;
  }
  return { observation: allowedObservation, value: await transmit(allowedObservation) };
}
