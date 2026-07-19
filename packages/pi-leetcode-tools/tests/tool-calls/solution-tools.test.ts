import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  SolutionInputSchema,
  SolutionSearchInputSchema,
  SolutionSearchToolResultSchema,
  SolutionToolResultSchema
} from "../../src/tool-calls/contract.js";
import { createToolGateway } from "../../src/tool-calls/gateway.js";
import { READ_TOOL_METADATA } from "../../src/tool-calls/read-tools.js";
import { createLeetCodeTools } from "../../src/tool-calls/registry.js";
import { FakeLeetCodeClient } from "./fake-client.js";

describe("answer-bearing solution tools", () => {
  it("publishes bounded schemas and requires exactly one regional detail identifier", () => {
    expect(Check(SolutionSearchInputSchema, { titleSlug: "two-sum" })).toBe(true);
    expect(Check(SolutionSearchInputSchema, { titleSlug: "two-sum", limit: 51 })).toBe(false);
    expect(Check(SolutionInputSchema, { topicId: "123" })).toBe(true);
    expect(Check(SolutionInputSchema, { region: "cn", slug: "two-sum-solution" })).toBe(true);
    expect(Check(SolutionInputSchema, {})).toBe(false);
    expect(Check(SolutionInputSchema, { topicId: "123", slug: "two-sum-solution" })).toBe(false);
  });

  it("registers both solution tools with explicit answer-bearing guidance", () => {
    const tools = createLeetCodeTools(createToolGateway({
      client: new FakeLeetCodeClient(),
      interactiveUI: false
    }));
    const search = tools.find(({ name }) => name === "lc_solution_search");
    const detail = tools.find(({ name }) => name === "lc_solution");
    const searchMetadata = READ_TOOL_METADATA.find(({ name }) => name === "lc_solution_search");
    const detailMetadata = READ_TOOL_METADATA.find(({ name }) => name === "lc_solution");

    expect(search?.description).toContain("answer-bearing");
    expect(detail?.description).toContain("answer-bearing");
    expect(searchMetadata?.promptGuidelines.join(" ")).toContain("explicitly asks");
    expect(detailMetadata?.promptGuidelines.join(" ")).toContain("do not persist");
  });

  it("routes normalized defaults through the shared Gateway and advertises solution risk", async () => {
    const client = new FakeLeetCodeClient();
    const gateway = createToolGateway({ client, interactiveUI: false });

    const search = await gateway.execute("lc_solution_search", { titleSlug: "two-sum" }, {
      requestId: "solution-search"
    });
    expect(Check(SolutionSearchToolResultSchema, search)).toBe(true);
    expect(client.calls[0]).toMatchObject({
      method: "searchSolutions",
      input: { region: "global", titleSlug: "two-sum", limit: 10, offset: 0 }
    });

    const detail = await gateway.execute("lc_solution", {
      region: "cn",
      slug: "two-sum-solution"
    }, { requestId: "solution-detail" });
    expect(Check(SolutionToolResultSchema, detail)).toBe(true);
    expect(client.calls[1]).toMatchObject({
      method: "getSolution",
      input: { region: "cn", slug: "two-sum-solution" }
    });

    expect(gateway.getCapabilities().tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "lc_solution_search",
          requiresAuth: false,
          consequence: "answer_read",
          disclosureRisk: "solution"
        }),
        expect.objectContaining({
          name: "lc_solution",
          requiresAuth: false,
          consequence: "answer_read",
          disclosureRisk: "solution"
        })
      ])
    );
  });
});
