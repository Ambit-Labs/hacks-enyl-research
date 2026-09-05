// Disabled: web_fetch runs in the app runtime, not the sandbox
// (docs/concepts/built-in-tools.md table: "`web_fetch` | Fetch a URL. |
// App runtime"), so it reaches outside the sandbox to the open network.
// The sandbox has no network access and the model must not be able to pull
// in anything from outside it.

import { disableTool } from "eve/tools";

export default disableTool();
