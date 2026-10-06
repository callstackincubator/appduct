// The same app as app.js, opting in to the real entry with @appduct/web/enabled.
import { registerTool } from "@appduct/web/enabled";

registerTool({
  name: "add",
  description: "Add two numbers.",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  outputSchema: { type: "object", properties: { total: { type: "number" } } },
  handler: ({ a, b }) => ({ total: a + b }),
});
