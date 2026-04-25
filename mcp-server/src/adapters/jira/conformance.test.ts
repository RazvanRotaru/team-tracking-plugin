import { describe } from "vitest";
import { runConformance } from "../conformance.js";
import { JiraAdapter } from "./index.js";

const creds = process.env.JIRA_TEST_CREDS; // base64(JSON({baseUrl,email,apiToken,projectKey}))

if (!creds) {
  describe.skip("adapter conformance: jira (set JIRA_TEST_CREDS to enable)", () => {});
} else {
  const parsed = JSON.parse(Buffer.from(creds, "base64").toString("utf8")) as {
    baseUrl: string;
    email: string;
    apiToken: string;
    projectKey: string;
  };

  runConformance("jira", async () => {
    const adapter = new JiraAdapter({
      baseUrl: parsed.baseUrl,
      email: parsed.email,
      apiToken: parsed.apiToken,
      statusMap: {
        Backlog: "Backlog",
        Todo: "To Do",
        "In Progress": "In Progress",
        "In Review": "In Review",
        Done: "Done",
        Blocked: "Blocked",
      },
      projects: [{ name: "TestProj", adapterProjectRef: parsed.projectKey }],
    });
    await adapter.init({});
    return {
      adapter,
      project: "TestProj",
      // No cleanup: tests rely on a sandbox project that's allowed to accrue
      // throwaway issues.
    };
  });
}
