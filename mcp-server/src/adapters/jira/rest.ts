/**
 * Thin REST wrapper around Jira Cloud's v3 API.
 *
 * Auth: HTTP Basic with email + API token. Every method returns the parsed
 * JSON body (or void) and throws on non-2xx with the Jira error envelope.
 */
export type JiraAuth = {
  baseUrl: string;
  email: string;
  apiToken: string;
};

export type JiraIssue = {
  id: string;
  key: string;
  fields: Record<string, unknown>;
};

type FetchLike = typeof fetch;

export class JiraRest {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetch: FetchLike;

  constructor(auth: JiraAuth, fetchImpl: FetchLike = fetch) {
    this.baseUrl = auth.baseUrl.replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(`${auth.email}:${auth.apiToken}`).toString("base64")}`;
    this.fetch = fetchImpl;
  }

  private async request<T>(method: string, pathAndQuery: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${pathAndQuery}`;
    const res = await this.fetch(url, {
      method,
      headers: {
        authorization: this.authHeader,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        // ignore
      }
      throw new Error(`jira ${method} ${pathAndQuery} ${res.status}: ${detail}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  getIssue(idOrKey: string, fields?: string[]): Promise<JiraIssue> {
    const q = fields ? `?fields=${encodeURIComponent(fields.join(","))}` : "";
    return this.request("GET", `/rest/api/3/issue/${encodeURIComponent(idOrKey)}${q}`);
  }

  createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
    return this.request("POST", "/rest/api/3/issue", { fields });
  }

  editIssue(idOrKey: string, fields: Record<string, unknown>): Promise<void> {
    return this.request("PUT", `/rest/api/3/issue/${encodeURIComponent(idOrKey)}`, { fields });
  }

  transitionIssue(idOrKey: string, transitionId: string): Promise<void> {
    return this.request("POST", `/rest/api/3/issue/${encodeURIComponent(idOrKey)}/transitions`, {
      transition: { id: transitionId },
    });
  }

  listTransitions(idOrKey: string): Promise<{
    transitions: Array<{ id: string; name: string; to: { name: string } }>;
  }> {
    return this.request("GET", `/rest/api/3/issue/${encodeURIComponent(idOrKey)}/transitions`);
  }

  searchJql(jql: string, fields?: string[]): Promise<{ issues: JiraIssue[]; total: number }> {
    return this.request("POST", "/rest/api/3/search", {
      jql,
      fields: fields ?? ["*all"],
      maxResults: 200,
    });
  }

  addComment(idOrKey: string, body: string): Promise<{ id: string }> {
    // Jira v3 takes Atlassian Document Format. Wrap raw text in a paragraph.
    return this.request("POST", `/rest/api/3/issue/${encodeURIComponent(idOrKey)}/comment`, {
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
      },
    });
  }

  createIssueLink(args: {
    type: string; // e.g. "is parent of"
    inwardKey: string;
    outwardKey: string;
  }): Promise<void> {
    return this.request("POST", "/rest/api/3/issueLink", {
      type: { name: args.type },
      inwardIssue: { key: args.inwardKey },
      outwardIssue: { key: args.outwardKey },
    });
  }
}
