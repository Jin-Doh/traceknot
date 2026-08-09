const workflowPath = new URL("../../.github/workflows/auto-pr-triage.yml", import.meta.url);
export const workflow = await Bun.file(workflowPath).text();

function embeddedScript(source: string): string {
  const marker = "          script: |\n";
  const start = source.indexOf(marker);
  if (start === -1) throw new Error("auto-triage github-script block not found");

  const scriptLines: string[] = [];
  for (const line of source.slice(start + marker.length).split("\n")) {
    if (line !== "" && !line.startsWith("            ")) break;
    scriptLines.push(line.slice(12));
  }
  return scriptLines.join("\n");
}

interface PullRequestFile {
  filename: string;
}

interface Request {
  owner: string;
  repo: string;
  issue_number?: number;
  pull_number?: number;
  per_page?: number;
  labels?: string[];
  assignees?: string[];
  name?: string;
  assignee?: string;
}

type Endpoint = (request: Request) => Promise<unknown>;
type IssueEndpoint = "get" | "addLabels" | "removeLabel" | "addAssignees" | "checkUserCanBeAssigned";

interface GithubMock {
  rest: {
    issues: Record<IssueEndpoint, Endpoint>;
    pulls: { listFiles: Endpoint };
  };
  paginate: (endpoint: Endpoint, request: Request) => Promise<PullRequestFile[]>;
}

interface ContextMock {
  repo: { owner: string; repo: string };
  payload: {
    pull_request: {
      number: number;
      title: string;
      body: string;
      user: { login: string; type: "User" | "Bot" };
    };
  };
}

type CallName = "get" | "paginate" | "addLabels" | "removeLabel" | "checkAssignable" | "addAssignees";
export type Calls = Record<CallName, Request[]>;

export interface Scenario {
  title?: string;
  body?: string;
  files?: string[];
  labels?: string[];
  assignees?: string[];
  author?: string;
  authorType?: "User" | "Bot";
  assignabilityError?: Error & { status?: number };
  getError?: Error;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (github: GithubMock, context: ContextMock) => Promise<void>;
export const runScript = new AsyncFunction("github", "context", embeddedScript(workflow));

export function apiError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export function setup(scenario: Scenario = {}): { github: GithubMock; context: ContextMock; calls: Calls } {
  const calls: Calls = {
    get: [],
    paginate: [],
    addLabels: [],
    removeLabel: [],
    checkAssignable: [],
    addAssignees: [],
  };
  const files = (scenario.files ?? ["src/index.ts"]).map((filename) => ({ filename }));

  const listFiles: Endpoint = async () => ({ data: [] });
  const github: GithubMock = {
    rest: {
      issues: {
        get: async (request) => {
          calls.get.push(request);
          if (scenario.getError) throw scenario.getError;
          return {
            data: {
              labels: (scenario.labels ?? []).map((name) => ({ name })),
              assignees: (scenario.assignees ?? []).map((login) => ({ login })),
            },
          };
        },
        addLabels: async (request) => {
          calls.addLabels.push(request);
          return {};
        },
        removeLabel: async (request) => {
          calls.removeLabel.push(request);
          return {};
        },
        checkUserCanBeAssigned: async (request) => {
          calls.checkAssignable.push(request);
          if (scenario.assignabilityError) throw scenario.assignabilityError;
          return { status: 204 };
        },
        addAssignees: async (request) => {
          calls.addAssignees.push(request);
          return {};
        },
      },
      pulls: { listFiles },
    },
    paginate: async (endpoint, request) => {
      if (endpoint !== listFiles) throw new Error("paginate called with the wrong endpoint");
      calls.paginate.push(request);
      return files;
    },
  };

  return {
    github,
    calls,
    context: {
      repo: { owner: "traceknot", repo: "traceknot" },
      payload: {
        pull_request: {
          number: 42,
          title: scenario.title ?? "Improve tracing",
          body: scenario.body ?? "Adds tracing support",
          user: {
            login: scenario.author ?? "external-contributor",
            type: scenario.authorType ?? "User",
          },
        },
      },
    },
  };
}

export async function run(scenario: Scenario = {}): Promise<Calls> {
  const { github, context, calls } = setup(scenario);
  await runScript(github, context);
  return calls;
}
