// Disabled: `agent` lets the root session delegate to a fresh copy of
// itself ("From the root session, delegate a subtask to a fresh copy of
// the root agent." — docs/concepts/built-in-tools.md). That's a second
// execution surface outside this session's own context and budget, on a
// task that must stay a single bounded load_task -> recalc_and_read ->
// submit loop.

import { disableTool } from "eve/tools";

export default disableTool();
