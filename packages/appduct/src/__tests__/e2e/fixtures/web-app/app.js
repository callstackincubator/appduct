// The app author's code: the same file is bundled against `@appduct/web` and `@appduct/web/enabled`.
import { registerTool } from "@appduct/web";

registerTool({
  name: "add",
  description: "Add two numbers.",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  outputSchema: { type: "object", properties: { total: { type: "number" } } },
  handler: ({ a, b }) => ({ total: a + b }),
});
