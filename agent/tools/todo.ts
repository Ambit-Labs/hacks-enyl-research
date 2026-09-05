// Disabled: this agent already runs a fixed load_task -> recalc_and_read ->
// submit loop under a 12-call budget. A durable todo list adds no value to
// that loop and only spends calls the budget can't afford (the baseline
// traces show todo called 5 times for zero benefit).
//
// docs/concepts/built-in-tools.md, "Disable a default": exporting
// disableTool() from agent/tools/<slug>.ts removes the matching built-in.

import { disableTool } from "eve/tools";

export default disableTool();
