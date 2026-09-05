// Disabled: the sandbox has no network, and the baseline traces show
// web_search as the exact derail pattern (task 33722 called it once and
// never submitted). See docs/concepts/built-in-tools.md, "Disable a
// default": exporting disableTool() from agent/tools/<slug>.ts removes the
// matching built-in and the model never sees it.

import { disableTool } from "eve/tools";

export default disableTool();
